/* @ds-bundle: {"format":4,"namespace":"FortyMMDesignSystem_f2d51f","components":[],"sourceHashes":{"slides/deck-stage.js":"522102a1c71e","ui_kits/android/screens.jsx":"14fa8005fdf9","ui_kits/components/kit.js":"f6e54d5f90d9","ui_kits/components/match.js":"1e4437e3e85d","ui_kits/ios/screens.jsx":"6a65af75fe9f","ui_kits/marketing/components.jsx":"a8e8032606ad","ui_kits/spectator/components.jsx":"ad7b8c6b89bd","ui_kits/web_admin/components.jsx":"87a6da773737"},"inlinedExternals":[],"unexposedExports":[]} */

(() => {

const __ds_ns = (window.FortyMMDesignSystem_f2d51f = window.FortyMMDesignSystem_f2d51f || {});

const __ds_scope = {};

(__ds_ns.__errors = __ds_ns.__errors || []);

// slides/deck-stage.js
try { (() => {
/**
 * <deck-stage> — reusable web component for HTML decks.
 *
 * Handles:
 *  (a) speaker notes — reads <script type="application/json" id="speaker-notes">
 *      and posts {slideIndexChanged: N} to the parent window on nav.
 *  (b) keyboard navigation — ←/→, PgUp/PgDn, Space, Home/End, number keys.
 *  (c) press R to reset to slide 0 (with a tasteful keyboard hint).
 *  (d) bottom-center overlay showing slide count + hints, fades out on idle.
 *  (e) auto-scaling — inner canvas is a fixed design size (default 1920×1080)
 *      scaled with `transform: scale()` to fit the viewport, letterboxed.
 *      Set the `noscale` attribute to render at authored size (1:1) — the
 *      PPTX exporter sets this so its DOM capture sees unscaled geometry.
 *  (f) print — `@media print` lays every slide out as its own page at the
 *      design size, so the browser's Print → Save as PDF produces a clean
 *      one-page-per-slide PDF with no extra setup.
 *
 * Slides are HIDDEN, not unmounted. Non-active slides stay in the DOM with
 * `visibility: hidden` + `opacity: 0`, so their state (videos, iframes,
 * form inputs, React trees) is preserved across navigation.
 *
 * Lifecycle event — the component dispatches a `slidechange` CustomEvent on
 * itself whenever the active slide changes (including the initial mount).
 * The event bubbles and composes out of shadow DOM, so you can listen on
 * the <deck-stage> element or on document:
 *
 *   document.querySelector('deck-stage').addEventListener('slidechange', (e) => {
 *     e.detail.index         // new 0-based index
 *     e.detail.previousIndex // previous index, or -1 on init
 *     e.detail.total         // total slide count
 *     e.detail.slide         // the new active slide element
 *     e.detail.previousSlide // the prior slide element, or null on init
 *     e.detail.reason        // 'init' | 'keyboard' | 'click' | 'tap' | 'api'
 *   });
 *
 * Persistence: current slide index is saved to localStorage keyed by the
 * document path, so refresh returns you to the same place.
 *
 * Usage:
 *   <deck-stage width="1920" height="1080">
 *     <section data-label="Title">...</section>
 *     <section data-label="Agenda">...</section>
 *   </deck-stage>
 *
 * Slides are the direct element children of <deck-stage>. Each slide is
 * automatically tagged with:
 *   - data-screen-label="NN Label"   (1-indexed, for comment flow)
 *   - data-om-validate="no_overflowing_text,no_overlapping_text,slide_sized_text"
 */

(() => {
  const DESIGN_W_DEFAULT = 1920;
  const DESIGN_H_DEFAULT = 1080;
  const STORAGE_PREFIX = 'deck-stage:slide:';
  const OVERLAY_HIDE_MS = 1800;
  const VALIDATE_ATTR = 'no_overflowing_text,no_overlapping_text,slide_sized_text';
  const pad2 = n => String(n).padStart(2, '0');
  const stylesheet = `
    :host {
      position: fixed;
      inset: 0;
      display: block;
      background: #000;
      color: #fff;
      font-family: -apple-system, BlinkMacSystemFont, "Helvetica Neue", Helvetica, Arial, sans-serif;
      overflow: hidden;
    }

    .stage {
      position: absolute;
      inset: 0;
      display: flex;
      align-items: center;
      justify-content: center;
    }

    .canvas {
      position: relative;
      transform-origin: center center;
      flex-shrink: 0;
      background: #fff;
      will-change: transform;
    }

    /* Slides live in light DOM (via <slot>) so authored CSS still applies.
       We absolutely position each slotted child to stack them. */
    ::slotted(*) {
      position: absolute !important;
      inset: 0 !important;
      width: 100% !important;
      height: 100% !important;
      box-sizing: border-box !important;
      overflow: hidden;
      opacity: 0;
      pointer-events: none;
      visibility: hidden;
    }
    ::slotted([data-deck-active]) {
      opacity: 1;
      pointer-events: auto;
      visibility: visible;
    }

    /* Tap zones for mobile — back/forward thirds like Stories.
       Transparent, no visible UI, don't block the overlay. */
    .tapzones {
      position: fixed;
      inset: 0;
      display: flex;
      z-index: 2147482000;
      pointer-events: none;
    }
    .tapzone {
      flex: 1;
      pointer-events: auto;
      -webkit-tap-highlight-color: transparent;
    }
    /* Only activate tap zones on coarse pointers (touch devices). */
    @media (hover: hover) and (pointer: fine) {
      .tapzones { display: none; }
    }

    .overlay {
      position: fixed;
      left: 50%;
      bottom: 22px;
      transform: translate(-50%, 6px) scale(0.92);
      filter: blur(6px);
      display: flex;
      align-items: center;
      gap: 4px;
      padding: 4px;
      background: #000;
      color: #fff;
      border-radius: 999px;
      font-size: 12px;
      font-feature-settings: "tnum" 1;
      letter-spacing: 0.01em;
      opacity: 0;
      pointer-events: none;
      transition: opacity 260ms ease, transform 260ms cubic-bezier(.2,.8,.2,1), filter 260ms ease;
      transform-origin: center bottom;
      z-index: 2147483000;
      user-select: none;
    }
    .overlay[data-visible] {
      opacity: 1;
      pointer-events: auto;
      transform: translate(-50%, 0) scale(1);
      filter: blur(0);
    }

    .btn {
      appearance: none;
      -webkit-appearance: none;
      background: transparent;
      border: 0;
      margin: 0;
      padding: 0;
      color: inherit;
      font: inherit;
      cursor: default;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      height: 28px;
      min-width: 28px;
      border-radius: 999px;
      color: rgba(255,255,255,0.72);
      transition: background 140ms ease, color 140ms ease;
      -webkit-tap-highlight-color: transparent;
    }
    .btn:hover { background: rgba(255,255,255,0.12); color: #fff; }
    .btn:active { background: rgba(255,255,255,0.18); }
    .btn:focus { outline: none; }
    .btn:focus-visible { outline: none; }
    .btn::-moz-focus-inner { border: 0; }
    .btn svg { width: 14px; height: 14px; display: block; }
    .btn.reset {
      font-size: 11px;
      font-weight: 500;
      letter-spacing: 0.02em;
      padding: 0 10px 0 12px;
      gap: 6px;
      color: rgba(255,255,255,0.72);
    }
    .btn.reset .kbd {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-width: 16px;
      height: 16px;
      padding: 0 4px;
      font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
      font-size: 10px;
      line-height: 1;
      color: rgba(255,255,255,0.88);
      background: rgba(255,255,255,0.12);
      border-radius: 4px;
    }

    .count {
      font-variant-numeric: tabular-nums;
      color: #fff;
      font-weight: 500;
      padding: 0 8px;
      min-width: 42px;
      text-align: center;
      font-size: 12px;
    }
    .count .sep { color: rgba(255,255,255,0.45); margin: 0 3px; font-weight: 400; }
    .count .total { color: rgba(255,255,255,0.55); }

    .divider {
      width: 1px;
      height: 14px;
      background: rgba(255,255,255,0.18);
      margin: 0 2px;
    }

    /* ── Print: one page per slide, no chrome ────────────────────────────
       The screen layout stacks every slide at inset:0 inside a scaled
       canvas; for print we want them in document flow at the authored
       design size so the browser paginates one slide per sheet. The
       @page size is set from the width/height attributes via the inline
       <style id="deck-stage-print-page"> that connectedCallback injects
       into <head> (the @page at-rule has no effect inside shadow DOM). */
    @media print {
      :host {
        position: static;
        inset: auto;
        background: none;
        overflow: visible;
        color: inherit;
      }
      .stage { position: static; display: block; }
      .canvas {
        transform: none !important;
        width: auto !important;
        height: auto !important;
        background: none;
        will-change: auto;
      }
      ::slotted(*) {
        position: relative !important;
        inset: auto !important;
        width: var(--deck-design-w) !important;
        height: var(--deck-design-h) !important;
        box-sizing: border-box !important;
        opacity: 1 !important;
        visibility: visible !important;
        pointer-events: auto;
        break-after: page;
        page-break-after: always;
        break-inside: avoid;
        overflow: hidden;
      }
      ::slotted(*:last-child) {
        break-after: auto;
        page-break-after: auto;
      }
      .overlay, .tapzones { display: none !important; }
    }
  `;
  class DeckStage extends HTMLElement {
    static get observedAttributes() {
      return ['width', 'height', 'noscale'];
    }
    constructor() {
      super();
      this._root = this.attachShadow({
        mode: 'open'
      });
      this._index = 0;
      this._slides = [];
      this._notes = [];
      this._hideTimer = null;
      this._mouseIdleTimer = null;
      this._storageKey = STORAGE_PREFIX + (location.pathname || '/');
      this._onKey = this._onKey.bind(this);
      this._onResize = this._onResize.bind(this);
      this._onSlotChange = this._onSlotChange.bind(this);
      this._onMouseMove = this._onMouseMove.bind(this);
      this._onTapBack = this._onTapBack.bind(this);
      this._onTapForward = this._onTapForward.bind(this);
    }
    get designWidth() {
      return parseInt(this.getAttribute('width'), 10) || DESIGN_W_DEFAULT;
    }
    get designHeight() {
      return parseInt(this.getAttribute('height'), 10) || DESIGN_H_DEFAULT;
    }
    connectedCallback() {
      this._render();
      this._loadNotes();
      this._syncPrintPageRule();
      window.addEventListener('keydown', this._onKey);
      window.addEventListener('resize', this._onResize);
      window.addEventListener('mousemove', this._onMouseMove, {
        passive: true
      });
      // Initial collection + layout happens via slotchange, which fires on mount.
    }
    disconnectedCallback() {
      window.removeEventListener('keydown', this._onKey);
      window.removeEventListener('resize', this._onResize);
      window.removeEventListener('mousemove', this._onMouseMove);
      if (this._hideTimer) clearTimeout(this._hideTimer);
      if (this._mouseIdleTimer) clearTimeout(this._mouseIdleTimer);
    }
    attributeChangedCallback() {
      if (this._canvas) {
        this._canvas.style.width = this.designWidth + 'px';
        this._canvas.style.height = this.designHeight + 'px';
        this._canvas.style.setProperty('--deck-design-w', this.designWidth + 'px');
        this._canvas.style.setProperty('--deck-design-h', this.designHeight + 'px');
        this._fit();
        this._syncPrintPageRule();
      }
    }
    _render() {
      const style = document.createElement('style');
      style.textContent = stylesheet;
      const stage = document.createElement('div');
      stage.className = 'stage';
      const canvas = document.createElement('div');
      canvas.className = 'canvas';
      canvas.style.width = this.designWidth + 'px';
      canvas.style.height = this.designHeight + 'px';
      canvas.style.setProperty('--deck-design-w', this.designWidth + 'px');
      canvas.style.setProperty('--deck-design-h', this.designHeight + 'px');
      const slot = document.createElement('slot');
      slot.addEventListener('slotchange', this._onSlotChange);
      canvas.appendChild(slot);
      stage.appendChild(canvas);

      // Tap zones (mobile): left third = back, right third = forward.
      const tapzones = document.createElement('div');
      tapzones.className = 'tapzones export-hidden';
      tapzones.setAttribute('aria-hidden', 'true');
      const tzBack = document.createElement('div');
      tzBack.className = 'tapzone tapzone--back';
      const tzMid = document.createElement('div');
      tzMid.className = 'tapzone tapzone--mid';
      tzMid.style.pointerEvents = 'none';
      const tzFwd = document.createElement('div');
      tzFwd.className = 'tapzone tapzone--fwd';
      tzBack.addEventListener('click', this._onTapBack);
      tzFwd.addEventListener('click', this._onTapForward);
      tapzones.append(tzBack, tzMid, tzFwd);

      // Overlay: compact, solid black, with clickable controls.
      const overlay = document.createElement('div');
      overlay.className = 'overlay export-hidden';
      overlay.setAttribute('role', 'toolbar');
      overlay.setAttribute('aria-label', 'Deck controls');
      overlay.innerHTML = `
        <button class="btn prev" type="button" aria-label="Previous slide" title="Previous (←)">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 3L5 8l5 5"/></svg>
        </button>
        <span class="count" aria-live="polite"><span class="current">1</span><span class="sep">/</span><span class="total">1</span></span>
        <button class="btn next" type="button" aria-label="Next slide" title="Next (→)">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 3l5 5-5 5"/></svg>
        </button>
        <span class="divider"></span>
        <button class="btn reset" type="button" aria-label="Reset to first slide" title="Reset (R)">Reset<span class="kbd">R</span></button>
      `;
      overlay.querySelector('.prev').addEventListener('click', () => this._go(this._index - 1, 'click'));
      overlay.querySelector('.next').addEventListener('click', () => this._go(this._index + 1, 'click'));
      overlay.querySelector('.reset').addEventListener('click', () => this._go(0, 'click'));
      this._root.append(style, stage, tapzones, overlay);
      this._canvas = canvas;
      this._slot = slot;
      this._overlay = overlay;
      this._countEl = overlay.querySelector('.current');
      this._totalEl = overlay.querySelector('.total');
    }

    /** @page must live in the document stylesheet — it's a no-op inside
     *  shadow DOM. Inject/update a single <head> style tag so the print
     *  sheet matches the design size and Save-as-PDF yields one slide per
     *  page with no margins. */
    _syncPrintPageRule() {
      const id = 'deck-stage-print-page';
      let tag = document.getElementById(id);
      if (!tag) {
        tag = document.createElement('style');
        tag.id = id;
        document.head.appendChild(tag);
      }
      tag.textContent = '@page { size: ' + this.designWidth + 'px ' + this.designHeight + 'px; margin: 0; } ' + '@media print { html, body { margin: 0 !important; padding: 0 !important; background: none !important; overflow: visible !important; height: auto !important; } ' + '* { -webkit-print-color-adjust: exact; print-color-adjust: exact; } }';
    }
    _onSlotChange() {
      this._collectSlides();
      this._restoreIndex();
      this._applyIndex({
        showOverlay: false,
        broadcast: true,
        reason: 'init'
      });
      this._fit();
    }
    _collectSlides() {
      const assigned = this._slot.assignedElements({
        flatten: true
      });
      this._slides = assigned.filter(el => {
        // Skip template/style/script nodes even if someone slots them.
        const tag = el.tagName;
        return tag !== 'TEMPLATE' && tag !== 'SCRIPT' && tag !== 'STYLE';
      });
      this._slides.forEach((slide, i) => {
        const n = i + 1;
        // Determine a label for comment flow: prefer explicit data-label,
        // then an existing data-screen-label, then first heading, else "Slide".
        let label = slide.getAttribute('data-label');
        if (!label) {
          const existing = slide.getAttribute('data-screen-label');
          if (existing) {
            // Strip any leading number the author may have included.
            label = existing.replace(/^\s*\d+\s*/, '').trim() || existing;
          }
        }
        if (!label) {
          const h = slide.querySelector('h1, h2, h3, [data-title]');
          if (h) label = (h.textContent || '').trim().slice(0, 40);
        }
        if (!label) label = 'Slide';
        slide.setAttribute('data-screen-label', `${pad2(n)} ${label}`);

        // Validation attribute for comment flow / auto-checks.
        if (!slide.hasAttribute('data-om-validate')) {
          slide.setAttribute('data-om-validate', VALIDATE_ATTR);
        }
        slide.setAttribute('data-deck-slide', String(i));
      });
      if (this._totalEl) this._totalEl.textContent = String(this._slides.length || 1);
      if (this._index >= this._slides.length) this._index = Math.max(0, this._slides.length - 1);
    }
    _loadNotes() {
      const tag = document.getElementById('speaker-notes');
      if (!tag) {
        this._notes = [];
        return;
      }
      try {
        const parsed = JSON.parse(tag.textContent || '[]');
        if (Array.isArray(parsed)) this._notes = parsed;
      } catch (e) {
        console.warn('[deck-stage] Failed to parse #speaker-notes JSON:', e);
        this._notes = [];
      }
    }
    _restoreIndex() {
      try {
        const raw = localStorage.getItem(this._storageKey);
        if (raw != null) {
          const n = parseInt(raw, 10);
          if (Number.isFinite(n) && n >= 0 && n < this._slides.length) {
            this._index = n;
          }
        }
      } catch (e) {/* ignore */}
    }
    _persistIndex() {
      try {
        localStorage.setItem(this._storageKey, String(this._index));
      } catch (e) {/* ignore */}
    }
    _applyIndex({
      showOverlay = true,
      broadcast = true,
      reason = 'init'
    } = {}) {
      if (!this._slides.length) return;
      const prev = this._prevIndex == null ? -1 : this._prevIndex;
      const curr = this._index;
      this._slides.forEach((s, i) => {
        if (i === curr) s.setAttribute('data-deck-active', '');else s.removeAttribute('data-deck-active');
      });
      if (this._countEl) this._countEl.textContent = String(curr + 1);
      this._persistIndex();
      if (broadcast) {
        // (1) Legacy: host-window postMessage for speaker-notes renderers.
        try {
          window.postMessage({
            slideIndexChanged: curr
          }, '*');
        } catch (e) {}

        // (2) In-page CustomEvent on the <deck-stage> element itself.
        //     Bubbles and composes out of shadow DOM so slide code can listen:
        //       document.querySelector('deck-stage').addEventListener('slidechange', e => {
        //         e.detail.index, e.detail.previousIndex, e.detail.total, e.detail.slide, e.detail.reason
        //       });
        const detail = {
          index: curr,
          previousIndex: prev,
          total: this._slides.length,
          slide: this._slides[curr] || null,
          previousSlide: prev >= 0 ? this._slides[prev] || null : null,
          reason: reason // 'init' | 'keyboard' | 'click' | 'tap' | 'api'
        };
        this.dispatchEvent(new CustomEvent('slidechange', {
          detail,
          bubbles: true,
          composed: true
        }));
      }
      this._prevIndex = curr;
      if (showOverlay) this._flashOverlay();
    }
    _flashOverlay() {
      if (!this._overlay) return;
      this._overlay.setAttribute('data-visible', '');
      if (this._hideTimer) clearTimeout(this._hideTimer);
      this._hideTimer = setTimeout(() => {
        this._overlay.removeAttribute('data-visible');
      }, OVERLAY_HIDE_MS);
    }
    _fit() {
      if (!this._canvas) return;
      // PPTX export sets noscale so the DOM capture sees authored-size
      // geometry — the scaled canvas is in shadow DOM, so the exporter's
      // resetTransformSelector can't reach .canvas.style.transform directly.
      if (this.hasAttribute('noscale')) {
        this._canvas.style.transform = 'none';
        return;
      }
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const s = Math.min(vw / this.designWidth, vh / this.designHeight);
      this._canvas.style.transform = `scale(${s})`;
    }
    _onResize() {
      this._fit();
    }
    _onMouseMove() {
      // Keep overlay visible while mouse moves; hide after idle.
      this._flashOverlay();
    }
    _onTapBack(e) {
      e.preventDefault();
      this._go(this._index - 1, 'tap');
    }
    _onTapForward(e) {
      e.preventDefault();
      this._go(this._index + 1, 'tap');
    }
    _onKey(e) {
      // Ignore when the user is typing.
      const t = e.target;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const key = e.key;
      let handled = true;
      if (key === 'ArrowRight' || key === 'PageDown' || key === ' ' || key === 'Spacebar') {
        this._go(this._index + 1, 'keyboard');
      } else if (key === 'ArrowLeft' || key === 'PageUp') {
        this._go(this._index - 1, 'keyboard');
      } else if (key === 'Home') {
        this._go(0, 'keyboard');
      } else if (key === 'End') {
        this._go(this._slides.length - 1, 'keyboard');
      } else if (key === 'r' || key === 'R') {
        this._go(0, 'keyboard');
      } else if (/^[0-9]$/.test(key)) {
        // 1..9 jump to that slide; 0 jumps to 10.
        const n = key === '0' ? 9 : parseInt(key, 10) - 1;
        if (n < this._slides.length) this._go(n, 'keyboard');
      } else {
        handled = false;
      }
      if (handled) {
        e.preventDefault();
        this._flashOverlay();
      }
    }
    _go(i, reason = 'api') {
      if (!this._slides.length) return;
      const clamped = Math.max(0, Math.min(this._slides.length - 1, i));
      if (clamped === this._index) {
        this._flashOverlay();
        return;
      }
      this._index = clamped;
      this._applyIndex({
        showOverlay: true,
        broadcast: true,
        reason
      });
    }

    // Public API ------------------------------------------------------------

    /** Current slide index (0-based). */
    get index() {
      return this._index;
    }
    /** Total slide count. */
    get length() {
      return this._slides.length;
    }
    /** Programmatically navigate. */
    goTo(i) {
      this._go(i, 'api');
    }
    next() {
      this._go(this._index + 1, 'api');
    }
    prev() {
      this._go(this._index - 1, 'api');
    }
    reset() {
      this._go(0, 'api');
    }
  }
  if (!customElements.get('deck-stage')) {
    customElements.define('deck-stage', DeckStage);
  }
})();
})(); } catch (e) { __ds_ns.__errors.push({ path: "slides/deck-stage.js", error: String((e && e.message) || e) }); }

// ui_kits/android/screens.jsx
try { (() => {
// FortyMM Android — same content model as the iOS kit, with Android chrome
// (top app bar, navigation bar with active indicator, extended FAB). Tokens from colors_and_type.css.

function AndroidFrame({
  children
}) {
  return /*#__PURE__*/React.createElement("div", {
    style: {
      width: 384,
      height: 812,
      borderRadius: 28,
      overflow: 'hidden',
      border: '8px solid #000',
      outline: '1px solid var(--ink-600)',
      background: 'var(--bg-app)',
      position: 'relative',
      display: 'flex',
      flexDirection: 'column'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      height: 28,
      flex: 'none',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      padding: '0 16px',
      font: '500 13px Roboto, system-ui',
      color: 'var(--fg-1)'
    }
  }, /*#__PURE__*/React.createElement("span", null, "19:15"), /*#__PURE__*/React.createElement("span", {
    style: {
      width: 18,
      height: 10,
      border: '1px solid var(--fg-2)',
      borderRadius: 2
    }
  })), children);
}
function ANavBar({
  active = 0
}) {
  const items = ['Today', 'Draws', 'Ratings', 'You'];
  return /*#__PURE__*/React.createElement("nav", {
    style: {
      height: 80,
      flex: 'none',
      display: 'flex',
      background: 'var(--bg-panel)',
      borderTop: '1px solid var(--border-subtle)'
    }
  }, items.map((l, i) => /*#__PURE__*/React.createElement("a", {
    key: l,
    style: {
      flex: 1,
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 4,
      textDecoration: 'none',
      cursor: 'pointer'
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      width: 56,
      height: 28,
      borderRadius: 14,
      background: i === active ? 'var(--accent-soft)' : 'transparent',
      display: 'grid',
      placeItems: 'center'
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      width: 16,
      height: 16,
      borderRadius: 4,
      border: `2px solid ${i === active ? 'var(--accent-text)' : 'var(--fg-3)'}`
    }
  })), /*#__PURE__*/React.createElement("span", {
    style: {
      font: '500 12px var(--font-ui)',
      color: i === active ? 'var(--fg-1)' : 'var(--fg-3)'
    }
  }, l))));
}
function ALiveRow({
  table,
  game,
  a,
  b,
  pa,
  pb,
  server
}) {
  const row = (n, p, srv) => /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'grid',
      gridTemplateColumns: 'minmax(0,1fr) 14px 32px',
      gap: 8,
      alignItems: 'center'
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      font: '500 16px/1.3 var(--font-ui)',
      color: 'var(--fg-1)'
    }
  }, n), /*#__PURE__*/React.createElement("span", null, srv && /*#__PURE__*/React.createElement("span", {
    className: "serve-marker"
  })), /*#__PURE__*/React.createElement("span", {
    style: {
      font: '700 22px var(--font-num)',
      textAlign: 'right',
      color: 'var(--fg-1)'
    }
  }, p));
  return /*#__PURE__*/React.createElement("div", {
    style: {
      padding: '12px 0',
      borderBottom: '1px solid var(--border-subtle)',
      display: 'flex',
      flexDirection: 'column',
      gap: 6
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 10,
      alignItems: 'center'
    }
  }, /*#__PURE__*/React.createElement("span", {
    className: "live-marker"
  }, "Live"), /*#__PURE__*/React.createElement("span", {
    style: {
      font: '400 13px var(--font-ui)',
      color: 'var(--fg-3)'
    }
  }, "Table ", table, " \xB7 Game ", game)), row(a, pa, server === 0), row(b, pb, server === 1));
}
function AHome() {
  const upcoming = [['Tran, Linh', 'Today 20:30', 'Table 4', 2010], ['Silva, Rafael', 'Tomorrow 19:00', 'Riverside TT', 1985]];
  return /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("header", {
    style: {
      height: 64,
      flex: 'none',
      display: 'flex',
      alignItems: 'center',
      padding: '0 16px',
      gap: 12
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      font: '600 22px var(--font-ui)',
      color: 'var(--fg-1)',
      flex: 1
    }
  }, "Today"), /*#__PURE__*/React.createElement("span", {
    className: "fm-avatar",
    style: {
      display: 'inline-grid',
      placeItems: 'center',
      width: 32,
      height: 32,
      borderRadius: '50%',
      background: 'var(--ink-700)',
      font: '600 12px var(--font-ui)',
      color: 'var(--fg-2)'
    }
  }, "YO")), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      overflowY: 'auto',
      padding: '0 16px 96px',
      position: 'relative'
    }
  }, /*#__PURE__*/React.createElement("h2", {
    style: {
      font: '600 16px var(--font-ui)',
      margin: '4px 0 0',
      color: 'var(--fg-1)'
    }
  }, "Live at Riverside TT"), /*#__PURE__*/React.createElement(ALiveRow, {
    table: 3,
    game: 3,
    a: "Nguyen, Thanh",
    b: "Okafor, Daniel",
    pa: 8,
    pb: 6,
    server: 0
  }), /*#__PURE__*/React.createElement("h2", {
    style: {
      font: '600 16px var(--font-ui)',
      margin: '24px 0 0',
      color: 'var(--fg-1)'
    }
  }, "Your upcoming matches"), upcoming.map(([n, t, w, r]) => /*#__PURE__*/React.createElement("div", {
    key: n,
    style: {
      padding: '12px 0',
      borderBottom: '1px solid var(--border-subtle)',
      display: 'grid',
      gridTemplateColumns: 'minmax(0,1fr) auto',
      gap: 2
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      font: '600 16px var(--font-ui)',
      color: 'var(--fg-1)'
    }
  }, "vs ", n), /*#__PURE__*/React.createElement("span", {
    style: {
      font: '400 14px var(--font-num)',
      color: 'var(--fg-3)',
      textAlign: 'right'
    }
  }, r.toLocaleString()), /*#__PURE__*/React.createElement("span", {
    style: {
      font: '400 14px var(--font-ui)',
      color: 'var(--fg-2)'
    }
  }, t, " \xB7 ", w))), /*#__PURE__*/React.createElement("h2", {
    style: {
      font: '600 16px var(--font-ui)',
      margin: '24px 0 0',
      color: 'var(--fg-1)'
    }
  }, "Recent"), /*#__PURE__*/React.createElement("div", {
    style: {
      padding: '12px 0',
      borderBottom: '1px solid var(--border-subtle)',
      display: 'grid',
      gridTemplateColumns: 'minmax(0,1fr) auto',
      gap: 2
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      font: '600 16px var(--font-ui)',
      color: 'var(--fg-1)'
    }
  }, "Lost to Patel, Meera"), /*#__PURE__*/React.createElement("span", {
    className: "rating-down"
  }, "\u25BC \u22128"), /*#__PURE__*/React.createElement("span", {
    style: {
      font: '400 13px var(--font-num)',
      color: 'var(--fg-3)'
    }
  }, "1\u20133 \xB7 11\u20139 8\u201311 7\u201311 9\u201311"))), /*#__PURE__*/React.createElement("button", {
    style: {
      position: 'absolute',
      right: 16,
      bottom: 100,
      height: 56,
      padding: '0 20px',
      borderRadius: 16,
      border: 0,
      background: 'var(--accent)',
      color: 'var(--on-accent)',
      font: '600 15px var(--font-ui)',
      cursor: 'pointer'
    }
  }, "+ Log a match"), /*#__PURE__*/React.createElement(ANavBar, {
    active: 0
  }));
}
Object.assign(window, {
  AndroidFrame,
  ANavBar,
  ALiveRow,
  AHome
});
ReactDOM.createRoot(document.getElementById('root')).render(/*#__PURE__*/React.createElement("div", {
  style: {
    display: 'flex',
    justifyContent: 'center',
    padding: 40
  }
}, /*#__PURE__*/React.createElement(AndroidFrame, null, /*#__PURE__*/React.createElement(AHome, null))));
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/android/screens.jsx", error: String((e && e.message) || e) }); }

// ui_kits/components/kit.js
try { (() => {
/* FortyMM shared behaviours (v2.1). Used by the gallery, previews and app screens.
   Icons · tooltips (hover + focus, Esc) · single-select groups (radiogroup/tablist/pressed) ·
   filter chips with exclusive "All" · switches · disclosures · toasts · dialogs · split handle ·
   score entry · polite live announcements. No dependencies. */
(function () {
  const P = {
    check: '<path d="M20 6 9 17l-5-5"/>',
    alert: '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
    error: '<circle cx="12" cy="12" r="10"/><path d="M12 8v4"/><path d="M12 16h.01"/>',
    info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>',
    clock: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
    x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
    chevron: '<path d="m6 9 6 6 6-6"/>',
    more: '<circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/>',
    undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>',
    offline: '<path d="M12 20h.01"/><path d="M8.5 16.429a5 5 0 0 1 7 0"/><path d="M5 12.859a10 10 0 0 1 5.17-2.69"/><path d="M19 12.859a10 10 0 0 0-2.007-1.523"/><path d="M2 8.82a15 15 0 0 1 4.177-2.643"/><path d="M22 8.82a15 15 0 0 0-11.288-3.764"/><path d="m2 2 20 20"/>',
    search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
    plus: '<path d="M5 12h14"/><path d="M12 5v14"/>',
    minus: '<path d="M5 12h14"/>',
    map: '<path d="M20 10c0 4.993-5.539 10.193-7.399 11.799a1 1 0 0 1-1.202 0C9.539 20.193 4 14.993 4 10a8 8 0 0 1 16 0"/><circle cx="12" cy="10" r="3"/>',
    table: '<rect x="3" y="5" width="18" height="12" rx="1"/><path d="M12 5v12"/><path d="M8 21l1-4"/><path d="M16 21l-1-4"/>',
    user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
    calendar: '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4"/><path d="M8 2v4"/><path d="M3 10h18"/>',
    left: '<path d="m15 18-6-6 6-6"/>',
    right: '<path d="m9 18 6-6-6-6"/>',
    list: '<path d="M8 6h13"/><path d="M8 12h13"/><path d="M8 18h13"/><path d="M3 6h.01"/><path d="M3 12h.01"/><path d="M3 18h.01"/>'
  };
  const FM = window.FM = window.FM || {};
  /* Test mode: ?test in the URL or <html data-test>. Turns off transitions/animation and the caret,
     shows tooltips instantly, keeps toasts until dismissed. ?only=<testid> renders just that example.
     <html data-fm-ready="true"> is set once fonts are loaded and every component is initialised. */
  const QS = new URLSearchParams(location.search);
  const T = FM.test = {
    on: QS.has('test') || document.documentElement.hasAttribute('data-test')
  };
  if (T.on) document.documentElement.classList.add('fm-test');
  let uidN = 0;
  const nextId = p => p + ++uidN;
  const escH = s => String(s).replace(/[&<>"]/g, c => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;'
  })[c]);
  const normH = s => String(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const svg = n => '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">' + (P[n] || '') + '</svg>';
  FM.iconSvg = n => '<span class="fm-ic fm-ic--sm" aria-hidden="true">' + svg(n) + '</span>';
  FM.icons = function (root) {
    (root || document).querySelectorAll('[data-icon]').forEach(e => {
      if (e.querySelector('svg')) return;
      e.classList.add('fm-ic');
      e.setAttribute('aria-hidden', 'true');
      e.innerHTML = svg(e.dataset.icon);
    });
  };
  let live;
  FM.announce = function (msg) {
    if (!live) {
      live = document.createElement('div');
      live.className = 'fm-sr';
      live.setAttribute('aria-live', 'polite');
      document.body.appendChild(live);
    }
    live.textContent = '';
    setTimeout(() => {
      live.textContent = msg;
    }, 40);
  };

  /* Tooltip */
  let tip, tipT, owner;
  function tipEl() {
    if (!tip) {
      tip = document.createElement('div');
      tip.className = 'fm-tooltip';
      tip.id = 'fm-tooltip';
      tip.setAttribute('role', 'tooltip');
      tip.hidden = true;
      document.body.appendChild(tip);
    }
    return tip;
  }
  function showTip(el) {
    const t = tipEl();
    t.textContent = el.dataset.tip;
    t.hidden = false;
    owner = el;
    el.setAttribute('aria-describedby', 'fm-tooltip');
    const r = el.getBoundingClientRect(),
      w = t.offsetWidth,
      h = t.offsetHeight;
    let top = r.top - h - 8;
    if (top < 8) top = r.bottom + 8;
    let left = Math.max(8, Math.min(r.left + r.width / 2 - w / 2, innerWidth - w - 8));
    t.style.top = top + scrollY + 'px';
    t.style.left = left + scrollX + 'px';
  }
  function hideTip() {
    clearTimeout(tipT);
    if (tip) tip.hidden = true;
    if (owner) {
      owner.removeAttribute('aria-describedby');
      owner = null;
    }
  }
  document.addEventListener('pointerover', e => {
    if (e.pointerType === 'touch') return;
    const el = e.target.closest('[data-tip]');
    if (!el || el === owner) return;
    clearTimeout(tipT);
    tipT = setTimeout(() => showTip(el), T.on ? 0 : 300);
  });
  document.addEventListener('pointerout', e => {
    const el = e.target.closest('[data-tip]');
    if (el && !el.contains(e.relatedTarget)) {
      clearTimeout(tipT);
      if (document.activeElement !== el) hideTip();
    }
  });
  document.addEventListener('focusin', e => {
    const el = e.target.closest('[data-tip]');
    if (el && el.matches(':focus-visible')) showTip(el);
  });
  document.addEventListener('focusout', e => {
    if (e.target.closest('[data-tip]')) hideTip();
  });
  addEventListener('scroll', hideTip, true);

  /* Blocks clicks on aria-disabled controls (they stay focusable so their reason can be read) */
  document.addEventListener('click', e => {
    const d = e.target.closest('[aria-disabled=true]');
    if (d) {
      e.preventDefault();
      e.stopImmediatePropagation();
    }
  }, true);

  /* Selection groups */
  function attr(g) {
    const r = g.getAttribute('role');
    return r === 'radiogroup' ? 'aria-checked' : r === 'tablist' ? 'aria-selected' : 'aria-pressed';
  }
  function items(g) {
    return [...g.querySelectorAll('button')].filter(b => b.closest('[data-select]') === g && !b.disabled);
  }
  FM.select = function (g, b, focus) {
    const a = attr(g),
      rove = a !== 'aria-pressed';
    items(g).forEach(x => {
      const on = x === b;
      x.setAttribute(a, String(on));
      if (rove) x.tabIndex = on ? 0 : -1;
      const p = x.getAttribute('aria-controls');
      if (a === 'aria-selected' && p) {
        const el = document.getElementById(p);
        if (el) el.hidden = !on;
      }
    });
    if (focus) b.focus();
    if (a === 'aria-pressed' && g.dataset.announce !== 'off') FM.announce((b.dataset.label || b.textContent.trim()) + ', selected');
    g.dispatchEvent(new CustomEvent('fm-change', {
      bubbles: true,
      detail: {
        value: b.dataset.value || b.textContent.trim(),
        button: b
      }
    }));
  };
  function filter(g, b) {
    const all = g.querySelector('[data-all]'),
      rest = items(g).filter(x => x !== all);
    if (b === all) {
      rest.forEach(x => x.setAttribute('aria-pressed', 'false'));
    } else {
      b.setAttribute('aria-pressed', String(b.getAttribute('aria-pressed') !== 'true'));
    }
    if (all) all.setAttribute('aria-pressed', String(!rest.some(x => x.getAttribute('aria-pressed') === 'true')));
    const on = items(g).filter(x => x.getAttribute('aria-pressed') === 'true').map(x => x.textContent.trim());
    FM.announce('Showing ' + on.join(', '));
    g.dispatchEvent(new CustomEvent('fm-change', {
      bubbles: true,
      detail: {
        values: on
      }
    }));
  }
  document.addEventListener('click', e => {
    const b = e.target.closest('button');
    if (!b || b.disabled) return;
    const g = b.closest('[data-select]');
    if (g && items(g).includes(b)) {
      g.dataset.select === 'filter' ? filter(g, b) : FM.select(g, b);
    }
    if (b.getAttribute('role') === 'switch') {
      const on = b.getAttribute('aria-checked') !== 'true';
      b.setAttribute('aria-checked', String(on));
      b.dispatchEvent(new CustomEvent('fm-change', {
        bubbles: true,
        detail: {
          value: on
        }
      }));
    }
    if (b.hasAttribute('data-disclosure')) {
      const t = document.getElementById(b.getAttribute('aria-controls'));
      const open = b.getAttribute('aria-expanded') !== 'true';
      b.setAttribute('aria-expanded', String(open));
      if (t) t.hidden = !open;
    }
    if (b.dataset.dialog) {
      const d = document.getElementById(b.dataset.dialog);
      if (d) d.showModal();
    }
    if (b.hasAttribute('data-close')) {
      const d = b.closest('dialog');
      if (d) d.close(b.value || '');
    }
    if (b.dataset.toast) {
      FM.toast(b.dataset.toast, {
        undo: reversible(b)
      });
    }
    if (b.dataset.demo !== undefined) {
      FM.toast('“' + (b.dataset.demo || b.textContent.trim()) + '” isn’t wired up in this demo', {
        icon: 'info'
      });
    }
    if (b.dataset.busy) {
      if (b.getAttribute('aria-busy') === 'true') return;
      const label = b.textContent;
      b.setAttribute('aria-busy', 'true');
      b.textContent = b.dataset.busy;
      setTimeout(() => {
        b.removeAttribute('aria-busy');
        b.textContent = label;
        if (b.dataset.done) FM.toast(b.dataset.done);
      }, 1400);
    }
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && owner) {
      hideTip();
      return;
    }
    const b = e.target.closest('button');
    if (!b) return;
    const g = b.closest('[data-select]');
    if (!g || attr(g) === 'aria-pressed') return;
    const list = items(g),
      i = list.indexOf(b);
    if (i < 0) return;
    let n = null;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') n = list[(i + 1) % list.length];
    if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') n = list[(i - 1 + list.length) % list.length];
    if (e.key === 'Home') n = list[0];
    if (e.key === 'End') n = list[list.length - 1];
    if (n) {
      e.preventDefault();
      FM.select(g, n, true);
    }
  });
  document.addEventListener('click', e => {
    if (e.target.tagName === 'DIALOG') {
      const r = e.target.getBoundingClientRect();
      if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) e.target.close();
    }
  });

  /* Declarative reversible effects for data-toast buttons. Undo is offered only when something on the page
     actually changed: data-done-label (trigger relabels + aria-disabled), data-hide="id", data-reveal="id". */
  function reversible(b) {
    if (!b.hasAttribute('data-undo')) return null;
    const fx = [];
    if (b.dataset.doneLabel) {
      const old = b.innerHTML;
      b.textContent = b.dataset.doneLabel;
      b.setAttribute('aria-disabled', 'true');
      fx.push(() => {
        b.innerHTML = old;
        b.removeAttribute('aria-disabled');
      });
    }
    if (b.dataset.hide) {
      const t = document.getElementById(b.dataset.hide);
      if (t) {
        t.hidden = true;
        fx.push(() => {
          t.hidden = false;
        });
      }
    }
    if (b.dataset.reveal) {
      const t = document.getElementById(b.dataset.reveal);
      if (t) {
        t.hidden = false;
        fx.push(() => {
          t.hidden = true;
        });
      }
    }
    if (!fx.length) {
      console.warn('FM: data-undo without a reversible effect — Undo not offered', b);
      return null;
    }
    return () => {
      fx.forEach(f => f());
      if (b.isConnected) b.focus();
    };
  }

  /* Toast: success/confirmation only. 6 s; pauses on hover/focus. Errors use .fm-alert instead. */
  FM.toast = function (msg, opt) {
    opt = opt || {};
    let r = document.querySelector('.fm-toast-region');
    if (!r) {
      r = document.createElement('div');
      r.className = 'fm-toast-region';
      r.setAttribute('role', 'status');
      r.setAttribute('aria-live', 'polite');
      document.body.appendChild(r);
    }
    const t = document.createElement('div');
    t.className = 'fm-toast' + (opt.icon && opt.icon !== 'check' ? ' fm-toast--info' : '');
    t.innerHTML = '<span data-icon="' + (opt.icon || 'check') + '"></span><span class="fm-toast__msg"></span>';
    t.querySelector('.fm-toast__msg').textContent = msg;
    let timer;
    const close = () => {
      clearTimeout(timer);
      t.remove();
    };
    const arm = () => {
      clearTimeout(timer);
      if (T.on && !opt.duration) return;
      timer = setTimeout(close, opt.duration || 6000);
    };
    if (opt.undo) {
      const u = document.createElement('button');
      u.className = 'fm-btn fm-btn--sm fm-toast__action';
      u.textContent = 'Undo';
      u.onclick = () => {
        opt.undo();
        close();
        FM.announce('Undone');
      };
      t.appendChild(u);
    }
    const x = document.createElement('button');
    x.className = 'fm-btn fm-btn--sm fm-toast__close';
    x.setAttribute('aria-label', 'Dismiss');
    x.innerHTML = FM.iconSvg('x');
    x.onclick = close;
    t.appendChild(x);
    t.addEventListener('mouseenter', () => clearTimeout(timer));
    t.addEventListener('mouseleave', arm);
    t.addEventListener('focusin', () => clearTimeout(timer));
    t.addEventListener('focusout', arm);
    while (r.children.length >= 3) r.firstChild.remove();
    r.appendChild(t);
    FM.icons(t);
    arm();
    return close;
  };

  /* Split handle: drag or arrow keys */
  FM.split = function (root) {
    (root || document).querySelectorAll('.fm-split__handle').forEach(h => {
      if (h._fm) return;
      h._fm = 1;
      const s = h.closest('.fm-split');
      const set = p => {
        p = Math.max(35, Math.min(72, p));
        s.style.setProperty('--split', p + '%');
        h.setAttribute('aria-valuenow', Math.round(p));
      };
      h.addEventListener('keydown', e => {
        const v = +h.getAttribute('aria-valuenow') || 58;
        const k = {
          ArrowLeft: v - 4,
          ArrowRight: v + 4,
          Home: 35,
          End: 72
        }[e.key];
        if (k !== undefined) {
          e.preventDefault();
          set(k);
        }
      });
      h.addEventListener('pointerdown', e => {
        h.setPointerCapture(e.pointerId);
        const r = s.getBoundingClientRect();
        const mv = ev => set((ev.clientX - r.left) / r.width * 100);
        const up = () => {
          h.removeEventListener('pointermove', mv);
          h.removeEventListener('pointerup', up);
        };
        h.addEventListener('pointermove', mv);
        h.addEventListener('pointerup', up);
      });
    });
  };

  /* Score entry: data-scorepad='{"names":[..],"games":[[11,7],[9,11]],"pts":[4,3],"serve":0,"bestOf":5}' */
  FM.scorepad = function (el) {
    const cfg = JSON.parse(el.dataset.scorepad);
    const st = {
      pts: cfg.pts.slice(),
      done: cfg.games.slice(),
      serve: cfg.serve || 0
    };
    const hist = [];
    const won = i => st.done.filter(g => g[i] > g[1 - i]).length;
    const need = Math.ceil((cfg.bestOf || 5) / 2);
    function render(changed) {
      [0, 1].forEach(i => {
        const p = el.querySelector('[data-pts="' + i + '"]');
        p.textContent = st.pts[i];
        el.querySelector('[data-games="' + i + '"]').textContent = won(i);
        el.querySelector('[data-serve="' + i + '"]').style.visibility = st.serve === i ? 'visible' : 'hidden';
        el.querySelector('[data-add="' + i + '"]').disabled = won(0) >= need || won(1) >= need;
        if (changed === i) {
          p.classList.remove('score-updated');
          void p.offsetWidth;
          p.classList.add('score-updated');
        }
      });
      const u = el.querySelector('[data-undo]');
      u.disabled = !hist.length;
      const h = el.querySelector('[data-history]');
      if (h && window.FMMatch) h.innerHTML = FMMatch.games({
        p: cfg.names.map(n => ({
          name: n,
          short: n.split(',')[0]
        })),
        games: st.done.concat(won(0) >= need || won(1) >= need ? [] : [st.pts.slice()]),
        state: 'live',
        id: el.id || 'sp'
      });
    }
    el.addEventListener('click', e => {
      const a = e.target.closest('[data-add]');
      const u = e.target.closest('[data-undo]');
      if (a) {
        const i = +a.dataset.add;
        hist.push(JSON.stringify(st));
        st.pts[i]++;
        const tot = st.pts[0] + st.pts[1];
        const deuce = st.pts[0] >= 10 && st.pts[1] >= 10;
        if (deuce || tot % 2 === 0) st.serve = 1 - st.serve;
        const [x, y] = st.pts;
        if ((x >= 11 || y >= 11) && Math.abs(x - y) >= 2) {
          st.done.push([x, y]);
          const w = x > y ? 0 : 1;
          st.pts = [0, 0];
          render(i);
          const short = cfg.names[w].split(',')[0];
          FM.toast('Game ' + st.done.length + ' to ' + short + ', ' + Math.max(x, y) + '–' + Math.min(x, y), {
            undo: () => {
              Object.assign(st, JSON.parse(hist.pop()));
              render();
            }
          });
          return;
        }
        render(i);
        FM.announce(cfg.names[i].split(',')[0] + ' ' + st.pts[i] + ', ' + cfg.names[1 - i].split(',')[0] + ' ' + st.pts[1 - i]);
      }
      if (u && hist.length) {
        Object.assign(st, JSON.parse(hist.pop()));
        render();
        FM.announce('Last point undone');
      }
    });
    render();
  };

  /* Date picker. <div class="fm-datefield" data-datepicker='{"value":"2026-04-11","today":"2026-04-10","min":"2026-04-01"}'> with an input + button,
     or <div class="fm-cal fm-cal--inline" data-datepicker='…'>. Arrows move a day/week, PageUp/PageDown a month, Enter picks, Esc closes. */
  const MON = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'],
    DOW = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'],
    DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const iso = d => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  const parse = s => {
    const [y, m, d] = s.split('-').map(Number);
    return new Date(y, m - 1, d);
  };
  const long = d => DAYS[d.getDay()] + ' ' + d.getDate() + ' ' + MON[d.getMonth()] + ' ' + d.getFullYear();
  /* Accepts "11 April 2026", "Sat 11 Apr", "April 11 2026", "11/4/2026" (day first), "11.4.26", "2026-04-11". Year optional. Returns null if not a real date. */
  FM.parseDate = function (s, fallbackYear) {
    s = s.toLowerCase().replace(/,/g, ' ').replace(/\b(mon|tue|wed|thu|fri|sat|sun)[a-z]*\b/g, ' ').replace(/(\d)(st|nd|rd|th)\b/g, '$1').trim();
    let y, m, d, r;
    if (r = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/)) {
      y = +r[1];
      m = +r[2];
      d = +r[3];
    } else if (r = s.match(/^(\d{1,2})[\/.\-\s](\d{1,2})(?:[\/.\-\s](\d{2,4}))?$/)) {
      d = +r[1];
      m = +r[2];
      y = r[3] ? +r[3] : fallbackYear;
    } else {
      const mi = MON.findIndex(n => new RegExp('\\b' + n.slice(0, 3).toLowerCase() + '[a-z]*\\b').test(s));
      if (mi < 0) return null;
      m = mi + 1;
      const nums = (s.match(/\d+/g) || []).map(Number);
      if (!nums.length) return null;
      d = nums.find(n => n <= 31);
      y = nums.find(n => n > 31) || (nums.length > 1 && nums[1] < 100 && nums[0] !== nums[1] ? nums[1] : fallbackYear);
      if (d === undefined) return null;
    }
    if (y < 100) y += 2000;
    const dt = new Date(y, m - 1, d);
    return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d ? dt : null;
  };
  FM.datepicker = function (el) {
    const cfg = JSON.parse(el.dataset.datepicker);
    const inline = el.classList.contains('fm-cal');
    let sel = cfg.value ? parse(cfg.value) : null,
      focus = sel || parse(cfg.today),
      view = new Date(focus.getFullYear(), focus.getMonth(), 1);
    const min = cfg.min ? parse(cfg.min) : null;
    const cal = inline ? el : document.createElement('div');
    if (!inline) {
      cal.className = 'fm-overlay fm-cal';
      cal.hidden = true;
      cal.setAttribute('role', 'dialog');
      cal.setAttribute('aria-label', 'Choose date');
      el.appendChild(cal);
    }
    const input = el.querySelector('input'),
      btn = el.querySelector('[data-cal-open]');
    const uid = nextId('cal');
    function draw(moveFocus) {
      const y = view.getFullYear(),
        m = view.getMonth();
      const start = new Date(y, m, 1 - (new Date(y, m, 1).getDay() + 6) % 7);
      let h = '<div class="fm-cal__head"><button class="fm-btn fm-btn--ghost fm-btn--sm fm-btn--icon" data-nav="-1" aria-label="Previous month">' + FM.iconSvg('left') + '</button><span class="fm-cal__title" id="' + uid + '" aria-live="polite">' + MON[m] + ' ' + y + '</span><button class="fm-btn fm-btn--ghost fm-btn--sm fm-btn--icon" data-nav="1" aria-label="Next month">' + FM.iconSvg('right') + '</button></div><table role="grid" aria-labelledby="' + uid + '"><thead><tr>' + DOW.map(d => '<th scope="col" abbr="' + d + '">' + d + '</th>').join('') + '</tr></thead><tbody>';
      for (let w = 0; w < 6; w++) {
        h += '<tr>';
        for (let i = 0; i < 7; i++) {
          const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + w * 7 + i),
            k = iso(d);
          const cls = ['fm-cal__day', d.getMonth() !== m ? 'out' : '', k === cfg.today ? 'today' : ''].join(' ');
          const dis = min && d < min;
          h += '<td><button class="' + cls + '" data-date="' + k + '" tabindex="' + (k === iso(focus) ? 0 : -1) + '" aria-selected="' + (sel && k === iso(sel)) + '" aria-label="' + long(d) + (k === cfg.today ? ', today' : '') + '"' + (dis ? ' disabled' : '') + '>' + d.getDate() + '</button></td>';
        }
        h += '</tr>';
      }
      cal.innerHTML = h + '</tbody></table><div class="fm-cal__foot"><span></span><button class="fm-btn fm-btn--link" data-today>Today</button></div>';
      if (moveFocus) {
        const f = cal.querySelector('[data-date="' + iso(focus) + '"]');
        if (f) f.focus();
      }
    }
    function go(d) {
      focus = d;
      if (d.getMonth() !== view.getMonth() || d.getFullYear() !== view.getFullYear()) view = new Date(d.getFullYear(), d.getMonth(), 1);
      draw(true);
    }
    let pick = function (d) {
      sel = d;
      focus = d;
      if (input) {
        input.value = long(d);
        input.removeAttribute('aria-invalid');
      }
      el.dispatchEvent(new CustomEvent('fm-change', {
        bubbles: true,
        detail: {
          value: iso(d)
        }
      }));
      if (inline) {
        draw(true);
        FM.announce(long(d) + ' selected');
      } else close(true);
    };
    function open() {
      cal.hidden = false;
      if (btn) btn.setAttribute('aria-expanded', 'true');
      draw(true);
    }
    function close(ret) {
      if (inline) return;
      cal.hidden = true;
      if (btn) {
        btn.setAttribute('aria-expanded', 'false');
        if (ret) btn.focus();
      }
    }
    if (btn) {
      btn.setAttribute('aria-haspopup', 'dialog');
      btn.setAttribute('aria-expanded', 'false');
      btn.addEventListener('click', () => cal.hidden ? open() : close(true));
    }
    if (input && sel) input.value = long(sel);
    if (input) {
      const err = document.createElement('p');
      err.className = 'fm-error';
      err.id = uid + '-err';
      err.hidden = true;
      err.innerHTML = '<span data-icon="error"></span><span></span>';
      (el.closest('.fm-field') || el.parentNode).appendChild(err);
      FM.icons(err);
      input.setAttribute('aria-describedby', ((input.getAttribute('aria-describedby') || '') + ' ' + err.id).trim());
      const fail = msg => {
        input.setAttribute('aria-invalid', 'true');
        err.lastChild.textContent = msg;
        err.hidden = false;
      };
      const ok = () => {
        input.removeAttribute('aria-invalid');
        err.hidden = true;
      };
      function check() {
        const v = input.value.trim();
        if (!v) {
          sel = null;
          ok();
          draw(false);
          return true;
        }
        const d = FM.parseDate(v, view.getFullYear());
        if (!d) {
          fail('Enter a date like 11 April 2026 or 11/4/2026.');
          return false;
        }
        if (min && d < min) {
          fail('Pick ' + long(min) + ' or later.');
          return false;
        }
        sel = d;
        focus = d;
        view = new Date(d.getFullYear(), d.getMonth(), 1);
        input.value = long(d);
        ok();
        draw(false);
        el.dispatchEvent(new CustomEvent('fm-change', {
          bubbles: true,
          detail: {
            value: iso(d)
          }
        }));
        return true;
      }
      input.addEventListener('change', check);
      input.addEventListener('keydown', e => {
        if (e.key === 'Enter') {
          e.preventDefault();
          check();
        }
        if (e.key === 'ArrowDown' && e.altKey) {
          e.preventDefault();
          open();
        }
        if (e.key === 'Escape' && !cal.hidden) close(true);
      });
      const _pick = pick;
      pick = d => {
        ok();
        _pick(d);
      };
    }
    cal.addEventListener('click', e => {
      const n = e.target.closest('[data-nav]'),
        d = e.target.closest('[data-date]'),
        t = e.target.closest('[data-today]');
      if (n) {
        view = new Date(view.getFullYear(), view.getMonth() + +n.dataset.nav, 1);
        focus = new Date(view);
        draw(false);
      }
      if (d && !d.disabled) pick(parse(d.dataset.date));
      if (t) go(parse(cfg.today));
    });
    cal.addEventListener('keydown', e => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        close(true);
        return;
      }
      const d = e.target.closest('[data-date]');
      if (!d) return;
      const f = parse(d.dataset.date);
      const k = {
        ArrowLeft: -1,
        ArrowRight: 1,
        ArrowUp: -7,
        ArrowDown: 7
      }[e.key];
      if (k) {
        e.preventDefault();
        go(new Date(f.getFullYear(), f.getMonth(), f.getDate() + k));
      } else if (e.key === 'PageUp' || e.key === 'PageDown') {
        e.preventDefault();
        go(new Date(f.getFullYear(), f.getMonth() + (e.key === 'PageUp' ? -1 : 1), f.getDate()));
      } else if (e.key === 'Home' || e.key === 'End') {
        e.preventDefault();
        const dow = (f.getDay() + 6) % 7;
        go(new Date(f.getFullYear(), f.getMonth(), f.getDate() + (e.key === 'Home' ? -dow : 6 - dow)));
      }
    });
    if (!inline) document.addEventListener('pointerdown', e => {
      if (!cal.hidden && !el.contains(e.target)) close(false);
    });
    draw(false);
  };

  /* Combobox (ARIA 1.2 list autocomplete). <div class="fm-combo" data-combobox='[{"name":"Nguyen, Thanh","club":"Riverside TT","rating":"2,145"},…]'><input class="fm-input" id=…></div>
     Matches name or club, ignoring accents. ↓/↑ move, Enter picks, Esc closes (again clears), Home/End stay in the text. */
  FM.combobox = function (el) {
    const data = JSON.parse(el.dataset.combobox);
    const input = el.querySelector('input');
    const uid = input.id || nextId('cb');
    const norm = s => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
    const list = document.createElement('ul');
    list.className = 'fm-overlay fm-combo__list';
    list.id = uid + '-list';
    list.setAttribute('role', 'listbox');
    list.hidden = true;
    const lab = document.querySelector('label[for="' + input.id + '"]');
    if (lab) list.setAttribute('aria-label', lab.textContent.trim());
    el.appendChild(list);
    const ic = document.createElement('span');
    ic.dataset.icon = 'search';
    el.insertBefore(ic, input);
    FM.icons(el);
    input.setAttribute('role', 'combobox');
    input.setAttribute('aria-autocomplete', 'list');
    input.setAttribute('aria-expanded', 'false');
    input.setAttribute('aria-controls', list.id);
    input.setAttribute('autocomplete', 'off');
    let items = [],
      active = -1,
      chosen = null;
    const hl = (name, q) => {
      if (!q) return esc(name);
      const i = norm(name).indexOf(q);
      return i < 0 ? esc(name) : esc(name.slice(0, i)) + '<mark>' + esc(name.slice(i, i + q.length)) + '</mark>' + esc(name.slice(i + q.length));
    };
    const esc = s => String(s).replace(/[&<>"]/g, c => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;'
    })[c]);
    function render() {
      const q = norm(input.value.trim());
      items = data.filter(p => !q || norm(p.name).includes(q) || norm(p.club || '').includes(q));
      if (!items.length) {
        list.innerHTML = '<li class="fm-combo__empty" role="presentation">No players match “' + esc(input.value.trim()) + '”. Check the spelling or search by club.</li>';
        active = -1;
      } else list.innerHTML = items.map((p, i) => '<li class="fm-combo__opt" role="option" id="' + uid + '-o' + i + '" aria-selected="' + (i === active) + '"><span class="ck">' + (chosen === p ? FM.iconSvg('check') : '') + '</span><b>' + hl(p.name, q) + '</b>' + (p.club ? '<small>' + esc(p.club) + '</small>' : '') + (p.rating ? '<span class="r" aria-label="rating ' + p.rating + '">' + p.rating + '</span>' : '') + '</li>').join('');
      if (active >= 0) {
        input.setAttribute('aria-activedescendant', uid + '-o' + active);
        const a = list.children[active];
        if (a) {
          const t = a.offsetTop,
            b = t + a.offsetHeight;
          if (t < list.scrollTop) list.scrollTop = t;else if (b > list.scrollTop + list.clientHeight) list.scrollTop = b - list.clientHeight;
        }
      } else input.removeAttribute('aria-activedescendant');
      clearTimeout(el._ann);
      el._ann = setTimeout(() => FM.announce(items.length ? items.length + ' player' + (items.length > 1 ? 's' : '') + ' found' : 'No players found'), 500);
    }
    function open() {
      list.hidden = false;
      input.setAttribute('aria-expanded', 'true');
      render();
    }
    function close() {
      list.hidden = true;
      input.setAttribute('aria-expanded', 'false');
      input.removeAttribute('aria-activedescendant');
      active = -1;
    }
    function pick(i) {
      chosen = items[i];
      input.value = chosen.name;
      close();
      el.dispatchEvent(new CustomEvent('fm-change', {
        bubbles: true,
        detail: {
          value: chosen
        }
      }));
    }
    input.addEventListener('input', () => {
      chosen = null;
      active = input.value.trim() ? 0 : -1;
      open();
    });
    input.addEventListener('click', () => {
      if (list.hidden) open();
    });
    input.addEventListener('keydown', e => {
      const n = items.length;
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (list.hidden) {
          open();
          active = 0;
          render();
          return;
        }
        if (n) {
          active = (active + 1) % n;
          render();
        }
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        if (list.hidden) {
          open();
          active = n - 1;
          render();
          return;
        }
        if (n) {
          active = (active - 1 + n) % n;
          render();
        }
      } else if (e.key === 'Enter') {
        if (!list.hidden && active >= 0) {
          e.preventDefault();
          pick(active);
        }
      } else if (e.key === 'Escape') {
        if (!list.hidden) {
          e.preventDefault();
          close();
        } else if (input.value) {
          input.value = '';
          chosen = null;
        }
      } else if (e.key === 'Tab') {
        close();
      }
    });
    list.addEventListener('pointerdown', e => e.preventDefault());
    list.addEventListener('click', e => {
      const o = e.target.closest('[role=option]');
      if (o) pick([...list.children].indexOf(o));
    });
    list.addEventListener('pointermove', e => {
      const o = e.target.closest('[role=option]');
      if (o) {
        const i = [...list.children].indexOf(o);
        if (i !== active) {
          active = i;
          render();
        }
      }
    });
    input.addEventListener('blur', () => setTimeout(close, 0));
  };
  FM.init = function (root) {
    FM.icons(root);
    FM.split(root);
    (root || document).querySelectorAll('[data-code]').forEach(el => {
      if (!el._fmCode) FM.code(el);
    });
    (root || document).querySelectorAll('[role=menubar]').forEach(el => {
      if (!el._fm) {
        el._fm = 1;
        FM.menubar(el);
      }
    });
    (root || document).querySelectorAll('.fm-carousel').forEach(el => {
      if (!el._fm) {
        el._fm = 1;
        FM.carousel(el);
      }
    });
    (root || document).querySelectorAll('[data-combobox]').forEach(el => {
      if (!el._fm) {
        el._fm = 1;
        FM.combobox(el);
      }
    });
    (root || document).querySelectorAll('[data-datepicker]').forEach(el => {
      if (!el._fm) {
        el._fm = 1;
        FM.datepicker(el);
      }
    });
    (root || document).querySelectorAll('[data-scorepad]').forEach(el => {
      if (!el._fm) {
        el._fm = 1;
        FM.scorepad(el);
      }
    });
    (root || document).querySelectorAll('[data-select][role=radiogroup],[data-select][role=tablist]').forEach(g => {
      const a = attr(g);
      items(g).forEach(b => b.tabIndex = b.getAttribute(a) === 'true' ? 0 : -1);
    });
  };
  /* Code input: <div class="fm-code" data-code="6" data-split="3" aria-labelledby="…">. Emits fm-input on every edit and
     fm-change when full. el._fmCode = {invalid(bool), describe(ids), clear()}. Letters and digits only, uppercased. */
  FM.code = function (el) {
    const n = +el.dataset.code || 6,
      split = +el.dataset.split || 0;
    el.setAttribute('role', 'group');
    let h = '';
    for (let i = 0; i < n; i++) {
      if (split && i === split) h += '<span class="fm-code__sep" aria-hidden="true"></span>';
      h += '<input class="fm-input" maxlength="' + n + '" autocapitalize="characters" autocomplete="' + (i ? 'off' : 'one-time-code') + '" spellcheck="false" aria-label="Character ' + (i + 1) + ' of ' + n + '"' + (el.hasAttribute('data-disabled') ? ' disabled' : '') + '>';
    }
    el.innerHTML = h;
    const cells = [...el.querySelectorAll('input')];
    const clean = s => s.toUpperCase().replace(/[^A-Z0-9]/g, '');
    const val = () => cells.map(c => c.value).join('');
    function emit() {
      cells.forEach(c => c.removeAttribute('aria-invalid'));
      el.dispatchEvent(new CustomEvent('fm-input', {
        bubbles: true,
        detail: {
          value: val()
        }
      }));
      if (val().length === n) el.dispatchEvent(new CustomEvent('fm-change', {
        bubbles: true,
        detail: {
          value: val()
        }
      }));
    }
    function fill(from, s) {
      s = clean(s);
      let i = from;
      for (const ch of s) {
        if (i >= n) break;
        cells[i++].value = ch;
      }
      cells[Math.min(i, n - 1)].focus();
      emit();
    }
    cells.forEach((c, i) => {
      c.addEventListener('focus', () => c.select());
      c.addEventListener('input', () => {
        const v = clean(c.value);
        if (v.length > 1) {
          c.value = '';
          fill(i, v);
          return;
        }
        c.value = v;
        if (v && i < n - 1) cells[i + 1].focus();
        emit();
      });
      c.addEventListener('keydown', e => {
        if (e.key === 'Backspace' && !c.value && i > 0) {
          e.preventDefault();
          cells[i - 1].value = '';
          cells[i - 1].focus();
          emit();
        } else if (e.key === 'ArrowLeft' && i > 0) {
          e.preventDefault();
          cells[i - 1].focus();
        } else if (e.key === 'ArrowRight' && i < n - 1) {
          e.preventDefault();
          cells[i + 1].focus();
        }
      });
      c.addEventListener('paste', e => {
        e.preventDefault();
        fill(i, (e.clipboardData || window.clipboardData).getData('text'));
      });
    });
    el._fmCode = {
      invalid: b => cells.forEach(c => b ? c.setAttribute('aria-invalid', 'true') : c.removeAttribute('aria-invalid')),
      describe: ids => cells.forEach(c => ids ? c.setAttribute('aria-describedby', ids) : c.removeAttribute('aria-describedby')),
      clear: () => {
        cells.forEach(c => c.value = '');
        cells[0].focus();
        emit();
      }
    };
    if (el.dataset.describedby) el._fmCode.describe(el.dataset.describedby);
  };

  /* Command palette: FM.palette(dialogEl, [{group,label,icon,hint,keywords,run}], {shortcut:true}) → {open(query)}.
     Commands run after the dialog closes so focus can move where the command puts it. */
  FM.palette = function (dlg, cmds, opt) {
    opt = opt || {};
    const uid = nextId('pal');
    dlg.classList.add('fm-palette');
    dlg.setAttribute('aria-label', 'Command palette');
    dlg.innerHTML = '<div class="fm-palette__search"><span data-icon="search"></span><input role="combobox" aria-expanded="true" aria-autocomplete="list" aria-controls="' + uid + '-l" aria-label="Search commands and players" placeholder="Type a command or player" autocomplete="off" spellcheck="false"></div><div class="fm-palette__list" id="' + uid + '-l" role="listbox" aria-label="Commands"></div><div class="fm-palette__foot" aria-hidden="true"><span><span class="fm-kbd">↑</span> <span class="fm-kbd">↓</span> move</span><span><span class="fm-kbd">↵</span> run</span><span><span class="fm-kbd">esc</span> close</span></div>';
    FM.icons(dlg);
    const input = dlg.querySelector('input'),
      list = dlg.querySelector('[role=listbox]');
    let shown = [],
      active = 0;
    function render() {
      const q = normH(input.value.trim());
      shown = cmds.filter(c => !q || normH(c.label + ' ' + (c.hint || '') + ' ' + (c.keywords || '')).includes(q));
      if (active >= shown.length) active = 0;
      if (!shown.length) {
        list.innerHTML = '<div class="fm-combo__empty" role="presentation">No commands or players match “' + escH(input.value.trim()) + '”.</div>';
        input.removeAttribute('aria-activedescendant');
        return;
      }
      let h = '',
        g = null,
        gi = 0;
      shown.forEach((c, i) => {
        if (c.group !== g) {
          if (g !== null) h += '</div>';
          g = c.group;
          gi++;
          h += '<div role="group" aria-labelledby="' + uid + '-g' + gi + '"><div class="fm-palette__group" id="' + uid + '-g' + gi + '" role="presentation">' + escH(g) + '</div>';
        }
        h += '<div class="fm-palette__opt" role="option" id="' + uid + '-o' + i + '" aria-selected="' + (i === active) + '">' + (c.icon ? '<span data-icon="' + c.icon + '"></span>' : '') + '<span>' + escH(c.label) + '</span>' + (c.hint ? '<small>' + escH(c.hint) + '</small>' : '') + '</div>';
      });
      list.innerHTML = h + '</div>';
      FM.icons(list);
      input.setAttribute('aria-activedescendant', uid + '-o' + active);
      const a = document.getElementById(uid + '-o' + active);
      if (a) {
        const t = a.offsetTop,
          b = t + a.offsetHeight;
        if (t < list.scrollTop + 8) list.scrollTop = t - 30;else if (b > list.scrollTop + list.clientHeight) list.scrollTop = b - list.clientHeight;
      }
    }
    function run(i) {
      const c = shown[i];
      if (!c) return;
      dlg.close();
      setTimeout(() => c.run(), 0);
    }
    input.addEventListener('input', () => {
      active = 0;
      render();
    });
    input.addEventListener('keydown', e => {
      const n = shown.length;
      if (e.key === 'ArrowDown' && n) {
        e.preventDefault();
        active = (active + 1) % n;
        render();
      } else if (e.key === 'ArrowUp' && n) {
        e.preventDefault();
        active = (active - 1 + n) % n;
        render();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        run(active);
      }
    });
    list.addEventListener('pointerdown', e => e.preventDefault());
    list.addEventListener('click', e => {
      const o = e.target.closest('[role=option]');
      if (o) run(+o.id.split('-o').pop());
    });
    list.addEventListener('pointermove', e => {
      const o = e.target.closest('[role=option]');
      if (o) {
        const i = +o.id.split('-o').pop();
        if (i !== active) {
          active = i;
          render();
        }
      }
    });
    const api = {
      open(q) {
        input.value = q || '';
        active = 0;
        render();
        if (!dlg.open) dlg.showModal();
        input.focus();
      }
    };
    if (opt.shortcut) document.addEventListener('keydown', e => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        dlg.open ? dlg.close() : api.open();
      }
    });
    T.palette = async q => {
      api.open(q);
      await paint();
    };
    return api;
  };

  /* Menubar: <ul class="fm-menubar" role="menubar"> of <li role="none"><button class="fm-menubar__top" aria-controls="menuId"> + <div role="menu" hidden>.
     ← → between menus (open menus follow), ↓/Enter/Space open, ↑ opens at the end, Home/End, Esc closes to the top item. Emits fm-change "Menu → Item". */
  FM.menubar = function (bar) {
    const tops = [...bar.querySelectorAll('.fm-menubar__top')];
    let openI = -1;
    tops.forEach((t, i) => {
      t.setAttribute('role', 'menuitem');
      t.setAttribute('aria-haspopup', 'menu');
      t.setAttribute('aria-expanded', 'false');
      t.tabIndex = i ? -1 : 0;
    });
    const menu = i => document.getElementById(tops[i].getAttribute('aria-controls'));
    const its = i => [...menu(i).querySelectorAll('[role=menuitem]')];
    function rove(i) {
      tops.forEach((t, j) => t.tabIndex = j === i ? 0 : -1);
    }
    function close(focusTop) {
      if (openI < 0) return;
      const i = openI;
      menu(i).hidden = true;
      tops[i].setAttribute('aria-expanded', 'false');
      openI = -1;
      if (focusTop) tops[i].focus();
    }
    function open(i, last) {
      close(false);
      openI = i;
      rove(i);
      menu(i).hidden = false;
      tops[i].setAttribute('aria-expanded', 'true');
      const l = its(i);
      l.forEach(x => x.tabIndex = -1);
      const f = last ? l[l.length - 1] : l[0];
      if (f) f.focus();
    }
    function step(i, d) {
      const n = (i + d + tops.length) % tops.length;
      if (openI >= 0) open(n);else {
        rove(n);
        tops[n].focus();
      }
    }
    bar.addEventListener('keydown', e => {
      const t = e.target.closest('.fm-menubar__top'),
        it = e.target.closest('[role=menu] [role=menuitem]');
      if (t && !it) {
        const i = tops.indexOf(t);
        const k = {
          ArrowRight: () => step(i, 1),
          ArrowLeft: () => step(i, -1),
          ArrowDown: () => open(i),
          Enter: () => open(i),
          ' ': () => open(i),
          ArrowUp: () => open(i, true),
          Home: () => step(0, 0),
          End: () => step(tops.length - 1, 0),
          Escape: () => close(true)
        }[e.key];
        if (k) {
          e.preventDefault();
          k();
        }
        return;
      }
      if (it && openI >= 0) {
        const l = its(openI),
          k = l.indexOf(it);
        const f = {
          ArrowDown: () => l[(k + 1) % l.length].focus(),
          ArrowUp: () => l[(k - 1 + l.length) % l.length].focus(),
          Home: () => l[0].focus(),
          End: () => l[l.length - 1].focus(),
          Escape: () => close(true),
          ArrowRight: () => open((openI + 1) % tops.length),
          ArrowLeft: () => open((openI - 1 + tops.length) % tops.length)
        }[e.key];
        if (f) {
          e.preventDefault();
          f();
        } else if (e.key === 'Tab') close(false);
      }
    });
    bar.addEventListener('click', e => {
      const it = e.target.closest('[role=menu] [role=menuitem]');
      if (it && openI >= 0) {
        const top = tops[openI].textContent.trim();
        close(true);
        bar.dispatchEvent(new CustomEvent('fm-change', {
          bubbles: true,
          detail: {
            value: top + ' → ' + it.textContent.trim()
          }
        }));
        return;
      }
      const t = e.target.closest('.fm-menubar__top');
      if (t) {
        const i = tops.indexOf(t);
        openI === i ? close(true) : open(i);
      }
    });
    bar.addEventListener('pointerover', e => {
      const t = e.target.closest('.fm-menubar__top');
      if (t && openI >= 0 && tops.indexOf(t) !== openI) open(tops.indexOf(t));
    });
    document.addEventListener('pointerdown', e => {
      if (openI >= 0 && !bar.contains(e.target)) close(false);
    });
  };

  /* Carousel: <section class="fm-carousel" aria-roledescription="carousel"> with [data-prev] [data-next] .fm-carousel__pos .fm-carousel__track. */
  FM.carousel = function (el) {
    const tr = el.querySelector('.fm-carousel__track'),
      prev = el.querySelector('[data-prev]'),
      next = el.querySelector('[data-next]'),
      pos = el.querySelector('.fm-carousel__pos');
    const slides = [...tr.children],
      n = slides.length;
    if (!n) return;
    slides.forEach((s, i) => {
      s.setAttribute('role', 'group');
      s.setAttribute('aria-roledescription', 'slide');
      s.setAttribute('aria-label', i + 1 + ' of ' + n);
    });
    const cur = () => {
      let k = 0;
      slides.forEach((s, i) => {
        if (s.offsetLeft <= tr.scrollLeft + 4) k = i;
      });
      return k;
    };
    function upd() {
      const k = cur(),
        v = Math.max(1, Math.round(tr.clientWidth / (slides[0].offsetWidth + 16))),
        last = Math.min(n, k + v);
      pos.textContent = (last > k + 1 ? k + 1 + '–' + last : k + 1) + ' of ' + n;
      prev.disabled = tr.scrollLeft <= 2;
      next.disabled = tr.scrollLeft + tr.clientWidth >= tr.scrollWidth - 2;
    }
    const smooth = () => !(T.on || matchMedia('(prefers-reduced-motion: reduce)').matches);
    const go = d => {
      const k = Math.max(0, Math.min(n - 1, cur() + d));
      tr.scrollTo({
        left: slides[k].offsetLeft,
        behavior: smooth() ? 'smooth' : 'auto'
      });
    };
    prev.addEventListener('click', () => go(-1));
    next.addEventListener('click', () => go(1));
    let t;
    tr.addEventListener('scroll', () => {
      clearTimeout(t);
      t = setTimeout(upd, 60);
    });
    addEventListener('resize', upd);
    upd();
  };

  /* Test helpers — call from page.evaluate(). Each returns once the state is painted. */
  const $ = s => typeof s === 'string' ? document.querySelector(s) : s;
  const paint = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
  T.tooltip = async s => {
    showTip($(s));
    await paint();
  };
  T.hideTooltip = async () => {
    hideTip();
    await paint();
  };
  T.openCalendar = async s => {
    const el = $(s);
    const b = el.querySelector('[data-cal-open]');
    if (b.getAttribute('aria-expanded') !== 'true') b.click();
    await paint();
  };
  T.openCombo = async (s, q) => {
    const el = $(s);
    const i = el.querySelector('input');
    i.focus();
    i.value = q || '';
    i.dispatchEvent(new Event('input', {
      bubbles: true
    }));
    await paint();
  };
  T.toast = async (msg, opt) => {
    FM.toast(msg, Object.assign({
      duration: 0
    }, opt));
    await paint();
  };
  T.dialog = async id => {
    document.getElementById(id).showModal();
    await paint();
  };
  T.clear = async () => {
    hideTip();
    document.querySelectorAll('.fm-toast').forEach(t => t.remove());
    document.querySelectorAll('dialog[open]').forEach(d => d.close());
    document.querySelectorAll('.fm-cal.fm-overlay').forEach(c => {
      c.hidden = true;
    });
    document.querySelectorAll('[role=combobox]').forEach(i => i.blur());
    await paint();
  };
  function only(id) {
    const el = document.querySelector('[data-testid="' + CSS.escape(id) + '"]');
    if (!el) {
      console.warn('FM: no element with data-testid="' + id + '"');
      return;
    }
    document.documentElement.classList.add('fm-only');
    el.setAttribute('data-fm-only', '');
    for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) p.setAttribute('data-fm-path', '');
  }
  T.ready = new Promise(res => {
    const go = () => {
      FM.init();
      if (QS.get('only')) only(QS.get('only'));
      (document.fonts ? document.fonts.ready : Promise.resolve()).then(paint).then(() => {
        document.documentElement.dataset.fmReady = 'true';
        res();
      });
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', go);else go();
  });
})();
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/components/kit.js", error: String((e && e.message) || e) }); }

// ui_kits/components/match.js
try { (() => {
/* FortyMM match primitives (v2.1) — shared by the gallery, previews and app screens.
   FMMatch.row(m)      match row: status, names, games won (boxed), current points (large), game-score disclosure
   FMMatch.games(m)    game history table
   FMMatch.slot(m)     schedule block (button; full names in tooltip + accessible name)
   FMMatch.timeline()  schedule timeline from FMMatch.day
   FMMatch.detail(m)   match detail card with state-appropriate actions
   Markup uses kit.css classes only, so it can also be written by hand. */
(function () {
  const esc = s => String(s).replace(/[&<>"]/g, c => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;'
  })[c]);
  const min = t => {
    const [h, m] = t.split(':').map(Number);
    return h * 60 + m;
  };
  const fmt = n => String(Math.floor(n / 60)).padStart(2, '0') + ':' + String(n % 60).padStart(2, '0');
  const ic = n => '<span data-icon="' + n + '"></span>';
  function st(m) {
    const g = m.games || [];
    const inPlay = (m.state === 'live' || m.state === 'offline') && g.length;
    const done = inPlay ? g.slice(0, -1) : g;
    const cur = inPlay ? g[g.length - 1] : null;
    const won = [0, 1].map(i => done.filter(x => x[i] > x[1 - i]).length);
    return {
      done,
      cur,
      won,
      winner: m.state === 'final' ? won[0] > won[1] ? 0 : 1 : -1
    };
  }
  const short = p => p.short || p.name.split(',')[0];
  const vs = m => esc(m.p[0].name) + ' vs ' + esc(m.p[1].name);
  function status(m) {
    switch (m.state) {
      case 'live':
        return '<span class="live-marker">Live</span>';
      case 'final':
        return '<span class="fm-status">Final</span>';
      case 'offline':
        return '<span class="fm-status fm-status--offline">Scorer offline</span>';
      case 'conflict':
        return '<span class="fm-status fm-status--conflict">' + ic('alert') + 'Needs decision</span>';
      default:
        if (m.called) return '<span class="fm-status">' + ic('check') + 'Called</span>';
        return '<span class="fm-status">' + ic('clock') + '<span class="num">' + m.start + '</span></span>';
    }
  }
  function games(m) {
    const s = st(m);
    const all = s.cur ? s.done.concat([s.cur]) : s.done;
    if (!all.length) return '<p class="fm-help">No games played yet.</p>';
    let h = '<table class="fm-games"><caption class="fm-sr">Game scores, ' + vs(m) + '</caption><thead><tr><th scope="col"><span class="fm-sr">Player</span></th>';
    all.forEach((g, i) => {
      const c = s.cur && i === all.length - 1;
      h += '<th scope="col"' + (c ? ' class="cur"' : '') + '>' + (c ? 'Game ' + (i + 1) + ' · now' : 'Game ' + (i + 1)) + '</th>';
    });
    h += '</tr></thead><tbody>';
    [0, 1].forEach(p => {
      h += '<tr><th scope="row">' + esc(short(m.p[p])) + '</th>';
      all.forEach((g, i) => {
        const c = s.cur && i === all.length - 1;
        h += '<td class="' + (c ? 'cur' : g[p] > g[1 - p] ? 'w' : '') + '">' + g[p] + '</td>';
      });
      h += '</tr>';
    });
    return h + '</tbody></table>';
  }
  function row(m, o) {
    o = o || {};
    const s = st(m);
    const scored = m.state === 'live' || m.state === 'offline';
    const id = (o.idPrefix || 'm') + '-' + m.id;
    const meta = [m.state !== 'upcoming' && m.state !== 'conflict' ? 'Table ' + m.table : 'Table ' + m.table, m.round, m.state === 'live' && s.cur ? 'Game ' + (s.done.length + 1) : null, m.state === 'offline' ? 'last update <span class="num">' + m.offlineSince + '</span>' : null].filter(Boolean).join(' · ');
    let h = '<article class="fm-match' + (o.lg ? ' fm-match--lg' : '') + '" data-state="' + m.state + '" aria-label="' + vs(m) + '"><div class="fm-match__head">' + status(m) + '<span>' + meta + '</span></div>';
    if (o.cols !== false && (scored || m.state === 'final')) h += '<div class="fm-match__p fm-match__cols" aria-hidden="true"><span></span><span></span><span>Games</span>' + (scored ? '<span>Points</span>' : '') + '</div>';
    [0, 1].forEach(i => {
      const p = m.p[i];
      const cls = s.winner === -1 ? '' : s.winner === i ? 'w' : 'l';
      h += '<div class="fm-match__p ' + cls + '"><span class="fm-match__name">' + esc(p.name) + (o.club && p.club ? '<small>' + esc(p.club) + '</small>' : '') + '</span>';
      if (scored || m.state === 'final') {
        h += '<span>' + (scored && m.serve === i ? '<span class="serve-marker" role="img" aria-label="Serving"></span>' : '') + '</span><span class="fm-match__games" aria-label="' + s.won[i] + ' games won">' + s.won[i] + '</span>';
        if (scored) h += '<span class="fm-match__pts" aria-label="' + (s.cur ? s.cur[i] : 0) + ' points in this game">' + (s.cur ? s.cur[i] : 0) + '</span>';
      }
      h += '</div>';
    });
    if (m.rest) h += '<p class="fm-notice fm-notice--rest">' + ic('clock') + '<span>' + esc(m.rest.who) + ' rests until <span class="num">' + m.rest.until + '</span></span></p>';
    if ((m.games || []).length && o.details !== false) h += '<button class="fm-match__toggle" data-disclosure aria-expanded="false" aria-controls="' + id + '-g">Game scores' + ic('chevron') + '</button><div id="' + id + '-g" hidden>' + games(m) + '</div>';
    return h + '</article>';
  }
  function slot(m, o) {
    o = o || {};
    const t0 = o.t0 || min('10:30');
    const left = min(m.start) - t0,
      w = min(m.end) - min(m.start);
    const pos = o.abs !== false ? ' style="left:calc(' + left + ' * var(--ppm));width:calc(' + w + ' * var(--ppm) - 6px)"' : '';
    if (m.state === 'free') return '<div class="fm-slot" data-state="free"' + pos + '><span class="fm-slot__status">Free</span><span class="fm-slot__time">' + m.start + '–' + m.end + '</span></div>';
    const s = st(m);
    let top = '';
    if (m.state === 'live') top = '<span class="fm-slot__status live-marker">Live</span>';else if (m.state === 'final') top = '<span class="fm-slot__status">Final <span class="num">' + s.won[0] + '–' + s.won[1] + '</span></span>';else if (m.state === 'offline') top = '<span class="fm-slot__status">Scorer offline</span>';else if (m.state === 'conflict') top = '<span class="fm-slot__status">Needs decision</span>';else if (m.rest) top = '<span class="fm-slot__status rest">' + esc(m.rest.who) + ' rests to <span class="num">' + m.rest.until + '</span></span>';
    const time = m.state === 'live' || m.state === 'offline' ? 'since ' + m.start : m.start + '–' + m.end;
    const tipText = m.p[0].name + ' vs ' + m.p[1].name + ' · Table ' + m.table + ' · ' + time + (m.state === 'conflict' && m.conflict ? ' · ' + m.conflict.short : '');
    return '<button class="fm-slot" data-state="' + m.state + '" data-id="' + m.id + '" aria-pressed="false" data-tip="' + esc(tipText) + '" data-label="' + esc(short(m.p[0]) + ' vs ' + short(m.p[1])) + '"' + pos + '>' + top + '<span class="fm-slot__names"><span>' + esc(short(m.p[0])) + '</span><span>' + esc(short(m.p[1])) + '</span></span><span class="fm-slot__time">' + time + '</span><span class="fm-sr">' + esc(tipText) + '</span></button>';
  }
  function timeline(o) {
    o = o || {};
    const d = FMMatch.day,
      t0 = min(d.from),
      t1 = min(d.to);
    let h = '<div class="fm-timeline" data-select="single" data-announce="on" aria-label="Schedule, ' + d.from + ' to ' + d.to + '"><span aria-hidden="true"></span><div class="fm-timeline__ruler" aria-hidden="true" style="width:calc(' + (t1 - t0) + ' * var(--ppm))">';
    for (let t = t0; t < t1; t += 30) h += '<span style="left:calc(' + (t - t0) + ' * var(--ppm))">' + fmt(t) + '</span>';
    if (d.now) h += '<span class="now" style="left:calc(' + (min(d.now) - t0) + ' * var(--ppm))">Now ' + d.now + '</span>';
    h += '</div>';
    d.tables.forEach(tb => {
      h += '<div class="fm-timeline__table">Table ' + tb + '</div><div class="fm-timeline__track" role="group" aria-label="Table ' + tb + '" style="width:calc(' + (t1 - t0) + ' * var(--ppm))">';
      d.matches.filter(m => m.table === tb).forEach(m => h += slot(m, {
        t0
      }));
      if (d.now) h += '<span class="fm-timeline__now" style="left:calc(' + (min(d.now) - t0) + ' * var(--ppm))"></span>';
      h += '</div>';
    });
    return h + '</div>';
  }
  function detail(m) {
    const s = st(m);
    let alert = '',
      acts = '';
    if (m.state === 'conflict' && m.conflict) alert = '<div class="fm-alert fm-alert--warning" role="group" aria-label="Scheduling conflict">' + ic('alert') + '<p class="fm-alert__title">' + esc(m.conflict.title) + '</p><p class="fm-alert__body">' + esc(m.conflict.body) + '</p><div class="fm-alert__actions"><button class="fm-btn fm-btn--primary fm-btn--sm" data-act="fix">' + esc(m.conflict.fix) + '</button><button class="fm-btn fm-btn--secondary fm-btn--sm" data-act="keep">Keep ' + m.start + '</button></div></div>';
    if (m.state === 'offline') alert = '<div class="fm-alert fm-alert--error" role="alert">' + ic('offline') + '<p class="fm-alert__title">Table ' + m.table + ' scorer is offline</p><p class="fm-alert__body">Last score arrived at <span class="num">' + m.offlineSince + '</span>. Points entered on that device will sync when it reconnects.</p><div class="fm-alert__actions"><button class="fm-btn fm-btn--primary fm-btn--sm" data-act="takeover">Score from this device</button><button class="fm-btn fm-btn--secondary fm-btn--sm" data-act="ping">Send a reminder</button></div></div>';
    if (m.kept) alert = '<p class="fm-notice fm-notice--warning">' + ic('alert') + '<span>' + esc(m.conflict.kept) + '</span></p>';
    if (m.state === 'live') acts = '<a class="fm-btn fm-btn--secondary" href="../tournament/mobile.html">Open scoring</a><button class="fm-btn fm-btn--ghost" data-demo>Move to another table</button>';
    if (m.state === 'upcoming') acts = (m.called ? '<button class="fm-btn fm-btn--secondary" data-uncall="' + m.id + '">Cancel call</button>' : '<button class="fm-btn fm-btn--primary" data-act="call"' + (m.rest ? ' aria-disabled="true" data-tip="' + esc(m.rest.who) + ' is resting until ' + m.rest.until + '"' : '') + '>Call to table</button>') + '<button class="fm-btn fm-btn--ghost" data-demo>Reschedule</button><button class="fm-btn fm-btn--danger end" data-dialog="dlg-withdraw">Withdraw a player…</button>';
    if (m.state === 'final') acts = '<button class="fm-btn fm-btn--secondary" data-demo>Edit result</button><button class="fm-btn fm-btn--ghost" data-demo>Print score sheet</button>';
    const facts = [['Event', m.event], ['Round', m.round], ['Table', 'Table ' + m.table], [m.state === 'final' ? 'Played' : 'Start', m.state === 'final' ? m.start + '–' + m.end : m.start]];
    return '<section class="fm-card" aria-labelledby="dt-' + m.id + '"><div class="fm-card__head"><div><h3 class="fm-card__title" id="dt-' + m.id + '">' + esc(short(m.p[0])) + ' vs ' + esc(short(m.p[1])) + '</h3><p class="fm-card__sub">' + esc(m.event) + ' · ' + esc(m.round) + '</p></div>' + status(m) + '</div><div class="fm-card__body">' + row(m, {
      cols: true,
      details: false,
      club: true,
      lg: true,
      idPrefix: 'd'
    }).replace('<div class="fm-match__head">', '<div class="fm-match__head" hidden>') + alert + ((m.games || []).length ? '<div><h4 class="fm-section-title" style="margin-bottom:8px">Game scores</h4><div class="fm-scroll">' + games(m) + '</div></div>' : '') + '<dl class="fm-dl">' + facts.map(f => '<div><dt>' + f[0] + '</dt><dd>' + esc(f[1]) + '</dd></div>').join('') + '</dl></div>' + (acts ? '<div class="fm-card__foot">' + acts + '</div>' : '') + '</section>';
  }
  const P = (name, club, s) => ({
    name,
    club,
    short: s
  });
  const day = {
    from: '10:30',
    to: '13:00',
    now: '11:47',
    tables: [1, 2, 3, 4],
    matches: [{
      id: 'a1',
      table: 1,
      state: 'final',
      start: '10:30',
      end: '11:05',
      event: 'Open singles',
      round: 'Round of 32',
      p: [P('Nguyen, Thanh', 'Riverside TT'), P('Silva, Rafael', 'Northside')],
      games: [[11, 7], [9, 11], [11, 8], [11, 6]]
    }, {
      id: 'a2',
      table: 1,
      state: 'live',
      start: '11:10',
      end: '11:45',
      event: 'Open singles',
      round: 'Round of 16',
      serve: 0,
      p: [P('Okafor-Adeyemi, Daniel', 'Eastgate'), P('Johansen-Whitfield, Annika', 'Northside')],
      games: [[11, 9], [8, 11], [11, 6], [8, 6]]
    }, {
      id: 'a3',
      table: 1,
      state: 'upcoming',
      start: '12:00',
      end: '12:35',
      event: 'Open singles',
      round: 'Round of 16',
      p: [P('Chen, Wei', 'Riverside TT'), P('Ali, Rashid', 'Eastgate')],
      games: []
    }, {
      id: 'b1',
      table: 2,
      state: 'final',
      start: '10:30',
      end: '11:00',
      event: 'Under 18 singles',
      round: 'Quarterfinal',
      p: [P('Lindqvist, Erik', 'Northside'), P('Haddad, Youssef', 'Riverside TT')],
      games: [[11, 5], [11, 8], [11, 4]]
    }, {
      id: 'b2',
      table: 2,
      state: 'free',
      start: '11:05',
      end: '11:45'
    }, {
      id: 'b3',
      table: 2,
      state: 'conflict',
      start: '11:50',
      end: '12:25',
      event: 'Open singles',
      round: 'Round of 16',
      p: [P('Patel, Meera', 'Riverside TT'), P('Park, Ji-ho', 'Eastgate')],
      games: [],
      conflict: {
        short: 'Patel would rest 5 min',
        title: 'Patel would get 5 minutes’ rest',
        body: 'Her match on Table 3 is running 10 minutes over. Starting at 12:05 keeps the 15-minute minimum.',
        fix: 'Move to 12:05',
        kept: 'Kept at 11:50 by the organizer. Patel gets 5 minutes’ rest, under the 15-minute minimum.'
      }
    }, {
      id: 'c1',
      table: 3,
      state: 'final',
      start: '10:30',
      end: '11:05',
      event: 'Open singles',
      round: 'Round of 32',
      p: [P('Moreau, Élodie', 'Eastgate'), P('Kim, Hyun-woo', 'Northside')],
      games: [[11, 9], [7, 11], [11, 13], [11, 8], [12, 10]]
    }, {
      id: 'c2',
      table: 3,
      state: 'live',
      start: '11:05',
      end: '11:45',
      event: 'Open singles',
      round: 'Round of 32',
      serve: 1,
      p: [P('Patel, Meera', 'Riverside TT'), P('Wójcik-Szymańska, Agnieszka', 'Northside')],
      games: [[11, 8], [6, 11], [11, 9], [9, 11], [9, 9]]
    }, {
      id: 'c3',
      table: 3,
      state: 'upcoming',
      start: '12:15',
      end: '12:50',
      event: 'Under 18 singles',
      round: 'Semifinal',
      p: [P('Dubois, Camille', 'Eastgate'), P('Lindqvist, Erik', 'Northside')],
      games: [],
      rest: {
        who: 'Lindqvist',
        until: '12:10'
      }
    }, {
      id: 'd1',
      table: 4,
      state: 'offline',
      start: '11:00',
      end: '11:40',
      event: 'Open doubles',
      round: 'Quarterfinal',
      serve: 1,
      offlineSince: '11:42',
      p: [P('Rossi, Giulia / Haddad, Youssef', 'Riverside TT', 'Rossi / Haddad'), P('Fernández-Castillo, Marisol / Kim, Hyun-woo', 'Northside', 'Fernández-Castillo / Kim')],
      games: [[11, 7], [5, 11], [4, 7]]
    }, {
      id: 'd2',
      table: 4,
      state: 'upcoming',
      start: '12:05',
      end: '12:40',
      event: 'Open singles',
      round: 'Round of 16',
      p: [P('Moreau, Élodie', 'Eastgate'), P('Silva, Rafael', 'Northside')],
      games: []
    }]
  };
  window.FMMatch = {
    row,
    games,
    slot,
    timeline,
    detail,
    status,
    day,
    find: id => day.matches.find(m => m.id === id)
  };
})();
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/components/match.js", error: String((e && e.message) || e) }); }

// ui_kits/ios/screens.jsx
try { (() => {
// FortyMM mobile — Match scoring screen + Today screen.
// Styles read tokens from colors_and_type.css (linked by index.html).

const mt = {
  num: "var(--font-num)",
  ui: "var(--font-ui)"
};
function PhoneFrame({
  children,
  label
}) {
  return /*#__PURE__*/React.createElement("figure", {
    style: {
      margin: 0,
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      gap: 12
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      width: 390,
      height: 844,
      borderRadius: 44,
      overflow: 'hidden',
      position: 'relative',
      background: 'var(--bg-app)',
      border: '8px solid #000',
      outline: '1px solid var(--ink-600)',
      display: 'flex',
      flexDirection: 'column'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      height: 44,
      flex: 'none',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      padding: '0 28px',
      font: '600 15px -apple-system, system-ui',
      color: 'var(--fg-1)'
    }
  }, /*#__PURE__*/React.createElement("span", null, "19:15"), /*#__PURE__*/React.createElement("span", {
    style: {
      width: 24,
      height: 11,
      border: '1px solid var(--fg-2)',
      borderRadius: 3
    }
  })), children), label && /*#__PURE__*/React.createElement("figcaption", {
    style: {
      font: '500 13px var(--font-ui)',
      color: 'var(--fg-3)'
    }
  }, label));
}

// ---------- scoring logic ----------
const PLAYERS = [{
  last: 'Nguyen',
  full: 'Nguyen, Thanh',
  club: 'Riverside TT'
}, {
  last: 'Okafor',
  full: 'Okafor, Daniel',
  club: 'Eastgate'
}];
function serverFor(pts, firstServer) {
  const total = pts[0] + pts[1];
  const swaps = total >= 20 ? 10 + (total - 20) : Math.floor(total / 2);
  return (firstServer + swaps) % 2;
}
function MatchScreen() {
  const [st, setSt] = React.useState({
    games: [[11, 6], [9, 11]],
    pts: [8, 6],
    hist: [],
    flash: [0, 0],
    notice: null
  });
  const {
    games,
    pts,
    hist,
    flash,
    notice
  } = st;
  const firstServer = games.length % 2; // alternates each game
  const won = [games.filter(g => g[0] > g[1]).length, games.filter(g => g[1] > g[0]).length];
  const matchOver = won[0] === 3 || won[1] === 3;
  const server = serverFor(pts, firstServer);
  function point(i) {
    setSt(s => {
      const w = [s.games.filter(g => g[0] > g[1]).length, s.games.filter(g => g[1] > g[0]).length];
      if (w[0] === 3 || w[1] === 3) return s;
      const np = [...s.pts];
      np[i]++;
      const flash = [...s.flash];
      flash[i]++;
      const hist = [...s.hist, {
        games: s.games,
        pts: s.pts
      }];
      if (np[i] >= 11 && np[i] - np[1 - i] >= 2) {
        return {
          games: [...s.games, np],
          pts: [0, 0],
          hist,
          flash,
          notice: `Game ${s.games.length + 1} to ${PLAYERS[i].last}, ${np[i]}–${np[1 - i]}`
        };
      }
      return {
        ...s,
        pts: np,
        hist,
        flash,
        notice: null
      };
    });
  }
  function undo() {
    setSt(s => {
      if (!s.hist.length) return s;
      const last = s.hist[s.hist.length - 1];
      return {
        ...s,
        games: last.games,
        pts: last.pts,
        hist: s.hist.slice(0, -1),
        notice: 'Point removed'
      };
    });
  }
  const ghost = {
    height: 44,
    padding: '0 14px',
    borderRadius: 8,
    border: '1px solid var(--border-control)',
    background: 'transparent',
    color: 'var(--fg-1)',
    font: '600 15px var(--font-ui)',
    cursor: 'pointer'
  };
  return /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      display: 'flex',
      flexDirection: 'column',
      minHeight: 0
    }
  }, /*#__PURE__*/React.createElement("header", {
    style: {
      padding: '4px 20px 14px',
      display: 'flex',
      flexDirection: 'column',
      gap: 6,
      borderBottom: '1px solid var(--border-subtle)'
    }
  }, /*#__PURE__*/React.createElement("a", {
    style: {
      font: '500 15px var(--font-ui)',
      color: 'var(--fg-3)',
      textDecoration: 'none'
    }
  }, "\u2039 Spring Open"), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: 12
    }
  }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    style: {
      font: '600 22px/1.2 var(--font-ui)',
      color: 'var(--fg-1)'
    }
  }, "Table 3"), /*#__PURE__*/React.createElement("div", {
    style: {
      font: '400 14px var(--font-ui)',
      color: 'var(--fg-3)'
    }
  }, "Round of 16 \xB7 Best of 5")), matchOver ? /*#__PURE__*/React.createElement("span", {
    style: {
      font: '600 13px var(--font-ui)',
      color: 'var(--fg-2)'
    }
  }, "Final") : /*#__PURE__*/React.createElement("span", {
    className: "live-marker"
  }, "Live")), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 14,
      alignItems: 'baseline',
      flexWrap: 'wrap',
      marginTop: 4
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      font: '500 13px var(--font-ui)',
      color: 'var(--fg-3)'
    }
  }, "Games"), games.map((g, k) => /*#__PURE__*/React.createElement("span", {
    key: k,
    style: {
      font: '500 15px var(--font-num)',
      color: 'var(--fg-2)'
    }
  }, /*#__PURE__*/React.createElement("b", {
    style: {
      color: 'var(--fg-1)',
      fontWeight: g[0] > g[1] ? 700 : 400
    }
  }, g[0]), "\u2013", /*#__PURE__*/React.createElement("b", {
    style: {
      color: 'var(--fg-1)',
      fontWeight: g[1] > g[0] ? 700 : 400
    }
  }, g[1]))), !matchOver && /*#__PURE__*/React.createElement("span", {
    style: {
      font: '500 13px var(--font-ui)',
      color: 'var(--fg-3)'
    }
  }, "Game ", games.length + 1, " now"))), [0, 1].map(i => {
    const lead = pts[i] > pts[1 - i];
    return /*#__PURE__*/React.createElement("section", {
      key: i,
      style: {
        flex: 1,
        display: 'grid',
        gridTemplateColumns: 'minmax(0,1fr) auto',
        gridTemplateRows: '1fr auto',
        gap: '8px 12px',
        padding: '16px 20px',
        borderBottom: i === 0 ? '1px solid var(--border-subtle)' : 'none',
        minHeight: 0
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
        alignSelf: 'start'
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        font: '600 24px/1.2 var(--font-ui)',
        color: 'var(--fg-1)'
      }
    }, PLAYERS[i].full), /*#__PURE__*/React.createElement("div", {
      style: {
        font: '400 14px var(--font-ui)',
        color: 'var(--fg-3)'
      }
    }, PLAYERS[i].club, " \xB7 games won ", /*#__PURE__*/React.createElement("span", {
      style: {
        fontFamily: 'var(--font-num)',
        color: 'var(--fg-1)',
        fontWeight: 600
      }
    }, won[i])), !matchOver && server === i && /*#__PURE__*/React.createElement("div", {
      style: {
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        marginTop: 6,
        font: '500 14px var(--font-ui)',
        color: 'var(--fg-1)'
      }
    }, /*#__PURE__*/React.createElement("span", {
      className: "serve-marker"
    }), "Serving")), /*#__PURE__*/React.createElement("span", {
      key: flash[i],
      className: flash[i] ? 'score-updated' : '',
      "aria-live": "polite",
      style: {
        alignSelf: 'start',
        font: '700 112px/1 var(--font-num)',
        fontVariantNumeric: 'tabular-nums',
        letterSpacing: '-0.04em',
        color: lead || pts[0] === pts[1] ? 'var(--fg-1)' : 'var(--fg-2)',
        borderRadius: 8,
        padding: '0 6px',
        minWidth: 140,
        textAlign: 'right'
      }
    }, pts[i]), /*#__PURE__*/React.createElement("button", {
      onClick: () => point(i),
      disabled: matchOver,
      className: "fm-press",
      style: {
        gridColumn: '1 / -1',
        height: 56,
        borderRadius: 8,
        border: 0,
        background: matchOver ? 'var(--bg-panel)' : 'var(--accent)',
        color: matchOver ? 'var(--fg-disabled)' : 'var(--on-accent)',
        font: '600 17px var(--font-ui)',
        cursor: matchOver ? 'default' : 'pointer'
      }
    }, "Point to ", PLAYERS[i].last));
  }), /*#__PURE__*/React.createElement("footer", {
    style: {
      borderTop: '1px solid var(--border-subtle)',
      padding: '12px 20px 28px',
      display: 'flex',
      flexDirection: 'column',
      gap: 10
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      minHeight: 20,
      font: '500 14px var(--font-ui)',
      color: 'var(--fg-2)'
    },
    "aria-live": "polite"
  }, matchOver ? `${PLAYERS[won[0] === 3 ? 0 : 1].last} wins ${Math.max(...won)}–${Math.min(...won)}. Submit to update ratings.` : notice || 'Next on this table: Chen vs Ali, about 20:05'), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 8
    }
  }, /*#__PURE__*/React.createElement("button", {
    onClick: undo,
    disabled: !hist.length,
    style: {
      ...ghost,
      flex: 1,
      opacity: hist.length ? 1 : 0.45
    }
  }, "Undo point"), /*#__PURE__*/React.createElement("button", {
    style: {
      ...ghost,
      flex: 1
    }
  }, matchOver ? 'Submit result' : 'Time-out'))));
}

// ---------- Today screen ----------
function TodayRow({
  head,
  headColor,
  a,
  b,
  sa,
  sb,
  server,
  live
}) {
  const row = (n, s, srv, w) => /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'grid',
      gridTemplateColumns: 'minmax(0,1fr) 14px 32px',
      gap: 8,
      alignItems: 'center'
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      font: `${w ? 700 : 500} 16px/1.3 var(--font-ui)`,
      color: w === false ? 'var(--loser)' : 'var(--fg-1)'
    }
  }, n), /*#__PURE__*/React.createElement("span", null, srv && /*#__PURE__*/React.createElement("span", {
    className: "serve-marker"
  })), /*#__PURE__*/React.createElement("span", {
    style: {
      font: '700 22px var(--font-num)',
      textAlign: 'right',
      color: w === false ? 'var(--loser)' : 'var(--fg-1)'
    }
  }, s));
  const done = sa != null && !live;
  return /*#__PURE__*/React.createElement("div", {
    style: {
      padding: '12px 0',
      borderBottom: '1px solid var(--border-subtle)',
      display: 'flex',
      flexDirection: 'column',
      gap: 6
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 10,
      alignItems: 'center'
    }
  }, live && /*#__PURE__*/React.createElement("span", {
    className: "live-marker"
  }, "Live"), /*#__PURE__*/React.createElement("span", {
    style: {
      font: '400 13px var(--font-ui)',
      color: headColor || 'var(--fg-3)'
    }
  }, head)), row(a, sa, server === 0, done ? sa > sb : undefined), row(b, sb, server === 1, done ? sb > sa : undefined));
}
function TodayScreen() {
  const tab = (l, on) => /*#__PURE__*/React.createElement("span", {
    style: {
      flex: 1,
      textAlign: 'center',
      padding: '8px 0',
      borderRadius: 8,
      font: '600 13px var(--font-ui)',
      color: on ? 'var(--accent-text)' : 'var(--fg-3)',
      background: on ? 'var(--accent-soft)' : 'transparent'
    }
  }, l);
  return /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      display: 'flex',
      flexDirection: 'column',
      minHeight: 0
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      overflowY: 'auto',
      padding: '4px 20px 20px'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      font: '400 14px var(--font-ui)',
      color: 'var(--fg-3)'
    }
  }, "Spring Open \xB7 Riverside TT"), /*#__PURE__*/React.createElement("h1", {
    style: {
      font: '600 28px/1.2 var(--font-ui)',
      margin: '2px 0 18px',
      color: 'var(--fg-1)'
    }
  }, "Today"), /*#__PURE__*/React.createElement("section", {
    style: {
      background: 'var(--bg-panel)',
      border: '1px solid var(--border-subtle)',
      borderRadius: 8,
      padding: 16,
      display: 'flex',
      flexDirection: 'column',
      gap: 10
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      font: '500 14px var(--font-ui)',
      color: 'var(--fg-3)'
    }
  }, "Your next match"), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'baseline',
      gap: 12,
      flexWrap: 'wrap'
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      font: '600 26px/1.1 var(--font-ui)',
      color: 'var(--fg-1)'
    }
  }, "Table 2"), /*#__PURE__*/React.createElement("span", {
    style: {
      font: '600 26px/1.1 var(--font-num)',
      color: 'var(--fg-1)'
    }
  }, "19:40"), /*#__PURE__*/React.createElement("span", {
    style: {
      font: '400 15px var(--font-ui)',
      color: 'var(--fg-2)'
    }
  }, "in 25 min")), /*#__PURE__*/React.createElement("div", {
    style: {
      font: '500 17px var(--font-ui)',
      color: 'var(--fg-1)'
    }
  }, "vs Park, Ji-ho ", /*#__PURE__*/React.createElement("span", {
    style: {
      font: '400 14px var(--font-num)',
      color: 'var(--fg-3)'
    }
  }, "1,912")), /*#__PURE__*/React.createElement("div", {
    style: {
      font: '400 14px var(--font-ui)',
      color: 'var(--rest)'
    }
  }, "Rest until 19:35 \xB7 warm-up table 6 is free"), /*#__PURE__*/React.createElement("button", {
    style: {
      height: 48,
      borderRadius: 8,
      border: 0,
      background: 'var(--accent)',
      color: 'var(--on-accent)',
      font: '600 16px var(--font-ui)',
      marginTop: 4,
      cursor: 'pointer'
    }
  }, "I'm ready")), /*#__PURE__*/React.createElement("h2", {
    style: {
      font: '600 17px var(--font-ui)',
      margin: '24px 0 0',
      color: 'var(--fg-1)'
    }
  }, "On the tables now"), /*#__PURE__*/React.createElement(TodayRow, {
    live: true,
    head: "Table 3 \xB7 Game 3",
    a: "Nguyen, Thanh",
    b: "Okafor, Daniel",
    sa: 8,
    sb: 6,
    server: 0
  }), /*#__PURE__*/React.createElement(TodayRow, {
    live: true,
    head: "Table 1 \xB7 Game 2",
    a: "Johansen-Whitfield, Annika",
    b: "Rossi, Giulia",
    sa: 4,
    sb: 7,
    server: 1
  }), /*#__PURE__*/React.createElement("h2", {
    style: {
      font: '600 17px var(--font-ui)',
      margin: '24px 0 0',
      color: 'var(--fg-1)'
    }
  }, "Your results"), /*#__PURE__*/React.createElement("div", {
    style: {
      padding: '12px 0',
      borderBottom: '1px solid var(--border-subtle)',
      display: 'grid',
      gridTemplateColumns: 'minmax(0,1fr) auto',
      gap: 4
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      font: '600 16px var(--font-ui)',
      color: 'var(--fg-1)'
    }
  }, "Won against Silva, Rafael"), /*#__PURE__*/React.createElement("span", {
    className: "rating-up"
  }, "\u25B2 +12"), /*#__PURE__*/React.createElement("span", {
    style: {
      font: '400 13px var(--font-num)',
      color: 'var(--fg-3)'
    }
  }, "3\u20131 \xB7 11\u20137 9\u201311 11\u20138 11\u20136"), /*#__PURE__*/React.createElement("span", {
    style: {
      font: '400 13px var(--font-num)',
      color: 'var(--fg-3)',
      textAlign: 'right'
    }
  }, "1,859"))), /*#__PURE__*/React.createElement("nav", {
    style: {
      display: 'flex',
      gap: 4,
      padding: '8px 12px 28px',
      borderTop: '1px solid var(--border-subtle)',
      background: 'var(--bg-app)'
    }
  }, tab('Today', true), tab('Draws'), tab('Ratings'), tab('You')));
}
Object.assign(window, {
  PhoneFrame,
  MatchScreen,
  TodayScreen,
  TodayRow
});
function IOSApp() {
  return /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 48,
      flexWrap: 'wrap',
      justifyContent: 'center',
      padding: 40
    }
  }, /*#__PURE__*/React.createElement(PhoneFrame, {
    label: "Scoring a match \u2014 tap a point button to try it"
  }, /*#__PURE__*/React.createElement(MatchScreen, null)), /*#__PURE__*/React.createElement(PhoneFrame, {
    label: "Player's day at a tournament"
  }, /*#__PURE__*/React.createElement(TodayScreen, null)));
}
ReactDOM.createRoot(document.getElementById('root')).render(/*#__PURE__*/React.createElement(IOSApp, null));
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/ios/screens.jsx", error: String((e && e.message) || e) }); }

// ui_kits/marketing/components.jsx
try { (() => {
// FortyMM marketing site. Tokens from colors_and_type.css.

const mkBtn = {
  height: 48,
  padding: '0 20px',
  borderRadius: 8,
  font: '600 16px var(--font-ui)',
  cursor: 'pointer',
  border: '1px solid transparent',
  display: 'inline-flex',
  alignItems: 'center'
};
const mkPrimary = {
  ...mkBtn,
  background: 'var(--accent)',
  color: 'var(--on-accent)'
};
const mkSecondary = {
  ...mkBtn,
  background: 'transparent',
  color: 'var(--fg-1)',
  borderColor: 'var(--border-control)'
};
const mkWrap = {
  maxWidth: 1180,
  margin: '0 auto',
  padding: '0 clamp(20px,5vw,48px)'
};
function MkNav() {
  const link = {
    font: '500 15px var(--font-ui)',
    color: 'var(--fg-2)',
    textDecoration: 'none',
    cursor: 'pointer'
  };
  return /*#__PURE__*/React.createElement("nav", {
    style: {
      borderBottom: '1px solid var(--border-subtle)'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      ...mkWrap,
      display: 'flex',
      alignItems: 'center',
      gap: 28,
      height: 68,
      flexWrap: 'wrap'
    }
  }, /*#__PURE__*/React.createElement("img", {
    src: "../../assets/logo-wordmark.svg",
    alt: "FortyMM",
    style: {
      height: 30
    }
  }), /*#__PURE__*/React.createElement("a", {
    style: link
  }, "Features"), /*#__PURE__*/React.createElement("a", {
    style: link
  }, "For organizers"), /*#__PURE__*/React.createElement("a", {
    style: link
  }, "For clubs"), /*#__PURE__*/React.createElement("a", {
    style: link
  }, "About"), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1
    }
  }), /*#__PURE__*/React.createElement("a", {
    style: link
  }, "Sign in"), /*#__PURE__*/React.createElement("button", {
    style: {
      ...mkPrimary,
      height: 40,
      fontSize: 15
    }
  }, "Get the app")));
}
function MkScorePanel() {
  const row = (n, g, p, srv) => /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'grid',
      gridTemplateColumns: 'minmax(0,1fr) 14px 28px 64px',
      gap: 10,
      alignItems: 'center'
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      font: '600 20px/1.25 var(--font-ui)',
      color: 'var(--fg-1)'
    }
  }, n), /*#__PURE__*/React.createElement("span", null, srv && /*#__PURE__*/React.createElement("span", {
    className: "serve-marker"
  })), /*#__PURE__*/React.createElement("span", {
    style: {
      font: '500 18px var(--font-num)',
      color: 'var(--fg-3)',
      textAlign: 'right'
    }
  }, g), /*#__PURE__*/React.createElement("span", {
    style: {
      font: '700 48px/1 var(--font-num)',
      color: 'var(--fg-1)',
      textAlign: 'right'
    }
  }, p));
  return /*#__PURE__*/React.createElement("div", {
    style: {
      background: 'var(--bg-panel)',
      border: '1px solid var(--border-subtle)',
      borderRadius: 12,
      padding: 24,
      display: 'flex',
      flexDirection: 'column',
      gap: 14
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'center',
      gap: 12
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      font: '600 17px var(--font-ui)',
      color: 'var(--fg-1)'
    }
  }, "Table 3 ", /*#__PURE__*/React.createElement("span", {
    style: {
      fontWeight: 400,
      color: 'var(--fg-3)'
    }
  }, "\xB7 Round of 16 \xB7 Game 4")), /*#__PURE__*/React.createElement("span", {
    className: "live-marker"
  }, "Live")), row('Nguyen, Thanh', 2, 9, true), row('Okafor, Daniel', 1, 7, false), /*#__PURE__*/React.createElement("div", {
    style: {
      font: '400 15px var(--font-num)',
      color: 'var(--fg-3)'
    }
  }, "11\u20136 \xB7 9\u201311 \xB7 11\u20138"), /*#__PURE__*/React.createElement("div", {
    style: {
      borderTop: '1px solid var(--border-subtle)',
      paddingTop: 14,
      display: 'flex',
      gap: 24,
      flexWrap: 'wrap',
      font: '400 14px var(--font-ui)',
      color: 'var(--fg-2)'
    }
  }, /*#__PURE__*/React.createElement("span", null, "4 of 6 tables in use"), /*#__PURE__*/React.createElement("span", null, "Expected finish ", /*#__PURE__*/React.createElement("b", {
    style: {
      fontFamily: 'var(--font-num)',
      color: 'var(--fg-1)'
    }
  }, "18:40"))));
}
function MkHero() {
  return /*#__PURE__*/React.createElement("section", {
    style: {
      padding: 'clamp(48px,8vw,96px) 0'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      ...mkWrap,
      display: 'grid',
      gridTemplateColumns: 'repeat(auto-fit,minmax(min(100%,440px),1fr))',
      gap: 'clamp(32px,5vw,64px)',
      alignItems: 'center'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      flexDirection: 'column',
      gap: 24
    }
  }, /*#__PURE__*/React.createElement("h1", {
    style: {
      margin: 0,
      font: '700 clamp(40px,5.2vw,60px)/1.08 var(--font-ui)',
      letterSpacing: '-0.025em',
      color: 'var(--fg-1)',
      textWrap: 'balance'
    }
  }, "Keep score, run tournaments and follow your club\u2019s results."), /*#__PURE__*/React.createElement("p", {
    style: {
      margin: 0,
      font: '400 19px/1.55 var(--font-ui)',
      color: 'var(--fg-2)',
      maxWidth: 540,
      textWrap: 'pretty'
    }
  }, "FortyMM is a table-tennis app for players and organizers. Score matches from your phone, schedule a tournament across every table you have, and see results and ratings as they happen."), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 12,
      flexWrap: 'wrap'
    }
  }, /*#__PURE__*/React.createElement("button", {
    style: mkPrimary
  }, "Get the app"), /*#__PURE__*/React.createElement("button", {
    style: mkSecondary
  }, "Run a tournament")), /*#__PURE__*/React.createElement("p", {
    style: {
      margin: 0,
      font: '400 15px var(--font-ui)',
      color: 'var(--fg-3)'
    }
  }, "Free for players and clubs. No ads, no tracking.")), /*#__PURE__*/React.createElement(MkScorePanel, null)));
}
function MkFeatures() {
  const items = [['Score at the table', 'Large numbers, one tap per point and undo when you need it. Serve changes and game ends are tracked for you.'], ['Run the day', 'See which tables are free, who is resting and when the last match will finish. Conflicts come with a suggested fix.'], ['Follow your rating', 'Results update ratings straight away, with the change shown next to every match.']];
  return /*#__PURE__*/React.createElement("section", {
    style: {
      borderTop: '1px solid var(--border-subtle)',
      padding: '64px 0'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: mkWrap
  }, /*#__PURE__*/React.createElement("h2", {
    style: {
      margin: '0 0 32px',
      font: '600 28px var(--font-ui)',
      color: 'var(--fg-1)'
    }
  }, "What you can do"), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'grid',
      gridTemplateColumns: 'repeat(auto-fit,minmax(260px,1fr))',
      gap: 32
    }
  }, items.map(([t, d]) => /*#__PURE__*/React.createElement("div", {
    key: t,
    style: {
      display: 'flex',
      flexDirection: 'column',
      gap: 8
    }
  }, /*#__PURE__*/React.createElement("h3", {
    style: {
      margin: 0,
      font: '600 19px var(--font-ui)',
      color: 'var(--fg-1)'
    }
  }, t), /*#__PURE__*/React.createElement("p", {
    style: {
      margin: 0,
      font: '400 16px/1.55 var(--font-ui)',
      color: 'var(--fg-2)'
    }
  }, d))))));
}
function MkCommitments() {
  const items = ['FortyMM is free for players and clubs.', 'We don’t show ads.', 'We don’t sell or share your data, and we don’t use third-party tracking.', 'Every feature is available to everyone.'];
  return /*#__PURE__*/React.createElement("section", {
    style: {
      borderTop: '1px solid var(--border-subtle)',
      padding: '64px 0'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      ...mkWrap,
      display: 'grid',
      gridTemplateColumns: 'repeat(auto-fit,minmax(min(100%,320px),1fr))',
      gap: 32
    }
  }, /*#__PURE__*/React.createElement("h2", {
    style: {
      margin: 0,
      font: '600 28px var(--font-ui)',
      color: 'var(--fg-1)'
    }
  }, "What we commit to"), /*#__PURE__*/React.createElement("ul", {
    style: {
      listStyle: 'none',
      margin: 0,
      padding: 0
    }
  }, items.map(i => /*#__PURE__*/React.createElement("li", {
    key: i,
    style: {
      padding: '14px 0',
      borderBottom: '1px solid var(--border-subtle)',
      font: '400 17px/1.5 var(--font-ui)',
      color: 'var(--fg-1)'
    }
  }, i)))));
}
function MkFooter() {
  return /*#__PURE__*/React.createElement("footer", {
    style: {
      borderTop: '1px solid var(--border-subtle)',
      padding: '32px 0 48px'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      ...mkWrap,
      display: 'flex',
      gap: 24,
      flexWrap: 'wrap',
      alignItems: 'center',
      font: '400 14px var(--font-ui)',
      color: 'var(--fg-3)'
    }
  }, /*#__PURE__*/React.createElement("img", {
    src: "../../assets/logo-mark.svg",
    alt: "",
    style: {
      height: 20
    }
  }), /*#__PURE__*/React.createElement("span", null, "\xA9 2026 FortyMM"), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1
    }
  }), /*#__PURE__*/React.createElement("a", null, "iOS"), /*#__PURE__*/React.createElement("a", null, "Android"), /*#__PURE__*/React.createElement("a", null, "Privacy"), /*#__PURE__*/React.createElement("a", null, "Contact")));
}
Object.assign(window, {
  MkNav,
  MkHero,
  MkScorePanel,
  MkFeatures,
  MkCommitments,
  MkFooter
});
ReactDOM.createRoot(document.getElementById('root')).render(/*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement(MkNav, null), /*#__PURE__*/React.createElement(MkHero, null), /*#__PURE__*/React.createElement(MkFeatures, null), /*#__PURE__*/React.createElement(MkCommitments, null), /*#__PURE__*/React.createElement(MkFooter, null)));
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/marketing/components.jsx", error: String((e && e.message) || e) }); }

// ui_kits/spectator/components.jsx
try { (() => {
// Spectator bracket — public, shareable, readable from across the hall.
function SpecHeader() {
  return /*#__PURE__*/React.createElement("header", {
    style: {
      padding: '20px clamp(20px,4vw,40px)',
      display: 'flex',
      alignItems: 'center',
      gap: 20,
      borderBottom: '1px solid var(--border-subtle)',
      flexWrap: 'wrap'
    }
  }, /*#__PURE__*/React.createElement("img", {
    src: "../../assets/logo-wordmark.svg",
    alt: "FortyMM",
    style: {
      height: 30
    }
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      minWidth: 200
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      font: '600 22px var(--font-ui)',
      color: 'var(--fg-1)'
    }
  }, "Spring Open 2026"), /*#__PURE__*/React.createElement("div", {
    style: {
      font: '400 14px var(--font-ui)',
      color: 'var(--fg-3)'
    }
  }, "Saturday \xB7 Riverside TT \xB7 64 players")), /*#__PURE__*/React.createElement("span", {
    className: "live-marker",
    style: {
      fontSize: 15
    }
  }, "2 matches live"), /*#__PURE__*/React.createElement("button", {
    style: {
      height: 40,
      padding: '0 16px',
      borderRadius: 8,
      background: 'transparent',
      border: '1px solid var(--border-control)',
      color: 'var(--fg-1)',
      font: '600 14px var(--font-ui)',
      cursor: 'pointer'
    }
  }, "Share link"));
}
const SPEC_ROUNDS = [{
  name: 'Round of 16',
  matches: [['Nguyen, Thanh', 1, 'Silva, Rafael', 16, 3, 1, 'done', 'Table 1'], ['Kim, Hyun-woo', 8, 'Dubois, Claire', 9, 3, 0, 'done', 'Table 4'], ['Okafor, Daniel', 5, 'Johansen-Whitfield, Annika', 12, 1, 1, 'live', 'Table 2 · game 3 · 9–9'], ['Patel, Meera', 4, 'Park, Ji-ho', 13, null, null, 'next', 'Table 2 · about 12:05'], ['Tran, Linh', 3, 'Rossi, Giulia', 14, 2, 1, 'live', 'Table 3 · game 4 · 8–6'], ['Chen, Wei', 6, 'Ali, Rashid', 11, null, null, 'next', 'Table 5 · 11:20']]
}, {
  name: 'Quarterfinals',
  matches: [['Nguyen, Thanh', 1, 'Kim, Hyun-woo', 8, null, null, 'next', 'Table 1 · 13:10'], ['Okafor / Johansen-Whitfield', null, 'Patel / Park', null, null, null, 'tbd', 'About 13:10'], ['Tran / Rossi', null, 'Chen / Ali', null, null, null, 'tbd', 'About 13:50']]
}];
function SpecMatch({
  m
}) {
  const [a, sa, b, sb, ga, gb, st, where] = m;
  const done = st === 'done';
  const row = (n, seed, g, win) => /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'grid',
      gridTemplateColumns: '28px minmax(0,1fr) 28px',
      gap: 8,
      alignItems: 'center'
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      font: '500 13px var(--font-num)',
      color: 'var(--fg-3)'
    }
  }, seed || ''), /*#__PURE__*/React.createElement("span", {
    style: {
      font: `${win ? 700 : 500} 16px/1.3 var(--font-ui)`,
      color: done && !win ? 'var(--loser)' : st === 'tbd' ? 'var(--fg-3)' : 'var(--fg-1)'
    }
  }, n), /*#__PURE__*/React.createElement("span", {
    style: {
      font: '700 22px var(--font-num)',
      textAlign: 'right',
      color: done && !win ? 'var(--loser)' : 'var(--fg-1)'
    }
  }, g ?? ''));
  return /*#__PURE__*/React.createElement("div", {
    style: {
      padding: '12px 0',
      borderBottom: '1px solid var(--border-subtle)',
      display: 'flex',
      flexDirection: 'column',
      gap: 6
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 10,
      alignItems: 'center',
      font: '400 13px var(--font-ui)',
      color: 'var(--fg-3)'
    }
  }, st === 'live' && /*#__PURE__*/React.createElement("span", {
    className: "live-marker"
  }, "Live"), done && /*#__PURE__*/React.createElement("span", {
    style: {
      fontWeight: 600,
      color: 'var(--fg-2)'
    }
  }, "Final"), st === 'next' && /*#__PURE__*/React.createElement("span", {
    style: {
      fontWeight: 600,
      color: 'var(--fg-2)'
    }
  }, "Next"), /*#__PURE__*/React.createElement("span", null, where)), row(a, sa, ga, done && ga > gb), row(b, sb, gb, done && gb > ga));
}
function SpecBracket() {
  return /*#__PURE__*/React.createElement("div", {
    style: {
      padding: '24px clamp(20px,4vw,40px)',
      display: 'grid',
      gridTemplateColumns: 'repeat(auto-fit,minmax(320px,1fr))',
      gap: 40,
      alignItems: 'start'
    }
  }, SPEC_ROUNDS.map(r => /*#__PURE__*/React.createElement("section", {
    key: r.name
  }, /*#__PURE__*/React.createElement("h2", {
    style: {
      margin: '0 0 4px',
      font: '600 18px var(--font-ui)',
      color: 'var(--fg-1)'
    }
  }, r.name), r.matches.map((m, i) => /*#__PURE__*/React.createElement(SpecMatch, {
    key: i,
    m: m
  })))));
}
Object.assign(window, {
  SpecHeader,
  SpecBracket,
  SpecMatch
});
ReactDOM.createRoot(document.getElementById('root')).render(/*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement(SpecHeader, null), /*#__PURE__*/React.createElement(SpecBracket, null)));
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/spectator/components.jsx", error: String((e && e.message) || e) }); }

// ui_kits/web_admin/components.jsx
try { (() => {
// FortyMM tournament admin — Tables & schedule.
// Tokens come from colors_and_type.css. Orange = actions/selection only.

const AD_NOW = 11 * 60 + 15; // 11:15
const fmt = m => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const adBtn = {
  height: 36,
  padding: '0 14px',
  borderRadius: 8,
  font: '600 14px var(--font-ui)',
  cursor: 'pointer',
  border: '1px solid transparent',
  whiteSpace: 'nowrap'
};
const adPrimary = {
  ...adBtn,
  background: 'var(--accent)',
  color: 'var(--on-accent)'
};
const adSecondary = {
  ...adBtn,
  background: 'transparent',
  color: 'var(--fg-1)',
  borderColor: 'var(--border-control)'
};
function AdSidebar() {
  const items = ['Overview', 'Tables & schedule', 'Draws', 'Players', 'Results', 'Settings'];
  return /*#__PURE__*/React.createElement("aside", {
    style: {
      width: 216,
      flex: 'none',
      background: 'var(--bg-panel)',
      borderRight: '1px solid var(--border-subtle)',
      padding: '20px 12px',
      display: 'flex',
      flexDirection: 'column',
      gap: 4
    }
  }, /*#__PURE__*/React.createElement("img", {
    src: "../../assets/logo-wordmark.svg",
    alt: "FortyMM",
    style: {
      height: 30,
      alignSelf: 'flex-start',
      margin: '0 8px 20px'
    }
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      padding: '0 8px 12px'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      font: '600 15px var(--font-ui)',
      color: 'var(--fg-1)'
    }
  }, "Spring Open"), /*#__PURE__*/React.createElement("div", {
    style: {
      font: '400 13px var(--font-ui)',
      color: 'var(--fg-3)'
    }
  }, "Saturday \xB7 Riverside TT")), items.map((l, i) => {
    const on = i === 1;
    return /*#__PURE__*/React.createElement("a", {
      key: l,
      style: {
        padding: '9px 10px',
        borderRadius: 8,
        font: '500 14px var(--font-ui)',
        textDecoration: 'none',
        cursor: 'pointer',
        background: on ? 'var(--accent-soft)' : 'transparent',
        color: on ? 'var(--accent-text)' : 'var(--fg-2)'
      }
    }, l);
  }));
}
function AdFacts({
  finish,
  planned
}) {
  const late = finish - planned;
  const facts = [['Expected finish', fmt(finish), late > 0 ? `${late} min after plan (${fmt(planned)})` : 'On plan', late > 0], ['Tables in use', '4 of 6', '2 free now'], ['Matches left', '38', 'of 112'], ['Players resting', '7', 'shortest rest 5 min']];
  return /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'grid',
      gridTemplateColumns: 'repeat(auto-fit,minmax(180px,1fr))',
      borderTop: '1px solid var(--border-subtle)',
      borderBottom: '1px solid var(--border-subtle)'
    }
  }, facts.map(([l, v, s, warn], i) => /*#__PURE__*/React.createElement("div", {
    key: l,
    style: {
      padding: '14px 20px',
      borderLeft: i ? '1px solid var(--border-subtle)' : 'none',
      display: 'flex',
      flexDirection: 'column',
      gap: 2
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      font: '500 13px var(--font-ui)',
      color: 'var(--fg-3)'
    }
  }, l), /*#__PURE__*/React.createElement("span", {
    style: {
      font: `700 ${i === 0 ? 30 : 24}px/1.15 var(--font-num)`,
      color: 'var(--fg-1)'
    }
  }, v), /*#__PURE__*/React.createElement("span", {
    style: {
      font: '400 13px var(--font-ui)',
      color: warn ? 'var(--conflict)' : 'var(--fg-3)'
    }
  }, s))));
}
function AdAttention({
  issues,
  onResolve,
  resolvedNote
}) {
  return /*#__PURE__*/React.createElement("section", {
    style: {
      display: 'flex',
      flexDirection: 'column',
      gap: 0,
      border: `1px solid ${issues.length ? 'var(--conflict)' : 'var(--border-subtle)'}`,
      borderRadius: 8,
      background: issues.length ? 'var(--conflict-soft)' : 'transparent'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 10,
      padding: '12px 16px'
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      display: 'inline-grid',
      placeItems: 'center',
      width: 20,
      height: 20,
      borderRadius: '50%',
      background: issues.length ? 'var(--conflict)' : 'var(--green-400)',
      color: 'var(--ink-950)',
      font: '700 12px var(--font-ui)'
    }
  }, issues.length ? '!' : '✓'), /*#__PURE__*/React.createElement("h2", {
    style: {
      margin: 0,
      font: '600 16px var(--font-ui)',
      color: 'var(--fg-1)'
    }
  }, issues.length ? `${issues.length} scheduling ${issues.length === 1 ? 'issue needs' : 'issues need'} a decision` : 'No scheduling issues'), resolvedNote && /*#__PURE__*/React.createElement("span", {
    style: {
      font: '400 14px var(--font-ui)',
      color: 'var(--fg-2)'
    }
  }, resolvedNote)), issues.map(it => /*#__PURE__*/React.createElement("div", {
    key: it.id,
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 16,
      padding: '12px 16px',
      borderTop: '1px solid rgba(245,197,66,0.25)',
      flexWrap: 'wrap'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      flex: '1 1 360px',
      display: 'flex',
      flexDirection: 'column',
      gap: 2
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      font: '600 15px var(--font-ui)',
      color: 'var(--fg-1)'
    }
  }, it.title), /*#__PURE__*/React.createElement("span", {
    style: {
      font: '400 14px/1.45 var(--font-ui)',
      color: 'var(--fg-2)'
    }
  }, it.detail)), /*#__PURE__*/React.createElement("button", {
    style: adSecondary
  }, "Show in schedule"), /*#__PURE__*/React.createElement("button", {
    style: adPrimary,
    onClick: () => onResolve(it)
  }, it.action))));
}
const TABLES = [{
  n: 1,
  live: true,
  a: 'Johansen-Whitfield, Annika',
  b: 'Rossi, Giulia',
  g: [1, 0],
  p: [4, 7],
  srv: 1,
  game: 2,
  mins: 14,
  next: 'Kim vs Dubois'
}, {
  n: 2,
  live: true,
  a: 'Okafor, Daniel',
  b: 'Johansen, Anders',
  g: [1, 1],
  p: [9, 9],
  srv: 0,
  game: 3,
  mins: 31,
  next: 'Patel vs Park',
  late: 15
}, {
  n: 3,
  live: true,
  a: 'Nguyen, Thanh',
  b: 'Silva, Rafael',
  g: [1, 1],
  p: [8, 6],
  srv: 0,
  game: 3,
  mins: 22,
  next: 'Chen vs Ali'
}, {
  n: 4,
  live: true,
  a: 'Tanaka, Yuki',
  b: 'Müller, Friedrich',
  g: [0, 0],
  p: [3, 2],
  srv: 1,
  game: 1,
  mins: 4,
  next: 'Ahmed vs Hansen'
}, {
  n: 5,
  free: 'since 11:08',
  ready: ['Kim, Hyun-woo', 'Ali, Rashid']
}, {
  n: 6,
  free: 'since 11:12',
  ready: ['Rossi, Marco', 'Dubois, Claire'],
  note: 'Dubois finished 11:02 — rest ends 11:17'
}];
function AdTable({
  t
}) {
  const head = /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: 8
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      font: '600 17px var(--font-ui)',
      color: 'var(--fg-1)'
    }
  }, "Table ", t.n), t.live ? /*#__PURE__*/React.createElement("span", {
    className: "live-marker"
  }, "Live") : /*#__PURE__*/React.createElement("span", {
    style: {
      font: '600 13px var(--font-ui)',
      color: 'var(--fg-2)'
    }
  }, "Free ", t.free));
  if (!t.live) return /*#__PURE__*/React.createElement("div", {
    style: {
      border: '1px solid var(--border-subtle)',
      borderRadius: 8,
      padding: 16,
      display: 'flex',
      flexDirection: 'column',
      gap: 10
    }
  }, head, /*#__PURE__*/React.createElement("div", {
    style: {
      font: '400 14px var(--font-ui)',
      color: 'var(--fg-3)'
    }
  }, "Ready to call"), /*#__PURE__*/React.createElement("div", {
    style: {
      font: '600 16px/1.35 var(--font-ui)',
      color: 'var(--fg-1)'
    }
  }, t.ready[0], /*#__PURE__*/React.createElement("br", null), t.ready[1]), /*#__PURE__*/React.createElement("div", {
    style: {
      font: '400 13px var(--font-ui)',
      color: t.note ? 'var(--rest)' : 'var(--fg-3)'
    }
  }, t.note || 'Both checked in'), /*#__PURE__*/React.createElement("button", {
    style: {
      ...(t.note ? adSecondary : adPrimary),
      marginTop: 'auto',
      alignSelf: 'flex-start'
    }
  }, t.note ? 'Call at 11:17' : 'Call to table'));
  const row = (name, g, p, srv) => /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'grid',
      gridTemplateColumns: 'minmax(0,1fr) 12px 20px 36px',
      gap: 8,
      alignItems: 'center'
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      font: '500 15px/1.3 var(--font-ui)',
      color: 'var(--fg-1)'
    }
  }, name), /*#__PURE__*/React.createElement("span", null, srv && /*#__PURE__*/React.createElement("span", {
    className: "serve-marker",
    style: {
      width: 8,
      height: 8
    }
  })), /*#__PURE__*/React.createElement("span", {
    style: {
      font: '500 14px var(--font-num)',
      color: 'var(--fg-3)',
      textAlign: 'right'
    }
  }, g), /*#__PURE__*/React.createElement("span", {
    style: {
      font: '700 24px/1 var(--font-num)',
      color: 'var(--fg-1)',
      textAlign: 'right'
    }
  }, p));
  return /*#__PURE__*/React.createElement("div", {
    style: {
      background: 'var(--bg-panel)',
      border: '1px solid var(--border-subtle)',
      borderRadius: 8,
      padding: 16,
      display: 'flex',
      flexDirection: 'column',
      gap: 8
    }
  }, head, row(t.a, t.g[0], t.p[0], t.srv === 0), row(t.b, t.g[1], t.p[1], t.srv === 1), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      justifyContent: 'space-between',
      gap: 8,
      font: '400 13px var(--font-ui)',
      color: 'var(--fg-3)',
      borderTop: '1px solid var(--border-subtle)',
      paddingTop: 8,
      flexWrap: 'wrap'
    }
  }, /*#__PURE__*/React.createElement("span", null, "Game ", t.game, " \xB7 ", t.mins, " min", t.late ? /*#__PURE__*/React.createElement("span", {
    style: {
      color: 'var(--conflict)'
    }
  }, " \xB7 ", t.late, " min over") : null), /*#__PURE__*/React.createElement("span", null, "Next: ", t.next)));
}

// schedule: [start, dur, a, b, status]
const SCHED = [[[620, 35, 'Nguyen', 'Silva', 'done'], [665, 35, 'Johansen-Whitfield', 'Rossi', 'live'], [710, 35, 'Kim', 'Dubois'], [755, 35, 'Tanaka', 'Chen']], [[620, 35, 'Okafor', 'Park', 'done'], [664, 50, 'Okafor', 'Johansen', 'live'], [715, 35, 'Patel', 'Park', 'conflict'], [760, 35, 'Hansen', 'Müller']], [[620, 35, 'Chen', 'Ali', 'done'], [673, 35, 'Nguyen', 'Silva', 'live'], [715, 35, 'Chen', 'Ali'], [760, 35, 'Okafor', 'Kim']], [[625, 35, 'Ahmed', 'Hansen', 'done'], [671, 35, 'Tanaka', 'Müller', 'live'], [715, 35, 'Ahmed', 'Hansen'], [760, 35, 'Patel', 'Nguyen']], [[620, 35, 'Patel', 'Rossi', 'done'], [680, 35, 'Kim', 'Ali'], [725, 35, 'Silva', 'Johansen'], [770, 35, 'Okafor', 'Ali', 'conflict']], [[627, 35, 'Dubois', 'Tran', 'done'], [677, 35, 'Rossi', 'Dubois'], [725, 35, 'Park', 'Tanaka'], [770, 35, 'Chen', 'Rossi']]];
function AdSchedule({
  fixed
}) {
  const start = 600,
    endT = 840,
    ppm = 4.4,
    labelW = 76;
  const hours = [];
  for (let m = start; m <= endT; m += 60) hours.push(m);
  return /*#__PURE__*/React.createElement("section", {
    style: {
      display: 'flex',
      flexDirection: 'column',
      gap: 12
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'baseline',
      gap: 12,
      flexWrap: 'wrap'
    }
  }, /*#__PURE__*/React.createElement("h2", {
    style: {
      margin: 0,
      font: '600 18px var(--font-ui)',
      color: 'var(--fg-1)'
    }
  }, "Schedule"), /*#__PURE__*/React.createElement("span", {
    style: {
      font: '400 14px var(--font-ui)',
      color: 'var(--fg-3)'
    }
  }, "10:00\u201314:00 \xB7 hover a match for full names")), /*#__PURE__*/React.createElement("div", {
    style: {
      overflowX: 'auto',
      border: '1px solid var(--border-subtle)',
      borderRadius: 8
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'relative',
      width: labelW + (endT - start) * ppm + 16,
      paddingBottom: 8
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      height: 32,
      position: 'relative',
      borderBottom: '1px solid var(--border-subtle)'
    }
  }, hours.map(h => /*#__PURE__*/React.createElement("span", {
    key: h,
    style: {
      position: 'absolute',
      left: labelW + (h - start) * ppm,
      top: 8,
      font: '500 13px var(--font-num)',
      color: 'var(--fg-3)',
      paddingLeft: 6,
      borderLeft: '1px solid var(--border-subtle)',
      height: 24
    }
  }, fmt(h)))), /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'absolute',
      top: 0,
      bottom: 0,
      left: labelW + (AD_NOW - start) * ppm,
      width: 2,
      background: 'var(--fg-1)',
      zIndex: 2
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      position: 'absolute',
      top: 6,
      left: 6,
      font: '600 12px var(--font-num)',
      color: 'var(--ink-950)',
      background: 'var(--fg-1)',
      borderRadius: 4,
      padding: '1px 5px'
    }
  }, "Now ", fmt(AD_NOW))), SCHED.map((row, ti) => /*#__PURE__*/React.createElement("div", {
    key: ti,
    style: {
      position: 'relative',
      height: 76,
      borderBottom: ti < 5 ? '1px solid var(--border-subtle)' : 'none'
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      position: 'absolute',
      left: 16,
      top: 28,
      font: '600 14px var(--font-ui)',
      color: 'var(--fg-2)'
    }
  }, "Table ", ti + 1), row.map(([s, d, a, b, st], k) => {
    const cf = st === 'conflict' && !fixed.includes(`${ti}-${k}`);
    const done = st === 'done',
      live = st === 'live';
    return /*#__PURE__*/React.createElement("div", {
      key: k,
      title: `${a} vs ${b} · ${fmt(s)}–${fmt(s + d)}`,
      style: {
        position: 'absolute',
        left: labelW + (s - start) * ppm + 2,
        top: 6,
        width: d * ppm - 6,
        height: 64,
        boxSizing: 'border-box',
        padding: '6px 8px',
        borderRadius: 6,
        border: `1px solid ${cf ? 'var(--conflict)' : 'var(--border-subtle)'}`,
        background: cf ? 'var(--conflict-soft)' : live ? 'var(--ink-800)' : done ? 'transparent' : 'var(--bg-panel)',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden'
      }
    }, [a, b].map(n => /*#__PURE__*/React.createElement("span", {
      key: n,
      style: {
        font: `${done ? 500 : 600} 13px/1.25 var(--font-ui)`,
        color: done ? 'var(--fg-3)' : 'var(--fg-1)',
        overflowWrap: 'anywhere'
      }
    }, n)), /*#__PURE__*/React.createElement("span", {
      style: {
        font: '400 12px var(--font-num)',
        color: cf ? 'var(--conflict)' : live ? 'var(--live)' : 'var(--fg-3)',
        marginTop: 'auto'
      }
    }, cf ? 'Needs decision' : live ? 'Live' : fmt(s)));
  }))))));
}
function AdSolverDetails() {
  const rules = [['No player plays back-to-back', 'Required', 'Met'], ['At least 15 min rest between a player’s matches', 'Required', '1 at risk (Okafor)'], ['Matches start when their table is free', 'Required', '1 at risk (Table 2)'], ['Doubles and singles for the same player don’t overlap', 'Required', 'Met'], ['Spread matches evenly across tables', 'Preferred', 'Met'], ['Finish by 18:30', 'Preferred', '10 min over']];
  return /*#__PURE__*/React.createElement("details", {
    style: {
      borderTop: '1px solid var(--border-subtle)',
      paddingTop: 14
    }
  }, /*#__PURE__*/React.createElement("summary", {
    style: {
      cursor: 'pointer',
      font: '600 15px var(--font-ui)',
      color: 'var(--fg-2)'
    }
  }, "Scheduling details ", /*#__PURE__*/React.createElement("span", {
    style: {
      fontWeight: 400,
      color: 'var(--fg-3)'
    }
  }, "\xB7 rules, last re-plan 11:09")), /*#__PURE__*/React.createElement("table", {
    style: {
      marginTop: 12,
      borderCollapse: 'collapse',
      width: '100%',
      maxWidth: 820,
      font: '400 14px var(--font-ui)',
      color: 'var(--fg-2)'
    }
  }, /*#__PURE__*/React.createElement("tbody", null, rules.map(r => /*#__PURE__*/React.createElement("tr", {
    key: r[0],
    style: {
      borderBottom: '1px solid var(--border-subtle)'
    }
  }, /*#__PURE__*/React.createElement("td", {
    style: {
      padding: '8px 12px 8px 0'
    }
  }, r[0]), /*#__PURE__*/React.createElement("td", {
    style: {
      padding: 8,
      color: 'var(--fg-3)'
    }
  }, r[1]), /*#__PURE__*/React.createElement("td", {
    style: {
      padding: 8,
      color: r[2] === 'Met' ? 'var(--fg-3)' : 'var(--conflict)'
    }
  }, r[2]))))), /*#__PURE__*/React.createElement("p", {
    style: {
      font: '400 13px var(--font-num)',
      color: 'var(--fg-3)',
      margin: '12px 0 0'
    }
  }, "Solver: SMT \xB7 1,248 variables \xB7 12 constraints \xB7 solved in 234 ms \xB7 objective: minimise finish time"));
}
function AdminApp() {
  const [issues, setIssues] = React.useState([{
    id: 'okafor',
    key: '4-3',
    title: 'Okafor’s singles is 15 min over on Table 2',
    detail: 'He is due on Table 5 at 12:50 for doubles. Moving that match to 13:05 keeps his 15 min rest.',
    action: 'Move to 13:05',
    finish: 5
  }, {
    id: 'patel',
    key: '1-2',
    title: 'Table 2 won’t be free for Patel vs Park at 11:55',
    detail: 'Okafor vs Johansen is still in game 3. Delaying the next match to 12:05 avoids calling players to a busy table.',
    action: 'Delay to 12:05',
    finish: 5
  }]);
  const [fixed, setFixed] = React.useState([]);
  const [finish, setFinish] = React.useState(18 * 60 + 40);
  const [note, setNote] = React.useState(null);
  const resolve = it => {
    setIssues(xs => xs.filter(x => x.id !== it.id));
    setFixed(f => [...f, it.key]);
    setFinish(f => f + it.finish);
    setNote(`Done — expected finish now ${fmt(finish + it.finish)}.`);
  };
  return /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      minHeight: '100vh'
    }
  }, /*#__PURE__*/React.createElement(AdSidebar, null), /*#__PURE__*/React.createElement("main", {
    style: {
      flex: 1,
      minWidth: 0,
      padding: '20px 24px 40px',
      display: 'flex',
      flexDirection: 'column',
      gap: 20
    }
  }, /*#__PURE__*/React.createElement("header", {
    style: {
      display: 'flex',
      alignItems: 'flex-end',
      gap: 16,
      flexWrap: 'wrap'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      minWidth: 240
    }
  }, /*#__PURE__*/React.createElement("h1", {
    style: {
      margin: 0,
      font: '600 26px/1.2 var(--font-ui)',
      color: 'var(--fg-1)'
    }
  }, "Tables & schedule"), /*#__PURE__*/React.createElement("div", {
    style: {
      font: '400 14px var(--font-ui)',
      color: 'var(--fg-3)'
    }
  }, "Round of 16 in progress \xB7 ", fmt(AD_NOW))), /*#__PURE__*/React.createElement("button", {
    style: adSecondary
  }, "Pause calling"), /*#__PURE__*/React.createElement("button", {
    style: adSecondary
  }, "Add a table")), /*#__PURE__*/React.createElement(AdFacts, {
    finish: finish,
    planned: 18 * 60 + 30
  }), /*#__PURE__*/React.createElement(AdAttention, {
    issues: issues,
    onResolve: resolve,
    resolvedNote: note
  }), /*#__PURE__*/React.createElement("section", {
    style: {
      display: 'grid',
      gridTemplateColumns: 'repeat(auto-fill,minmax(300px,1fr))',
      gap: 12
    }
  }, TABLES.map(t => /*#__PURE__*/React.createElement(AdTable, {
    key: t.n,
    t: t
  }))), /*#__PURE__*/React.createElement(AdSchedule, {
    fixed: fixed
  }), /*#__PURE__*/React.createElement(AdSolverDetails, null)));
}
Object.assign(window, {
  AdSidebar,
  AdFacts,
  AdAttention,
  AdTable,
  AdSchedule,
  AdSolverDetails,
  AdminApp
});
ReactDOM.createRoot(document.getElementById('root')).render(/*#__PURE__*/React.createElement(AdminApp, null));
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/web_admin/components.jsx", error: String((e && e.message) || e) }); }

})();
