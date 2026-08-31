// Runs on the Daily Ops webapp — handles the "close after submit" signal.
//
// Two scenarios:
//  1. Loaded inside the WMS page overlay (iframe)  → tell the parent frame to
//     remove the overlay via postMessage.
//  2. Loaded as a standalone tab (opened by the old flow or direct link) →
//     ask the background service worker to close the tab.

// Announce the extension (and its version) to the webapp so it can detect that
// the extension is installed. The app also pings (wms-ext-ping) in case it
// started listening after this fired.
try {
  const _extV = (chrome.runtime.getManifest && chrome.runtime.getManifest().version) || '';
  window.postMessage({ type: 'wms-ext-hello', version: _extV }, '*');
} catch (e) {}

// Provide a stable per-device id to the webapp. This content script runs in
// every Daily Ops frame — the side-panel iframe AND normal tabs — which have
// SEPARATE (partitioned) localStorage, so the page can't share an id between
// them on its own. chrome.storage.local IS shared across the extension on this
// browser profile, so we mint the id here and postMessage it into the page,
// letting the dashboard scope its saved layout per device (not globally).
try {
  chrome.storage.local.get(['wmsUser', 'wmsUserLabel', 'dashDeviceId', 'wmsWarehouses'], (res) => {
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
    // Hand the app the warehouses this account can access (captured on WMS by
    // content.js) so it can lock the dashboard to the user's warehouses. Only
    // meaningful for the WMS identity.
    if (res && Array.isArray(res.wmsWarehouses) && id === res.wmsUser) msg.warehouses = res.wmsWarehouses;
    window.postMessage(msg, '*');
  });
} catch (e) { /* storage unavailable — app falls back to a local id */ }

window.addEventListener('message', (e) => {
  if (!e.data) return;

  // Dashboard asks whether the extension is installed → reply with our version.
  if (e.data.type === 'wms-ext-ping') {
    try { window.postMessage({ type: 'wms-ext-hello', version: (chrome.runtime.getManifest && chrome.runtime.getManifest().version) || '' }, '*'); } catch (err) {}
    return;
  }

  // Dashboard asks: is a logged-in WMS tab currently open (and who)? Relay to the
  // background service worker, which polls the open wms.golocad.com tabs, and hand
  // the answer back to the page. This gates "Sign in with WMS" on a live login.
  if (e.data.type === 'wms-live-check-request') {
    try {
      chrome.runtime.sendMessage({ action: 'wmsLiveCheck' }, (resp) => {
        const ok = !chrome.runtime.lastError && resp && resp.id;
        window.postMessage({
          type: 'wms-live-check-result',
          id: ok ? resp.id : null,
          label: ok ? (resp.label || null) : null,
          warehouses: ok ? (resp.warehouses || null) : null
        }, '*');
      });
    } catch (err) {
      window.postMessage({ type: 'wms-live-check-result', id: null }, '*');
    }
    return;
  }

  // Dashboard asks to sync attendance now → relay to the background worker (which
  // reads the LOCAD Ops token and pulls attendance), then hand the result back.
  if (e.data.type === 'wms-sync-attendance') {
    try {
      chrome.runtime.sendMessage({ action: 'syncAttendance' }, (resp) => {
        const ok = !chrome.runtime.lastError && resp && resp.ok;
        window.postMessage({ type: 'wms-sync-attendance-result', ok: !!ok, error: (resp && resp.error) || (chrome.runtime.lastError && chrome.runtime.lastError.message) || null }, '*');
      });
    } catch (err) { window.postMessage({ type: 'wms-sync-attendance-result', ok: false, error: String(err) }, '*'); }
    return;
  }

  // Dashboard asks to sync inbound POs now → relay to the background worker.
  if (e.data.type === 'wms-sync-inbound') {
    try {
      chrome.runtime.sendMessage({ action: 'syncInbound' }, (resp) => {
        const ok = !chrome.runtime.lastError && resp && resp.ok;
        window.postMessage({ type: 'wms-sync-inbound-result', ok: !!ok, error: (resp && resp.error) || (chrome.runtime.lastError && chrome.runtime.lastError.message) || null }, '*');
      });
    } catch (err) { window.postMessage({ type: 'wms-sync-inbound-result', ok: false, error: String(err) }, '*'); }
    return;
  }

  if (e.data.type !== 'wms-ext-close') return;
  if (window.parent !== window) {
    // We're inside an iframe — signal the WMS page to close the overlay
    window.parent.postMessage({ type: 'wms-close-overlay' }, '*');
  } else {
    // Standalone tab — close via background
    chrome.runtime.sendMessage({ action: 'closeTab' });
  }
});
