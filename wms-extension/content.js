(function () {
  'use strict';

  const APP_URL = 'https://bellavaffa-cmd.github.io/daily-ops-webapp/';
  const PULSE_STYLE_ID = 'wms-ext-pulse-style';

  let floatingBtn = null;
  let errorAutoTriggered = false;

  // ─── DOM helpers ────────────────────────────────────────────────────────────

  function q(sel) { return document.querySelector(sel); }
  function txt(el) { return el ? el.textContent.trim() : ''; }

  // ─── Find carrier-error element (flexible — tries multiple selectors) ────────

  function findCarrierErrorEl() {
    // Priority: specific selectors that are known to work
    const specific = [
      '.notification-container.error',
      'platform-page-alert .notification-container',
      'platform-page-alert',
      '[role="alert"]',
      '.notification-container',
    ];
    for (const sel of specific) {
      const el = q(sel);
      if (el && /error returned from carrier/i.test(el.textContent || '')) return el;
    }
    // Fallback: scan ALL notification / alert-like elements on page
    const candidates = document.querySelectorAll(
      '[class*="notification"], [class*="alert"], [class*="toast"], [role="alert"]'
    );
    for (const el of candidates) {
      if (/error returned from carrier/i.test(el.textContent || '')) return el;
    }
    return null;
  }

  // ─── Data extraction (mirrors bookmarklet logic) ─────────────────────────────

  function extractData() {
    const orderEl = q('.packing-station-board-order-text-description');
    const toteEl  = q('#searchInputIdentifier');
    const whEl    = q('.packing-station-job-type-text-description');

    const orderId       = txt(orderEl);
    const toteNum       = toteEl ? (toteEl.value || '').trim() : '';
    const warehouseHint = txt(whEl);

    // Brand — first [Bracketed] segment in "Packing Instructions" note
    let brand = '';
    const noteTitles = Array.from(
      document.querySelectorAll('.packing-station-board-order-note-text-title')
    );
    for (const noteEl of noteTitles) {
      const spans = Array.from(noteEl.querySelectorAll('span'));
      const label = spans[0] ? spans[0].textContent.trim() : '';
      if (label.startsWith('Packing Instructions')) {
        const val = spans[1] ? spans[1].textContent.trim() : '';
        const m   = val.match(/^\[([^\]]+)\]/);
        if (m) brand = m[1].trim();
        break;
      }
    }

    // WMS error notification (flexible selectors)
    let wmsError = '';
    const errEl = findCarrierErrorEl() ||
      q('.notification-container.error') ||
      q('platform-page-alert .notification-container');
    if (errEl) {
      wmsError = errEl.textContent.trim().replace(/^Error[:\s]*/i, '').trim();
    }

    // SKUs
    const productEls = document.querySelectorAll(
      '.packing-station-product-information-container'
    );
    const skus = Array.from(productEls).map(el => {
      const sku   = txt(el.querySelector('.packing-station-product-information-sub-title'));
      const spans = Array.from(el.querySelectorAll('span'));
      let packType = '';
      for (let i = 0; i < spans.length; i++) {
        if (spans[i].textContent.trim() === 'Pack Type :') {
          packType = spans[i + 1] ? spans[i + 1].textContent.trim() : '';
          break;
        }
      }
      const qtyM = el.textContent.match(/(\d+)\s*\/\s*(\d+)/);
      return { sku, qty: qtyM ? qtyM[2] : '', packType };
    }).filter(s => s.sku);

    return { orderId, toteNum, warehouseHint, brand, wmsError, skus };
  }

  // ─── Open report form in side panel ──────────────────────────────────────────

  function openInSidePanel(data) {
    const b64 = btoa(unescape(encodeURIComponent(JSON.stringify(data))));
    const url = APP_URL + '?wmsScan=' + encodeURIComponent(b64) + '&ext=1';
    try {
      chrome.runtime.sendMessage({ action: 'openSidePanel', url }, () => {
        if (chrome.runtime.lastError) {
          const msg = chrome.runtime.lastError.message || '';
          if (/port closed/i.test(msg)) return;
          console.warn('[WMS ext] sendMessage failed:', msg);
          setBtnError('Reload page & retry');
        }
      });
    } catch (e) {
      console.error('[WMS ext] sendMessage threw:', e.message);
      setBtnError('Reload page & retry');
    }
  }

  function setBtnError(msg) {
    if (!floatingBtn) return;
    const btn = floatingBtn.querySelector('button');
    const orig = btn.innerHTML;
    btn.style.background = '#b91c1c';
    btn.innerHTML = msg;
    setTimeout(() => { btn.innerHTML = orig; btn.style.background = ''; }, 3000);
  }

  // ─── Floating button ─────────────────────────────────────────────────────────

  function ensurePulseStyle() {
    if (document.getElementById(PULSE_STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = PULSE_STYLE_ID;
    style.textContent = `
      @keyframes wms-pulse {
        0%, 100% { transform: scale(1); box-shadow: 0 4px 14px rgba(220,38,38,.45); }
        50%       { transform: scale(1.12); box-shadow: 0 6px 20px rgba(220,38,38,.7); }
      }
      #wms-report-fab { all: unset; display: block !important; }
      #wms-report-fab button {
        position: fixed !important;
        bottom: 24px !important;
        right: 24px !important;
        z-index: 2147483647 !important;
        background: #dc2626 !important;
        color: #fff !important;
        border: none !important;
        border-radius: 50px !important;
        padding: 10px 18px !important;
        font-size: 14px !important;
        font-weight: 600 !important;
        cursor: pointer !important;
        pointer-events: auto !important;
        box-shadow: 0 4px 14px rgba(220,38,38,.45) !important;
        display: flex !important;
        align-items: center !important;
        gap: 8px !important;
        font-family: -apple-system, 'Segoe UI', sans-serif !important;
        transition: transform .15s, box-shadow .15s !important;
        line-height: 1 !important;
      }
      #wms-report-fab button:hover {
        transform: scale(1.05) !important;
        box-shadow: 0 6px 18px rgba(220,38,38,.6) !important;
      }
      #wms-report-fab button.pulsing {
        animation: wms-pulse .5s ease 3 !important;
      }
    `;
    document.head.appendChild(style);
  }

  function createFloatingBtn() {
    if (floatingBtn) return;
    // Remove any stale FAB left by a previous content script injection
    const stale = document.getElementById('wms-report-fab');
    if (stale) stale.remove();
    ensurePulseStyle();

    const wrap = document.createElement('div');
    wrap.id = 'wms-report-fab';
    wrap.innerHTML = `
      <button>
        <svg width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.5"
             viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" stroke-linecap="round">
          <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
        </svg>
        Report Error
      </button>
    `;

    wrap.querySelector('button').addEventListener('click', () => {
      const data = extractData();
      if (!data.orderId && !data.toteNum) {
        alert('WMS extension: no order loaded on this packing station.');
        return;
      }
      // Brief visual feedback so user knows click registered
      const btn = wrap.querySelector('button');
      const orig = btn.innerHTML;
      btn.innerHTML = 'Opening…';
      btn.disabled = true;
      setTimeout(() => { btn.innerHTML = orig; btn.disabled = false; }, 2000);
      openInSidePanel(data);
    });

    document.body.appendChild(wrap);
    floatingBtn = wrap;
  }

  function removeFloatingBtn() {
    if (floatingBtn) { floatingBtn.remove(); floatingBtn = null; }
  }

  function pulseBtn() {
    if (!floatingBtn) return;
    const btn = floatingBtn.querySelector('button');
    btn.classList.remove('pulsing');
    void btn.offsetWidth;
    btn.classList.add('pulsing');
    btn.addEventListener('animationend', () => btn.classList.remove('pulsing'), { once: true });
  }

  // ─── State check (called on every DOM mutation) ───────────────────────────────

  function checkState() {
    const orderEl = q('.packing-station-board-order-text-description');
    const toteEl  = q('#searchInputIdentifier');
    const orderId = txt(orderEl);
    const toteNum = toteEl ? (toteEl.value || '').trim() : '';
    const hasOrder = !!(orderId || toteNum);

    // Flexible carrier-error detection
    const carrierErrEl = findCarrierErrorEl();
    const isCarrierError = !!carrierErrEl;

    if (hasOrder) {
      createFloatingBtn();
    } else {
      removeFloatingBtn();
      errorAutoTriggered = false;
    }

    // AUTO-TRIGGER: capture data immediately (before notification may disappear),
    // then open side panel after brief delay so the panel has time to initialise.
    if (hasOrder && isCarrierError && !errorAutoTriggered) {
      errorAutoTriggered = true;
      pulseBtn();
      const capturedData = extractData(); // capture NOW while notification is visible
      setTimeout(() => openInSidePanel(capturedData), 600);
    }

    if (!isCarrierError) errorAutoTriggered = false;
  }

  // ─── Boot ────────────────────────────────────────────────────────────────────

  checkState();

  new MutationObserver(checkState).observe(document.body, {
    childList: true,
    subtree: true,
    attributes: false,
    characterData: false,
  });

})();

// ── Logiwa token getter — sidepanel does the actual API fetch (bypasses CORS) ──
// Content script only reads localStorage; sidepanel.js handles Logiwa + Supabase calls.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action !== 'getLogiwaToken') return;
  sendResponse({ token: localStorage.getItem('token') || null });
  return false;
});

// ── Capture the logged-in WMS user ────────────────────────────────────────────
// So the dashboard can scope its saved layout to the PERSON (follows them across
// computers) instead of the device. The Logiwa auth token in localStorage is a
// JWT whose payload identifies the user (idtfr = user GUID, id = user id). We
// store a stable id in chrome.storage.local — shared across the extension — for
// closer.js to hand to the dashboard app.
(function captureWmsUser(tries) {
  function decodePayload(tok) {
    try {
      const seg = tok.split('.')[1];
      if (!seg) return null;
      let b64 = seg.replace(/-/g, '+').replace(/_/g, '/');
      if (b64.length % 4) b64 += '='.repeat(4 - (b64.length % 4));
      return JSON.parse(atob(b64));
    } catch (e) { return null; }
  }
  // Readable identity lives in the Userpilot user object (customer.name/email).
  // The key has an app-specific numeric suffix, so match by prefix.
  function readCustomer() {
    try {
      const key = Object.keys(localStorage).find(function (k) { return k.indexOf('userpilotUser') === 0; });
      if (!key) return {};
      const c = (JSON.parse(localStorage.getItem(key)) || {}).customer || {};
      return { name: c.name ? String(c.name).trim() : '', email: c.email ? String(c.email).trim() : '' };
    } catch (e) { return {}; }
  }
  // Read the CURRENT logged-in WMS identity straight from the live auth token.
  // A valid, unexpired token in this tab's localStorage IS proof of a live login;
  // no token (or expired) → not logged in. This backs the dashboard's requirement
  // that "Sign in with WMS" only works with a logged-in WMS tab actually open.
  function liveWmsIdentity() {
    try {
      const tok = localStorage.getItem('token');
      if (!tok) return null;
      const p = decodePayload(tok);
      if (!p) return null;
      if (p.exp && (Date.now() / 1000) >= Number(p.exp)) return null;   // expired session
      const uid = p.idtfr || p.id;
      if (!uid) return null;
      const cust = readCustomer();
      return { id: 'wms:' + uid, label: (cust && cust.name) || null };
    } catch (e) { return null; }
  }
  // The dashboard (via background) asks "is a logged-in WMS tab open, and who?"
  chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (!msg || msg.action !== 'wmsIdentity') return;
    const idn = liveWmsIdentity();
    if (!idn) { sendResponse({ id: null }); return false; }
    chrome.storage.local.get(['wmsWarehouses'], function (res) {
      sendResponse({ id: idn.id, label: idn.label, warehouses: (res && res.wmsWarehouses) || null });
    });
    return true;   // async sendResponse
  });
  // Capture the warehouses this account can access. Logiwa scopes this list to
  // the user's permissions, so it IS the user's warehouse access. Same host +
  // token as the sync; the WMS page origin is allowed by the API's CORS. We
  // stash the codes in chrome.storage.local (for closer.js → the app) and upsert
  // the full {code,id} set to wms_users so the Manager Console can see it too.
  function captureWarehouses(uid) {
    try {
      fetch('https://mywmsquery.logiwa.com/api/warehouse/list/i/0/s/1000', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + (localStorage.getItem('token') || '') },
        body: '{}'
      }).then(function (r) { return r.ok ? r.json() : null; }).then(function (d) {
        var arr = (d && d.data) || d || [];
        if (!Array.isArray(arr) || !arr.length) return;
        var whs = arr.map(function (w) { return { code: w.code, id: w.warehouseIdentifier }; }).filter(function (w) { return w.code; });
        if (!whs.length) return;
        chrome.storage.local.set({ wmsWarehouses: whs.map(function (w) { return w.code; }) });
        fetch('https://hmpkjmnxoidesnnoecfm.supabase.co/rest/v1/wms_users?on_conflict=user_id', {
          method: 'POST',
          headers: { apikey: 'sb_publishable_00pJSeJ3cKuxqwelQbaKWg_uJe7XPtP', Authorization: 'Bearer sb_publishable_00pJSeJ3cKuxqwelQbaKWg_uJe7XPtP', 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' },
          body: JSON.stringify([{ user_id: uid, warehouses: whs, warehouses_updated_at: new Date().toISOString() }])
        }).catch(function () {});
      }).catch(function () {});
    } catch (e) { /* ignore */ }
  }
  try {
    const tok = localStorage.getItem('token');
    const p = tok && decodePayload(tok);
    const uid = p && (p.idtfr || p.id);
    const cust = readCustomer();
    const upd = {};
    if (uid)       upd.wmsUser = 'wms:' + uid;
    if (cust.name) upd.wmsUserLabel = cust.name;
    if (cust.email) upd.wmsUserEmail = cust.email;
    // Persist the Logiwa session token (a JWT, valid ~30 days) so the app can sign
    // in and the extension can sync WITHOUT a WMS tab staying open — until it expires.
    if (tok) { upd.wmsToken = tok; if (p && p.exp) upd.wmsTokenExp = Number(p.exp); }
    if (Object.keys(upd).length) chrome.storage.local.set(upd);
    if (uid) captureWarehouses(uid);
    if (uid && cust.name) {
      // Register this user in the Manager Console directory (wms_users) so admins
      // can assign roles by name instead of pasting an id. Fire-and-forget.
      try {
        fetch('https://hmpkjmnxoidesnnoecfm.supabase.co/rest/v1/wms_users?on_conflict=user_id', {
          method: 'POST',
          headers: { apikey: 'sb_publishable_00pJSeJ3cKuxqwelQbaKWg_uJe7XPtP', Authorization: 'Bearer sb_publishable_00pJSeJ3cKuxqwelQbaKWg_uJe7XPtP', 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' },
          body: JSON.stringify([{ user_id: uid, name: cust.name, email: cust.email || null, updated_at: new Date().toISOString() }])
        }).catch(function () {});
      } catch (e) {}
      try { chrome.runtime.sendMessage({ action: 'syncRoles' }, function () { void chrome.runtime.lastError; }); } catch (e) {}   // WMS → dashboard role sync (runs in background, throttled)
      return;                                // captured + registered — done
    }
  } catch (e) { /* ignore */ }
  // Token / userpilot object may land just after login — retry a few times.
  if (tries > 0) setTimeout(function () { captureWmsUser(tries - 1); }, 1000);
})(5);
