const frame    = document.getElementById('appFrame');
const BASE_URL = 'https://bellavaffa-cmd.github.io/daily-ops-webapp/';

// ── Respond to background pings (used to detect if panel is already open) ──
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === 'ping') {
    sendResponse({ ok: true });
    return true; // keep channel open
  }
  if (msg.action === 'loadScan' && msg.url) {
    frame.src = msg.url;
  }
});

// ── On load: pick up a pending scan URL stored before the panel opened ──
// Retry a few times in case background writes storage slightly after panel loads.
function loadPendingScan(retries) {
  chrome.storage.session.get('pendingScan', (result) => {
    if (result.pendingScan) {
      frame.src = result.pendingScan;
      chrome.storage.session.remove('pendingScan');
    } else if (retries > 0) {
      setTimeout(() => loadPendingScan(retries - 1), 200);
    }
  });
}
loadPendingScan(5); // retry up to 5× over 1 s

// ── Bridge: app iframe → Logiwa sync ────────────────────────────────────────
// Extension pages bypass CORS for host_permissions URLs, so we do all the
// API work here in sidepanel.js rather than in the content script.
// Content script only reads localStorage to get the Logiwa token.
window.addEventListener('message', (e) => {
  if (!e.data || e.data.type !== 'wms-sync-logiwa') return;

  const reply = (payload) => frame.contentWindow.postMessage({ type: 'wms-sync-result', ...payload }, '*');

  chrome.tabs.query({ url: 'https://wms.golocad.com/*' }, (tabs) => {
    if (!tabs || !tabs.length) {
      reply({ ok: false, error: 'WMS tab not found — open wms.golocad.com first.' });
      return;
    }

    // Step 1: get token from content script (synchronous localStorage read)
    chrome.tabs.sendMessage(tabs[0].id, { action: 'getLogiwaToken' }, async (resp) => {
      if (chrome.runtime.lastError) {
        reply({ ok: false, error: 'Reload the wms.golocad.com tab and try again.' });
        return;
      }
      if (!resp || !resp.token) {
        reply({ ok: false, error: 'Not logged in to Logiwa.' });
        return;
      }

      // Step 2: run sync from sidepanel (extension page — no CORS restrictions)
      const token  = resp.token;
      const SB_URL = 'https://hmpkjmnxoidesnnoecfm.supabase.co';
      const SB_KEY = 'sb_publishable_00pJSeJ3cKuxqwelQbaKWg_uJe7XPtP';
      const LG_API = 'https://mywmsquery.logiwa.com';
      const SM     = { 6: 'new', 8: 'rfp', 9: 'picking', 12: 'picked' };

      try {
        let all = [], page = 0, total = 1;
        while (all.length < total) {
          const r = await fetch(LG_API + '/api/shipmentorder/list/unshipped/i/' + page + '/s/1000', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
            body: '{}'
          });
          if (!r.ok) throw new Error('Logiwa ' + r.status);
          const d = await r.json();
          all = all.concat(d.data || []);
          total = d.totalCount || 0;
          page++;
        }

        const cols = [...new Set(Object.values(SM))];
        const whs  = {};
        for (const o of all) {
          const wh = o.warehouseCode, col = SM[o.shipmentOrderStatusId];
          if (!wh || !col) continue;
          if (!whs[wh]) { whs[wh] = { wh }; cols.forEach(c => whs[wh][c] = 0); }
          whs[wh][col]++;
        }
        const rows = Object.values(whs).map(r => ({ ...r, updated_at: new Date().toISOString() }));

        const res = await fetch(SB_URL + '/rest/v1/b2c_data', {
          method: 'POST',
          headers: {
            apikey: SB_KEY, Authorization: 'Bearer ' + SB_KEY,
            'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates'
          },
          body: JSON.stringify(rows)
        });
        if (!res.ok) throw new Error('Supabase ' + res.status + ': ' + await res.text());

        reply({ ok: true, count: rows.length });
      } catch (err) {
        reply({ ok: false, error: err.message });
      }
    });
  });
});

// ── After form submission: close panel if we auto-opened it, else go home ──
window.addEventListener('message', (e) => {
  if (!e.data || e.data.type !== 'wms-close-overlay') return;

  chrome.storage.session.get('autoOpenedPanel', (result) => {
    chrome.storage.session.remove('autoOpenedPanel');
    if (result.autoOpenedPanel) {
      window.close(); // panel was closed before — close it again
    } else {
      frame.src = BASE_URL; // panel was already open — go back to dashboard
    }
  });
});
