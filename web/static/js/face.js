/**
 * Mirrormere Amos State overlay.
 * Shows the current voice state as one uppercase word in the header bar, beside the status light,
 * and an animated Aperture face (ring plus waveform mouth) in the bottom-right corner.
 * Both are mounted only when the page URL carries ?face=1; otherwise nothing is added to the DOM.
 */
(() => {
  const WORDS = {
    idle: 'IDLE',
    listening: 'LISTENING',
    transcribing: 'TRANSCRIBING',
    thinking: 'THINKING',
    synthesizing: 'SYNTHESIZING',
    speaking: 'SPEAKING',
    error: 'ERROR',
  };

  const ERROR_RESET_MS = 4000;
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const MOUTH_POINTS = 33;
  const MOUTH_X0 = 20;
  const MOUTH_STEP = 1.875;
  const MOUTH_AMP = 14;
  const REDUCED_AMP = 6;
  const REDUCED_T = 1;
  const FRAME_MS = 33;

  function hasFaceParam() {
    const search = typeof window !== 'undefined' && window.location ? window.location.search : '';
    return new URLSearchParams(search || '').get('face') === '1';
  }

  /**
   * Mouth envelope: zero at both ends, full in the middle.
   * @param {number} i point index, 0..32
   */
  function envelope(i) {
    return Math.sin((Math.PI * i) / (MOUTH_POINTS - 1));
  }

  /**
   * Returns the 33 polyline points for the waveform mouth at time t (seconds) and amplitude amp.
   * amp 0 is a flat line at y 50.
   * @param {number} t
   * @param {number} amp
   * @returns {Array<[number, number]>}
   */
  function mouthPoints(t, amp) {
    const points = [];
    for (let i = 0; i < MOUTH_POINTS; i += 1) {
      const wave = Math.sin(t * 9 + i * 0.7) * 0.6 + Math.sin(t * 5.3 + i * 1.9) * 0.4;
      points.push([MOUTH_X0 + i * MOUTH_STEP, 50 + amp * envelope(i) * wave]);
    }
    return points;
  }

  /** Alternating zigzag used for the error state. */
  function zigzagPoints() {
    const points = [];
    for (let i = 0; i < MOUTH_POINTS; i += 1) {
      points.push([MOUTH_X0 + i * MOUTH_STEP, i % 2 === 0 ? 44 : 56]);
    }
    return points;
  }

  function formatPoints(points) {
    return points.map(([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`).join(' ');
  }

  function defaultReducedMotion() {
    try {
      return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
        ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
        : false;
    } catch (e) {
      return false;
    }
  }

  /**
   * FaceController renders the voice state word, the face stage, and resets error back to idle.
   */
  class FaceController {
    /**
     * @param {Object} [options={}]
     * @param {Object} [options.sseClient] SSE client exposing on(eventType, callback)
     * @param {Document} [options.document] defaults to the global document
     * @param {Function} [options.raf] requestAnimationFrame; defaults to window's
     * @param {Function} [options.caf] cancelAnimationFrame; defaults to window's
     * @param {boolean} [options.prefersReducedMotion] defaults to the media query
     */
    constructor(options = {}) {
      this.sseClient = options.sseClient || null;
      this.document = options.document || (typeof document !== 'undefined' ? document : null);
      this.element = null;
      this.resetTimer = null;
      this.stage = null;
      this.mouth = null;
      this.ring = null;
      this.raf = options.raf || (typeof window !== 'undefined' && window.requestAnimationFrame
        ? window.requestAnimationFrame.bind(window) : null);
      this.caf = options.caf || (typeof window !== 'undefined' && window.cancelAnimationFrame
        ? window.cancelAnimationFrame.bind(window) : null);
      this.reducedMotion = options.prefersReducedMotion !== undefined
        ? !!options.prefersReducedMotion
        : defaultReducedMotion();
      this.looping = false;
      this.rafId = null;
      this.lastFrame = null;

      if (!hasFaceParam() || !this.document) return;

      const el = this.document.createElement('div');
      el.id = 'amos-face';
      el.className = 'amos-face';
      el.setAttribute('aria-live', 'polite');
      el.dataset.state = 'idle';
      el.textContent = WORDS.idle;
      // Header bar, right side, just before the system status light; when the
      // header is absent (a page without it) fall back to the body.
      const header = typeof this.document.querySelector === 'function'
        ? this.document.querySelector('.header-status')
        : null;
      if (header && typeof header.insertBefore === 'function') {
        header.insertBefore(el, header.firstChild || null);
      } else {
        this.document.body.appendChild(el);
      }
      this.element = el;

      this.mountStage();

      if (this.sseClient && typeof this.sseClient.on === 'function') {
        this.sseClient.on('voice.state', (data) => {
          this.setState(data && data.state);
        });
      }
    }

    /**
     * Builds the face stage (ring plus mouth, inline SVG). Skipped when the
     * document cannot create SVG elements, for example a minimal test double.
     */
    mountStage() {
      const doc = this.document;
      if (typeof doc.createElementNS !== 'function' || !doc.body) return;

      const stage = doc.createElement('div');
      stage.id = 'amos-face-stage';
      stage.className = 'amos-face-stage';
      stage.setAttribute('aria-hidden', 'true');
      stage.dataset.state = 'idle';

      const svg = doc.createElementNS(SVG_NS, 'svg');
      svg.setAttribute('viewBox', '0 0 100 100');

      const ring = doc.createElementNS(SVG_NS, 'circle');
      ring.setAttribute('class', 'af-ring');
      ring.setAttribute('cx', '50');
      ring.setAttribute('cy', '50');
      ring.setAttribute('r', '44');
      ring.setAttribute('fill', 'none');
      ring.setAttribute('stroke-width', '2.5');

      const mouth = doc.createElementNS(SVG_NS, 'polyline');
      mouth.setAttribute('class', 'af-mouth');
      mouth.setAttribute('fill', 'none');
      mouth.setAttribute('stroke-width', '2.5');
      mouth.setAttribute('stroke-linecap', 'round');

      svg.appendChild(ring);
      svg.appendChild(mouth);
      stage.appendChild(svg);
      doc.body.appendChild(stage);

      this.stage = stage;
      this.ring = ring;
      this.mouth = mouth;
      this.drawMouth(mouthPoints(0, 0));
    }

    drawMouth(points) {
      if (this.mouth) this.mouth.setAttribute('points', formatPoints(points));
    }

    /** Starts the speaking loop at 30 fps. No-op without a raf or while already running. */
    startLoop() {
      if (!this.raf || this.looping) return;
      this.looping = true;
      this.lastFrame = null;
      const tick = (now) => {
        if (!this.looping) return;
        this.rafId = this.raf(tick);
        if (this.lastFrame !== null && now - this.lastFrame < FRAME_MS) return;
        this.lastFrame = now;
        this.drawMouth(mouthPoints(now / 1000, MOUTH_AMP));
      };
      this.rafId = this.raf(tick);
    }

    stopLoop() {
      if (this.looping && this.caf) this.caf(this.rafId);
      this.looping = false;
      this.rafId = null;
      this.lastFrame = null;
    }

    /** Applies the face for a state: stage data-state, mouth, and the speaking loop. */
    applyStage(key) {
      if (!this.stage) return;
      this.stage.dataset.state = key;
      this.stopLoop();
      if (key === 'speaking') {
        if (this.reducedMotion) {
          this.drawMouth(mouthPoints(REDUCED_T, REDUCED_AMP));
        } else {
          this.startLoop();
        }
      } else if (key === 'error') {
        this.drawMouth(zigzagPoints());
      } else {
        this.drawMouth(mouthPoints(0, 0));
      }
    }

    /**
     * Sets the displayed state. Any call cancels a pending error reset.
     * Unknown states are shown as idle.
     * @param {string} state
     */
    setState(state) {
      this.clearResetTimer();

      const key = Object.prototype.hasOwnProperty.call(WORDS, state) ? state : 'idle';
      if (this.element) {
        this.element.dataset.state = key;
        this.element.textContent = WORDS[key];
      }
      this.applyStage(key);

      if (key === 'error') {
        this.resetTimer = setTimeout(() => {
          this.resetTimer = null;
          this.setState('idle');
        }, ERROR_RESET_MS);
      }
    }

    clearResetTimer() {
      if (this.resetTimer !== null) {
        clearTimeout(this.resetTimer);
        this.resetTimer = null;
      }
    }
  }

  if (typeof window !== 'undefined') {
    window.MirrormereFace = {
      FaceController,
      WORDS,
      mouthPoints,
    };
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      FaceController,
      WORDS,
      mouthPoints,
    };
  }
})();
