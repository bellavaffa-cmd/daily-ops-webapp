// Background service worker

// Open side panel when the extension toolbar icon is clicked
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch(err => console.error('[WMS bg] setPanelBehavior:', err));

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {

  if (msg.action === 'openSidePanel' && msg.url && sender.tab) {
    const url   = msg.url;
    const tabId = sender.tab.id;

    console.log('[WMS bg] openSidePanel received, tabId:', tabId);

    // Open the panel immediately while user gesture is still active
    chrome.sidePanel.open({ tabId }, () => {
      if (chrome.runtime.lastError) {
        console.error('[WMS bg] sidePanel.open FAILED:', chrome.runtime.lastError.message);
      } else {
        console.log('[WMS bg] sidePanel.open SUCCESS');
      }
    });

    // Ping to check if panel was already open before we opened it
    chrome.runtime.sendMessage({ action: 'ping' }, (pingResp) => {
      const panelWasOpen = !chrome.runtime.lastError && !!pingResp;
      console.log('[WMS bg] panelWasOpen:', panelWasOpen);

      chrome.storage.session.set({
        pendingScan:     url,
        autoOpenedPanel: !panelWasOpen
      }, () => {
        console.log('[WMS bg] pendingScan stored');
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
  if (msg.action === 'triggerLogiwaSync') {
    (async () => {
      const broadcast = (payload) => {
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
          const wh = o.warehouseCode, col = SM[o.shipmentOrderStatusId];
          if (!wh || !col) continue;
          if (!whs[wh]) { whs[wh] = { wh }; cols.forEach(c => whs[wh][c] = 0); }
          whs[wh][col]++;
        }
        const rows = Object.values(whs).map(r => ({ ...r, updated_at: new Date().toISOString() }));

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

        broadcast({ ok: true, count: rows.length });
      } catch (e) {
        broadcast({ ok: false, error: e.message });
      }
    })();
    return false;
  }
});
