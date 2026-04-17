// extension/lib/parsers.js — pure parsing / rendering helpers.
//
// Loaded by:
//   • the service worker (background.js) via importScripts()
//   • the content script (content.js) as the first entry in content_scripts.js
//   • unit tests (tests/parsers.test.js) as a CommonJS module
//
// Exposes `YTS` on the extension's globalThis; exports the same shape via module.exports for Node.
// Nothing in this file may reference chrome.*, document, window, or other host-specific globals.

(function () {
  // ---------- SSE ----------

  // Parses Server-Sent Events from a fetch response body. Yields the parsed JSON payload
  // for each `data:` event. Handles events that span multiple chunks, terminates on [DONE].
  async function* sseEvents(response) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let sep;
      while ((sep = buf.indexOf('\n\n')) !== -1) {
        const event = buf.slice(0, sep);
        buf = buf.slice(sep + 2);
        const dataLines = event
          .split('\n')
          .filter((l) => l.startsWith('data:'))
          .map((l) => l.slice(5).trimStart());
        if (!dataLines.length) continue;
        const payload = dataLines.join('\n');
        if (payload === '[DONE]') return;
        try { yield JSON.parse(payload); } catch { /* ignore malformed */ }
      }
    }
  }

  // Parses newline-delimited JSON (Ollama's streaming format).
  async function* ndjson(response) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        try { yield JSON.parse(line); } catch { /* ignore */ }
      }
    }
    if (buf.trim()) {
      try { yield JSON.parse(buf); } catch {}
    }
  }

  // ---------- JSON extraction ----------

  // Walks characters tracking brace depth and string escapes to extract one complete
  // JSON object starting at `start`. Returns the slice as a string, or null on failure.
  function sliceBalancedJson(s, start) {
    let depth = 0;
    let inStr = false;
    let escape = false;
    for (let i = start; i < s.length; i++) {
      const c = s[i];
      if (inStr) {
        if (escape) escape = false;
        else if (c === '\\') escape = true;
        else if (c === '"') inStr = false;
      } else {
        if (c === '"') inStr = true;
        else if (c === '{') depth++;
        else if (c === '}') {
          depth--;
          if (depth === 0) return s.slice(start, i + 1);
        }
      }
    }
    return null;
  }

  // ---------- Markdown rendering ----------

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    }[c]));
  }

  // Tiny markdown renderer — escapes first, then applies transforms. Safe against XSS from
  // model output. Supports headings, bullet lists, paragraphs, **bold**, *italic*, `code`,
  // and [mm:ss] / [h:mm:ss] timestamps (rewritten to yts-ts anchors).
  function renderMarkdown(md) {
    const lines = escapeHtml(md).split('\n');
    let html = '';
    let inList = false;
    let paragraph = [];
    const flushPara = () => {
      if (paragraph.length) {
        html += `<p>${paragraph.join(' ')}</p>`;
        paragraph = [];
      }
    };
    for (const line of lines) {
      if (/^###\s/.test(line)) {
        flushPara();
        if (inList) { html += '</ul>'; inList = false; }
        html += `<h4>${line.replace(/^###\s/, '')}</h4>`;
      } else if (/^##\s/.test(line)) {
        flushPara();
        if (inList) { html += '</ul>'; inList = false; }
        html += `<h3>${line.replace(/^##\s/, '')}</h3>`;
      } else if (/^#\s/.test(line)) {
        flushPara();
        if (inList) { html += '</ul>'; inList = false; }
        html += `<h2>${line.replace(/^#\s/, '')}</h2>`;
      } else if (/^[-*]\s/.test(line)) {
        flushPara();
        if (!inList) { html += '<ul>'; inList = true; }
        html += `<li>${line.replace(/^[-*]\s/, '')}</li>`;
      } else if (!line.trim()) {
        flushPara();
        if (inList) { html += '</ul>'; inList = false; }
      } else {
        paragraph.push(line);
      }
    }
    flushPara();
    if (inList) html += '</ul>';

    return html
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\[(\d{1,2}):(\d{2})(?::(\d{2}))?\]/g, (_, a, b, c) => {
        const seconds = c
          ? Number(a) * 3600 + Number(b) * 60 + Number(c)
          : Number(a) * 60 + Number(b);
        const label = c ? `${a}:${b}:${c}` : `${a}:${b}`;
        return `<a class="yts-ts" data-seconds="${seconds}" href="#" title="Jump to ${label}">[${label}]</a>`;
      });
  }

  // ---------- YouTube innertube helpers ----------

  function findTranscriptParams(data) {
    const panels = data?.engagementPanels || [];
    for (const panel of panels) {
      const r = panel.engagementPanelSectionListRenderer;
      if (!r) continue;
      const pid = r.panelIdentifier || r.targetId || '';
      if (!String(pid).includes('transcript')) continue;

      const params =
        r.content?.continuationItemRenderer?.continuationEndpoint?.getTranscriptEndpoint?.params ||
        r.content?.continuationItemRenderer?.continuationEndpoint?.continuationCommand?.token;
      if (params) return params;
    }
    return null;
  }

  // Recursively collect transcript text from innertube response.
  // Handles both transcriptSegmentRenderer (new) and transcriptCueRenderer (older) shapes.
  function extractTranscriptTexts(data) {
    const texts = [];
    const walk = (obj) => {
      if (!obj || typeof obj !== 'object') return;

      if (obj.transcriptSegmentRenderer) {
        const snippet = obj.transcriptSegmentRenderer.snippet;
        const text =
          snippet?.simpleText ||
          (Array.isArray(snippet?.runs) ? snippet.runs.map((r) => r.text || '').join('') : '');
        if (text) texts.push(text);
        return;
      }
      if (obj.transcriptCueRenderer) {
        const cue = obj.transcriptCueRenderer.cue;
        const text =
          cue?.simpleText ||
          (Array.isArray(cue?.runs) ? cue.runs.map((r) => r.text || '').join('') : '');
        if (text) texts.push(text);
        return;
      }

      for (const val of Object.values(obj)) {
        if (Array.isArray(val)) val.forEach(walk);
        else if (val && typeof val === 'object') walk(val);
      }
    };
    walk(data);
    return texts;
  }

  const api = {
    sseEvents, ndjson,
    sliceBalancedJson,
    escapeHtml, renderMarkdown,
    findTranscriptParams, extractTranscriptTexts,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    (typeof globalThis !== 'undefined' ? globalThis : self).YTS = api;
  }
})();
