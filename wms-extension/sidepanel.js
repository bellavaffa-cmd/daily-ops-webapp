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
chrome.storage.session.get('pendingScan', (result) => {
  if (result.pendingScan) {
    frame.src = result.pendingScan;
    chrome.storage.session.remove('pendingScan');
  }
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
