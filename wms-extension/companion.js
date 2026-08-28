// Content script on wms.companion.golocad.com (LOCAD Ops).
// Reads the app's Cognito access token (localStorage.tokens.access) and (a) pushes
// it to the background on load so attendance can sync tab-free until it expires
// (~24h), and (b) relays it on request. Only reads the token; sends it only to the
// extension's own background, never elsewhere.
(function () {
  function accessToken() { try { return (JSON.parse(localStorage.getItem('tokens')) || {}).access || null; } catch (e) { return null; } }
  function jwtExp(t) { try { return JSON.parse(atob(t.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).exp || 0; } catch (e) { return 0; } }
  function push() {
    const t = accessToken();
    if (t) { try { chrome.runtime.sendMessage({ action: 'storeCompanionToken', token: t, exp: jwtExp(t) }, () => { void chrome.runtime.lastError; }); } catch (e) {} }
  }
  push();
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg && msg.action === 'getCompanionToken') { sendResponse({ token: accessToken() }); return false; }
  });
})();
