// Background service worker

// Open side panel when the extension toolbar icon is clicked
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch(err => console.error('sidePanel.setPanelBehavior:', err));

chrome.runtime.onMessage.addListener((msg, sender) => {
  // Open side panel with a pre-filled scan URL
  if (msg.action === 'openSidePanel' && msg.url && sender.tab) {
    // Store URL so sidepanel.html can read it on load
    chrome.storage.session.set({ pendingScan: msg.url });
    chrome.sidePanel.open({ tabId: sender.tab.id });
    // Also notify if the side panel is already open
    chrome.runtime.sendMessage({ action: 'loadScan', url: msg.url })
      .catch(() => {}); // ignore error if side panel isn't listening yet
  }

  // Open a new tab (kept for fallback)
  if (msg.action === 'openTab' && msg.url) {
    chrome.tabs.create({ url: msg.url, active: true });
  }

  // Close a tab after form submission (standalone-tab flow)
  if (msg.action === 'closeTab' && sender.tab) {
    chrome.tabs.remove(sender.tab.id);
  }
});
