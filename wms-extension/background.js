// Background service worker

// Open side panel when the extension toolbar icon is clicked
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch(err => console.error('sidePanel.setPanelBehavior:', err));

chrome.runtime.onMessage.addListener((msg, sender) => {

  if (msg.action === 'openSidePanel' && msg.url && sender.tab) {
    const url   = msg.url;
    const tabId = sender.tab.id;

    // Ping the side panel to find out if it is already open.
    // If it responds → was open → navigate only, don't close after submit.
    // If no response → was closed → open it and close it after submit.
    chrome.runtime.sendMessage({ action: 'ping' }, (response) => {
      const panelWasOpen = !chrome.runtime.lastError && !!response;

      chrome.storage.session.set({
        pendingScan:      url,
        autoOpenedPanel:  !panelWasOpen   // true = we opened it, close after submit
      });

      chrome.sidePanel.open({ tabId });

      if (panelWasOpen) {
        // Panel already open — tell it to load the new scan directly
        chrome.runtime.sendMessage({ action: 'loadScan', url }).catch(() => {});
      }
    });
    return; // keep listener channel open for async response
  }

  // Open a new tab (fallback)
  if (msg.action === 'openTab' && msg.url) {
    chrome.tabs.create({ url: msg.url, active: true });
  }

  // Close a tab after form submission (standalone-tab flow)
  if (msg.action === 'closeTab' && sender.tab) {
    chrome.tabs.remove(sender.tab.id);
  }
});
