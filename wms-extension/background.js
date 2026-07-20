// Background service worker — opens the Daily Ops app in a new tab.
// Content script sends messages here so we can call chrome.tabs.create
// even without a direct user gesture (needed for auto-trigger on error).

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.action === 'openTab' && msg.url) {
    chrome.tabs.create({ url: msg.url, active: true });
  }
});
