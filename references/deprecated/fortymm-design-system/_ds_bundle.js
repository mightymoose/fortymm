/* @ds-bundle: {"format":3,"namespace":"FortyMMDesignSystem_f2d51f","components":[],"sourceHashes":{"slides/deck-stage.js":"522102a1c71e","ui_kits/android/android-frame.jsx":"26b6e42067a7","ui_kits/android/screens.jsx":"e6f40dfe0c16","ui_kits/ios/ios-frame.jsx":"d67eb3ffe562","ui_kits/ios/screens.jsx":"bfb538cdc85f","ui_kits/marketing/browser-window.jsx":"2e3bb69bede4","ui_kits/marketing/components.jsx":"8ac37317f6bf","ui_kits/spectator/components.jsx":"973e1ca6e8a1","ui_kits/web_admin/components.jsx":"7fde4691a773"},"inlinedExternals":[],"unexposedExports":[]} */

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

// ui_kits/android/android-frame.jsx
try { (() => {
// Android.jsx — Simplified Android (Material 3) device frame
// Status bar + top app bar + content + gesture nav + keyboard.
// Based on Figma M3 spec. No dependencies, no image assets.

const MD_C = {
  surface: '#f4fbf8',
  surfaceVariant: '#dae5e1',
  inverseOnSurface: '#ecf2ef',
  secondaryContainer: '#cde8e1',
  primaryFixedDim: '#83d5c6',
  onSurface: '#171d1b',
  onSurfaceVar: '#49454f',
  onPrimaryContainer: '#00201c',
  primary: '#006a60',
  frameBorder: 'rgba(116,119,117,0.5)'
};

// ─────────────────────────────────────────────────────────────
// Status bar (time left, wifi/cell/battery right)
// ─────────────────────────────────────────────────────────────
function AndroidStatusBar({
  dark = false
}) {
  const c = dark ? '#fff' : MD_C.onSurface;
  return /*#__PURE__*/React.createElement("div", {
    style: {
      height: 40,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      padding: '0 16px',
      position: 'relative',
      fontFamily: 'Roboto, system-ui, sans-serif'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      width: 128,
      display: 'flex',
      alignItems: 'center',
      gap: 8
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 14,
      fontWeight: 400,
      letterSpacing: 0.25,
      lineHeight: '20px',
      color: c
    }
  }, "9:30")), /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'absolute',
      left: '50%',
      top: 8,
      transform: 'translateX(-50%)',
      width: 24,
      height: 24,
      borderRadius: 100,
      background: '#2e2e2e'
    }
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      paddingRight: 2
    }
  }, /*#__PURE__*/React.createElement("svg", {
    width: "16",
    height: "16",
    viewBox: "0 0 16 16",
    style: {
      marginRight: -2
    }
  }, /*#__PURE__*/React.createElement("path", {
    d: "M8 13.3L.67 5.97a10.37 10.37 0 0114.66 0L8 13.3z",
    fill: c
  })), /*#__PURE__*/React.createElement("svg", {
    width: "16",
    height: "16",
    viewBox: "0 0 16 16",
    style: {
      marginRight: -2
    }
  }, /*#__PURE__*/React.createElement("path", {
    d: "M14.67 14.67V1.33L1.33 14.67h13.34z",
    fill: c
  }))), /*#__PURE__*/React.createElement("svg", {
    width: "16",
    height: "16",
    viewBox: "0 0 16 16"
  }, /*#__PURE__*/React.createElement("rect", {
    x: "3.75",
    y: "2",
    width: "8.5",
    height: "13",
    rx: "1.5",
    fill: c
  }), /*#__PURE__*/React.createElement("rect", {
    x: "5.5",
    y: "0.9",
    width: "5",
    height: "2",
    rx: "0.5",
    fill: c
  }))));
}

// ─────────────────────────────────────────────────────────────
// Top app bar (Material 3 small/medium)
// ─────────────────────────────────────────────────────────────
function AndroidAppBar({
  title = 'Title',
  large = false
}) {
  const iconDot = /*#__PURE__*/React.createElement("div", {
    style: {
      width: 48,
      height: 48,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      width: 22,
      height: 22,
      borderRadius: '50%',
      background: MD_C.onSurfaceVar,
      opacity: 0.3
    }
  }));
  return /*#__PURE__*/React.createElement("div", {
    style: {
      background: MD_C.surface,
      padding: '4px 4px 0'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      height: 56,
      display: 'flex',
      alignItems: 'center',
      gap: 4
    }
  }, iconDot, !large && /*#__PURE__*/React.createElement("span", {
    style: {
      flex: 1,
      fontSize: 22,
      fontWeight: 400,
      color: MD_C.onSurface,
      fontFamily: 'Roboto, system-ui, sans-serif'
    }
  }, title), large && /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1
    }
  }), iconDot), large && /*#__PURE__*/React.createElement("div", {
    style: {
      padding: '16px 16px 20px',
      fontSize: 28,
      fontWeight: 400,
      color: MD_C.onSurface,
      fontFamily: 'Roboto, system-ui, sans-serif'
    }
  }, title));
}

// ─────────────────────────────────────────────────────────────
// List item (Material 3)
// ─────────────────────────────────────────────────────────────
function AndroidListItem({
  headline,
  supporting,
  leading
}) {
  return /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 16,
      padding: '12px 16px',
      minHeight: 56,
      boxSizing: 'border-box',
      fontFamily: 'Roboto, system-ui, sans-serif'
    }
  }, leading && /*#__PURE__*/React.createElement("div", {
    style: {
      width: 40,
      height: 40,
      borderRadius: '50%',
      background: MD_C.primary,
      color: '#fff',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      fontSize: 18,
      fontWeight: 500,
      flexShrink: 0
    }
  }, leading), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      minWidth: 0
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 16,
      color: MD_C.onSurface,
      lineHeight: '24px'
    }
  }, headline), supporting && /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 14,
      color: MD_C.onSurfaceVar,
      lineHeight: '20px'
    }
  }, supporting)));
}

// ─────────────────────────────────────────────────────────────
// Gesture nav bar (pill)
// ─────────────────────────────────────────────────────────────
function AndroidNavBar({
  dark = false
}) {
  return /*#__PURE__*/React.createElement("div", {
    style: {
      height: 24,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      width: 108,
      height: 4,
      borderRadius: 2,
      background: dark ? '#fff' : MD_C.onSurface,
      opacity: 0.4
    }
  }));
}

// ─────────────────────────────────────────────────────────────
// Device frame — wraps everything
// ─────────────────────────────────────────────────────────────
function AndroidDevice({
  children,
  width = 412,
  height = 892,
  dark = false,
  title,
  large = false,
  keyboard = false
}) {
  return /*#__PURE__*/React.createElement("div", {
    style: {
      width,
      height,
      borderRadius: 18,
      overflow: 'hidden',
      background: dark ? '#1d1b20' : MD_C.surface,
      border: `8px solid ${MD_C.frameBorder}`,
      boxShadow: '0 30px 80px rgba(0,0,0,0.25)',
      display: 'flex',
      flexDirection: 'column',
      boxSizing: 'border-box'
    }
  }, /*#__PURE__*/React.createElement(AndroidStatusBar, {
    dark: dark
  }), title !== undefined && /*#__PURE__*/React.createElement(AndroidAppBar, {
    title: title,
    large: large
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      overflow: 'auto'
    }
  }, children), keyboard && /*#__PURE__*/React.createElement(AndroidKeyboard, null), /*#__PURE__*/React.createElement(AndroidNavBar, {
    dark: dark
  }));
}

// ─────────────────────────────────────────────────────────────
// Keyboard — Gboard (Material 3)
// ─────────────────────────────────────────────────────────────
function AndroidKeyboard() {
  let _k = 0;
  const key = (l, {
    flex = 1,
    bg = MD_C.surface,
    r = 6,
    minW,
    fs = 21
  } = {}) => /*#__PURE__*/React.createElement("div", {
    key: _k++,
    style: {
      height: 46,
      borderRadius: r,
      flex,
      minWidth: minW,
      background: bg,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      fontFamily: 'Roboto, system-ui',
      fontSize: fs,
      color: MD_C.onPrimaryContainer
    }
  }, l);
  const row = (keys, style = {}) => /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 6,
      justifyContent: 'center',
      ...style
    }
  }, keys.map(l => key(l)));
  return /*#__PURE__*/React.createElement("div", {
    style: {
      background: MD_C.inverseOnSurface,
      padding: '0 8px 8px',
      display: 'flex',
      flexDirection: 'column',
      gap: 4
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      height: 44
    }
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      flexDirection: 'column',
      gap: 12
    }
  }, row(['q', 'w', 'e', 'r', 't', 'y', 'u', 'i', 'o', 'p']), row(['a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l'], {
    padding: '0 20px'
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 6
    }
  }, key('', {
    bg: MD_C.surfaceVariant
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 6,
      flex: 7,
      minWidth: 274
    }
  }, ['z', 'x', 'c', 'v', 'b', 'n', 'm'].map(l => key(l))), key('', {
    bg: MD_C.surfaceVariant
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 6
    }
  }, key('?123', {
    bg: MD_C.secondaryContainer,
    r: 100,
    minW: 58,
    fs: 14
  }), key(',', {
    bg: MD_C.surfaceVariant
  }), key('', {
    flex: 3,
    minW: 154
  }), key('.', {
    bg: MD_C.surfaceVariant
  }), key('', {
    bg: MD_C.primaryFixedDim,
    r: 100,
    minW: 58
  }))));
}
Object.assign(window, {
  AndroidDevice,
  AndroidStatusBar,
  AndroidAppBar,
  AndroidListItem,
  AndroidNavBar,
  AndroidKeyboard
});
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/android/android-frame.jsx", error: String((e && e.message) || e) }); }

// ui_kits/android/screens.jsx
try { (() => {
// Android screens for FortyMM — same visual language as iOS kit but with Material-ish adjustments
const C = {
  ink950: '#0B0D12',
  ink900: '#11141B',
  ink800: '#171B24',
  ink700: '#1F2430',
  ink600: '#2A3040',
  ink500: '#3A4152',
  fg1: '#F7F8FB',
  fg2: '#E4E7EF',
  fg3: '#A9B0C2',
  ball: '#FF7A1A',
  serve: '#00E29A'
};
function AScreen({
  children
}) {
  return /*#__PURE__*/React.createElement("div", {
    style: {
      height: '100%',
      background: C.ink950,
      color: C.fg1,
      fontFamily: "'Roboto', 'Space Grotesk', sans-serif",
      overflowY: 'auto',
      paddingBottom: 80
    }
  }, children);
}
function ATopBar({
  title
}) {
  return /*#__PURE__*/React.createElement("div", {
    style: {
      height: 56,
      display: 'flex',
      alignItems: 'center',
      padding: '0 16px',
      gap: 16,
      borderBottom: `1px solid ${C.ink600}`
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: "'Bebas Neue', sans-serif",
      fontSize: 26,
      letterSpacing: '0.03em',
      color: C.fg1
    }
  }, title), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1
    }
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      width: 24,
      height: 24,
      borderRadius: '50%',
      background: C.ink700
    }
  }));
}
function ABottomNav({
  active = 'home'
}) {
  const items = [{
    k: 'home',
    l: 'Matches'
  }, {
    k: 'find',
    l: 'Find'
  }, {
    k: 'bracket',
    l: 'Draws'
  }, {
    k: 'you',
    l: 'You'
  }];
  return /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'absolute',
      bottom: 0,
      left: 0,
      right: 0,
      height: 72,
      background: C.ink900,
      borderTop: `1px solid ${C.ink600}`,
      display: 'flex',
      paddingBottom: 8
    }
  }, items.map(i => /*#__PURE__*/React.createElement("div", {
    key: i.k,
    style: {
      flex: 1,
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 4
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      width: active === i.k ? 64 : 24,
      height: 32,
      borderRadius: 16,
      background: active === i.k ? 'rgba(255,122,26,0.18)' : 'transparent',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      width: 20,
      height: 20,
      borderRadius: active === i.k ? '50%' : 4,
      background: active === i.k ? C.ball : C.ink600
    }
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      font: `600 10px 'Roboto'`,
      letterSpacing: '0.1em',
      color: active === i.k ? C.ball : C.fg3,
      textTransform: 'uppercase'
    }
  }, i.l))));
}
function AFab() {
  return /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'absolute',
      right: 20,
      bottom: 92,
      width: 56,
      height: 56,
      borderRadius: 16,
      background: C.ball,
      color: C.ink950,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      fontSize: 28,
      fontWeight: 700,
      boxShadow: '0 8px 24px rgba(255,122,26,0.45)'
    }
  }, "+");
}
function AHome() {
  return /*#__PURE__*/React.createElement(AScreen, null, /*#__PURE__*/React.createElement(ATopBar, {
    title: "FORTYMM"
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      padding: '16px'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      font: '600 11px monospace',
      letterSpacing: '0.14em',
      color: C.fg3,
      textTransform: 'uppercase',
      marginBottom: 10
    }
  }, "\u25CF Live near you"), /*#__PURE__*/React.createElement("div", {
    style: {
      background: C.ink800,
      border: '1px solid rgba(0,226,154,0.3)',
      borderRadius: 12,
      padding: 14,
      boxShadow: '0 0 20px rgba(0,226,154,0.08)'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      justifyContent: 'space-between',
      marginBottom: 10
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      display: 'inline-flex',
      gap: 6,
      alignItems: 'center',
      font: `600 10px monospace`,
      letterSpacing: '0.14em',
      color: C.serve
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      width: 7,
      height: 7,
      borderRadius: '50%',
      background: C.serve,
      boxShadow: `0 0 8px ${C.serve}`
    }
  }), "LIVE \xB7 GAME 3"), /*#__PURE__*/React.createElement("span", {
    style: {
      font: `500 10px monospace`,
      color: C.fg3,
      letterSpacing: '0.1em'
    }
  }, "COURT 3")), /*#__PURE__*/React.createElement(APlayerRow, {
    n: "Nguyen, T.",
    s: 11,
    seed: "1",
    win: true
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      height: 1,
      background: C.ink600,
      margin: '10px 0'
    }
  }), /*#__PURE__*/React.createElement(APlayerRow, {
    n: "Okafor, D.",
    s: 8,
    seed: "8"
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      font: '600 11px monospace',
      letterSpacing: '0.14em',
      color: C.fg3,
      textTransform: 'uppercase',
      margin: '24px 0 10px'
    }
  }, "Upcoming"), ['Tran, L. · Today 20:30', 'Silva, R. · Tomorrow 19:00', 'Kim, H. · Sat 14:00'].map(t => /*#__PURE__*/React.createElement("div", {
    key: t,
    style: {
      background: C.ink800,
      border: `1px solid ${C.ink600}`,
      borderRadius: 10,
      padding: '12px 14px',
      marginBottom: 8,
      display: 'flex',
      alignItems: 'center',
      gap: 12
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      width: 36,
      height: 36,
      borderRadius: '50%',
      background: C.ink700,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      font: '700 12px sans-serif',
      color: C.fg2
    }
  }, t.slice(0, 2).toUpperCase()), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      font: '500 14px sans-serif',
      color: C.fg1
    }
  }, t), /*#__PURE__*/React.createElement("div", {
    style: {
      font: '700 12px monospace',
      color: C.ball,
      background: 'rgba(255,122,26,0.14)',
      padding: '4px 10px',
      borderRadius: 999
    }
  }, "\u2605 1980")))), /*#__PURE__*/React.createElement(AFab, null), /*#__PURE__*/React.createElement(ABottomNav, {
    active: "home"
  }));
}
function APlayerRow({
  n,
  s,
  seed,
  win
}) {
  return /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 12
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      width: 36,
      height: 36,
      borderRadius: '50%',
      background: win ? 'linear-gradient(135deg,#FF7A1A,#B94700)' : C.ink700,
      boxShadow: win ? `0 0 0 2px ${C.ball}` : 'none',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      font: '700 13px sans-serif',
      color: win ? '#fff' : C.fg2
    }
  }, n.slice(0, 2).toUpperCase()), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      font: '600 15px sans-serif',
      color: win ? C.serve : C.fg1
    }
  }, n), /*#__PURE__*/React.createElement("div", {
    style: {
      font: `500 10px monospace`,
      color: C.fg3,
      letterSpacing: '0.1em'
    }
  }, "SEED ", seed)), /*#__PURE__*/React.createElement("div", {
    style: {
      font: `700 30px monospace`,
      fontVariantNumeric: 'tabular-nums',
      color: win ? C.serve : C.fg1
    }
  }, s));
}
Object.assign(window, {
  AHome,
  APlayerRow
});

// ---- App mount (moved from index.html) ----
function Phone({
  children
}) {
  return /*#__PURE__*/React.createElement("div", {
    style: {
      width: 380,
      height: 790,
      borderRadius: 36,
      overflow: 'hidden',
      border: '8px solid #2A3040',
      background: '#0B0D12',
      position: 'relative',
      boxShadow: '0 40px 80px rgba(0,0,0,0.55)'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      height: 32,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      padding: '0 18px',
      color: '#fff',
      fontSize: 13,
      fontFamily: 'Roboto'
    }
  }, /*#__PURE__*/React.createElement("span", null, "9:30"), /*#__PURE__*/React.createElement("div", {
    style: {
      width: 10,
      height: 10,
      borderRadius: '50%',
      background: '#2e2e2e'
    }
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 5
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      width: 14,
      height: 10,
      background: '#fff',
      clipPath: 'polygon(0 100%, 100% 100%, 100% 0)'
    }
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      width: 18,
      height: 10,
      border: '1px solid #fff',
      borderRadius: 2
    }
  }))), children);
}
ReactDOM.createRoot(document.getElementById('root')).render(/*#__PURE__*/React.createElement(Phone, null, /*#__PURE__*/React.createElement(AHome, null)));
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/android/screens.jsx", error: String((e && e.message) || e) }); }

// ui_kits/ios/ios-frame.jsx
try { (() => {
// iOS.jsx — Simplified iOS 26 (Liquid Glass) device frame
// Based on the iOS 26 UI Kit + Figma status bar spec. No assets, no deps.
// Exports: IOSDevice, IOSStatusBar, IOSNavBar, IOSGlassPill, IOSList, IOSListRow, IOSKeyboard

// ─────────────────────────────────────────────────────────────
// Status bar
// ─────────────────────────────────────────────────────────────
function IOSStatusBar({
  dark = false,
  time = '9:41'
}) {
  const c = dark ? '#fff' : '#000';
  return /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 154,
      alignItems: 'center',
      justifyContent: 'center',
      padding: '21px 24px 19px',
      boxSizing: 'border-box',
      position: 'relative',
      zIndex: 20,
      width: '100%'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      height: 22,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      paddingTop: 1.5
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: '-apple-system, "SF Pro", system-ui',
      fontWeight: 590,
      fontSize: 17,
      lineHeight: '22px',
      color: c
    }
  }, time)), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      height: 22,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 7,
      paddingTop: 1,
      paddingRight: 1
    }
  }, /*#__PURE__*/React.createElement("svg", {
    width: "19",
    height: "12",
    viewBox: "0 0 19 12"
  }, /*#__PURE__*/React.createElement("rect", {
    x: "0",
    y: "7.5",
    width: "3.2",
    height: "4.5",
    rx: "0.7",
    fill: c
  }), /*#__PURE__*/React.createElement("rect", {
    x: "4.8",
    y: "5",
    width: "3.2",
    height: "7",
    rx: "0.7",
    fill: c
  }), /*#__PURE__*/React.createElement("rect", {
    x: "9.6",
    y: "2.5",
    width: "3.2",
    height: "9.5",
    rx: "0.7",
    fill: c
  }), /*#__PURE__*/React.createElement("rect", {
    x: "14.4",
    y: "0",
    width: "3.2",
    height: "12",
    rx: "0.7",
    fill: c
  })), /*#__PURE__*/React.createElement("svg", {
    width: "17",
    height: "12",
    viewBox: "0 0 17 12"
  }, /*#__PURE__*/React.createElement("path", {
    d: "M8.5 3.2C10.8 3.2 12.9 4.1 14.4 5.6L15.5 4.5C13.7 2.7 11.2 1.5 8.5 1.5C5.8 1.5 3.3 2.7 1.5 4.5L2.6 5.6C4.1 4.1 6.2 3.2 8.5 3.2Z",
    fill: c
  }), /*#__PURE__*/React.createElement("path", {
    d: "M8.5 6.8C9.9 6.8 11.1 7.3 12 8.2L13.1 7.1C11.8 5.9 10.2 5.1 8.5 5.1C6.8 5.1 5.2 5.9 3.9 7.1L5 8.2C5.9 7.3 7.1 6.8 8.5 6.8Z",
    fill: c
  }), /*#__PURE__*/React.createElement("circle", {
    cx: "8.5",
    cy: "10.5",
    r: "1.5",
    fill: c
  })), /*#__PURE__*/React.createElement("svg", {
    width: "27",
    height: "13",
    viewBox: "0 0 27 13"
  }, /*#__PURE__*/React.createElement("rect", {
    x: "0.5",
    y: "0.5",
    width: "23",
    height: "12",
    rx: "3.5",
    stroke: c,
    strokeOpacity: "0.35",
    fill: "none"
  }), /*#__PURE__*/React.createElement("rect", {
    x: "2",
    y: "2",
    width: "20",
    height: "9",
    rx: "2",
    fill: c
  }), /*#__PURE__*/React.createElement("path", {
    d: "M25 4.5V8.5C25.8 8.2 26.5 7.2 26.5 6.5C26.5 5.8 25.8 4.8 25 4.5Z",
    fill: c,
    fillOpacity: "0.4"
  }))));
}

// ─────────────────────────────────────────────────────────────
// Liquid glass pill — blur + tint + shine
// ─────────────────────────────────────────────────────────────
function IOSGlassPill({
  children,
  dark = false,
  style = {}
}) {
  return /*#__PURE__*/React.createElement("div", {
    style: {
      height: 44,
      minWidth: 44,
      borderRadius: 9999,
      position: 'relative',
      overflow: 'hidden',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      boxShadow: dark ? '0 2px 6px rgba(0,0,0,0.35), 0 6px 16px rgba(0,0,0,0.2)' : '0 1px 3px rgba(0,0,0,0.07), 0 3px 10px rgba(0,0,0,0.06)',
      ...style
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'absolute',
      inset: 0,
      borderRadius: 9999,
      backdropFilter: 'blur(12px) saturate(180%)',
      WebkitBackdropFilter: 'blur(12px) saturate(180%)',
      background: dark ? 'rgba(120,120,128,0.28)' : 'rgba(255,255,255,0.5)'
    }
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'absolute',
      inset: 0,
      borderRadius: 9999,
      boxShadow: dark ? 'inset 1.5px 1.5px 1px rgba(255,255,255,0.15), inset -1px -1px 1px rgba(255,255,255,0.08)' : 'inset 1.5px 1.5px 1px rgba(255,255,255,0.7), inset -1px -1px 1px rgba(255,255,255,0.4)',
      border: dark ? '0.5px solid rgba(255,255,255,0.15)' : '0.5px solid rgba(0,0,0,0.06)'
    }
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'relative',
      zIndex: 1,
      display: 'flex',
      alignItems: 'center',
      padding: '0 4px'
    }
  }, children));
}

// ─────────────────────────────────────────────────────────────
// Navigation bar — glass pills + large title
// ─────────────────────────────────────────────────────────────
function IOSNavBar({
  title = 'Title',
  dark = false,
  trailingIcon = true
}) {
  const muted = dark ? 'rgba(255,255,255,0.6)' : '#404040';
  const text = dark ? '#fff' : '#000';
  const pillIcon = content => /*#__PURE__*/React.createElement(IOSGlassPill, {
    dark: dark
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      width: 36,
      height: 36,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center'
    }
  }, content));
  return /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      flexDirection: 'column',
      gap: 10,
      paddingTop: 62,
      paddingBottom: 10,
      position: 'relative',
      zIndex: 5
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      padding: '0 16px'
    }
  }, pillIcon(/*#__PURE__*/React.createElement("svg", {
    width: "12",
    height: "20",
    viewBox: "0 0 12 20",
    fill: "none",
    style: {
      marginLeft: -1
    }
  }, /*#__PURE__*/React.createElement("path", {
    d: "M10 2L2 10l8 8",
    stroke: muted,
    strokeWidth: "2.5",
    strokeLinecap: "round",
    strokeLinejoin: "round"
  }))), trailingIcon && pillIcon(/*#__PURE__*/React.createElement("svg", {
    width: "22",
    height: "6",
    viewBox: "0 0 22 6"
  }, /*#__PURE__*/React.createElement("circle", {
    cx: "3",
    cy: "3",
    r: "2.5",
    fill: muted
  }), /*#__PURE__*/React.createElement("circle", {
    cx: "11",
    cy: "3",
    r: "2.5",
    fill: muted
  }), /*#__PURE__*/React.createElement("circle", {
    cx: "19",
    cy: "3",
    r: "2.5",
    fill: muted
  })))), /*#__PURE__*/React.createElement("div", {
    style: {
      padding: '0 16px',
      fontFamily: '-apple-system, system-ui',
      fontSize: 34,
      fontWeight: 700,
      lineHeight: '41px',
      color: text,
      letterSpacing: 0.4
    }
  }, title));
}

// ─────────────────────────────────────────────────────────────
// Grouped list (inset card, r:26) + row (52px)
// ─────────────────────────────────────────────────────────────
function IOSListRow({
  title,
  detail,
  icon,
  chevron = true,
  isLast = false,
  dark = false
}) {
  const text = dark ? '#fff' : '#000';
  const sec = dark ? 'rgba(235,235,245,0.6)' : 'rgba(60,60,67,0.6)';
  const ter = dark ? 'rgba(235,235,245,0.3)' : 'rgba(60,60,67,0.3)';
  const sep = dark ? 'rgba(84,84,88,0.65)' : 'rgba(60,60,67,0.12)';
  return /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      minHeight: 52,
      padding: '0 16px',
      position: 'relative',
      fontFamily: '-apple-system, system-ui',
      fontSize: 17,
      letterSpacing: -0.43
    }
  }, icon && /*#__PURE__*/React.createElement("div", {
    style: {
      width: 30,
      height: 30,
      borderRadius: 7,
      background: icon,
      marginRight: 12,
      flexShrink: 0
    }
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      color: text
    }
  }, title), detail && /*#__PURE__*/React.createElement("span", {
    style: {
      color: sec,
      marginRight: 6
    }
  }, detail), chevron && /*#__PURE__*/React.createElement("svg", {
    width: "8",
    height: "14",
    viewBox: "0 0 8 14",
    style: {
      flexShrink: 0
    }
  }, /*#__PURE__*/React.createElement("path", {
    d: "M1 1l6 6-6 6",
    stroke: ter,
    strokeWidth: "2",
    fill: "none",
    strokeLinecap: "round",
    strokeLinejoin: "round"
  })), !isLast && /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'absolute',
      bottom: 0,
      right: 0,
      left: icon ? 58 : 16,
      height: 0.5,
      background: sep
    }
  }));
}
function IOSList({
  header,
  children,
  dark = false
}) {
  const hc = dark ? 'rgba(235,235,245,0.6)' : 'rgba(60,60,67,0.6)';
  const bg = dark ? '#1C1C1E' : '#fff';
  return /*#__PURE__*/React.createElement("div", null, header && /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: '-apple-system, system-ui',
      fontSize: 13,
      color: hc,
      textTransform: 'uppercase',
      padding: '8px 36px 6px',
      letterSpacing: -0.08
    }
  }, header), /*#__PURE__*/React.createElement("div", {
    style: {
      background: bg,
      borderRadius: 26,
      margin: '0 16px',
      overflow: 'hidden'
    }
  }, children));
}

// ─────────────────────────────────────────────────────────────
// Device frame
// ─────────────────────────────────────────────────────────────
function IOSDevice({
  children,
  width = 402,
  height = 874,
  dark = false,
  title,
  keyboard = false
}) {
  return /*#__PURE__*/React.createElement("div", {
    style: {
      width,
      height,
      borderRadius: 48,
      overflow: 'hidden',
      position: 'relative',
      background: dark ? '#000' : '#F2F2F7',
      boxShadow: '0 40px 80px rgba(0,0,0,0.18), 0 0 0 1px rgba(0,0,0,0.12)',
      fontFamily: '-apple-system, system-ui, sans-serif',
      WebkitFontSmoothing: 'antialiased'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'absolute',
      top: 11,
      left: '50%',
      transform: 'translateX(-50%)',
      width: 126,
      height: 37,
      borderRadius: 24,
      background: '#000',
      zIndex: 50
    }
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'absolute',
      top: 0,
      left: 0,
      right: 0,
      zIndex: 10
    }
  }, /*#__PURE__*/React.createElement(IOSStatusBar, {
    dark: dark
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      height: '100%',
      display: 'flex',
      flexDirection: 'column'
    }
  }, title !== undefined && /*#__PURE__*/React.createElement(IOSNavBar, {
    title: title,
    dark: dark
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      overflow: 'auto'
    }
  }, children), keyboard && /*#__PURE__*/React.createElement(IOSKeyboard, {
    dark: dark
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'absolute',
      bottom: 0,
      left: 0,
      right: 0,
      zIndex: 60,
      height: 34,
      display: 'flex',
      justifyContent: 'center',
      alignItems: 'flex-end',
      paddingBottom: 8,
      pointerEvents: 'none'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      width: 139,
      height: 5,
      borderRadius: 100,
      background: dark ? 'rgba(255,255,255,0.7)' : 'rgba(0,0,0,0.25)'
    }
  })));
}

// ─────────────────────────────────────────────────────────────
// Keyboard — iOS 26 liquid glass
// ─────────────────────────────────────────────────────────────
function IOSKeyboard({
  dark = false
}) {
  const glyph = dark ? 'rgba(255,255,255,0.7)' : '#595959';
  const sugg = dark ? 'rgba(255,255,255,0.6)' : '#333';
  const keyBg = dark ? 'rgba(255,255,255,0.22)' : 'rgba(255,255,255,0.85)';

  // special-key icons
  const icons = {
    shift: /*#__PURE__*/React.createElement("svg", {
      width: "19",
      height: "17",
      viewBox: "0 0 19 17"
    }, /*#__PURE__*/React.createElement("path", {
      d: "M9.5 1L1 9.5h4.5V16h8V9.5H18L9.5 1z",
      fill: glyph
    })),
    del: /*#__PURE__*/React.createElement("svg", {
      width: "23",
      height: "17",
      viewBox: "0 0 23 17"
    }, /*#__PURE__*/React.createElement("path", {
      d: "M7 1h13a2 2 0 012 2v11a2 2 0 01-2 2H7l-6-7.5L7 1z",
      fill: "none",
      stroke: glyph,
      strokeWidth: "1.6",
      strokeLinejoin: "round"
    }), /*#__PURE__*/React.createElement("path", {
      d: "M10 5l7 7M17 5l-7 7",
      stroke: glyph,
      strokeWidth: "1.6",
      strokeLinecap: "round"
    })),
    ret: /*#__PURE__*/React.createElement("svg", {
      width: "20",
      height: "14",
      viewBox: "0 0 20 14"
    }, /*#__PURE__*/React.createElement("path", {
      d: "M18 1v6H4m0 0l4-4M4 7l4 4",
      fill: "none",
      stroke: "#fff",
      strokeWidth: "1.8",
      strokeLinecap: "round",
      strokeLinejoin: "round"
    }))
  };
  const key = (content, {
    w,
    flex,
    ret,
    fs = 25,
    k
  } = {}) => /*#__PURE__*/React.createElement("div", {
    key: k,
    style: {
      height: 42,
      borderRadius: 8.5,
      flex: flex ? 1 : undefined,
      width: w,
      minWidth: 0,
      background: ret ? '#08f' : keyBg,
      boxShadow: '0 1px 0 rgba(0,0,0,0.075)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      fontFamily: '-apple-system, "SF Compact", system-ui',
      fontSize: fs,
      fontWeight: 458,
      color: ret ? '#fff' : glyph
    }
  }, content);
  const row = (keys, pad = 0) => /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 6.5,
      justifyContent: 'center',
      padding: `0 ${pad}px`
    }
  }, keys.map(l => key(l, {
    flex: true,
    k: l
  })));
  return /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'relative',
      zIndex: 15,
      borderRadius: 27,
      overflow: 'hidden',
      padding: '11px 0 2px',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      boxShadow: dark ? '0 -2px 20px rgba(0,0,0,0.09)' : '0 -1px 6px rgba(0,0,0,0.018), 0 -3px 20px rgba(0,0,0,0.012)'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'absolute',
      inset: 0,
      borderRadius: 27,
      backdropFilter: 'blur(12px) saturate(180%)',
      WebkitBackdropFilter: 'blur(12px) saturate(180%)',
      background: dark ? 'rgba(120,120,128,0.14)' : 'rgba(255,255,255,0.25)'
    }
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'absolute',
      inset: 0,
      borderRadius: 27,
      boxShadow: dark ? 'inset 1.5px 1.5px 1px rgba(255,255,255,0.15)' : 'inset 1.5px 1.5px 1px rgba(255,255,255,0.7), inset -1px -1px 1px rgba(255,255,255,0.4)',
      border: dark ? '0.5px solid rgba(255,255,255,0.15)' : '0.5px solid rgba(0,0,0,0.06)',
      pointerEvents: 'none'
    }
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 20,
      alignItems: 'center',
      padding: '8px 22px 13px',
      width: '100%',
      boxSizing: 'border-box',
      position: 'relative'
    }
  }, ['"The"', 'the', 'to'].map((w, i) => /*#__PURE__*/React.createElement(React.Fragment, {
    key: i
  }, i > 0 && /*#__PURE__*/React.createElement("div", {
    style: {
      width: 1,
      height: 25,
      background: '#ccc',
      opacity: 0.3
    }
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      textAlign: 'center',
      fontFamily: '-apple-system, system-ui',
      fontSize: 17,
      color: sugg,
      letterSpacing: -0.43,
      lineHeight: '22px'
    }
  }, w)))), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      flexDirection: 'column',
      gap: 13,
      padding: '0 6.5px',
      width: '100%',
      boxSizing: 'border-box',
      position: 'relative'
    }
  }, row(['q', 'w', 'e', 'r', 't', 'y', 'u', 'i', 'o', 'p']), row(['a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l'], 20), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 14.25,
      alignItems: 'center'
    }
  }, key(icons.shift, {
    w: 45,
    k: 'shift'
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 6.5,
      flex: 1
    }
  }, ['z', 'x', 'c', 'v', 'b', 'n', 'm'].map(l => key(l, {
    flex: true,
    k: l
  }))), key(icons.del, {
    w: 45,
    k: 'del'
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 6,
      alignItems: 'center'
    }
  }, key('ABC', {
    w: 92.25,
    fs: 18,
    k: 'abc'
  }), key('', {
    flex: true,
    k: 'space'
  }), key(icons.ret, {
    w: 92.25,
    ret: true,
    k: 'ret'
  }))), /*#__PURE__*/React.createElement("div", {
    style: {
      height: 56,
      width: '100%',
      position: 'relative'
    }
  }));
}
Object.assign(window, {
  IOSDevice,
  IOSStatusBar,
  IOSNavBar,
  IOSGlassPill,
  IOSList,
  IOSListRow,
  IOSKeyboard
});
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/ios/ios-frame.jsx", error: String((e && e.message) || e) }); }

// ui_kits/ios/screens.jsx
try { (() => {
// iOS screens for FortyMM — uses IOSDevice primitives + custom dark FortyMM styling
// Four screens: Home feed, Match tracker, Bracket, Profile

const C = {
  ink950: '#0B0D12',
  ink900: '#11141B',
  ink800: '#171B24',
  ink700: '#1F2430',
  ink600: '#2A3040',
  ink500: '#3A4152',
  fg1: '#F7F8FB',
  fg2: '#E4E7EF',
  fg3: '#A9B0C2',
  muted: '#6B7283',
  ball: '#FF7A1A',
  ballDim: '#B94700',
  serve: '#00E29A',
  loss: '#FF4D6D'
};
function Screen({
  children,
  pad = true
}) {
  return /*#__PURE__*/React.createElement("div", {
    style: {
      height: '100%',
      background: C.ink950,
      color: C.fg1,
      fontFamily: "'Space Grotesk', system-ui, sans-serif",
      overflowY: 'auto',
      paddingBottom: 100
    }
  }, children);
}
function TopBar({
  title,
  right
}) {
  return /*#__PURE__*/React.createElement("div", {
    style: {
      padding: '62px 20px 12px',
      display: 'flex',
      alignItems: 'flex-end',
      justifyContent: 'space-between',
      position: 'sticky',
      top: 0,
      background: 'rgba(11,13,18,0.75)',
      backdropFilter: 'blur(12px)',
      zIndex: 5,
      borderBottom: `1px solid ${C.ink600}`
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: "'Bebas Neue', sans-serif",
      fontSize: 34,
      letterSpacing: '0.02em',
      lineHeight: 1,
      color: C.fg1
    }
  }, title), right);
}
function TabBar({
  active = 'home',
  onTab
}) {
  const tabs = [{
    k: 'home',
    l: 'Matches'
  }, {
    k: 'find',
    l: 'Find'
  }, {
    k: 'log',
    l: '+',
    primary: true
  }, {
    k: 'bracket',
    l: 'Draws'
  }, {
    k: 'profile',
    l: 'You'
  }];
  return /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'absolute',
      bottom: 0,
      left: 0,
      right: 0,
      zIndex: 40,
      padding: '10px 12px 30px',
      background: 'rgba(11,13,18,0.85)',
      backdropFilter: 'blur(16px)',
      borderTop: `1px solid ${C.ink600}`,
      display: 'flex',
      justifyContent: 'space-around'
    }
  }, tabs.map(t => /*#__PURE__*/React.createElement("div", {
    key: t.k,
    onClick: () => onTab && onTab(t.k),
    style: {
      flex: 1,
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      gap: 4,
      cursor: 'pointer'
    }
  }, t.primary ? /*#__PURE__*/React.createElement("div", {
    style: {
      width: 48,
      height: 48,
      borderRadius: '50%',
      background: C.ball,
      color: C.ink950,
      fontSize: 26,
      fontWeight: 700,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      boxShadow: '0 8px 20px rgba(255,122,26,0.45)',
      marginTop: -12
    }
  }, "+") : /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("div", {
    style: {
      width: 22,
      height: 22,
      borderRadius: active === t.k ? '50%' : '4px',
      background: active === t.k ? C.ball : C.ink700,
      border: active === t.k ? 'none' : `1.5px solid ${C.ink500}`
    }
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      font: `600 10px 'Space Grotesk', sans-serif`,
      letterSpacing: '0.1em',
      textTransform: 'uppercase',
      color: active === t.k ? C.ball : C.fg3
    }
  }, t.l)))));
}

// HOME screen — your matches feed
function HomeScreen() {
  return /*#__PURE__*/React.createElement(Screen, null, /*#__PURE__*/React.createElement(TopBar, {
    title: "Matches",
    right: /*#__PURE__*/React.createElement("div", {
      style: {
        width: 36,
        height: 36,
        borderRadius: '50%',
        background: C.ink700,
        border: `1px solid ${C.ink500}`
      }
    })
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      padding: '20px 16px 0'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      font: '600 11px var(--font-mono)',
      letterSpacing: '0.14em',
      color: C.fg3,
      textTransform: 'uppercase',
      marginBottom: 12
    }
  }, "\u25CF Live near you"), /*#__PURE__*/React.createElement(LiveMatchCard, null), /*#__PURE__*/React.createElement("div", {
    style: {
      font: '600 11px var(--font-mono)',
      letterSpacing: '0.14em',
      color: C.fg3,
      textTransform: 'uppercase',
      margin: '28px 0 12px'
    }
  }, "Your upcoming"), /*#__PURE__*/React.createElement(UpcomingMatch, null), /*#__PURE__*/React.createElement(UpcomingMatch, {
    opponent: "Silva, R.",
    rating: 1985,
    time: "Tomorrow \xB7 19:00",
    club: "Riverside TT"
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      font: '600 11px var(--font-mono)',
      letterSpacing: '0.14em',
      color: C.fg3,
      textTransform: 'uppercase',
      margin: '28px 0 12px'
    }
  }, "Recent"), /*#__PURE__*/React.createElement(RecentMatch, null)));
}
function LiveMatchCard() {
  return /*#__PURE__*/React.createElement("div", {
    style: {
      background: C.ink800,
      border: `1px solid rgba(0,226,154,0.35)`,
      borderRadius: 14,
      padding: 16,
      boxShadow: '0 0 0 1px rgba(0,226,154,0.12), 0 0 24px rgba(0,226,154,0.1)'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      justifyContent: 'space-between',
      marginBottom: 12
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      display: 'inline-flex',
      gap: 6,
      alignItems: 'center',
      font: `600 10px 'JetBrains Mono'`,
      letterSpacing: '0.14em',
      color: C.serve
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      width: 7,
      height: 7,
      borderRadius: '50%',
      background: C.serve,
      boxShadow: `0 0 8px ${C.serve}`
    }
  }), "LIVE \xB7 GAME 3"), /*#__PURE__*/React.createElement("span", {
    style: {
      font: `500 10px 'JetBrains Mono'`,
      color: C.fg3,
      letterSpacing: '0.1em'
    }
  }, "COURT 3")), /*#__PURE__*/React.createElement(IOSPlayerRow, {
    name: "Nguyen, T.",
    seed: "1",
    score: 11,
    win: true
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      height: 1,
      background: C.ink600,
      margin: '10px 0'
    }
  }), /*#__PURE__*/React.createElement(IOSPlayerRow, {
    name: "Okafor, D.",
    seed: "8",
    score: 8
  }));
}
function IOSPlayerRow({
  name,
  seed,
  score,
  win
}) {
  return /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 12
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      width: 36,
      height: 36,
      borderRadius: '50%',
      background: win ? 'linear-gradient(135deg,#FF7A1A,#B94700)' : C.ink700,
      boxShadow: win ? `0 0 0 2px ${C.ball}` : 'none',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      font: '700 13px sans-serif',
      color: win ? '#fff' : C.fg2
    }
  }, name.split(',')[0].slice(0, 2).toUpperCase()), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      font: '600 15px sans-serif',
      color: win ? C.serve : C.fg1
    }
  }, name), /*#__PURE__*/React.createElement("div", {
    style: {
      font: `500 10px 'JetBrains Mono'`,
      color: C.fg3,
      letterSpacing: '0.1em'
    }
  }, "SEED ", seed)), /*#__PURE__*/React.createElement("div", {
    style: {
      font: `700 32px 'JetBrains Mono'`,
      fontVariantNumeric: 'tabular-nums',
      color: win ? C.serve : C.fg1,
      lineHeight: 1
    }
  }, score));
}
function UpcomingMatch({
  opponent = 'Tran, L.',
  rating = 2010,
  time = 'Today · 20:30',
  club = 'Downtown TT Club'
}) {
  return /*#__PURE__*/React.createElement("div", {
    style: {
      background: C.ink800,
      border: `1px solid ${C.ink600}`,
      borderRadius: 12,
      padding: 14,
      marginBottom: 8,
      display: 'flex',
      gap: 12,
      alignItems: 'center'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      width: 40,
      height: 40,
      borderRadius: '50%',
      background: C.ink700,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      font: '700 14px sans-serif',
      color: C.fg2
    }
  }, opponent.slice(0, 2).toUpperCase()), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      font: '600 15px sans-serif',
      color: C.fg1
    }
  }, opponent), /*#__PURE__*/React.createElement("div", {
    style: {
      font: '400 12px sans-serif',
      color: C.fg3
    }
  }, time, " \xB7 ", club)), /*#__PURE__*/React.createElement("div", {
    style: {
      font: `700 12px 'JetBrains Mono'`,
      color: C.ball,
      background: 'rgba(255,122,26,0.14)',
      padding: '4px 10px',
      borderRadius: 999
    }
  }, "\u2605 ", rating));
}
function RecentMatch() {
  return /*#__PURE__*/React.createElement("div", {
    style: {
      background: C.ink800,
      border: `1px solid ${C.ink600}`,
      borderRadius: 12,
      padding: 14,
      display: 'flex',
      gap: 12,
      alignItems: 'center'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      width: 40,
      height: 40,
      borderRadius: '50%',
      background: 'linear-gradient(135deg,#00E29A,#009968)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      font: '700 14px sans-serif',
      color: C.ink950
    }
  }, "W"), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      font: '600 15px sans-serif',
      color: C.fg1
    }
  }, "def. Patel, M.  ", /*#__PURE__*/React.createElement("span", {
    style: {
      color: C.fg3,
      fontFamily: 'JetBrains Mono',
      fontSize: 13
    }
  }, "3\u20131")), /*#__PURE__*/React.createElement("div", {
    style: {
      font: '400 12px sans-serif',
      color: C.fg3
    }
  }, "Yesterday \xB7 Singles \xB7 +12 rating")), /*#__PURE__*/React.createElement("div", {
    style: {
      font: `700 14px 'JetBrains Mono'`,
      color: C.serve
    }
  }, "+12"));
}

// BRACKET screen
function BracketScreen() {
  return /*#__PURE__*/React.createElement(Screen, null, /*#__PURE__*/React.createElement(TopBar, {
    title: "Spring Open",
    right: /*#__PURE__*/React.createElement("div", {
      style: {
        font: `500 11px 'JetBrains Mono'`,
        color: C.fg3,
        letterSpacing: '0.14em'
      }
    }, "R16 \xB7 LIVE")
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      padding: '16px'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 8,
      marginBottom: 16,
      overflowX: 'auto'
    }
  }, ['R32', 'R16', 'QF', 'SF', 'F'].map((r, i) => /*#__PURE__*/React.createElement("div", {
    key: r,
    style: {
      padding: '6px 14px',
      borderRadius: 999,
      font: `600 11px 'Space Grotesk'`,
      letterSpacing: '0.08em',
      whiteSpace: 'nowrap',
      background: i === 1 ? C.ball : 'transparent',
      color: i === 1 ? C.ink950 : C.fg2,
      border: i === 1 ? 'none' : `1px solid ${C.ink500}`
    }
  }, r))), [['Nguyen, T.', 'Silva, R.', 11, 7, true], ['Okafor, D.', 'Johansen, A.', 11, 9, true], ['Tran, L.', 'Patel, M.', 8, 11, false], ['Chen, W.', 'Park, J.', null, null, null]].map((m, i) => /*#__PURE__*/React.createElement(MiniMatch, {
    key: i,
    m: m
  }))));
}
function MiniMatch({
  m
}) {
  const [a, b, sa, sb, aWin] = m;
  const pending = sa === null;
  return /*#__PURE__*/React.createElement("div", {
    style: {
      background: C.ink800,
      border: `1px solid ${C.ink600}`,
      borderRadius: 10,
      padding: 12,
      marginBottom: 8
    }
  }, /*#__PURE__*/React.createElement(MiniRow, {
    n: a,
    s: sa,
    win: aWin === true,
    pending: pending
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      height: 1,
      background: C.ink600,
      margin: '8px 0'
    }
  }), /*#__PURE__*/React.createElement(MiniRow, {
    n: b,
    s: sb,
    win: aWin === false,
    pending: pending
  }));
}
function MiniRow({
  n,
  s,
  win,
  pending
}) {
  return /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 10
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      font: '500 14px sans-serif',
      color: win ? C.serve : pending ? C.fg3 : C.fg1
    }
  }, n), /*#__PURE__*/React.createElement("div", {
    style: {
      font: `700 15px 'JetBrains Mono'`,
      color: win ? C.serve : pending ? C.fg3 : C.fg2,
      fontVariantNumeric: 'tabular-nums'
    }
  }, pending ? '—' : s));
}

// PROFILE screen
function ProfileScreen() {
  return /*#__PURE__*/React.createElement(Screen, null, /*#__PURE__*/React.createElement("div", {
    style: {
      paddingTop: 62
    }
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      padding: '20px 20px 0',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      gap: 12
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      width: 88,
      height: 88,
      borderRadius: '50%',
      background: 'linear-gradient(135deg,#FF7A1A,#B94700)',
      boxShadow: `0 0 0 3px ${C.ball}, 0 0 40px rgba(255,122,26,0.35)`,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      font: '700 30px sans-serif',
      color: '#fff'
    }
  }, "YO"), /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: "'Bebas Neue'",
      fontSize: 34,
      letterSpacing: '0.02em',
      color: C.fg1,
      lineHeight: 1
    }
  }, "You"), /*#__PURE__*/React.createElement("div", {
    style: {
      font: `500 11px 'JetBrains Mono'`,
      color: C.fg3,
      letterSpacing: '0.14em'
    }
  }, "Downtown TT Club \xB7 Since Mar 2025")), /*#__PURE__*/React.createElement("div", {
    style: {
      padding: '24px 16px 0',
      display: 'grid',
      gridTemplateColumns: '1fr 1fr 1fr',
      gap: 8
    }
  }, /*#__PURE__*/React.createElement(Stat, {
    v: "1,847",
    l: "Rating"
  }), /*#__PURE__*/React.createElement(Stat, {
    v: "42",
    l: "Matches"
  }), /*#__PURE__*/React.createElement(Stat, {
    v: "71%",
    l: "Win rate"
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      padding: '24px 16px 0'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      font: '600 11px var(--font-mono)',
      letterSpacing: '0.14em',
      color: C.fg3,
      textTransform: 'uppercase',
      marginBottom: 10
    }
  }, "Rating history"), /*#__PURE__*/React.createElement("div", {
    style: {
      background: C.ink800,
      border: `1px solid ${C.ink600}`,
      borderRadius: 12,
      padding: 16,
      height: 140,
      position: 'relative'
    }
  }, /*#__PURE__*/React.createElement("svg", {
    width: "100%",
    height: "100%",
    viewBox: "0 0 300 100",
    preserveAspectRatio: "none"
  }, /*#__PURE__*/React.createElement("polyline", {
    points: "0,70 30,65 60,68 90,55 120,58 150,45 180,48 210,35 240,38 270,25 300,22",
    fill: "none",
    stroke: C.ball,
    strokeWidth: "2"
  }), /*#__PURE__*/React.createElement("polyline", {
    points: "0,70 30,65 60,68 90,55 120,58 150,45 180,48 210,35 240,38 270,25 300,22 300,100 0,100",
    fill: "rgba(255,122,26,0.12)"
  })))));
}
function Stat({
  v,
  l
}) {
  return /*#__PURE__*/React.createElement("div", {
    style: {
      background: C.ink800,
      border: `1px solid ${C.ink600}`,
      borderRadius: 10,
      padding: '14px 12px',
      textAlign: 'center'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      font: `700 22px 'JetBrains Mono'`,
      fontVariantNumeric: 'tabular-nums',
      color: C.fg1
    }
  }, v), /*#__PURE__*/React.createElement("div", {
    style: {
      font: `600 10px 'Space Grotesk'`,
      letterSpacing: '0.14em',
      color: C.fg3,
      textTransform: 'uppercase',
      marginTop: 2
    }
  }, l));
}
Object.assign(window, {
  Screen,
  TopBar,
  TabBar,
  HomeScreen,
  BracketScreen,
  ProfileScreen,
  LiveMatchCard
});

// ---- App mount (moved from index.html) ----
function Phone({
  children,
  tab = 'home',
  onTab
}) {
  return /*#__PURE__*/React.createElement("div", {
    className: "phone"
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      width: 372,
      height: 790,
      borderRadius: 48,
      overflow: 'hidden',
      position: 'relative',
      background: '#000',
      boxShadow: '0 30px 80px rgba(0,0,0,0.55), 0 0 0 1px rgba(0,0,0,0.5)'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'absolute',
      top: 10,
      left: '50%',
      transform: 'translateX(-50%)',
      width: 120,
      height: 34,
      borderRadius: 22,
      background: '#000',
      zIndex: 60
    }
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'absolute',
      top: 16,
      left: 26,
      fontFamily: '-apple-system, system-ui',
      fontWeight: 600,
      fontSize: 15,
      color: '#fff',
      zIndex: 30
    }
  }, "9:41"), /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'absolute',
      top: 16,
      right: 26,
      display: 'flex',
      gap: 6,
      zIndex: 30
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      width: 16,
      height: 11,
      background: '#fff',
      borderRadius: 1
    }
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      width: 22,
      height: 11,
      border: '1px solid #fff',
      borderRadius: 3
    }
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      width: '100%',
      height: '100%'
    }
  }, children), /*#__PURE__*/React.createElement(TabBar, {
    active: tab,
    onTab: onTab
  })));
}
function App() {
  const [tab, setTab] = React.useState('home');
  const screens = {
    home: /*#__PURE__*/React.createElement(HomeScreen, null),
    bracket: /*#__PURE__*/React.createElement(BracketScreen, null),
    profile: /*#__PURE__*/React.createElement(ProfileScreen, null),
    find: /*#__PURE__*/React.createElement(HomeScreen, null),
    log: /*#__PURE__*/React.createElement(HomeScreen, null)
  };
  return /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center'
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "tabs"
  }, /*#__PURE__*/React.createElement("button", {
    className: "tab " + (tab === 'home' ? 'on' : ''),
    onClick: () => setTab('home')
  }, "Matches"), /*#__PURE__*/React.createElement("button", {
    className: "tab " + (tab === 'bracket' ? 'on' : ''),
    onClick: () => setTab('bracket')
  }, "Bracket"), /*#__PURE__*/React.createElement("button", {
    className: "tab " + (tab === 'profile' ? 'on' : ''),
    onClick: () => setTab('profile')
  }, "Profile")), /*#__PURE__*/React.createElement(Phone, {
    tab: tab,
    onTab: setTab
  }, screens[tab]));
}
ReactDOM.createRoot(document.getElementById('root')).render(/*#__PURE__*/React.createElement(App, null));
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/ios/screens.jsx", error: String((e && e.message) || e) }); }

// ui_kits/marketing/browser-window.jsx
try { (() => {
// Chrome.jsx — Simplified Chrome browser window (dark theme, macOS)
// No dependencies, no image assets. All inline styles + inline SVG.

const CHROME_C = {
  barBg: '#202124',
  tabBg: '#35363a',
  text: '#e8eaed',
  dim: '#9aa0a6',
  urlBg: '#282a2d'
};
function ChromeTrafficLights() {
  return /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 8,
      padding: '0 14px'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      width: 12,
      height: 12,
      borderRadius: '50%',
      background: '#ff5f57'
    }
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      width: 12,
      height: 12,
      borderRadius: '50%',
      background: '#febc2e'
    }
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      width: 12,
      height: 12,
      borderRadius: '50%',
      background: '#28c840'
    }
  }));
}

// Single tab (active has curved scoops)
function ChromeTab({
  title = 'New Tab',
  active = false
}) {
  const curve = flip => /*#__PURE__*/React.createElement("svg", {
    width: "8",
    height: "10",
    viewBox: "0 0 8 10",
    style: {
      position: 'absolute',
      bottom: 0,
      [flip ? 'right' : 'left']: -8,
      transform: flip ? 'scaleX(-1)' : 'none'
    }
  }, /*#__PURE__*/React.createElement("path", {
    d: "M0 10C2 9 6 8 8 0V10H0Z",
    fill: CHROME_C.tabBg
  }));
  return /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'relative',
      height: 34,
      alignSelf: 'flex-end',
      padding: '0 12px',
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      background: active ? CHROME_C.tabBg : 'transparent',
      borderRadius: '8px 8px 0 0',
      minWidth: 120,
      maxWidth: 220,
      fontFamily: 'system-ui, sans-serif',
      fontSize: 12,
      color: active ? CHROME_C.text : CHROME_C.dim
    }
  }, active && curve(false), active && curve(true), /*#__PURE__*/React.createElement("div", {
    style: {
      width: 14,
      height: 14,
      borderRadius: '50%',
      background: '#5f6368',
      flexShrink: 0
    }
  }), /*#__PURE__*/React.createElement("span", {
    style: {
      flex: 1,
      whiteSpace: 'nowrap',
      overflow: 'hidden',
      textOverflow: 'ellipsis'
    }
  }, title));
}
function ChromeTabBar({
  tabs = [{
    title: 'New Tab'
  }],
  activeIndex = 0
}) {
  return /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      height: 44,
      background: CHROME_C.barBg,
      paddingRight: 8
    }
  }, /*#__PURE__*/React.createElement(ChromeTrafficLights, null), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'flex-end',
      height: '100%',
      paddingLeft: 4,
      flex: 1
    }
  }, tabs.map((t, i) => /*#__PURE__*/React.createElement(ChromeTab, {
    key: i,
    title: t.title,
    active: i === activeIndex
  }))));
}
function ChromeToolbar({
  url = 'example.com'
}) {
  const iconDot = /*#__PURE__*/React.createElement("div", {
    style: {
      width: 28,
      height: 28,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      width: 16,
      height: 16,
      borderRadius: '50%',
      background: CHROME_C.dim,
      opacity: 0.4
    }
  }));
  return /*#__PURE__*/React.createElement("div", {
    style: {
      height: 40,
      background: CHROME_C.tabBg,
      display: 'flex',
      alignItems: 'center',
      gap: 4,
      padding: '0 8px'
    }
  }, iconDot, /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      height: 30,
      borderRadius: 15,
      background: CHROME_C.urlBg,
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      padding: '0 14px',
      margin: '0 6px'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      width: 12,
      height: 12,
      borderRadius: '50%',
      background: CHROME_C.dim,
      opacity: 0.4
    }
  }), /*#__PURE__*/React.createElement("span", {
    style: {
      flex: 1,
      color: CHROME_C.text,
      fontSize: 13,
      fontFamily: 'system-ui, sans-serif'
    }
  }, url)), iconDot);
}
function ChromeWindow({
  tabs = [{
    title: 'New Tab'
  }],
  activeIndex = 0,
  url = 'example.com',
  width = 900,
  height = 600,
  children
}) {
  return /*#__PURE__*/React.createElement("div", {
    style: {
      width,
      height,
      borderRadius: 10,
      overflow: 'hidden',
      boxShadow: '0 24px 80px rgba(0,0,0,0.35), 0 0 0 1px rgba(0,0,0,0.1)',
      display: 'flex',
      flexDirection: 'column',
      background: CHROME_C.tabBg
    }
  }, /*#__PURE__*/React.createElement(ChromeTabBar, {
    tabs: tabs,
    activeIndex: activeIndex
  }), /*#__PURE__*/React.createElement(ChromeToolbar, {
    url: url
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      background: '#fff',
      overflow: 'auto'
    }
  }, children));
}
Object.assign(window, {
  ChromeWindow,
  ChromeTabBar,
  ChromeToolbar,
  ChromeTab,
  ChromeTrafficLights
});
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/marketing/browser-window.jsx", error: String((e && e.message) || e) }); }

// ui_kits/marketing/components.jsx
try { (() => {
// Marketing site components for FortyMM
// Uses tokens from ../../colors_and_type.css

function Nav() {
  return /*#__PURE__*/React.createElement("nav", {
    style: {
      position: 'sticky',
      top: 0,
      zIndex: 50,
      display: 'flex',
      alignItems: 'center',
      gap: 32,
      padding: '18px 40px',
      background: 'rgba(11,13,18,0.72)',
      backdropFilter: 'blur(16px)',
      WebkitBackdropFilter: 'blur(16px)',
      borderBottom: '1px solid var(--ink-600)'
    }
  }, /*#__PURE__*/React.createElement(Logo, {
    size: 28
  }), /*#__PURE__*/React.createElement("a", {
    style: navLink
  }, "Product"), /*#__PURE__*/React.createElement("a", {
    style: navLink
  }, "Tournaments"), /*#__PURE__*/React.createElement("a", {
    style: navLink
  }, "Clubs"), /*#__PURE__*/React.createElement("a", {
    style: navLink
  }, "Manifesto"), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1
    }
  }), /*#__PURE__*/React.createElement("a", {
    style: navLink
  }, "Sign in"), /*#__PURE__*/React.createElement("button", {
    className: "btn-primary"
  }, "Get the app"));
}
const navLink = {
  font: '500 14px var(--font-ui)',
  color: 'var(--fg-2)',
  textDecoration: 'none',
  cursor: 'pointer'
};
function Logo({
  size = 32
}) {
  return /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 10
    }
  }, /*#__PURE__*/React.createElement("svg", {
    width: size,
    height: size,
    viewBox: "0 0 80 80"
  }, /*#__PURE__*/React.createElement("defs", null, /*#__PURE__*/React.createElement("radialGradient", {
    id: "lg",
    cx: "35%",
    cy: "35%",
    r: "65%"
  }, /*#__PURE__*/React.createElement("stop", {
    offset: "0%",
    stopColor: "#FFB57A"
  }), /*#__PURE__*/React.createElement("stop", {
    offset: "55%",
    stopColor: "#FF7A1A"
  }), /*#__PURE__*/React.createElement("stop", {
    offset: "100%",
    stopColor: "#B94700"
  }))), /*#__PURE__*/React.createElement("circle", {
    cx: "40",
    cy: "40",
    r: "36",
    fill: "url(#lg)"
  }), /*#__PURE__*/React.createElement("ellipse", {
    cx: "30",
    cy: "28",
    rx: "10",
    ry: "6",
    fill: "#FFF",
    fillOpacity: "0.22"
  })), /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: "'Bebas Neue', sans-serif",
      fontSize: size * 0.95,
      letterSpacing: '0.04em',
      color: 'var(--fg-1)',
      lineHeight: 1
    }
  }, "FORTYMM", /*#__PURE__*/React.createElement("span", {
    style: {
      color: 'var(--ball-500)'
    }
  }, ".")));
}
function Hero() {
  return /*#__PURE__*/React.createElement("section", {
    style: {
      position: 'relative',
      padding: '80px 40px 120px',
      overflow: 'hidden'
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "fortymm-grid-bg",
    style: {
      position: 'absolute',
      inset: 0,
      opacity: 0.6,
      maskImage: 'radial-gradient(ellipse 70% 50% at 70% 30%, black, transparent)',
      WebkitMaskImage: 'radial-gradient(ellipse 70% 50% at 70% 30%, black, transparent)'
    }
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'absolute',
      top: '10%',
      right: '5%',
      width: 500,
      height: 500,
      background: 'radial-gradient(circle, rgba(255,122,26,0.18), transparent 70%)',
      pointerEvents: 'none'
    }
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'relative',
      maxWidth: 1180,
      margin: '0 auto',
      display: 'grid',
      gridTemplateColumns: '1.1fr 0.9fr',
      gap: 64,
      alignItems: 'center'
    }
  }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    className: "overline",
    style: {
      color: 'var(--ball-500)',
      marginBottom: 20
    }
  }, "\u25CF Free forever \xB7 No ads \xB7 No tracking"), /*#__PURE__*/React.createElement("h1", {
    style: {
      fontFamily: "'Bebas Neue', sans-serif",
      fontSize: 112,
      lineHeight: 0.92,
      letterSpacing: '0.01em',
      color: 'var(--fg-1)',
      margin: '0 0 24px',
      textTransform: 'uppercase'
    }
  }, "Play more.", /*#__PURE__*/React.createElement("br", null), /*#__PURE__*/React.createElement("span", {
    style: {
      color: 'var(--ball-500)'
    }
  }, "Pay never.")), /*#__PURE__*/React.createElement("p", {
    style: {
      fontSize: 20,
      lineHeight: 1.5,
      color: 'var(--fg-2)',
      maxWidth: 520,
      margin: '0 0 32px'
    }
  }, "The table-tennis app made by players, for players. Track your matches, join tournaments, find opponents. No premium tier. No cookie banners. No horse shit."), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 12
    }
  }, /*#__PURE__*/React.createElement("button", {
    className: "btn-primary btn-lg"
  }, "Download for iOS"), /*#__PURE__*/React.createElement("button", {
    className: "btn-secondary btn-lg"
  }, "Download for Android")), /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 24,
      display: 'flex',
      gap: 28,
      alignItems: 'center'
    }
  }, /*#__PURE__*/React.createElement(Stat, {
    n: "12,480",
    l: "active players"
  }), /*#__PURE__*/React.createElement(Stat, {
    n: "340",
    l: "clubs"
  }), /*#__PURE__*/React.createElement(Stat, {
    n: "1,102",
    l: "tournaments run"
  }))), /*#__PURE__*/React.createElement(HeroScoreboard, null)));
}
function Stat({
  n,
  l
}) {
  return /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: 'var(--font-mono)',
      fontSize: 22,
      fontWeight: 700,
      color: 'var(--fg-1)',
      fontVariantNumeric: 'tabular-nums'
    }
  }, n), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 12,
      color: 'var(--fg-3)',
      letterSpacing: '0.1em',
      textTransform: 'uppercase'
    }
  }, l));
}
function HeroScoreboard() {
  return /*#__PURE__*/React.createElement("div", {
    style: {
      background: 'var(--ink-800)',
      border: '1px solid var(--ink-600)',
      borderRadius: 16,
      padding: 28,
      boxShadow: '0 24px 60px rgba(0,0,0,0.5)'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'center',
      marginBottom: 20
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      display: 'inline-flex',
      alignItems: 'center',
      gap: 8,
      fontFamily: 'var(--font-mono)',
      fontSize: 11,
      letterSpacing: '0.14em',
      color: 'var(--serve-500)'
    }
  }, /*#__PURE__*/React.createElement("span", {
    className: "ball-dot ball-dot--live"
  }), "LIVE \xB7 GAME 4"), /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: 'var(--font-mono)',
      fontSize: 11,
      color: 'var(--fg-3)',
      letterSpacing: '0.1em'
    }
  }, "COURT 3 \xB7 19:42")), /*#__PURE__*/React.createElement(Player, {
    name: "Nguyen, T.",
    seed: "1",
    score: 11,
    win: true
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      height: 1,
      background: 'var(--ink-600)',
      margin: '14px 0'
    }
  }), /*#__PURE__*/React.createElement(Player, {
    name: "Okafor, D.",
    seed: "8",
    score: 8
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 24,
      display: 'grid',
      gridTemplateColumns: 'repeat(4,1fr)',
      gap: 8
    }
  }, [[11, 6], [9, 11], [11, 8], [11, 8]].map((g, i) => /*#__PURE__*/React.createElement(GameBox, {
    key: i,
    g: g,
    live: i === 3
  }))));
}
function Player({
  name,
  seed,
  score,
  win
}) {
  return /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 14
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      width: 40,
      height: 40,
      borderRadius: '50%',
      background: win ? 'linear-gradient(135deg,#FF7A1A,#B94700)' : 'var(--ink-700)',
      boxShadow: win ? '0 0 0 2px var(--ball-500)' : 'none',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      font: '700 14px var(--font-ui)',
      color: win ? '#fff' : 'var(--fg-2)'
    }
  }, name.split(',')[0].slice(0, 2).toUpperCase()), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      font: '600 16px var(--font-ui)',
      color: win ? 'var(--serve-500)' : 'var(--fg-1)'
    }
  }, name), /*#__PURE__*/React.createElement("div", {
    style: {
      font: '500 11px var(--font-mono)',
      color: 'var(--fg-3)',
      letterSpacing: '0.1em'
    }
  }, "SEED ", seed, " \xB7 2145")), /*#__PURE__*/React.createElement("div", {
    style: {
      font: '700 44px var(--font-mono)',
      fontVariantNumeric: 'tabular-nums',
      color: win ? 'var(--serve-500)' : 'var(--fg-1)',
      lineHeight: 1
    }
  }, score));
}
function GameBox({
  g,
  live
}) {
  return /*#__PURE__*/React.createElement("div", {
    style: {
      background: 'var(--ink-900)',
      border: live ? '1px solid rgba(0,226,154,0.4)' : '1px solid var(--ink-600)',
      borderRadius: 8,
      padding: '10px 8px',
      textAlign: 'center'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      font: '700 18px var(--font-mono)',
      color: g[0] > g[1] ? 'var(--serve-500)' : 'var(--fg-2)'
    }
  }, g[0]), /*#__PURE__*/React.createElement("div", {
    style: {
      height: 1,
      background: 'var(--ink-600)',
      margin: '4px 0'
    }
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      font: '700 18px var(--font-mono)',
      color: g[1] > g[0] ? 'var(--serve-500)' : 'var(--fg-2)'
    }
  }, g[1]));
}
function Manifesto() {
  return /*#__PURE__*/React.createElement("section", {
    style: {
      padding: '100px 40px',
      background: 'var(--ink-900)',
      borderTop: '1px solid var(--ink-600)',
      borderBottom: '1px solid var(--ink-600)'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      maxWidth: 900,
      margin: '0 auto'
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "overline",
    style: {
      color: 'var(--ball-500)',
      marginBottom: 16
    }
  }, "\u25CF Manifesto"), /*#__PURE__*/React.createElement("h2", {
    style: {
      fontFamily: "'Bebas Neue', sans-serif",
      fontSize: 64,
      lineHeight: 1,
      letterSpacing: '0.01em',
      color: 'var(--fg-1)',
      margin: '0 0 40px',
      textTransform: 'uppercase'
    }
  }, "For the love of the game."), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'grid',
      gridTemplateColumns: '1fr 1fr',
      gap: 32
    }
  }, /*#__PURE__*/React.createElement(Promise, {
    n: "01",
    t: "No ads. Not now, not ever.",
    d: "Every other sports-tracker app ends up covered in Draftkings banners. Ours won't. That's a commitment, not a roadmap item."
  }), /*#__PURE__*/React.createElement(Promise, {
    n: "02",
    t: "No premium tier.",
    d: "Every feature works for everyone. No unlocks, no trials, no 'upgrade to see full bracket' nonsense."
  }), /*#__PURE__*/React.createElement(Promise, {
    n: "03",
    t: "We don't sell your data.",
    d: "No trackers, no third-party analytics, no cookie consent theater. We keep what the app needs to work. Nothing else."
  }), /*#__PURE__*/React.createElement(Promise, {
    n: "04",
    t: "The math is quiet. The rallies are loud.",
    d: "We use an SMT solver to pack tournament schedules \u2014 fewer back-to-backs, smarter court assignments. You'll never see it. You'll just play more."
  }))));
}
function Promise({
  n,
  t,
  d
}) {
  return /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: 'var(--font-mono)',
      fontSize: 13,
      fontWeight: 700,
      color: 'var(--ball-500)',
      letterSpacing: '0.1em',
      marginBottom: 10
    }
  }, n), /*#__PURE__*/React.createElement("h3", {
    style: {
      font: '600 22px var(--font-ui)',
      color: 'var(--fg-1)',
      margin: '0 0 10px',
      letterSpacing: '-0.01em'
    }
  }, t), /*#__PURE__*/React.createElement("p", {
    style: {
      font: '400 15px/1.55 var(--font-ui)',
      color: 'var(--fg-2)',
      margin: 0
    }
  }, d));
}
function Footer() {
  return /*#__PURE__*/React.createElement("footer", {
    style: {
      padding: '60px 40px 40px',
      borderTop: '1px solid var(--ink-600)'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      maxWidth: 1180,
      margin: '0 auto',
      display: 'flex',
      gap: 60,
      flexWrap: 'wrap'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      flex: '0 0 280px'
    }
  }, /*#__PURE__*/React.createElement(Logo, {
    size: 24
  }), /*#__PURE__*/React.createElement("p", {
    style: {
      font: '400 13px/1.55 var(--font-ui)',
      color: 'var(--fg-3)',
      margin: '16px 0 0'
    }
  }, "Made by players, in basements and rec centers. \xA9 2026 FortyMM.")), /*#__PURE__*/React.createElement(FooterCol, {
    h: "Product",
    items: ['iOS', 'Android', 'Spectator']
  }), /*#__PURE__*/React.createElement(FooterCol, {
    h: "Tournaments",
    items: ['Run one', 'Find one', 'SMT solver']
  }), /*#__PURE__*/React.createElement(FooterCol, {
    h: "Community",
    items: ['Discord', 'Clubs', 'Open-source']
  }), /*#__PURE__*/React.createElement(FooterCol, {
    h: "Never",
    items: ['Ads', 'Tracking', 'Premium']
  })));
}
function FooterCol({
  h,
  items
}) {
  return /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    className: "overline",
    style: {
      marginBottom: 14
    }
  }, h), items.map(i => /*#__PURE__*/React.createElement("div", {
    key: i,
    style: {
      font: '500 14px/2 var(--font-ui)',
      color: 'var(--fg-2)',
      cursor: 'pointer'
    }
  }, i)));
}
Object.assign(window, {
  Nav,
  Logo,
  Hero,
  Manifesto,
  Footer
});

// ---- App mount (moved from index.html) ----
function App() {
  return /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement(Nav, null), /*#__PURE__*/React.createElement(Hero, null), /*#__PURE__*/React.createElement(Manifesto, null), /*#__PURE__*/React.createElement(Footer, null));
}
ReactDOM.createRoot(document.getElementById('root')).render(/*#__PURE__*/React.createElement(App, null));
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/marketing/components.jsx", error: String((e && e.message) || e) }); }

// ui_kits/spectator/components.jsx
try { (() => {
// Spectator public bracket view — full-bleed, shareable, readable from 10 feet
const C = {
  ink950: '#0B0D12',
  ink900: '#11141B',
  ink800: '#171B24',
  ink700: '#1F2430',
  ink600: '#2A3040',
  ink500: '#3A4152',
  fg1: '#F7F8FB',
  fg2: '#E4E7EF',
  fg3: '#A9B0C2',
  ball: '#FF7A1A',
  serve: '#00E29A'
};
function SpecHeader() {
  return /*#__PURE__*/React.createElement("header", {
    style: {
      padding: '24px 40px',
      display: 'flex',
      alignItems: 'center',
      gap: 20,
      borderBottom: `1px solid ${C.ink600}`,
      background: 'rgba(11,13,18,0.8)',
      backdropFilter: 'blur(12px)',
      position: 'sticky',
      top: 0,
      zIndex: 5
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 10
    }
  }, /*#__PURE__*/React.createElement("svg", {
    width: "30",
    height: "30",
    viewBox: "0 0 80 80"
  }, /*#__PURE__*/React.createElement("defs", null, /*#__PURE__*/React.createElement("radialGradient", {
    id: "sh",
    cx: "35%",
    cy: "35%",
    r: "65%"
  }, /*#__PURE__*/React.createElement("stop", {
    offset: "0%",
    stopColor: "#FFB57A"
  }), /*#__PURE__*/React.createElement("stop", {
    offset: "55%",
    stopColor: "#FF7A1A"
  }), /*#__PURE__*/React.createElement("stop", {
    offset: "100%",
    stopColor: "#B94700"
  }))), /*#__PURE__*/React.createElement("circle", {
    cx: "40",
    cy: "40",
    r: "36",
    fill: "url(#sh)"
  })), /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: "'Bebas Neue'",
      fontSize: 24,
      letterSpacing: '0.04em',
      color: C.fg1
    }
  }, "FORTYMM", /*#__PURE__*/React.createElement("span", {
    style: {
      color: C.ball
    }
  }, "."))), /*#__PURE__*/React.createElement("div", {
    style: {
      height: 24,
      width: 1,
      background: C.ink600,
      margin: '0 8px'
    }
  }), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    style: {
      font: "700 22px 'Space Grotesk'",
      color: C.fg1,
      letterSpacing: '-0.01em'
    }
  }, "Spring Open 2026"), /*#__PURE__*/React.createElement("div", {
    style: {
      font: "500 12px 'JetBrains Mono'",
      color: C.fg3,
      letterSpacing: '0.1em'
    }
  }, "DAY 2 \xB7 64 PLAYERS \xB7 LIVE")), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1
    }
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'inline-flex',
      alignItems: 'center',
      gap: 8,
      padding: '8px 14px',
      borderRadius: 999,
      background: 'rgba(0,226,154,0.12)',
      border: '1px solid rgba(0,226,154,0.3)'
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      width: 8,
      height: 8,
      borderRadius: '50%',
      background: C.serve,
      boxShadow: `0 0 10px ${C.serve}`,
      animation: 'p 1.4s infinite'
    }
  }), /*#__PURE__*/React.createElement("span", {
    style: {
      font: "600 12px 'JetBrains Mono'",
      color: C.serve,
      letterSpacing: '0.14em'
    }
  }, "4 LIVE")), /*#__PURE__*/React.createElement("button", {
    style: {
      font: "600 13px 'Space Grotesk'",
      height: 38,
      padding: '0 18px',
      borderRadius: 8,
      background: 'transparent',
      border: `1px solid ${C.ink500}`,
      color: C.fg1,
      cursor: 'pointer'
    }
  }, "Share"), /*#__PURE__*/React.createElement("style", null, `@keyframes p{0%,100%{opacity:1}50%{opacity:0.5}}`));
}
function Bracket() {
  const rounds = [{
    name: 'R16',
    matches: [['Nguyen, T.', 1, 'Silva, R.', 16, 11, 7, 'a', 'done'], ['Kim, H.', 8, 'Dubois, C.', 9, 11, 6, 'a', 'done'], ['Okafor, D.', 5, 'Johansen, A.', 12, 9, 11, 'b', 'live', '9-11, game 3'], ['Patel, M.', 4, 'Park, J.', 13, null, null, null, 'next'], ['Tran, L.', 3, 'Rossi, G.', 14, 11, 8, 'a', 'live', '11-8, game 4'], ['Chen, W.', 6, 'Ali, R.', 11, null, null, null, 'next'], ['Ahmed, I.', 7, 'Hansen, M.', 10, null, null, null, 'scheduled'], ['Tanaka, Y.', 2, 'Müller, F.', 15, null, null, null, 'scheduled']]
  }, {
    name: 'QF',
    matches: [['W1', null, 'W2', null, null, null, null, 'pending']]
  }, {
    name: 'SF',
    matches: [['', null, '', null, null, null, null, 'pending']]
  }];
  return /*#__PURE__*/React.createElement("div", {
    style: {
      padding: 40,
      display: 'flex',
      gap: 32,
      overflowX: 'auto',
      alignItems: 'flex-start'
    }
  }, rounds.map((r, ri) => /*#__PURE__*/React.createElement("div", {
    key: r.name,
    style: {
      display: 'flex',
      flexDirection: 'column',
      gap: ri === 0 ? 12 : ri === 1 ? 52 : 136,
      minWidth: 300
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      font: `700 14px 'JetBrains Mono'`,
      color: C.ball,
      letterSpacing: '0.2em',
      marginBottom: 6
    }
  }, "ROUND \xB7 ", r.name), r.matches.map((m, i) => /*#__PURE__*/React.createElement(SpecMatch, {
    key: i,
    m: m
  })))));
}
function SpecMatch({
  m
}) {
  const [a, sa, b, sb, scA, scB, win, status, detail] = m;
  const live = status === 'live';
  const pending = status === 'pending' || status === 'scheduled' || status === 'next';
  return /*#__PURE__*/React.createElement("div", {
    style: {
      background: C.ink800,
      border: `1px solid ${live ? 'rgba(0,226,154,0.4)' : C.ink600}`,
      borderRadius: 12,
      padding: '12px 14px',
      boxShadow: live ? '0 0 24px rgba(0,226,154,0.1)' : 'none',
      minWidth: 280
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      justifyContent: 'space-between',
      marginBottom: 8,
      minHeight: 14
    }
  }, live ? /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("span", {
    style: {
      display: 'inline-flex',
      gap: 6,
      alignItems: 'center',
      font: "600 10px 'JetBrains Mono'",
      color: C.serve,
      letterSpacing: '0.14em'
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      width: 6,
      height: 6,
      borderRadius: '50%',
      background: C.serve,
      boxShadow: `0 0 8px ${C.serve}`
    }
  }), "LIVE"), /*#__PURE__*/React.createElement("span", {
    style: {
      font: "500 10px 'JetBrains Mono'",
      color: C.fg3,
      letterSpacing: '0.1em'
    }
  }, detail)) : /*#__PURE__*/React.createElement("span", {
    style: {
      font: "500 10px 'JetBrains Mono'",
      color: C.fg3,
      letterSpacing: '0.14em',
      textTransform: 'uppercase'
    }
  }, status === 'done' ? 'FINAL' : status === 'next' ? 'UP NEXT' : '—')), /*#__PURE__*/React.createElement(SpecRow, {
    n: a,
    seed: sa,
    s: scA,
    win: win === 'a',
    pending: pending
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      height: 1,
      background: C.ink600,
      margin: '7px 0'
    }
  }), /*#__PURE__*/React.createElement(SpecRow, {
    n: b,
    seed: sb,
    s: scB,
    win: win === 'b',
    pending: pending
  }));
}
function SpecRow({
  n,
  seed,
  s,
  win,
  pending
}) {
  return /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 10
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      font: `600 11px 'JetBrains Mono'`,
      color: C.fg3,
      minWidth: 24
    }
  }, seed ? `[${seed}]` : ''), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      font: `600 15px 'Space Grotesk'`,
      color: win ? C.serve : pending ? C.fg3 : C.fg1
    }
  }, n || '—'), /*#__PURE__*/React.createElement("div", {
    style: {
      font: `700 22px 'JetBrains Mono'`,
      fontVariantNumeric: 'tabular-nums',
      color: win ? C.serve : pending ? C.fg3 : C.fg2,
      lineHeight: 1,
      minWidth: 24,
      textAlign: 'right'
    }
  }, pending || s == null ? '' : s));
}
Object.assign(window, {
  SpecHeader,
  Bracket
});

// ---- App mount (moved from index.html) ----
ReactDOM.createRoot(document.getElementById('root')).render(/*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement(SpecHeader, null), /*#__PURE__*/React.createElement(Bracket, null)));
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/spectator/components.jsx", error: String((e && e.message) || e) }); }

// ui_kits/web_admin/components.jsx
try { (() => {
// Web admin dashboard components for FortyMM tournament control
const C = {
  ink950: '#0B0D12',
  ink900: '#11141B',
  ink800: '#171B24',
  ink700: '#1F2430',
  ink600: '#2A3040',
  ink500: '#3A4152',
  fg1: '#F7F8FB',
  fg2: '#E4E7EF',
  fg3: '#A9B0C2',
  ball: '#FF7A1A',
  serve: '#00E29A',
  loss: '#FF4D6D',
  warn: '#FFC43D'
};
function Sidebar({
  active = 'courts'
}) {
  const items = [['overview', 'Overview'], ['draws', 'Draws'], ['courts', 'Courts · Live'], ['players', 'Players'], ['schedule', 'Schedule'], ['solver', 'SMT solver'], ['reports', 'Reports'], ['settings', 'Settings']];
  return /*#__PURE__*/React.createElement("aside", {
    style: {
      width: 220,
      background: C.ink900,
      borderRight: `1px solid ${C.ink600}`,
      padding: '18px 0',
      display: 'flex',
      flexDirection: 'column',
      gap: 2
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      padding: '0 18px 18px',
      display: 'flex',
      alignItems: 'center',
      gap: 10,
      borderBottom: `1px solid ${C.ink600}`,
      marginBottom: 12
    }
  }, /*#__PURE__*/React.createElement("svg", {
    width: "28",
    height: "28",
    viewBox: "0 0 80 80"
  }, /*#__PURE__*/React.createElement("defs", null, /*#__PURE__*/React.createElement("radialGradient", {
    id: "sg",
    cx: "35%",
    cy: "35%",
    r: "65%"
  }, /*#__PURE__*/React.createElement("stop", {
    offset: "0%",
    stopColor: "#FFB57A"
  }), /*#__PURE__*/React.createElement("stop", {
    offset: "55%",
    stopColor: "#FF7A1A"
  }), /*#__PURE__*/React.createElement("stop", {
    offset: "100%",
    stopColor: "#B94700"
  }))), /*#__PURE__*/React.createElement("circle", {
    cx: "40",
    cy: "40",
    r: "36",
    fill: "url(#sg)"
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: "'Bebas Neue'",
      fontSize: 22,
      letterSpacing: '0.04em',
      color: C.fg1
    }
  }, "FORTYMM", /*#__PURE__*/React.createElement("span", {
    style: {
      color: C.ball
    }
  }, "."))), /*#__PURE__*/React.createElement("div", {
    style: {
      padding: '0 14px 8px',
      font: `600 10px 'Space Grotesk'`,
      letterSpacing: '0.14em',
      color: C.fg3,
      textTransform: 'uppercase'
    }
  }, "Spring Open"), items.map(([k, l]) => /*#__PURE__*/React.createElement("div", {
    key: k,
    style: {
      margin: '0 10px',
      padding: '9px 12px',
      borderRadius: 8,
      background: active === k ? 'rgba(255,122,26,0.12)' : 'transparent',
      color: active === k ? C.ball : C.fg2,
      font: '500 13px sans-serif',
      cursor: 'pointer',
      borderLeft: active === k ? `2px solid ${C.ball}` : '2px solid transparent'
    }
  }, l)), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1
    }
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      margin: '0 14px',
      padding: 12,
      background: C.ink800,
      border: `1px solid ${C.ink600}`,
      borderRadius: 8
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      font: `600 10px 'JetBrains Mono'`,
      color: C.serve,
      letterSpacing: '0.14em',
      marginBottom: 4
    }
  }, "\u25CF SOLVER READY"), /*#__PURE__*/React.createElement("div", {
    style: {
      font: '500 12px sans-serif',
      color: C.fg2
    }
  }, "12 constraints \xB7 0 conflicts")));
}
function ActionBar() {
  return /*#__PURE__*/React.createElement("div", {
    style: {
      height: 56,
      borderBottom: `1px solid ${C.ink600}`,
      display: 'flex',
      alignItems: 'center',
      padding: '0 24px',
      gap: 12,
      background: C.ink950
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      font: '600 16px sans-serif',
      color: C.fg1
    }
  }, "Courts \xB7 Live"), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'inline-flex',
      alignItems: 'center',
      gap: 6,
      font: `600 10px 'JetBrains Mono'`,
      color: C.serve,
      letterSpacing: '0.14em',
      marginLeft: 12
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      width: 7,
      height: 7,
      borderRadius: '50%',
      background: C.serve,
      boxShadow: `0 0 8px ${C.serve}`
    }
  }), "4 MATCHES LIVE"), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1
    }
  }), /*#__PURE__*/React.createElement("button", {
    style: btnGhost
  }, "Call next"), /*#__PURE__*/React.createElement("button", {
    style: btnGhost
  }, "Pause draw"), /*#__PURE__*/React.createElement("button", {
    style: btnPrimary
  }, "+ New match"));
}
const btnBase = {
  font: "600 13px 'Space Grotesk'",
  height: 36,
  padding: '0 14px',
  borderRadius: 8,
  border: '1px solid transparent',
  cursor: 'pointer'
};
const btnGhost = {
  ...btnBase,
  background: 'transparent',
  color: C.fg2,
  borderColor: C.ink500
};
const btnPrimary = {
  ...btnBase,
  background: C.ball,
  color: C.ink950
};
function StatStrip() {
  const stats = [['Matches done', '142'], ['Live now', '4'], ['Up next', '8'], ['Avg court util.', '92%'], ['Behind schedule', '0']];
  return /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'grid',
      gridTemplateColumns: 'repeat(5,1fr)',
      gap: 12,
      padding: 20,
      borderBottom: `1px solid ${C.ink600}`
    }
  }, stats.map(([l, v]) => /*#__PURE__*/React.createElement("div", {
    key: l,
    style: {
      background: C.ink800,
      border: `1px solid ${C.ink600}`,
      borderRadius: 10,
      padding: '14px 16px'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      font: `600 10px 'Space Grotesk'`,
      letterSpacing: '0.14em',
      color: C.fg3,
      textTransform: 'uppercase'
    }
  }, l), /*#__PURE__*/React.createElement("div", {
    style: {
      font: `700 26px 'JetBrains Mono'`,
      fontVariantNumeric: 'tabular-nums',
      color: C.fg1,
      marginTop: 4
    }
  }, v))));
}
function CourtGrid() {
  const courts = [{
    n: 1,
    a: 'Nguyen, T.',
    b: 'Silva, R.',
    sa: 11,
    sb: 7,
    g: 3,
    live: true,
    w: 'a'
  }, {
    n: 2,
    a: 'Okafor, D.',
    b: 'Johansen, A.',
    sa: 9,
    sb: 11,
    g: 2,
    live: true,
    w: 'b'
  }, {
    n: 3,
    a: 'Tran, L.',
    b: 'Patel, M.',
    sa: 11,
    sb: 8,
    g: 4,
    live: true,
    w: 'a'
  }, {
    n: 4,
    a: 'Chen, W.',
    b: 'Park, J.',
    sa: 6,
    sb: 4,
    g: 1,
    live: true,
    w: null
  }, {
    n: 5,
    a: '—',
    b: '—',
    next: 'Kim, H. vs Ali, R.'
  }, {
    n: 6,
    a: '—',
    b: '—',
    next: 'Rossi, G. vs Dubois, C.'
  }];
  return /*#__PURE__*/React.createElement("div", {
    style: {
      padding: 20,
      display: 'grid',
      gridTemplateColumns: 'repeat(3,1fr)',
      gap: 14
    }
  }, courts.map(c => /*#__PURE__*/React.createElement(CourtCard, {
    key: c.n,
    c: c
  })));
}
function CourtCard({
  c
}) {
  if (!c.live) return /*#__PURE__*/React.createElement("div", {
    style: {
      background: C.ink800,
      border: `1px dashed ${C.ink600}`,
      borderRadius: 12,
      padding: 18,
      minHeight: 160,
      display: 'flex',
      flexDirection: 'column',
      gap: 8,
      justifyContent: 'space-between'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      justifyContent: 'space-between'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      font: `700 18px 'Bebas Neue'`,
      letterSpacing: '0.05em',
      color: C.fg1
    }
  }, "COURT ", c.n), /*#__PURE__*/React.createElement("div", {
    style: {
      font: `600 10px 'JetBrains Mono'`,
      color: C.fg3,
      letterSpacing: '0.14em'
    }
  }, "OPEN")), /*#__PURE__*/React.createElement("div", {
    style: {
      font: '400 13px sans-serif',
      color: C.fg3
    }
  }, "Next up: ", /*#__PURE__*/React.createElement("span", {
    style: {
      color: C.fg1,
      fontWeight: 500
    }
  }, c.next)), /*#__PURE__*/React.createElement("button", {
    style: {
      ...btnBase,
      background: 'transparent',
      border: `1px solid ${C.ball}`,
      color: C.ball
    }
  }, "Call to court"));
  return /*#__PURE__*/React.createElement("div", {
    style: {
      background: C.ink800,
      border: `1px solid ${c.live ? 'rgba(0,226,154,0.3)' : C.ink600}`,
      borderRadius: 12,
      padding: 18,
      minHeight: 160,
      boxShadow: c.live ? '0 0 20px rgba(0,226,154,0.08)' : 'none'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      justifyContent: 'space-between',
      marginBottom: 12
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      font: `700 18px 'Bebas Neue'`,
      letterSpacing: '0.05em',
      color: C.fg1
    }
  }, "COURT ", c.n), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'inline-flex',
      alignItems: 'center',
      gap: 5,
      font: `600 10px 'JetBrains Mono'`,
      color: C.serve,
      letterSpacing: '0.14em'
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      width: 6,
      height: 6,
      borderRadius: '50%',
      background: C.serve,
      boxShadow: `0 0 6px ${C.serve}`
    }
  }), "LIVE \xB7 G", c.g)), /*#__PURE__*/React.createElement(CourtRow, {
    n: c.a,
    s: c.sa,
    win: c.w === 'a'
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      height: 1,
      background: C.ink600,
      margin: '8px 0'
    }
  }), /*#__PURE__*/React.createElement(CourtRow, {
    n: c.b,
    s: c.sb,
    win: c.w === 'b'
  }));
}
function CourtRow({
  n,
  s,
  win
}) {
  return /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 10
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      font: '500 14px sans-serif',
      color: win ? C.serve : C.fg1
    }
  }, n), /*#__PURE__*/React.createElement("div", {
    style: {
      font: `700 24px 'JetBrains Mono'`,
      fontVariantNumeric: 'tabular-nums',
      color: win ? C.serve : C.fg2,
      lineHeight: 1
    }
  }, s));
}
function SolverPanel() {
  return /*#__PURE__*/React.createElement("div", {
    style: {
      padding: 20,
      borderTop: `1px solid ${C.ink600}`,
      background: C.ink900
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 12,
      marginBottom: 14
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      font: `700 20px 'Bebas Neue'`,
      letterSpacing: '0.03em',
      color: C.fg1
    }
  }, "SMT SOLVER"), /*#__PURE__*/React.createElement("div", {
    style: {
      font: `600 10px 'JetBrains Mono'`,
      color: C.serve,
      letterSpacing: '0.14em'
    }
  }, "\u25CF OPTIMAL \xB7 234ms"), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1
    }
  }), /*#__PURE__*/React.createElement("button", {
    style: btnGhost
  }, "Re-solve")), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'grid',
      gridTemplateColumns: '2fr 1fr',
      gap: 14
    }
  }, /*#__PURE__*/React.createElement("pre", {
    style: {
      background: C.ink950,
      border: `1px solid ${C.ink600}`,
      borderRadius: 8,
      padding: 14,
      margin: 0,
      font: `500 12px 'JetBrains Mono'`,
      color: C.fg2,
      overflowX: 'auto'
    }
  }, `constraints:
  · no player back-to-back  (all 64 players)
  · 15min rest minimum     (hard)
  · court rotation balance (soft, w=3)
  · umpire availability    (9 active)

objective: minimize makespan
status: sat | bound: 4h 12m | actual: 4h 14m`), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      flexDirection: 'column',
      gap: 8
    }
  }, /*#__PURE__*/React.createElement(SolverStat, {
    l: "Constraints",
    v: "12"
  }), /*#__PURE__*/React.createElement(SolverStat, {
    l: "Variables",
    v: "1,248"
  }), /*#__PURE__*/React.createElement(SolverStat, {
    l: "Conflicts",
    v: "0",
    good: true
  }), /*#__PURE__*/React.createElement(SolverStat, {
    l: "Horizon",
    v: "4h 14m"
  }))));
}
function SolverStat({
  l,
  v,
  good
}) {
  return /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'center',
      padding: '10px 14px',
      background: C.ink800,
      border: `1px solid ${C.ink600}`,
      borderRadius: 8
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      font: `500 12px 'Space Grotesk'`,
      color: C.fg3,
      letterSpacing: '0.08em',
      textTransform: 'uppercase'
    }
  }, l), /*#__PURE__*/React.createElement("span", {
    style: {
      font: `700 14px 'JetBrains Mono'`,
      color: good ? C.serve : C.fg1
    }
  }, v));
}
Object.assign(window, {
  Sidebar,
  ActionBar,
  StatStrip,
  CourtGrid,
  SolverPanel
});

// ---- App mount (moved from index.html) ----
function App() {
  return /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      height: '100vh',
      width: '100vw'
    }
  }, /*#__PURE__*/React.createElement(Sidebar, {
    active: "courts"
  }), /*#__PURE__*/React.createElement("main", {
    style: {
      flex: 1,
      display: 'flex',
      flexDirection: 'column',
      overflow: 'auto'
    }
  }, /*#__PURE__*/React.createElement(ActionBar, null), /*#__PURE__*/React.createElement(StatStrip, null), /*#__PURE__*/React.createElement(CourtGrid, null), /*#__PURE__*/React.createElement(SolverPanel, null)));
}
ReactDOM.createRoot(document.getElementById('root')).render(/*#__PURE__*/React.createElement(App, null));
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/web_admin/components.jsx", error: String((e && e.message) || e) }); }

})();
