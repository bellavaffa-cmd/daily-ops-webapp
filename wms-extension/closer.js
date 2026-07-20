// Runs on the Daily Ops webapp when opened by the WMS extension.
// Listens for a close request from the page and relays it to the
// background service worker, which can call chrome.tabs.remove().
window.addEventListener('message', (e) => {
  if (e.data && e.data.type === 'wms-ext-close') {
    chrome.runtime.sendMessage({ action: 'closeTab' });
  }
});
