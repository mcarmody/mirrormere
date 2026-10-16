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
  const REDUCED_AMP = 6;
  const REDUCED_T = 1;
  const LEVELS_URL = 'http://127.0.0.1:8765/levels';
  const LEVEL_STALE_MS = 400;
  const LEVEL_GAIN = 2.2;
  const LEVEL_SPAN = 22;
  const EASE_TAU_MS = 20;
  const EASE_MAX_DT_MS = 100;
  const DECAY_TAU_MS = 120;
  const DRAW_MIN_MS = 25;
  const CONVO_MAX = 4;

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

  /**
   * Spatial smoothing for a 33-value level frame: one pass of the kernel [1, 2, 1] / 4.
   * Edge values reuse themselves as the missing neighbour. Returns a new array; input is not mutated.
   * @param {number[]} values
   * @returns {number[]}
   */
  function smoothValues(values) {
    const pass = (src) => {
      const last = src.length - 1;
      const out = new Array(src.length);
      for (let i = 0; i <= last; i += 1) {
        const left = src[i > 0 ? i - 1 : 0];
        const right = src[i < last ? i + 1 : last];
        out[i] = (left + 2 * src[i] + right) / 4;
      }
      return out;
    };
    return pass(values);
  }

  /**
   * Maps 33 waveform levels (-100..100, from the ear daemon's /levels stream) to mouth points.
   * Values are smoothed first; gain scales the level before clamping to the mouth span.
   * @param {number[]} values
   * @param {number} [gain=2.2]
   * @returns {Array<[number, number]>}
   */
  function framePoints(values, gain = LEVEL_GAIN) {
    const smoothed = smoothValues(values);
    const points = [];
    for (let i = 0; i < MOUTH_POINTS; i += 1) {
      const level = clamp((smoothed[i] / 100) * gain, -1, 1);
      points.push([MOUTH_X0 + i * MOUTH_STEP, 50 - level * LEVEL_SPAN]);
    }
    return points;
  }

  /**
   * Exponential approach from current toward target, one step per frame.
   * dtMs is clamped to 0..100. A null current, or one of a different length, returns a copy of target.
   * @param {number[]|null} current
   * @param {number[]} target
   * @param {number} dtMs
   * @param {number} [tauMs=20]
   * @returns {number[]}
   */
  function easeToward(current, target, dtMs, tauMs = EASE_TAU_MS) {
    if (!Array.isArray(current) || current.length !== target.length) return target.slice();
    const dt = Number.isFinite(dtMs) ? clamp(dtMs, 0, EASE_MAX_DT_MS) : 0;
    const k = 1 - Math.exp(-dt / tauMs);
    return target.map((t, i) => current[i] + (t - current[i]) * k);
  }

  function clamp(v, lo, hi) {
    return Math.min(hi, Math.max(lo, v));
  }

  function isLevelFrame(values) {
    return Array.isArray(values)
      && values.length === MOUTH_POINTS
      && values.every((v) => typeof v === 'number' && Number.isFinite(v));
  }

  function defaultClock() {
    return typeof performance !== 'undefined' && typeof performance.now === 'function'
      ? performance.now()
      : Date.now();
  }

  function defaultEventSourceFactory() {
    return typeof EventSource === 'function' ? (url) => new EventSource(url) : null;
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
     * @param {string} [options.levelsUrl] waveform SSE endpoint; defaults to the ear daemon on this Pi
     * @param {Function|null} [options.eventSourceFactory] url => EventSource-like; null disables the stream
     * @param {Function} [options.clock] milliseconds clock; defaults to performance.now
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
      this.levelsUrl = options.levelsUrl || LEVELS_URL;
      this.eventSourceFactory = options.eventSourceFactory !== undefined
        ? options.eventSourceFactory
        : defaultEventSourceFactory();
      this.clock = options.clock || defaultClock;
      this.levelFrame = null;
      this.levelAt = null;
      this.levelSource = null;
      this.shownY = null; // eased mouth y values, one per point; null outside speaking
      this.lastTick = null;

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
      if (this.stage) this.openLevels();

      if (this.sseClient && typeof this.sseClient.on === 'function') {
        this.sseClient.on('voice.state', (data) => {
          this.noteConvo(data);
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
      ring.setAttribute('stroke-width', '1.4');

      const mouth = doc.createElementNS(SVG_NS, 'polyline');
      mouth.setAttribute('class', 'af-mouth');
      mouth.setAttribute('fill', 'none');
      mouth.setAttribute('stroke-width', '1.4');
      mouth.setAttribute('stroke-linecap', 'round');

      svg.appendChild(ring);
      svg.appendChild(mouth);
      stage.appendChild(svg);
      doc.body.appendChild(stage);

      // Conversation log, left of the face: last few YOU/AMOS lines.
      const convo = doc.createElement('div');
      convo.id = 'amos-face-convo';
      convo.className = 'amos-face-convo';
      convo.setAttribute('aria-hidden', 'true');
      doc.body.appendChild(convo);
      this.convo = convo;
      this.convoLog = [];

      this.stage = stage;
      this.ring = ring;
      this.mouth = mouth;
      this.drawMouth(mouthPoints(0, 0));
    }

    drawMouth(points) {
      if (this.mouth) this.mouth.setAttribute('points', formatPoints(points));
    }

    /**
     * Opens the waveform stream once. EventSource reconnects by itself, so nothing
     * else is needed here. No-op when no factory is available.
     */
    openLevels() {
      if (!this.eventSourceFactory) return;
      let source = null;
      try {
        source = this.eventSourceFactory(this.levelsUrl);
      } catch (e) {
        return;
      }
      if (!source || typeof source.addEventListener !== 'function') return;
      source.addEventListener('frame', (e) => this.onLevelFrame(e));
      this.levelSource = source;
    }

    /** Stores a valid 33-value frame; malformed payloads are ignored. */
    onLevelFrame(e) {
      let values = null;
      try {
        values = JSON.parse(e ? e.data : undefined);
      } catch (err) {
        return;
      }
      if (!isLevelFrame(values)) return;
      this.levelFrame = values;
      this.levelAt = this.clock();
    }

    /** True when a level frame arrived within the last 400 ms. */
    hasFreshLevels() {
      return this.levelAt !== null && this.clock() - this.levelAt <= LEVEL_STALE_MS;
    }

    /**
     * Starts the speaking loop. While a level frame is fresh, every tick eases the mouth's y values
     * toward the frame's target; otherwise it eases the mouth flat toward y 50. No procedural wave.
     * No-op without a raf or while already running.
     */
    startLoop() {
      if (!this.raf || this.looping) return;
      this.looping = true;
      this.lastTick = null;
      const tick = (now) => {
        if (!this.looping) return;
        this.rafId = this.raf(tick);
        if (this.lastTick !== null && now - this.lastTick < DRAW_MIN_MS) return;
        const dt = this.lastTick === null ? 0 : now - this.lastTick;
        this.lastTick = now;
        if (this.hasFreshLevels()) {
          const target = framePoints(this.levelFrame);
          this.shownY = easeToward(this.shownY, target.map(([, y]) => y), dt);
          this.drawMouth(target.map(([x], i) => [x, this.shownY[i]]));
          return;
        }
        const flat = new Array(MOUTH_POINTS).fill(50);
        this.shownY = easeToward(this.shownY, flat, dt, DECAY_TAU_MS);
        this.drawMouth(mouthPoints(0, 0).map(([x], i) => [x, this.shownY[i]]));
      };
      this.rafId = this.raf(tick);
    }

    stopLoop() {
      if (this.looping && this.caf) this.caf(this.rafId);
      this.looping = false;
      this.rafId = null;
      this.lastTick = null;
    }

    /** Applies the face for a state: stage data-state, mouth, and the speaking loop. */
    applyStage(key) {
      if (!this.stage) return;
      this.stage.dataset.state = key;
      this.stopLoop();
      if (key !== 'speaking') {
        this.levelAt = null; // a new turn starts without stale levels
        this.shownY = null;
      }
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

    /**
     * Feeds a voice.state payload into the conversation log: the user's
     * transcript first, then Amos's reply. Missing fields are skipped.
     * @param {object} data voice.state payload
     */
    noteConvo(data) {
      if (!this.convo || !data) return;
      this.add('you', data.transcript);
      this.add('amos', data.reply);
      this.renderConvo();
    }

    /**
     * Appends one message, keeping only the last CONVO_MAX. Blank or
     * non-string text is ignored, as is text repeating the last message from
     * the same speaker.
     * @param {string} who 'you' or 'amos'
     * @param {*} text
     */
    add(who, text) {
      if (typeof text !== 'string' || text.trim() === '') return;
      const trimmed = text.trim();
      for (let i = this.convoLog.length - 1; i >= 0; i -= 1) {
        if (this.convoLog[i].who === who) {
          if (this.convoLog[i].text === trimmed) return;
          break;
        }
      }
      this.convoLog.push({ who, text: trimmed });
      while (this.convoLog.length > CONVO_MAX) this.convoLog.shift();
    }

    renderConvo() {
      if (!this.convo) return;
      this.convo.textContent = '';
      for (const msg of this.convoLog) {
        const row = this.document.createElement('div');
        row.className = `af-msg af-msg-${msg.who}`;
        const who = this.document.createElement('span');
        who.className = 'af-msg-who';
        who.textContent = msg.who === 'you' ? 'YOU' : 'AMOS';
        const text = this.document.createElement('span');
        text.className = 'af-msg-text';
        text.textContent = msg.text;
        row.appendChild(who);
        row.appendChild(text);
        this.convo.appendChild(row);
      }
    }
  }

  if (typeof window !== 'undefined') {
    window.MirrormereFace = {
      FaceController,
      WORDS,
      mouthPoints,
      framePoints,
      smoothValues,
      easeToward,
    };
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      FaceController,
      WORDS,
      mouthPoints,
      framePoints,
      smoothValues,
      easeToward,
    };
  }
})();
