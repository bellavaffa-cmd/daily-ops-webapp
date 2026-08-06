// Background service worker

// Open side panel when the extension toolbar icon is clicked
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch(err => console.error('[WMS bg] setPanelBehavior:', err));

// ── Hourly auto-sync, aligned to the top of the clock hour ──────────────────
// Fire at the next :00 and every 60 min after (1:00, 2:00, 3:00…). Chrome
// persists alarms, so recreate on install and browser startup. A background
// sync still needs an open wms.golocad.com tab for the token; if none is open
// it logs and no-ops until the next tick.
function scheduleHourlySync() {
  const now = Date.now();
  const nextHour = new Date(now);
  nextHour.setMinutes(0, 0, 0);
  nextHour.setHours(nextHour.getHours() + 1);
  chrome.alarms.create('hourlySync', { when: nextHour.getTime(), periodInMinutes: 60 });
}
chrome.runtime.onInstalled.addListener(scheduleHourlySync);
chrome.runtime.onStartup.addListener(scheduleHourlySync);
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === 'hourlySync') {
    performSync(false).catch(e => console.error('[WMS bg] hourly sync:', e.message));
  }
});

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

  // Manual sync from the side panel / webapp. Returning true keeps the message
  // port open as a SW keepalive in MV3 until performSync resolves.
  if (msg.action === 'triggerLogiwaSync' || msg.action === 'triggerLogiwaB2BSync') {
    performSync(msg.action === 'triggerLogiwaB2BSync').finally(() => sendResponse({}));
    return true;
  }
});

// ── Shared Logiwa sync ──────────────────────────────────────────────────────
// One Logiwa fetch returns ALL order types, so every sync computes both the B2C
// and B2B aggregates plus the productivity report. isB2B only picks which count
// is broadcast back and which storage key/result action the UI listens on.
async function performSync(isB2B) {
  const config = isB2B
    ? { orderType: 'B2B', sbTable: 'b2b_data', resultAction: 'syncLogiwaB2BResult', storageKey: 'logiwaB2BSync' }
    : { orderType: 'B2C', sbTable: 'b2c_data', resultAction: 'syncLogiwaResult',    storageKey: 'logiwaSync'    };

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

    // 3. Fetch orders + user-performance + jobs from Logiwa concurrently, and
    // each list's pages in parallel batches (instead of one page at a time).
    // Orders are the critical path (awaited first so B2C is reported early);
    // perf/jobs failures degrade to null without failing the sync.
    const LG_API = 'https://mywmsquery.logiwa.com';
    const fetchAllPages = async (makeUrl, body, concurrency = 4, pageSize = 1000) => {
      const headers = { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token };
      const getPage = async (p) => {
        const r = await fetch(makeUrl(p), { method: 'POST', headers, body });
        if (!r.ok) throw new Error('Logiwa API error ' + r.status);
        return r.json();
      };
      const first = await getPage(0);
      let out = first.data || [];
      const total = first.totalCount || out.length;
      const pages = Math.max(1, Math.ceil(total / pageSize));
      for (let s = 1; s < pages; s += concurrency) {
        const batch = [];
        for (let p = s; p < Math.min(s + concurrency, pages); p++) batch.push(getPage(p));
        for (const d of await Promise.all(batch)) out = out.concat(d.data || []);
      }
      return out;
    };

    // Bodies hoisted so all three lists can fire at once.
    const perfStart = new Date(Date.now() - 29 * 24 * 60 * 60 * 1000); perfStart.setUTCHours(0, 0, 0, 0);
    const perfEnd   = new Date(); perfEnd.setUTCHours(23, 59, 59, 999);
    const perfBody = JSON.stringify({
      queries: [{ field: 'ActivityDate', uniqueFieldName: 'ActivityDate.exd', keyword: 'exd',
                  label: 'Activity Date', value: `${perfStart.toISOString()},${perfEnd.toISOString()}`,
                  comparator: 'range', type: 'date', uiType: 'datetime' }],
      sorts: []
    });
    const jobBody = JSON.stringify({
      queries: [{ field: 'WarehouseJobStatusId', uniqueFieldName: 'WarehouseJobStatusId.wjst', keyword: 'wjst',
                  label: 'Job Status', value: '[1]', summaryValue: 'Pending',
                  comparator: 'in', comparatorLabel: 'in', type: 'numeric0', uiType: 'dropdown' }],
      sorts: []
    });

    const ordersP = fetchAllPages(p => `${LG_API}/api/shipmentorder/list/unshipped/i/${p}/s/1000`, '{}');
    const perfP   = fetchAllPages(p => `${LG_API}/api/warehousetask/userperformance/last/30/i/${p}/s/1000`, perfBody)
                      .catch(e => { console.error('[WMS bg] userperformance fetch:', e.message); return null; });
    const jobsP   = fetchAllPages(p => `${LG_API}/api/warehousejob/list/i/${p}/s/1000`, jobBody)
                      .catch(e => { console.error('[WMS bg] warehousejob fetch:', e.message); return null; });

    const all = await ordersP;  // critical path — a failure here fails the sync

    // 3b. Cut-off config → today/tomorrow split. Orders that dropped after their
    // cut-off (Priority-MP vs Non-MP) are tomorrow's dispatch; we count them
    // separately so the app can exclude them from today and show a Tomorrow tab.
    // Cut-offs are PER WAREHOUSE (set in the Manager Console → warehouse_config),
    // falling back to the '*' default row, then to hardcoded defaults. Interpreted
    // in the sync machine's local time (the operating region).
    let defCfg = { mp_cutoff: '16:15', nonmp_cutoff: '14:09' };
    const whCfg = {};
    try {
      const cr = await fetch('https://hmpkjmnxoidesnnoecfm.supabase.co/rest/v1/warehouse_config?select=wh,mp_cutoff,nonmp_cutoff', {
        headers: { apikey: 'sb_publishable_00pJSeJ3cKuxqwelQbaKWg_uJe7XPtP', Authorization: 'Bearer sb_publishable_00pJSeJ3cKuxqwelQbaKWg_uJe7XPtP' }
      });
      if (cr.ok) { for (const r of (await cr.json()) || []) { if (r.wh === '*') defCfg = { mp_cutoff: r.mp_cutoff, nonmp_cutoff: r.nonmp_cutoff }; else whCfg[r.wh] = r; } }
    } catch (e) { /* keep defaults */ }
    const todayCutoffTs = hhmm => {
      if (!hhmm) return null;
      const [h, m] = String(hhmm).split(':').map(Number);
      const d = new Date(); d.setHours(h || 0, m || 0, 0, 0);
      return d.getTime();
    };
    const _cutCache = {};
    const cutsFor = wh => {
      if (_cutCache[wh]) return _cutCache[wh];
      const c = whCfg[wh] || defCfg;
      const v = { mp: todayCutoffTs(c.mp_cutoff || defCfg.mp_cutoff), nonmp: todayCutoffTs(c.nonmp_cutoff || defCfg.nonmp_cutoff) };
      return (_cutCache[wh] = v);
    };
    // An order is "tomorrow" if it dropped after its warehouse's type cut-off today.
    const isTomorrowOrder = (o, isMp) => {
      const created = Date.parse(o.createdDateTime || o.shipmentOrderDate || '');
      if (!created) return false;
      const c = cutsFor(o.warehouseCode);
      const cut = isMp ? c.mp : c.nonmp;
      return !!(cut && created > cut);
    };

    // Warehouse code (name) → internal GUID, for the app's WMS deep-link
    // warehouse filter (?wn=[guid]). Keyed live so warehouse renames stay correct.
    const whGuid = {};
    for (const o of all) {
      if (o.warehouseCode && o.warehouseIdentifier && !whGuid[o.warehouseCode]) {
        whGuid[o.warehouseCode] = o.warehouseIdentifier;
      }
    }

    // 4. Pivot warehouseCode × status → counts. Compute BOTH the B2C and B2B
    // aggregates every sync — otherwise whichever aggregate this sync isn't
    // "for" goes stale (e.g. b2b_data.ready_ship stayed 0 after a B2C-context
    // sync even though the individual b2b_orders were refreshed). Zero-seed
    // every warehouse this session can see so a count dropping to zero actually
    // gets written rather than keeping its last value.
    // Order "tags" carry the marketplace labels. Normalise (lowercase, strip
    // non-alphanumerics) so "Non-MP"/"Non MP" and "Priority MP" all match.
    const normTag = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const orderHasTag = (o, t) => (o.tags || []).some(tag => normTag(tag.name) === t);

    // countTags=true (B2C) also tallies per-status Non-MP / Priority MP counts
    // into <status>_nonmp / <status>_prioritymp columns.
    const pivot = (orderType, sm, countTags) => {
      const cols = [...new Set(Object.values(sm))];
      const whs  = {};
      const seed = wh => {
        whs[wh] = { wh };
        cols.forEach(c => {
          whs[wh][c] = 0;
          if (countTags) {
            whs[wh][c + '_nonmp'] = 0; whs[wh][c + '_prioritymp'] = 0;
            whs[wh][c + '_tomorrow'] = 0;
            whs[wh][c + '_tomorrow_nonmp'] = 0; whs[wh][c + '_tomorrow_prioritymp'] = 0;
          }
        });
      };
      for (const o of all) {
        const wh = o.warehouseCode;
        if (!wh || whs[wh]) continue;
        seed(wh);
      }
      for (const o of all) {
        if (o.shipmentOrderTypeName !== orderType) continue;
        const wh = o.warehouseCode, col = sm[o.shipmentOrderStatusId];
        if (!wh || !col) continue;
        whs[wh][col]++;
        if (countTags) {
          const isNon = orderHasTag(o, 'nonmp');
          const isMp  = orderHasTag(o, 'prioritymp');
          if (isNon) whs[wh][col + '_nonmp']++;
          if (isMp)  whs[wh][col + '_prioritymp']++;
          if (isTomorrowOrder(o, isMp)) {
            whs[wh][col + '_tomorrow']++;
            if (isNon) whs[wh][col + '_tomorrow_nonmp']++;
            if (isMp)  whs[wh][col + '_tomorrow_prioritymp']++;
          }
        }
      }
      return Object.values(whs).map(r => ({ ...r, ...(countTags && whGuid[r.wh] ? { wh_id: whGuid[r.wh] } : {}), updated_at: new Date().toISOString() }));
    };
    const B2C_SM_AGG = { 6:'new',  8:'rfp', 9:'picking', 12:'picked',     13:'packing' };
    const B2B_SM_AGG = { 6:'open', 8:'rfp', 9:'picking', 12:'pack_ready', 13:'packing', 16:'ready_ship' };
    const b2cRows = pivot('B2C', B2C_SM_AGG, true);
    const b2bRows = pivot('B2B', B2B_SM_AGG, false);

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

    // 5. Upsert to Supabase — all tables every sync so nothing lags.
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
    await Promise.all([
      sbUpsert('b2c_data',        b2cRows,        'wh'),
      sbUpsert('b2b_data',        b2bRows,        'wh'),
      sbUpsert('b2b_orders',      b2bOrders,      'order_id'),
      sbUpsert('shortage_data',   shortageRows,   'wh'),
      sbUpsert('shortage_orders', shortageOrders, 'order_id'),
    ]);

    // 5b. B2C flow snapshot (feature 2): per warehouse, the current Open count
    // and how many B2C orders were created in the last 60 min (inflow). Appended
    // each sync so the app can show hourly inflow vs Open-queue depletion.
    try {
      const hourAgo = Date.now() - 60 * 60 * 1000;
      const flow = {};
      for (const o of all) {
        if (o.shipmentOrderTypeName !== 'B2C') continue;
        const wh = o.warehouseCode;
        if (!wh) continue;
        if (!flow[wh]) flow[wh] = { warehouse_code: wh, open_count: 0, inflow_1h: 0 };
        if (o.shipmentOrderStatusId === 6) flow[wh].open_count++;
        const created = Date.parse(o.createdDateTime || o.shipmentOrderDate || '');
        if (created && created >= hourAgo) flow[wh].inflow_1h++;
      }
      const nowIso = new Date().toISOString();
      const flowRows = Object.values(flow).map(f => ({ ...f, captured_at: nowIso }));
      if (flowRows.length) {
        await fetch(`${SB_URL}/rest/v1/b2c_flow_snapshot`, {
          method: 'POST',
          headers: { apikey: SB_KEY, Authorization: 'Bearer ' + SB_KEY, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
          body: JSON.stringify(flowRows)
        });
      }
      const flowCutoff = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
      await fetch(`${SB_URL}/rest/v1/b2c_flow_snapshot?captured_at=lt.${encodeURIComponent(flowCutoff)}`, {
        method: 'DELETE', headers: { apikey: SB_KEY, Authorization: 'Bearer ' + SB_KEY }
      }).catch(() => {});
    } catch (e) {
      console.error('[WMS bg] b2c flow snapshot error:', e.message);
    }

    // Report success now — the critical order data is written. Productivity and
    // jobs finish in the background so the UI isn't kept waiting on them.
    const aggCount = (isB2B ? b2bRows : b2cRows).length;
    await broadcast({ ok: true, count: aggCount, b2bCount: b2bOrders.length, shortageCount: shortageOrders.length });

    // 6. Productivity: Logiwa's authoritative user-performance report — per
    // user, per day, picked/packed order+item counts for the last 30 days.
    // Same host + token as the order fetch; failures here don't fail the sync.
    try {
      const perfAll = (await perfP) || [];
      const perfRows = perfAll.map(u => ({
        warehouse_code:   u.warehouseCode,
        executed_by:      u.executedBy,
        executed_by_name: u.executedByName || null,
        activity_date:    u.activityDate,
        picked_orders:    u.pickedOrderQuantity || 0,
        packed_orders:    u.packedOrderQuantity || 0,
        picked_items:     u.pickedItemQuantity  || 0,
        packed_items:     u.packedItemQuantity  || 0,
        updated_at:       new Date().toISOString()
      })).filter(u => u.warehouse_code && u.executed_by != null && u.activity_date);
      await sbUpsert('user_performance', perfRows, 'warehouse_code,executed_by,activity_date');
      // Retention: keep ~1 month.
      const upCutoff = new Date(Date.now() - 35 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      await fetch(`${SB_URL}/rest/v1/user_performance?activity_date=lt.${upCutoff}`, {
        method: 'DELETE', headers: { apikey: SB_KEY, Authorization: 'Bearer ' + SB_KEY }
      }).catch(() => {});

      // 6b. Productivity snapshot: append this sync's cumulative TODAY totals per
      // warehouse (timestamped with the sync time) so the app can show an hourly
      // depletion rate = this total minus the total ~1h ago. Plain insert (not
      // upsert) — each sync is a new point in the history.
      try {
        const todayStr = perfRows.reduce((m, r) => (r.activity_date > m ? r.activity_date : m), '');
        if (todayStr) {
          const snapWh = {};
          for (const r of perfRows) {
            if (r.activity_date !== todayStr) continue;
            const s = (snapWh[r.warehouse_code] = snapWh[r.warehouse_code] ||
              { warehouse_code: r.warehouse_code, activity_date: todayStr, picked_orders: 0, packed_orders: 0, picked_items: 0, packed_items: 0 });
            s.picked_orders += r.picked_orders;
            s.packed_orders += r.packed_orders;
            s.picked_items  += r.picked_items;
            s.packed_items  += r.packed_items;
          }
          const nowIso = new Date().toISOString();
          const snapRows = Object.values(snapWh).map(s => ({ ...s, captured_at: nowIso }));
          if (snapRows.length) {
            await fetch(`${SB_URL}/rest/v1/productivity_snapshot`, {
              method: 'POST',
              headers: { apikey: SB_KEY, Authorization: 'Bearer ' + SB_KEY, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
              body: JSON.stringify(snapRows)
            });
          }
          // Retention: keep ~2 days of snapshots (the app only needs the last hour).
          const snapCutoff = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
          await fetch(`${SB_URL}/rest/v1/productivity_snapshot?captured_at=lt.${encodeURIComponent(snapCutoff)}`, {
            method: 'DELETE', headers: { apikey: SB_KEY, Authorization: 'Bearer ' + SB_KEY }
          }).catch(() => {});
        }
      } catch (e) {
        console.error('[WMS bg] snapshot error:', e.message);
      }
    } catch (e) {
      console.error('[WMS bg] userperformance error:', e.message);
    }

    // 7. Jobs: Pending warehouse jobs only, aggregated per warehouse by priority
    // (3=High, 2=Medium, 1=Low; anything else = none). Filter to Pending in the
    // request body (WarehouseJobStatusId in [1]) — the unfiltered list returns
    // every job ever (thousands of Completed), so filtering keeps this light.
    try {
      const jobsAll = (await jobsP) || [];
      // Zero-seed from the order-fetch warehouses so a Pending count dropping to
      // zero still gets written rather than keeping its last value.
      const jobWhs = {};
      for (const o of all) {
        const wh = o.warehouseCode;
        if (wh && !jobWhs[wh]) jobWhs[wh] = { wh, total: 0, high: 0, medium: 0, low: 0, no_priority: 0 };
      }
      for (const o of jobsAll) {
        if (o.warehouseJobStatusId !== 1) continue; // Pending only (safety; body already filters)
        const wh = o.warehouseCode;
        if (!wh) continue;
        if (!jobWhs[wh]) jobWhs[wh] = { wh, total: 0, high: 0, medium: 0, low: 0, no_priority: 0 };
        const j = jobWhs[wh];
        j.total++;
        if (o.priority === 3) j.high++;
        else if (o.priority === 2) j.medium++;
        else if (o.priority === 1) j.low++;
        else j.no_priority++;
      }
      const jobRows = Object.values(jobWhs).map(r => ({ ...r, updated_at: new Date().toISOString() }));
      await sbUpsert('job_data', jobRows, 'wh');
    } catch (e) {
      console.error('[WMS bg] warehousejob error:', e.message);
    }

  } catch (e) {
    console.error('[WMS bg] sync error:', e.message);
    await broadcast({ ok: false, error: e.message });
  }
}
