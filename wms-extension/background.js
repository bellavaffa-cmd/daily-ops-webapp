// Background service worker

// Open side panel when the extension toolbar icon is clicked
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch(err => console.error('[WMS bg] setPanelBehavior:', err));

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === 'openSidePanel' && msg.url && sender.tab) {
    const url   = msg.url;
    const tabId = sender.tab.id;

    // Open the panel immediately while user gesture is still active
    chrome.sidePanel.open({ tabId }, () => {
      if (chrome.runtime.lastError) {
        console.error('[WMS bg] sidePanel.open FAILED:', chrome.runtime.lastError.message);
      }
    });

    // Ping to check if panel was already open before we opened it
    chrome.runtime.sendMessage({ action: 'ping' }, (pingResp) => {
      const panelWasOpen = !chrome.runtime.lastError && !!pingResp;

      chrome.storage.session.set({
        pendingScan:     url,
        autoOpenedPanel: !panelWasOpen
      }, () => {
        if (panelWasOpen) {
          // Panel was already showing — tell it to navigate to the scan
          chrome.runtime.sendMessage({ action: 'loadScan', url }, () => {
            void chrome.runtime.lastError;
          });
        }
      });
    });

    sendResponse({ ok: true });
    return false; // sendResponse already called synchronously
  }

  // Open a new tab (fallback)
  if (msg.action === 'openTab' && msg.url) {
    chrome.tabs.create({ url: msg.url, active: true });
  }

  // Close a tab after form submission (standalone-tab flow)
  if (msg.action === 'closeTab' && sender.tab) {
    chrome.tabs.remove(sender.tab.id);
  }

  // ── Logiwa B2C sync ────────────────────────────────────────────────────────
  // Runs in the background service worker which reliably bypasses CORS for
  // URLs in host_permissions (unlike extension pages such as sidepanel.html).
  // IMPORTANT: return true keeps the message port open, which acts as a
  // service-worker keepalive in MV3. Without it the SW can be terminated
  // mid-fetch (between returning from the handler and the first network call).
  if (msg.action === 'triggerLogiwaSync') {
    (async () => {
      // Notify the sidepanel of the result via both sendMessage (fast path)
      // and storage (reliable fallback in case the port closes first).
      const broadcast = async (payload) => {
        // Write to session storage first — sidepanel polls this as fallback
        await chrome.storage.session.set({ logiwaSync: { ...payload, ts: Date.now() } });
        // Also send a runtime message for the fast path
        chrome.runtime.sendMessage({ action: 'syncLogiwaResult', ...payload }, () => {
          void chrome.runtime.lastError; // suppress "no listener" if sidepanel closed
        });
      };

      try {
        // 1. Find a WMS tab with the content script running
        const tabs = await chrome.tabs.query({ url: 'https://wms.golocad.com/*' });
        if (!tabs || !tabs.length) throw new Error('WMS tab not found — open wms.golocad.com first.');

        // 2. Get the Logiwa session token from the page's localStorage
        const tokenResp = await new Promise((resolve) => {
          chrome.tabs.sendMessage(tabs[0].id, { action: 'getLogiwaToken' }, (r) => {
            void chrome.runtime.lastError;
            resolve(r);
          });
        });
        if (!tokenResp || !tokenResp.token) throw new Error('Reload the wms.golocad.com tab and try again.');
        const token = tokenResp.token;

        // 3. Fetch all unshipped orders from Logiwa
        const LG_API = 'https://mywmsquery.logiwa.com';
        const SM     = { 6: 'new', 8: 'rfp', 9: 'picking', 12: 'picked' };
        let all = [], page = 0, total = 1;
        while (all.length < total) {
          const r = await fetch(`${LG_API}/api/shipmentorder/list/unshipped/i/${page}/s/1000`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
            body: '{}'
          });
          if (!r.ok) throw new Error('Logiwa API error ' + r.status);
          const d = await r.json();
          all   = all.concat(d.data || []);
          total = d.totalCount || 0;
          page++;
        }

        // 4. Pivot: warehouseCode × status → counts
        const cols = [...new Set(Object.values(SM))];
        const whs  = {};
        for (const o of all) {
          if (o.shipmentOrderTypeName !== 'B2C') continue;
          const wh = o.warehouseCode, col = SM[o.shipmentOrderStatusId];
          if (!wh || !col) continue;
          if (!whs[wh]) { whs[wh] = { wh }; cols.forEach(c => whs[wh][c] = 0); }
          whs[wh][col]++;
        }
        const rows = Object.values(whs).map(r => ({ ...r, updated_at: new Date().toISOString() }));

        // 4b. B2B: one row per order (not pivoted) — order_id/wh/status only.
        // NOTE: order_id field name is a best guess (Logiwa's list endpoint has
        // never been inspected for its B2B order-identifier field) — verify
        // against a real response and adjust the fallback chain below if the
        // synced order_id values come back blank or wrong.
        const B2B_SM = { 6: 'open', 8: 'rfp', 9: 'picking', 12: 'pack_ready', 13: 'packing' };
        const b2bOrders = all
          .filter(o => o.shipmentOrderTypeName === 'B2B')
          .map(o => ({
            order_id: String(o.orderNumber ?? o.referenceNumber ?? o.shipmentOrderNumber ?? o.shipmentOrderId ?? o.id ?? ''),
            wh: o.warehouseCode,
            status: B2B_SM[o.shipmentOrderStatusId] || null,
            updated_at: new Date().toISOString()
          }))
          .filter(o => o.order_id && o.wh && o.status);

        // 5. Upsert to Supabase
        const SB_URL = 'https://hmpkjmnxoidesnnoecfm.supabase.co';
        const SB_KEY = 'sb_publishable_00pJSeJ3cKuxqwelQbaKWg_uJe7XPtP';
        const res = await fetch(`${SB_URL}/rest/v1/b2c_data`, {
          method: 'POST',
          headers: {
            apikey: SB_KEY, Authorization: 'Bearer ' + SB_KEY,
            'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates'
          },
          body: JSON.stringify(rows)
        });
        if (!res.ok) throw new Error('Supabase error ' + res.status + ': ' + await res.text());

        if (b2bOrders.length) {
          const b2bRes = await fetch(`${SB_URL}/rest/v1/b2b_orders`, {
            method: 'POST',
            headers: {
              apikey: SB_KEY, Authorization: 'Bearer ' + SB_KEY,
              'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates'
            },
            body: JSON.stringify(b2bOrders)
          });
          if (!b2bRes.ok) throw new Error('Supabase b2b_orders error ' + b2bRes.status + ': ' + await b2bRes.text());
        }

        await broadcast({ ok: true, count: rows.length, b2bCount: b2bOrders.length });
      } catch (e) {
        console.error('[WMS bg] sync error:', e.message);
        await broadcast({ ok: false, error: e.message });
      } finally {
        sendResponse({}); // close the port — signals async work is done
      }
    })();
    return true; // ← keep message port open as SW keepalive until finally{} runs
  }
});
