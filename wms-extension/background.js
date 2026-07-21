// Background service worker

// Open side panel when the extension toolbar icon is clicked
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch(err => console.error('sidePanel.setPanelBehavior:', err));

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {

  if (msg.action === 'openSidePanel' && msg.url && sender.tab) {
    const url   = msg.url;
    const tabId = sender.tab.id;

    // Open the panel immediately while user gesture is still active
    chrome.sidePanel.open({ tabId }, () => {
      if (chrome.runtime.lastError) {
        console.error('[WMS] sidePanel.open failed:', chrome.runtime.lastError.message);
      }
    });

    // Ping to check if panel was already open before we opened it,
    // then store the scan URL so the panel can read it on load.
    chrome.runtime.sendMessage({ action: 'ping' }, (pingResp) => {
      const panelWasOpen = !chrome.runtime.lastError && !!pingResp;

      chrome.storage.session.set({
        pendingScan:     url,
        autoOpenedPanel: !panelWasOpen
      });

      if (panelWasOpen) {
        // Panel was already showing — tell it to navigate to the scan
        chrome.runtime.sendMessage({ action: 'loadScan', url }, () => {
          void chrome.runtime.lastError;
        });
      }
    });

    sendResponse({ ok: true });
    return false; // sendResponse already called synchronously
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
