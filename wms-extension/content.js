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
          // "port closed" = background handled it but didn't send a response — harmless
          if (/port closed/i.test(msg)) return;
          console.warn('[WMS ext] sendMessage failed:', msg);
          setBtnError('Reload page & retry');
        }
      });
    } catch (e) {
      console.warn('[WMS ext] openInSidePanel error:', e);
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
