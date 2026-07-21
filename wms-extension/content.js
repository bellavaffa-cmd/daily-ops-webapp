(function () {
  'use strict';

  const APP_URL = 'https://bellavaffa-cmd.github.io/daily-ops-webapp/';
  const PULSE_STYLE_ID = 'wms-ext-pulse-style';

  let floatingBtn = null;
  let errorAutoTriggered = false;

  // ─── DOM helpers ────────────────────────────────────────────────────────────

  function q(sel) { return document.querySelector(sel); }
  function txt(el) { return el ? el.textContent.trim() : ''; }

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

    // WMS error notification
    let wmsError = '';
    const errEl =
      q('.notification-container.error') ||
      q('platform-page-alert .notification-container');
    if (errEl) {
      wmsError = errEl.textContent.trim().replace(/^Error/, '').trim();
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
    chrome.runtime.sendMessage({ action: 'openSidePanel', url });
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
      #wms-report-fab { all: unset; }
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
    ensurePulseStyle();

    const wrap = document.createElement('div');
    wrap.id = 'wms-report-fab';
    wrap.innerHTML = `
      <button>
        <svg width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.2"
             viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
          <path d="M12 9v4m0 4h.01M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94
                   a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
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

    const errEl =
      q('.notification-container.error') ||
      q('platform-page-alert .notification-container');
    const hasError = !!errEl;
    // Auto-trigger only when notification text contains "error returned from carrier"
    const isCarrierError = hasError &&
      /error returned from carrier/i.test(errEl.textContent || '');

    if (hasOrder) {
      createFloatingBtn();
    } else {
      removeFloatingBtn();
      errorAutoTriggered = false;
    }

    // AUTO-TRIGGER: carrier error → open side panel with pre-filled form
    if (hasOrder && isCarrierError && !errorAutoTriggered) {
      errorAutoTriggered = true;
      pulseBtn();
      setTimeout(() => {
        const data = extractData();
        if (data.wmsError) openInSidePanel(data);
      }, 600);
    }

    if (!hasError) errorAutoTriggered = false;
  }

  // ─── Boot ────────────────────────────────────────────────────────────────────

  checkState();

  new MutationObserver(checkState).observe(document.body, {
    childList: true,
    subtree: true,
    attributes: false,
    characterData: false
  });

})();
