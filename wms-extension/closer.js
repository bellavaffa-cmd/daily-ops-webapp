// Runs on the Daily Ops webapp — handles the "close after submit" signal.
//
// Two scenarios:
//  1. Loaded inside the WMS page overlay (iframe)  → tell the parent frame to
//     remove the overlay via postMessage.
//  2. Loaded as a standalone tab (opened by the old flow or direct link) →
//     ask the background service worker to close the tab.

// Provide a stable per-device id to the webapp. This content script runs in
// every Daily Ops frame — the side-panel iframe AND normal tabs — which have
// SEPARATE (partitioned) localStorage, so the page can't share an id between
// them on its own. chrome.storage.local IS shared across the extension on this
// browser profile, so we mint the id here and postMessage it into the page,
// letting the dashboard scope its saved layout per device (not globally).
try {
  chrome.storage.local.get(['wmsUser', 'wmsUserLabel', 'dashDeviceId'], (res) => {
    // Prefer the WMS-login identity (captured on wms.golocad.com by content.js)
    // so the layout follows the PERSON across computers. Fall back to a stable
    // per-device id when the user hasn't been on WMS yet in this browser.
    let id = res && res.wmsUser;
    if (!id) {
      id = res && res.dashDeviceId;
      if (!id) {
        id = 'dev-' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
        chrome.storage.local.set({ dashDeviceId: id });
      }
    }
    const msg = { type: 'dash-device-id', id: id };
    // Attach the readable display name only for the WMS identity (labels the row).
    if (res && res.wmsUserLabel && id === res.wmsUser) msg.label = res.wmsUserLabel;
    window.postMessage(msg, '*');
  });
} catch (e) { /* storage unavailable — app falls back to a local id */ }

window.addEventListener('message', (e) => {
  if (!e.data || e.data.type !== 'wms-ext-close') return;

  if (window.parent !== window) {
    // We're inside an iframe — signal the WMS page to close the overlay
    window.parent.postMessage({ type: 'wms-close-overlay' }, '*');
  } else {
    // Standalone tab — close via background
    chrome.runtime.sendMessage({ action: 'closeTab' });
  }
});
