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

// ── Bridge: app iframe → content script on wms.golocad.com ──────────────────
// Step 1: iframe posts {type:'wms-sync-logiwa'} → we kick off the content script.
// Step 2: content script fires chrome.runtime.sendMessage({action:'syncLogiwaResult'})
//         when done → we forward it to the iframe.
window.addEventListener('message', (e) => {
  if (!e.data || e.data.type !== 'wms-sync-logiwa') return;

  chrome.tabs.query({ url: 'https://wms.golocad.com/*' }, (tabs) => {
    if (!tabs || !tabs.length) {
      frame.contentWindow.postMessage({
        type: 'wms-sync-result', ok: false,
        error: 'WMS tab not found — open wms.golocad.com first.'
      }, '*');
      return;
    }

    chrome.tabs.sendMessage(tabs[0].id, { action: 'syncLogiwa' }, (resp) => {
      const err = chrome.runtime.lastError;
      if (err) {
        frame.contentWindow.postMessage({
          type: 'wms-sync-result', ok: false,
          error: 'Reload the wms.golocad.com tab and try again'
        }, '*');
      }
      // resp.ok === 'started' means content script acknowledged — result comes via onMessage below
    });
  });
});

// Step 2: receive the async result from content script and forward to iframe
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.action !== 'syncLogiwaResult') return;
  frame.contentWindow.postMessage({ type: 'wms-sync-result', ...msg }, '*');
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
