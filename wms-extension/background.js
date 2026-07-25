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

  // ── Shared Logiwa sync helper ──────────────────────────────────────────────
  // config: { orderType, statusMap, sbTable, resultAction, storageKey }
  // return true keeps the message port open as a SW keepalive in MV3.
  if (msg.action === 'triggerLogiwaSync' || msg.action === 'triggerLogiwaB2BSync') {
    const isB2B = msg.action === 'triggerLogiwaB2BSync';
    const config = isB2B
      ? { orderType: 'B2B', statusMap: { 6:'open', 8:'rfp', 9:'picking', 12:'pack_ready', 13:'packing', 16:'ready_ship' }, sbTable: 'b2b_data', resultAction: 'syncLogiwaB2BResult', storageKey: 'logiwaB2BSync' }
      : { orderType: 'B2C', statusMap: { 6:'new',  8:'rfp', 9:'picking', 12:'picked',     13:'packing' }, sbTable: 'b2c_data', resultAction: 'syncLogiwaResult',    storageKey: 'logiwaSync'    };

    (async () => {
      const broadcast = async (payload) => {
        await chrome.storage.session.set({ [config.storageKey]: { ...payload, ts: Date.now() } });
        chrome.runtime.sendMessage({ action: config.resultAction, ...payload }, () => {
          void chrome.runtime.lastError;
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

        // 4. Pivot warehouseCode × status → counts. One Logiwa fetch returns
        // ALL order types, so compute BOTH the B2C and B2B aggregates on every
        // sync — otherwise whichever aggregate this sync isn't "for" goes stale
        // (e.g. b2b_data.ready_ship stayed 0 after a B2C-context sync even
        // though the individual b2b_orders were refreshed).
        // Zero-seed every warehouse this session can see so a count dropping to
        // zero actually gets written rather than keeping its last value.
        const pivot = (orderType, sm) => {
          const cols = [...new Set(Object.values(sm))];
          const whs  = {};
          for (const o of all) {
            const wh = o.warehouseCode;
            if (!wh || whs[wh]) continue;
            whs[wh] = { wh };
            cols.forEach(c => whs[wh][c] = 0);
          }
          for (const o of all) {
            if (o.shipmentOrderTypeName !== orderType) continue;
            const wh = o.warehouseCode, col = sm[o.shipmentOrderStatusId];
            if (!wh || !col) continue;
            whs[wh][col]++;
          }
          return Object.values(whs).map(r => ({ ...r, updated_at: new Date().toISOString() }));
        };
        const B2C_SM_AGG = { 6:'new',  8:'rfp', 9:'picking', 12:'picked',     13:'packing' };
        const B2B_SM_AGG = { 6:'open', 8:'rfp', 9:'picking', 12:'pack_ready', 13:'packing', 16:'ready_ship' };
        const b2cRows = pivot('B2C', B2C_SM_AGG);
        const b2bRows = pivot('B2B', B2B_SM_AGG);

        // 4b. B2B: one row per order (not pivoted) — order_id/wh/status only.
        // order_id is Logiwa's "code" (human-readable, e.g. "585181359330264214",
        // same value as channelOrderNumber) — falls back to the internal GUID
        // "identifier" on the rare order missing a code.
        // brand = Logiwa clientDisplayName (the seller/brand). collected_by is
        // deliberately NOT sent: it's user-set in the app and a partial upsert
        // (merge-duplicates only touches the columns in the body) preserves it.
        const B2B_SM = { 6: 'open', 8: 'rfp', 9: 'picking', 12: 'pack_ready', 13: 'packing', 16: 'ready_ship' };
        const b2bOrders = all
          .filter(o => o.shipmentOrderTypeName === 'B2B')
          .map(o => ({
            order_id: String(o.code ?? o.identifier ?? ''),
            wh: o.warehouseCode,
            status: B2B_SM[o.shipmentOrderStatusId] || null,
            brand: o.clientDisplayName || null,
            expected_ship_date: o.expectedShipmentDate || null,
            updated_at: new Date().toISOString()
          }))
          .filter(o => o.order_id && o.wh && o.status);

        // 4c. Shortage: age-bucket pivot (any order type, statusId 2 = "Shortage" —
        // confirmed via a real Logiwa WMS filter URL, not guessed) + one row per
        // shortage order. Same zero-seeding as the main pivot above, so a
        // warehouse whose shortage count drops to zero actually gets written.
        const ageCols = ['age_1_3', 'age_4_7', 'age_7_plus'];
        const ageBucket = age => (age <= 3 ? 'age_1_3' : age <= 7 ? 'age_4_7' : 'age_7_plus');
        const shortageWhs = {};
        for (const o of all) {
          const wh = o.warehouseCode;
          if (!wh || shortageWhs[wh]) continue;
          shortageWhs[wh] = { wh };
          ageCols.forEach(c => shortageWhs[wh][c] = 0);
        }
        for (const o of all) {
          if (o.shipmentOrderStatusId !== 2) continue;
          const wh = o.warehouseCode;
          if (!wh) continue;
          shortageWhs[wh][ageBucket(o.orderAge || 0)]++;
        }
        const shortageRows = Object.values(shortageWhs).map(r => ({ ...r, updated_at: new Date().toISOString() }));

        const shortageOrders = all
          .filter(o => o.shipmentOrderStatusId === 2)
          .map(o => ({
            order_id: String(o.code ?? o.identifier ?? ''),
            wh: o.warehouseCode,
            order_type: o.shipmentOrderTypeName || null,
            age: o.orderAge ?? null,
            brand: o.clientDisplayName || null,
            updated_at: new Date().toISOString()
          }))
          .filter(o => o.order_id && o.wh);

        // 5. Upsert to Supabase — all five tables every sync so nothing lags.
        const SB_URL = 'https://hmpkjmnxoidesnnoecfm.supabase.co';
        const SB_KEY = 'sb_publishable_00pJSeJ3cKuxqwelQbaKWg_uJe7XPtP';
        const sbUpsert = async (table, rowsToSend, conflict) => {
          if (!rowsToSend.length) return;
          const r = await fetch(`${SB_URL}/rest/v1/${table}?on_conflict=${conflict}`, {
            method: 'POST',
            headers: { apikey: SB_KEY, Authorization: 'Bearer ' + SB_KEY, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates' },
            body: JSON.stringify(rowsToSend)
          });
          if (!r.ok) throw new Error(`Supabase ${table} error ${r.status}: ${await r.text()}`);
        };
        await sbUpsert('b2c_data',        b2cRows,        'wh');
        await sbUpsert('b2b_data',        b2bRows,        'wh');
        await sbUpsert('b2b_orders',      b2bOrders,      'order_id');
        await sbUpsert('shortage_data',   shortageRows,   'wh');
        await sbUpsert('shortage_orders', shortageOrders, 'order_id');

        const aggCount = (isB2B ? b2bRows : b2cRows).length;
        await broadcast({ ok: true, count: aggCount, b2bCount: b2bOrders.length, shortageCount: shortageOrders.length });
      } catch (e) {
        console.error('[WMS bg] sync error:', e.message);
        await broadcast({ ok: false, error: e.message });
      } finally {
        sendResponse({});
      }
    })();
    return true;
  }
});
