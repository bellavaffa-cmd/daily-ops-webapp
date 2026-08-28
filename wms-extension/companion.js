// Content script on wms.companion.golocad.com (LOCAD Ops).
// Relays the app's Cognito access token (localStorage.tokens.access) to the
// background service worker so it can pull attendance from the dashboard API
// and sync it to Supabase. Only reads the token; never sends it anywhere else.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.action === 'getCompanionToken') {
    let access = null;
    try { access = (JSON.parse(localStorage.getItem('tokens')) || {}).access || null; } catch (e) {}
    sendResponse({ token: access });
    return false;
  }
});
