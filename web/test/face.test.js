const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  FaceController, WORDS, mouthPoints, framePoints, smoothValues, easeToward,
} = require('../static/js/face.js');

/**
 * Lightweight mock DOM element for hermetic Node.js testing.
 */
function createMockElement(tagName = 'div') {
  const attributes = new Map();
  const children = [];
  let text = '';
  return {
    tagName: tagName.toUpperCase(),
    id: '',
    className: '',
    dataset: {},
    // Like the DOM, assigning textContent replaces every child node.
    get textContent() { return text; },
    set textContent(value) {
      for (const child of children) child.parentNode = null;
      children.length = 0;
      text = String(value);
    },
    children,
    parentNode: null,
    setAttribute(name, value) { attributes.set(name, String(value)); },
    getAttribute(name) { return attributes.has(name) ? attributes.get(name) : null; },
    appendChild(child) {
      child.parentNode = this;
      children.push(child);
      return child;
    },
  };
}

/**
 * Mock document with a body element and a createElement spy.
 */
function createMockDocument() {
  const body = createMockElement('body');
  const doc = {
    body,
    createCount: 0,
    createElement(tag) {
      doc.createCount += 1;
      return createMockElement(tag);
    },
  };
  return doc;
}

/**
 * Constructs a FaceController with window.location.search set to `search`.
 */
function withSearch(search, build) {
  const prev = global.window;
  global.window = { location: { search } };
  try {
    return build();
  } finally {
    if (prev === undefined) {
      delete global.window;
    } else {
      global.window = prev;
    }
  }
}

function mountFace(search = '?face=1') {
  const doc = createMockDocument();
  const sseClient = {
    handlers: new Map(),
    onCalls: [],
    on(eventType, fn) {
      this.onCalls.push(eventType);
      this.handlers.set(eventType, fn);
      return this;
    },
  };
  const controller = withSearch(search, () => new FaceController({ sseClient, document: doc }));
  const el = doc.body.children[0];
  return { controller, doc, sseClient, el };
}

test('Amos state word overlay', async (t) => {
  await t.test('word map covers every voice state', () => {
    assert.deepEqual(WORDS, {
      idle: 'IDLE',
      listening: 'LISTENING',
      transcribing: 'TRANSCRIBING',
      thinking: 'THINKING',
      synthesizing: 'SYNTHESIZING',
      speaking: 'SPEAKING',
      error: 'ERROR',
    });
  });

  await t.test('creates the overlay element with idle defaults when face=1', () => {
    const { doc, el, sseClient } = mountFace();
    assert.equal(doc.body.children.length, 1);
    assert.equal(el.id, 'amos-face');
    assert.equal(el.className, 'amos-face');
    assert.equal(el.getAttribute('aria-live'), 'polite');
    assert.equal(el.dataset.state, 'idle');
    assert.equal(el.textContent, 'IDLE');
    assert.deepEqual(sseClient.onCalls, ['voice.state']);
  });

  await t.test('each state maps to its word and dataset state', () => {
    const { controller, el } = mountFace();
    for (const [state, word] of Object.entries(WORDS)) {
      controller.setState(state);
      assert.equal(el.textContent, word, `text for ${state}`);
      assert.equal(el.dataset.state, state, `dataset for ${state}`);
    }
  });

  await t.test('unknown or missing state shows IDLE', () => {
    const { controller, el } = mountFace();
    controller.setState('speaking');
    controller.setState('bogus');
    assert.equal(el.textContent, 'IDLE');
    assert.equal(el.dataset.state, 'idle');

    controller.setState('speaking');
    controller.setState(undefined);
    assert.equal(el.textContent, 'IDLE');
    assert.equal(el.dataset.state, 'idle');
  });

  await t.test('error returns to IDLE after 4 s', (t2) => {
    t2.mock.timers.enable({ apis: ['setTimeout'] });
    const { controller, el } = mountFace();
    controller.setState('error');
    assert.equal(el.textContent, 'ERROR');
    assert.equal(el.dataset.state, 'error');

    t2.mock.timers.tick(3999);
    assert.equal(el.textContent, 'ERROR');

    t2.mock.timers.tick(1);
    assert.equal(el.textContent, 'IDLE');
    assert.equal(el.dataset.state, 'idle');
    t2.mock.timers.reset();
  });

  await t.test('a newer state cancels the pending error reset', (t2) => {
    t2.mock.timers.enable({ apis: ['setTimeout'] });
    const { controller, el } = mountFace();
    controller.setState('error');
    t2.mock.timers.tick(2000);
    controller.setState('speaking');

    t2.mock.timers.tick(10000);
    assert.equal(el.textContent, 'SPEAKING');
    assert.equal(el.dataset.state, 'speaking');
    t2.mock.timers.reset();
  });

  await t.test('a second error restarts the 4 s window', (t2) => {
    t2.mock.timers.enable({ apis: ['setTimeout'] });
    const { controller, el } = mountFace();
    controller.setState('error');
    t2.mock.timers.tick(3000);
    controller.setState('error');
    t2.mock.timers.tick(3999);
    assert.equal(el.textContent, 'ERROR');
    t2.mock.timers.tick(1);
    assert.equal(el.textContent, 'IDLE');
    t2.mock.timers.reset();
  });

  await t.test('without face=1 no element is created and sseClient.on is not called', () => {
    const doc = createMockDocument();
    const sseClient = {
      onCalls: 0,
      on() { this.onCalls += 1; return this; },
    };
    withSearch('?face=0', () => new FaceController({ sseClient, document: doc }));
    withSearch('', () => new FaceController({ sseClient, document: doc }));
    assert.equal(doc.createCount, 0);
    assert.equal(doc.body.children.length, 0);
    assert.equal(sseClient.onCalls, 0);
  });

  await t.test('voice.state SSE event updates the word', () => {
    const { sseClient, el } = mountFace();
    const handler = sseClient.handlers.get('voice.state');
    assert.equal(typeof handler, 'function');

    handler({ state: 'listening' });
    assert.equal(el.textContent, 'LISTENING');

    handler({ state: 'error' });
    assert.equal(el.textContent, 'ERROR');

    handler(null);
    assert.equal(el.textContent, 'IDLE');
  });

  await t.test('browser global window.MirrormereFace binding', () => {
    const faceCode = fs.readFileSync(path.join(__dirname, '../static/js/face.js'), 'utf8');
    const mockWindow = {};
    const fn = new Function('window', 'module', faceCode);
    fn(mockWindow, {});

    assert.ok(mockWindow.MirrormereFace, 'window.MirrormereFace should be defined');
    assert.strictEqual(typeof mockWindow.MirrormereFace.FaceController, 'function');
    assert.deepEqual(mockWindow.MirrormereFace.WORDS, WORDS);
  });
});

test('mounts first inside .header-status when the header exists', () => {
  const doc = createMockDocument();
  const header = createMockElement('div');
  header.insertBefore = (child, ref) => {
    child.parentNode = header;
    header.children.unshift(child);
    header.insertedBefore = ref;
    return child;
  };
  doc.querySelector = (sel) => (sel === '.header-status' ? header : null);
  const ctl = withSearch('?face=1', () => new FaceController({ document: doc, sseClient: null }));
  assert.equal(header.children[0], ctl.element);
  assert.equal(doc.body.children.length, 0);
  assert.equal(ctl.element.textContent, 'IDLE');
});

/**
 * Mock document that also creates SVG elements, so the face stage mounts.
 */
function createSvgMockDocument() {
  const doc = createMockDocument();
  doc.svgCount = 0;
  doc.createElementNS = (ns, tag) => {
    doc.svgCount += 1;
    return createMockElement(tag);
  };
  return doc;
}

/**
 * Fake requestAnimationFrame: queues callbacks until the test runs them.
 */
function createFakeRaf() {
  const raf = {
    queue: [],
    cancelled: [],
    nextId: 1,
    request(cb) {
      const id = raf.nextId;
      raf.nextId += 1;
      raf.queue.push({ id, cb });
      return id;
    },
    cancel(id) {
      raf.cancelled.push(id);
      raf.queue = raf.queue.filter((f) => f.id !== id);
    },
    // Runs the pending frame at timestamp `now` (ms).
    run(now) {
      const pending = raf.queue;
      raf.queue = [];
      for (const f of pending) f.cb(now);
    },
  };
  return raf;
}

function mountStage({ search = '?face=1', raf, prefersReducedMotion = false } = {}) {
  const doc = createSvgMockDocument();
  const sseClient = {
    handlers: new Map(),
    on(eventType, fn) { this.handlers.set(eventType, fn); return this; },
  };
  const controller = withSearch(search, () => new FaceController({
    sseClient,
    document: doc,
    raf: raf ? raf.request : undefined,
    caf: raf ? raf.cancel : undefined,
    prefersReducedMotion,
  }));
  const stage = doc.body.children.find((c) => c.id === 'amos-face-stage');
  const svg = stage ? stage.children[0] : null;
  const mouth = svg ? svg.children.find((c) => c.getAttribute('class') === 'af-mouth') : null;
  return { controller, doc, stage, mouth, svg, sseClient };
}

function parsePoints(attr) {
  return attr.split(' ').map((pair) => pair.split(',').map(Number));
}

test('Amos face stage', async (t) => {
  await t.test('mouthPoints returns 33 points spanning x 20 to 80', () => {
    const pts = mouthPoints(0.5, 14);
    assert.equal(pts.length, 33);
    assert.equal(pts[0][0], 20);
    assert.ok(Math.abs(pts[32][0] - 80) < 1e-9);
  });

  await t.test('mouthPoints endpoints stay at y 50', () => {
    for (const t0 of [0, 0.3, 1.7, 4.2]) {
      const pts = mouthPoints(t0, 14);
      assert.ok(Math.abs(pts[0][1] - 50) < 1e-9, `start at t=${t0}`);
      assert.ok(Math.abs(pts[32][1] - 50) < 1e-9, `end at t=${t0}`);
    }
  });

  await t.test('mouthPoints with amp 0 is flat', () => {
    for (const [, y] of mouthPoints(2.3, 0)) assert.equal(y, 50);
  });

  await t.test('mouthPoints keeps every y within 50 plus or minus amp', () => {
    for (let k = 0; k < 40; k += 1) {
      const pts = mouthPoints(k * 0.137, 14);
      for (const [, y] of pts) assert.ok(Math.abs(y - 50) <= 14 + 1e-9, `y=${y}`);
    }
  });

  await t.test('stage is created only with face=1', () => {
    const on = mountStage();
    assert.ok(on.stage, 'stage present with face=1');
    assert.equal(on.stage.id, 'amos-face-stage');
    assert.equal(on.stage.dataset.state, 'idle');
    assert.equal(on.stage.getAttribute('aria-hidden'), 'true');
    assert.ok(on.mouth, 'mouth polyline present');

    const off = mountStage({ search: '?face=0' });
    assert.equal(off.stage, undefined);
    assert.equal(off.doc.svgCount, 0);
    assert.equal(off.doc.body.children.length, 0);
  });

  await t.test('stage ignored when the document cannot create SVG elements', () => {
    const { doc, controller } = mountFace();
    assert.equal(controller.stage, null);
    assert.equal(doc.body.children.length, 1);
  });

  await t.test('speaking starts the loop and any other state cancels it', () => {
    const raf = createFakeRaf();
    const { controller, mouth } = mountStage({ raf });
    controller.setState('speaking');
    assert.equal(raf.queue.length, 1, 'one frame queued');
    raf.run(1000);
    assert.equal(raf.queue.length, 1, 'loop re-queues itself');
    for (const [, y] of parsePoints(mouth.getAttribute('points'))) assert.equal(y, 50, 'no level frame: flat mouth');

    controller.setState('listening');
    assert.equal(raf.queue.length, 0, 'loop cancelled');
    assert.equal(raf.cancelled.length, 1);
    for (const [, y] of parsePoints(mouth.getAttribute('points'))) assert.equal(y, 50);
  });

  await t.test('speaking with no level frame ever received draws a flat line (all y equal 50)', () => {
    const raf = createFakeRaf();
    const { controller, mouth } = mountStage({ raf });
    controller.setState('speaking');
    for (const now of [1000, 1100, 1300, 1600, 2000]) {
      raf.run(now);
      for (const [, y] of parsePoints(mouth.getAttribute('points'))) assert.equal(y, 50, `flat at ${now} ms`);
    }
  });

  await t.test('draws are capped at one per 25 ms', () => {
    const raf = createFakeRaf();
    const { controller, mouth } = mountStage({ raf });
    let draws = 0;
    const setAttribute = mouth.setAttribute.bind(mouth);
    mouth.setAttribute = (name, value) => {
      if (name === 'points') draws += 1;
      setAttribute(name, value);
    };
    controller.setState('speaking');
    raf.run(1000);
    const afterFirst = draws;
    raf.run(1010);
    assert.equal(draws, afterFirst, 'no redraw inside 25 ms');
    raf.run(1100);
    assert.equal(draws, afterFirst + 1, 'redraw after 25 ms');
  });

  await t.test('error draws the zigzag mouth', () => {
    const raf = createFakeRaf();
    const { controller, mouth } = mountStage({ raf });
    controller.setState('error');
    const pts = parsePoints(mouth.getAttribute('points'));
    assert.equal(pts.length, 33);
    assert.equal(pts[0][1], 44);
    assert.equal(pts[1][1], 56);
    assert.equal(pts[2][1], 44);
    assert.equal(raf.queue.length, 0, 'no loop on error');
  });

  await t.test('reduced motion starts no loop and draws a static mouth of amp 6', () => {
    const raf = createFakeRaf();
    const { controller, mouth, stage } = mountStage({ raf, prefersReducedMotion: true });
    controller.setState('speaking');
    assert.equal(raf.queue.length, 0, 'no rAF loop');
    assert.equal(stage.dataset.state, 'speaking');
    const pts = parsePoints(mouth.getAttribute('points'));
    const dev = Math.max(...pts.map(([, y]) => Math.abs(y - 50)));
    assert.ok(dev > 0 && dev <= 6 + 0.01, `static deviation ${dev}`);
  });
});

/**
 * Fake EventSource factory. Each opened stream records its url and listeners;
 * emit(type, data) delivers an event the way EventSource would.
 */
test('Amos face conversation log', async (t) => {
  const convoOf = (doc) => doc.body.children.find((c) => c.id === 'amos-face-convo');
  const rowsOf = (convo) => convo.children.map((row) => ({
    cls: row.className,
    who: row.children[0].textContent,
    text: row.children[1].textContent,
  }));

  await t.test('transcript then reply adds a YOU row then an AMOS row', () => {
    const { doc, sseClient } = mountStage();
    const handler = sseClient.handlers.get('voice.state');
    handler({ state: 'thinking', transcript: 'what time is it' });
    handler({ state: 'speaking', reply: 'Quarter to nine.' });
    const convo = convoOf(doc);
    assert.ok(convo, '#amos-face-convo exists');
    assert.equal(convo.getAttribute('aria-hidden'), 'true');
    assert.deepEqual(rowsOf(convo), [
      { cls: 'af-msg af-msg-you', who: 'YOU', text: 'what time is it' },
      { cls: 'af-msg af-msg-amos', who: 'AMOS', text: 'Quarter to nine.' },
    ]);
  });

  await t.test('repeating the same transcript adds no row', () => {
    const { doc, sseClient } = mountStage();
    const handler = sseClient.handlers.get('voice.state');
    handler({ state: 'listening', transcript: 'hello there' });
    handler({ state: 'thinking', transcript: 'hello there' });
    handler({ state: 'thinking', transcript: '  hello there  ' });
    assert.deepEqual(rowsOf(convoOf(doc)), [
      { cls: 'af-msg af-msg-you', who: 'YOU', text: 'hello there' },
    ]);
  });

  await t.test('five distinct messages keep only the last four', () => {
    const { doc, sseClient } = mountStage();
    const handler = sseClient.handlers.get('voice.state');
    for (let i = 1; i <= 5; i += 1) {
      handler({ state: 'thinking', transcript: `message ${i}` });
    }
    assert.deepEqual(
      rowsOf(convoOf(doc)).map((r) => r.text),
      ['message 2', 'message 3', 'message 4', 'message 5'],
    );
  });

  await t.test('a streamed reply grows one AMOS row to the latest text', () => {
    const { doc, sseClient } = mountStage();
    const handler = sseClient.handlers.get('voice.state');
    handler({ state: 'thinking', transcript: 'what time is it' });
    handler({ state: 'speaking', reply: 'Quarter' });
    handler({ state: 'speaking', reply: 'Quarter to nine.' });
    assert.deepEqual(rowsOf(convoOf(doc)), [
      { cls: 'af-msg af-msg-you', who: 'YOU', text: 'what time is it' },
      { cls: 'af-msg af-msg-amos', who: 'AMOS', text: 'Quarter to nine.' },
    ]);
  });

  await t.test('a transcript after a reply starts a new YOU row and the next reply a new AMOS row', () => {
    const { doc, sseClient } = mountStage();
    const handler = sseClient.handlers.get('voice.state');
    handler({ state: 'thinking', transcript: 'first question' });
    handler({ state: 'speaking', reply: 'First answer.' });
    handler({ state: 'thinking', transcript: 'second question' });
    handler({ state: 'speaking', reply: 'Second answer.' });
    assert.deepEqual(rowsOf(convoOf(doc)), [
      { cls: 'af-msg af-msg-you', who: 'YOU', text: 'first question' },
      { cls: 'af-msg af-msg-amos', who: 'AMOS', text: 'First answer.' },
      { cls: 'af-msg af-msg-you', who: 'YOU', text: 'second question' },
      { cls: 'af-msg af-msg-amos', who: 'AMOS', text: 'Second answer.' },
    ]);
  });

  await t.test('repeated speaking state during a streamed reply does not restart the loop', () => {
    const raf = createFakeRaf();
    const { stage, sseClient } = mountStage({ raf });
    const handler = sseClient.handlers.get('voice.state');
    handler({ state: 'speaking', reply: 'Quarter' });
    assert.equal(stage.dataset.state, 'speaking');
    assert.equal(raf.queue.length, 1, 'loop running');
    const cancelledBefore = raf.cancelled.length;
    handler({ state: 'speaking', reply: 'Quarter to nine.' });
    handler({ state: 'speaking', reply: 'Quarter to nine. Anything else?' });
    assert.equal(raf.cancelled.length, cancelledBefore, 'no raf cancel');
    assert.equal(raf.queue.length, 1, 'still one pending frame');
    assert.equal(stage.dataset.state, 'speaking');
  });
});

function createFakeStreamFactory() {
  const streams = [];
  const factory = (url) => {
    const stream = {
      url,
      listeners: new Map(),
      addEventListener(type, fn) { this.listeners.set(type, fn); },
      emit(type, data) { this.listeners.get(type)({ data }); },
    };
    streams.push(stream);
    return stream;
  };
  factory.streams = streams;
  return factory;
}

function mountLevels({ raf, clock, factory, search = '?face=1' } = {}) {
  const doc = createSvgMockDocument();
  const controller = withSearch(search, () => new FaceController({
    sseClient: null,
    document: doc,
    raf: raf.request,
    caf: raf.cancel,
    prefersReducedMotion: false,
    eventSourceFactory: factory,
    clock,
  }));
  const stage = doc.body.children.find((c) => c.id === 'amos-face-stage');
  const mouth = stage
    ? stage.children[0].children.find((c) => c.getAttribute('class') === 'af-mouth')
    : null;
  return { controller, mouth };
}

function assertPointsNear(actual, expected) {
  assert.equal(actual.length, expected.length);
  for (let i = 0; i < expected.length; i += 1) {
    assert.ok(Math.abs(actual[i][0] - expected[i][0]) < 0.01, `x at ${i}`);
    assert.ok(Math.abs(actual[i][1] - expected[i][1]) < 0.01, `y at ${i}: ${actual[i][1]} vs ${expected[i][1]}`);
  }
}

test('Amos face waveform levels', async (t) => {
  await t.test('framePoints returns 33 points spanning x 20 to 80', () => {
    const pts = framePoints(new Array(33).fill(0));
    assert.equal(pts.length, 33);
    assert.equal(pts[0][0], 20);
    assert.ok(Math.abs(pts[32][0] - 80) < 1e-9);
  });

  await t.test('framePoints maps zero to y 50, 100 to y 28 and -100 to y 72', () => {
    for (const [, y] of framePoints(new Array(33).fill(0))) assert.equal(y, 50);
    for (const [, y] of framePoints(new Array(33).fill(100))) assert.ok(Math.abs(y - 28) < 1e-9, `y=${y}`);
    for (const [, y] of framePoints(new Array(33).fill(-100))) assert.ok(Math.abs(y - 72) < 1e-9, `y=${y}`);
  });

  await t.test('framePoints default gain is 2.2: a level of 25 maps to y 37.9', () => {
    // 25/100 * 2.2 = 0.55, span 22: 50 - 0.55 * 22 = 37.9 (the old 3.2 gain gave 32.4)
    for (const [, y] of framePoints(new Array(33).fill(25))) assert.ok(Math.abs(y - 37.9) < 1e-9, `y=${y}`);
  });

  await t.test('framePoints smooths a lone spike before mapping it', () => {
    const spike = new Array(33).fill(0);
    spike[16] = 100;
    // one pass: smoothed centre is 50; at gain 1 that is level 0.5, so y = 50 - 0.5 * 22 = 39
    const pts = framePoints(spike, 1);
    assert.ok(Math.abs(pts[16][1] - 39) < 1e-9, `y=${pts[16][1]}`);
    assert.equal(pts[0][1], 50);
  });

  await t.test('framePoints clamps the scaled level to the mouth span', () => {
    const loud = framePoints(new Array(33).fill(100), 10);
    const max = framePoints(new Array(33).fill(100), 3.2);
    assert.deepEqual(loud, max);
    const half = framePoints(new Array(33).fill(100), 0.5);
    assert.ok(Math.abs(half[0][1] - 39) < 1e-9, `half gain y=${half[0][1]}`);
  });

  await t.test('no stream is opened without face=1', () => {
    const raf = createFakeRaf();
    const off = createFakeStreamFactory();
    mountLevels({ raf, factory: off, search: '?face=0' });
    assert.equal(off.streams.length, 0);
    mountLevels({ raf, factory: off, search: '' });
    assert.equal(off.streams.length, 0);
  });

  await t.test('the stream opens once at the levels url', () => {
    const raf = createFakeRaf();
    const factory = createFakeStreamFactory();
    mountLevels({ raf, factory, clock: () => 1000 });
    assert.equal(factory.streams.length, 1);
    assert.equal(factory.streams[0].url, 'http://127.0.0.1:8765/levels');
  });

  await t.test('a null factory disables the stream without error', () => {
    const raf = createFakeRaf();
    const { controller, mouth } = mountLevels({ raf, factory: null, clock: () => 1000 });
    controller.setState('speaking');
    raf.run(1000);
    assert.equal(controller.levelSource, null);
    assert.ok(mouth.getAttribute('points'));
  });

  await t.test('a fresh frame during speaking sets the mouth to framePoints', () => {
    const raf = createFakeRaf();
    let now = 1000;
    const factory = createFakeStreamFactory();
    const { controller, mouth } = mountLevels({ raf, factory, clock: () => now });
    controller.setState('speaking');
    const frame = Array.from({ length: 33 }, (_, i) => (i % 2 ? 100 : -50));
    factory.streams[0].emit('frame', JSON.stringify(frame));
    raf.run(now);
    assertPointsNear(parsePoints(mouth.getAttribute('points')), framePoints(frame));
  });

  await t.test('real frames redraw at the 25 ms cap and ease toward each new target', () => {
    const raf = createFakeRaf();
    let now = 1000;
    const factory = createFakeStreamFactory();
    const { controller, mouth } = mountLevels({ raf, factory, clock: () => now });
    controller.setState('speaking');
    const a = new Array(33).fill(80);
    const b = new Array(33).fill(-80);
    factory.streams[0].emit('frame', JSON.stringify(a));
    raf.run(now);
    const first = mouth.getAttribute('points');
    now = 1005;
    raf.run(now);
    assert.equal(mouth.getAttribute('points'), first, 'tick inside 25 ms is skipped');
    now = 1030;
    raf.run(now);
    assert.equal(mouth.getAttribute('points'), first, 'same target, eased values hold');
    factory.streams[0].emit('frame', JSON.stringify(b));
    // a sits at y 28 (clamped), b at y 72; 30 ms since the last drawn tick, tau 20 ms
    now = 1060;
    raf.run(now);
    const k = 1 - Math.exp(-30 / 20);
    const y = parsePoints(mouth.getAttribute('points'))[0][1];
    assert.ok(Math.abs(y - (28 + 44 * k)) < 0.01, `eased y=${y}`);
    assert.notEqual(y, 72, 'does not jump to the new target');
  });

  await t.test('after a fresh frame goes stale, drawn y values approach 50, not the procedural wave', () => {
    const raf = createFakeRaf();
    let now = 1000;
    const factory = createFakeStreamFactory();
    const { controller, mouth } = mountLevels({ raf, factory, clock: () => now });
    controller.setState('speaking');
    factory.streams[0].emit('frame', JSON.stringify(new Array(33).fill(100)));
    raf.run(now);
    now = 1400;
    raf.run(now);
    assertPointsNear(parsePoints(mouth.getAttribute('points')), framePoints(new Array(33).fill(100)));
    // 400 ms is still fresh; from 1430 ms on the frame is stale and the mouth decays flat
    now = 1430;
    raf.run(now);
    const first = parsePoints(mouth.getAttribute('points'));
    assert.ok(first.every(([, y]) => y > 28 && y < 50), `first stale tick moves toward 50: ${first[0][1]}`);
    // decay tau is 120 ms: 22 * e^(-1600/120) is well under 0.01
    for (let ms = 1460; ms <= 3000; ms += 30) {
      now = ms;
      raf.run(now);
    }
    const settled = parsePoints(mouth.getAttribute('points'));
    for (const [, y] of settled) assert.ok(Math.abs(y - 50) < 0.01, `settled y=${y}`);
  });

  await t.test('a malformed payload is ignored', () => {
    const raf = createFakeRaf();
    let now = 1000;
    const factory = createFakeStreamFactory();
    const { controller, mouth } = mountLevels({ raf, factory, clock: () => now });
    controller.setState('speaking');
    const stream = factory.streams[0];
    stream.emit('frame', 'not json');
    stream.emit('frame', '{"levels": 1}');
    stream.emit('frame', JSON.stringify(new Array(32).fill(0)));
    stream.emit('frame', JSON.stringify(new Array(33).fill('loud')));
    stream.emit('frame', undefined);
    assert.equal(controller.levelAt, null);
    assert.equal(controller.levelFrame, null);
    raf.run(now);
    for (const [, y] of parsePoints(mouth.getAttribute('points'))) assert.equal(y, 50, 'no valid frame: flat mouth');
  });
});

test('Amos face smoothing and easing helpers', async (t) => {
  await t.test('smoothValues keeps length and spreads a lone spike one step (single pass)', () => {
    const v = new Array(33).fill(0);
    v[16] = 100;
    const out = smoothValues(v);
    assert.equal(out.length, 33);
    assert.ok(Math.abs(out[16] - 50) < 1e-9, `centre ${out[16]}`);
    assert.ok(Math.abs(out[15] - 25) < 1e-9 && Math.abs(out[17] - 25) < 1e-9, 'immediate neighbours get 25');
    assert.equal(out[14], 0, 'energy does not reach two steps out after one pass');
    assert.equal(out[18], 0, 'energy does not reach two steps out after one pass');
  });

  await t.test('smoothValues leaves an all-equal frame unchanged', () => {
    const v = new Array(33).fill(42);
    assert.deepEqual(smoothValues(v), v);
  });

  await t.test('smoothValues does not mutate its input', () => {
    const v = Array.from({ length: 33 }, (_, i) => i * 3 - 40);
    const copy = v.slice();
    const out = smoothValues(v);
    assert.deepEqual(v, copy);
    assert.notStrictEqual(out, v);
  });

  await t.test('easeToward with a null current returns a copy of target', () => {
    const target = [1, 2, 3];
    const out = easeToward(null, target, 16);
    assert.deepEqual(out, target);
    assert.notStrictEqual(out, target);
  });

  await t.test('easeToward with a different length returns a copy of target', () => {
    assert.deepEqual(easeToward([0], [1, 2, 3], 16), [1, 2, 3]);
  });

  await t.test('easeToward with dtMs 0 returns current', () => {
    assert.deepEqual(easeToward([10, 20], [50, 60], 0), [10, 20]);
  });

  await t.test('easeToward with dtMs 100 and tauMs 45 moves more than 85% of the way', () => {
    const [y] = easeToward([0], [100], 100, 45);
    assert.ok(y > 85, `moved ${y}`);
    assert.ok(Math.abs(y - 100 * (1 - Math.exp(-100 / 45))) < 1e-9);
  });

  await t.test('easeToward uses tauMs 20 by default', () => {
    const [y] = easeToward([0], [100], 20);
    assert.ok(Math.abs(y - 100 * (1 - Math.exp(-1))) < 1e-9, `y=${y}`);
  });

  await t.test('easeToward clamps negative dtMs to 0 and dtMs above 100 to 100', () => {
    assert.deepEqual(easeToward([10], [50], -50), [10]);
    assert.deepEqual(easeToward([0], [100], 1000), easeToward([0], [100], 100));
  });

  await t.test('easeToward does not mutate its inputs', () => {
    const current = [0, 10];
    const target = [100, 110];
    easeToward(current, target, 16);
    assert.deepEqual(current, [0, 10]);
    assert.deepEqual(target, [100, 110]);
  });
});

test('Amos face speaking eases toward real levels', async (t) => {
  await t.test('a step from silence to full level rises over successive ticks', () => {
    const raf = createFakeRaf();
    let now = 1000;
    const factory = createFakeStreamFactory();
    const { controller, mouth } = mountLevels({ raf, factory, clock: () => now });
    const stream = factory.streams[0];
    controller.setState('speaking');
    stream.emit('frame', JSON.stringify(new Array(33).fill(0)));
    raf.run(now);
    assert.equal(parsePoints(mouth.getAttribute('points'))[0][1], 50);

    stream.emit('frame', JSON.stringify(new Array(33).fill(100)));
    const amps = [];
    for (let i = 0; i < 6; i += 1) {
      now += 30; // each tick clears the 25 ms draw cap
      raf.run(now);
      amps.push(50 - parsePoints(mouth.getAttribute('points'))[0][1]);
    }
    assert.ok(amps[0] > 0 && amps[0] < 22 * 0.9, `first tick is partial: ${amps[0]}`);
    for (let i = 1; i < amps.length; i += 1) {
      assert.ok(amps[i] > amps[i - 1], `strictly rising at tick ${i}: ${amps}`);
    }
    assert.ok(amps[5] <= 22 + 1e-9, `never overshoots: ${amps[5]}`);
  });

  await t.test('leaving speaking resets shownY', () => {
    const raf = createFakeRaf();
    let now = 1000;
    const factory = createFakeStreamFactory();
    const { controller } = mountLevels({ raf, factory, clock: () => now });
    controller.setState('speaking');
    factory.streams[0].emit('frame', JSON.stringify(new Array(33).fill(100)));
    raf.run(now);
    assert.ok(Array.isArray(controller.shownY), 'shownY set while speaking');
    now += 16;
    raf.run(now);
    controller.setState('listening');
    assert.equal(controller.shownY, null);
  });
});
