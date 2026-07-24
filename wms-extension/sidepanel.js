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
// Sidepanel relays the trigger and forwards the result back to the iframe via
// two paths: runtime.sendMessage (fast) and storage.onChanged (fallback).
//
// Generic relay so both the B2C and B2B "Sync Logiwa" buttons share one
// implementation — config: { msgType, bgAction, storageKey, resultMsgType, resultBgAction }
function setupSyncRelay({ msgType, bgAction, storageKey, resultMsgType, resultBgAction }) {
  let pendingSince = 0;

  window.addEventListener('message', (e) => {
    if (!e.data || e.data.type !== msgType) return;
    pendingSince = Date.now();
    // Clear any stale result from a previous sync so storage fallback fires fresh
    chrome.storage.session.remove(storageKey);
    chrome.runtime.sendMessage({ action: bgAction }, () => {
      void chrome.runtime.lastError;
    });
  });

  // Fast path: runtime message from background
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.action !== resultBgAction) return;
    pendingSince = 0;
    frame.contentWindow.postMessage({ type: resultMsgType, ...msg }, '*');
  });

  // Fallback path: background writes to session storage → sidepanel picks it up
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'session' || !changes[storageKey]) return;
    const result = changes[storageKey].newValue;
    if (!result || !pendingSince) return;   // no sync in progress
    if (result.ts < pendingSince) return;   // stale result from a previous sync
    pendingSince = 0;
    frame.contentWindow.postMessage({ type: resultMsgType, ...result }, '*');
  });
}

setupSyncRelay({
  msgType:        'wms-sync-logiwa',
  bgAction:       'triggerLogiwaSync',
  storageKey:     'logiwaSync',
  resultMsgType:  'wms-sync-result',
  resultBgAction: 'syncLogiwaResult',
});

setupSyncRelay({
  msgType:        'wms-sync-b2b-logiwa',
  bgAction:       'triggerLogiwaB2BSync',
  storageKey:     'logiwaB2BSync',
  resultMsgType:  'wms-sync-b2b-result',
  resultBgAction: 'syncLogiwaB2BResult',
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
