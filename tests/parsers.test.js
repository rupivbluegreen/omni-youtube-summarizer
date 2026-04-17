// tests/parsers.test.js — unit tests for extension/lib/parsers.js.
// Run with: node --test tests/
//
// Covers the pure helpers: sseEvents, ndjson, sliceBalancedJson, escapeHtml,
// renderMarkdown, findTranscriptParams, extractTranscriptTexts.

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  sseEvents,
  ndjson,
  sliceBalancedJson,
  escapeHtml,
  renderMarkdown,
  findTranscriptParams,
  extractTranscriptTexts,
} = require('../extension/lib/parsers.js');

// ---------- helpers ----------

// Creates a fetch-like Response whose .body.getReader() emits the given chunks
// in order. Each chunk can be a string (UTF-8 encoded) or a Uint8Array.
function mockResponse(chunks) {
  const encoder = new TextEncoder();
  const encoded = chunks.map((c) => (typeof c === 'string' ? encoder.encode(c) : c));
  let i = 0;
  const reader = {
    async read() {
      if (i >= encoded.length) return { done: true, value: undefined };
      return { done: false, value: encoded[i++] };
    },
  };
  return { body: { getReader: () => reader } };
}

async function collect(asyncIter) {
  const out = [];
  for await (const ev of asyncIter) out.push(ev);
  return out;
}

// ---------- sseEvents ----------

test('sseEvents: basic single-event stream', async () => {
  const res = mockResponse(['data: {"ok":1}\n\n']);
  const events = await collect(sseEvents(res));
  assert.deepEqual(events, [{ ok: 1 }]);
});

test('sseEvents: multi-event stream', async () => {
  const res = mockResponse([
    'data: {"n":1}\n\n',
    'data: {"n":2}\n\n',
    'data: {"n":3}\n\n',
  ]);
  const events = await collect(sseEvents(res));
  assert.deepEqual(events, [{ n: 1 }, { n: 2 }, { n: 3 }]);
});

test('sseEvents: handles events split across chunks', async () => {
  // Emit the JSON payload across multiple reads, boundary inside the token.
  const res = mockResponse([
    'data: {"text":"hel',
    'lo world"}\n',
    '\ndata: {"text":"ok"}\n\n',
  ]);
  const events = await collect(sseEvents(res));
  assert.deepEqual(events, [{ text: 'hello world' }, { text: 'ok' }]);
});

test('sseEvents: respects [DONE] terminator', async () => {
  const res = mockResponse([
    'data: {"n":1}\n\n',
    'data: [DONE]\n\n',
    'data: {"n":2}\n\n', // should be ignored
  ]);
  const events = await collect(sseEvents(res));
  assert.deepEqual(events, [{ n: 1 }]);
});

test('sseEvents: ignores non-data lines (comments, event: ...)', async () => {
  const res = mockResponse([
    ':heartbeat\n\n',
    'event: message\ndata: {"n":1}\n\n',
    'event: ping\n\n',
  ]);
  const events = await collect(sseEvents(res));
  assert.deepEqual(events, [{ n: 1 }]);
});

test('sseEvents: skips malformed JSON without throwing', async () => {
  const res = mockResponse([
    'data: {not valid}\n\n',
    'data: {"n":1}\n\n',
  ]);
  const events = await collect(sseEvents(res));
  assert.deepEqual(events, [{ n: 1 }]);
});

test('sseEvents: multi-line data concatenates', async () => {
  // Per SSE spec, multiple data: lines within one event are joined with \n.
  const res = mockResponse([
    'data: {"text":\ndata: "hi"}\n\n',
  ]);
  const events = await collect(sseEvents(res));
  assert.deepEqual(events, [{ text: 'hi' }]);
});

// ---------- ndjson ----------

test('ndjson: emits one event per line', async () => {
  const res = mockResponse([
    '{"n":1}\n',
    '{"n":2}\n{"n":3}\n',
  ]);
  const events = await collect(ndjson(res));
  assert.deepEqual(events, [{ n: 1 }, { n: 2 }, { n: 3 }]);
});

test('ndjson: handles line split across chunks', async () => {
  const res = mockResponse([
    '{"text":"hel',
    'lo"}\n',
  ]);
  const events = await collect(ndjson(res));
  assert.deepEqual(events, [{ text: 'hello' }]);
});

test('ndjson: flushes trailing line without newline', async () => {
  const res = mockResponse(['{"n":1}']);
  const events = await collect(ndjson(res));
  assert.deepEqual(events, [{ n: 1 }]);
});

test('ndjson: ignores blank lines + bad JSON', async () => {
  const res = mockResponse([
    '\n',
    '{"ok":true}\n',
    'garbage\n',
    '{"ok":false}\n',
  ]);
  const events = await collect(ndjson(res));
  assert.deepEqual(events, [{ ok: true }, { ok: false }]);
});

// ---------- sliceBalancedJson ----------

test('sliceBalancedJson: returns first complete object', () => {
  const s = 'noise {"a":1} more';
  const out = sliceBalancedJson(s, s.indexOf('{'));
  assert.equal(out, '{"a":1}');
});

test('sliceBalancedJson: handles nested braces', () => {
  const s = 'x = {"a":{"b":{"c":1}}};';
  const out = sliceBalancedJson(s, s.indexOf('{'));
  assert.equal(out, '{"a":{"b":{"c":1}}}');
});

test('sliceBalancedJson: ignores braces inside strings', () => {
  const s = '{"a":"}"} trailing';
  const out = sliceBalancedJson(s, 0);
  assert.equal(out, '{"a":"}"}');
});

test('sliceBalancedJson: handles escaped quotes inside strings', () => {
  const s = '{"k":"ab\\"c{"} tail';
  const out = sliceBalancedJson(s, 0);
  assert.equal(out, '{"k":"ab\\"c{"}');
  // And the extracted text should parse.
  assert.deepEqual(JSON.parse(out), { k: 'ab"c{' });
});

test('sliceBalancedJson: returns null on unterminated input', () => {
  assert.equal(sliceBalancedJson('{"a":1', 0), null);
});

// ---------- escapeHtml ----------

test('escapeHtml: escapes all five entities', () => {
  assert.equal(
    escapeHtml(`<tag class="x">&'</tag>`),
    '&lt;tag class=&quot;x&quot;&gt;&amp;&#39;&lt;/tag&gt;'
  );
});

// ---------- renderMarkdown ----------

test('renderMarkdown: escapes HTML before applying markdown', () => {
  const out = renderMarkdown('<script>alert(1)</script>');
  // The <script> tag must not survive literally.
  assert.ok(!/<script>/.test(out));
  assert.ok(/&lt;script&gt;/.test(out));
});

test('renderMarkdown: headings produce expected tags', () => {
  const out = renderMarkdown('# H1\n## H2\n### H3');
  assert.match(out, /<h2>H1<\/h2>/);
  assert.match(out, /<h3>H2<\/h3>/);
  assert.match(out, /<h4>H3<\/h4>/);
});

test('renderMarkdown: bullet list', () => {
  const out = renderMarkdown('- a\n- b\n- c');
  assert.match(out, /<ul><li>a<\/li><li>b<\/li><li>c<\/li><\/ul>/);
});

test('renderMarkdown: bold / italic / code', () => {
  const out = renderMarkdown('**bold** *em* `code`');
  assert.match(out, /<strong>bold<\/strong>/);
  assert.match(out, /<em>em<\/em>/);
  assert.match(out, /<code>code<\/code>/);
});

test('renderMarkdown: linkifies [mm:ss] timestamps', () => {
  const out = renderMarkdown('- Insight at [2:15]');
  assert.match(out, /<a class="yts-ts" data-seconds="135" href="#" title="Jump to 2:15">\[2:15\]<\/a>/);
});

test('renderMarkdown: linkifies [h:mm:ss] timestamps', () => {
  const out = renderMarkdown('See [1:02:05]');
  assert.match(out, /data-seconds="3725"/);
  assert.match(out, /\[1:02:05\]/);
});

test('renderMarkdown: leaves plain text [things] untouched', () => {
  const out = renderMarkdown('Section [intro] here');
  assert.ok(!/yts-ts/.test(out));
});

// ---------- findTranscriptParams ----------

test('findTranscriptParams: finds getTranscriptEndpoint.params', () => {
  const data = {
    engagementPanels: [
      { engagementPanelSectionListRenderer: { panelIdentifier: 'engagement-panel-transcript',
          content: { continuationItemRenderer: { continuationEndpoint: {
            getTranscriptEndpoint: { params: 'abc123' } } } } } },
    ],
  };
  assert.equal(findTranscriptParams(data), 'abc123');
});

test('findTranscriptParams: falls back to continuationCommand.token', () => {
  const data = {
    engagementPanels: [
      { engagementPanelSectionListRenderer: { targetId: 'transcript-panel',
          content: { continuationItemRenderer: { continuationEndpoint: {
            continuationCommand: { token: 'fallback-token' } } } } } },
    ],
  };
  assert.equal(findTranscriptParams(data), 'fallback-token');
});

test('findTranscriptParams: returns null when no transcript panel present', () => {
  assert.equal(findTranscriptParams({ engagementPanels: [] }), null);
  assert.equal(findTranscriptParams({}), null);
  assert.equal(findTranscriptParams(null), null);
});

// ---------- extractTranscriptTexts ----------

test('extractTranscriptTexts: handles transcriptSegmentRenderer with simpleText', () => {
  const data = {
    body: { items: [
      { transcriptSegmentRenderer: { snippet: { simpleText: 'Hello' } } },
      { transcriptSegmentRenderer: { snippet: { simpleText: 'world' } } },
    ]},
  };
  assert.deepEqual(extractTranscriptTexts(data), ['Hello', 'world']);
});

test('extractTranscriptTexts: handles runs arrays', () => {
  const data = {
    segments: [
      { transcriptSegmentRenderer: { snippet: { runs: [
        { text: 'Hel' }, { text: 'lo' },
      ]}}},
    ],
  };
  assert.deepEqual(extractTranscriptTexts(data), ['Hello']);
});

test('extractTranscriptTexts: handles older transcriptCueRenderer', () => {
  const data = {
    cues: [
      { transcriptCueRenderer: { cue: { simpleText: 'Legacy' } } },
    ],
  };
  assert.deepEqual(extractTranscriptTexts(data), ['Legacy']);
});

test('extractTranscriptTexts: walks deeply nested structures', () => {
  const data = { a: { b: { c: [
    { transcriptSegmentRenderer: { snippet: { simpleText: 'Deep' } } },
  ] } } };
  assert.deepEqual(extractTranscriptTexts(data), ['Deep']);
});
