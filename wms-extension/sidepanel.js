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

// ── Bridge: iframe "Sync Logiwa" → background service worker ────────────────
// Background service worker bypasses CORS for host_permissions URLs reliably.
// Sidepanel just relays the trigger and forwards the result back to the iframe.
window.addEventListener('message', (e) => {
  if (!e.data || e.data.type !== 'wms-sync-logiwa') return;
  chrome.runtime.sendMessage({ action: 'triggerLogiwaSync' }, () => {
    void chrome.runtime.lastError; // background handles everything async
  });
});

// Forward the async result from background → iframe
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
