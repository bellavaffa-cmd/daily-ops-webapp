// Runs on the Daily Ops webapp — handles the "close after submit" signal.
//
// Two scenarios:
//  1. Loaded inside the WMS page overlay (iframe)  → tell the parent frame to
//     remove the overlay via postMessage.
//  2. Loaded as a standalone tab (opened by the old flow or direct link) →
//     ask the background service worker to close the tab.

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
