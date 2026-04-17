// content.js — injects Summarize button + side panel on YouTube watch pages.

(() => {
  const PANEL_ID = 'yt-summarizer-panel';
  const BUTTON_ID = 'yt-summarizer-button';

  let currentVideoId = null;
  let isSummarizing = false;

  // ---------- YouTube helpers ----------

  function getVideoId() {
    try {
      const u = new URL(location.href);
      if (u.pathname !== '/watch') return null;
      return u.searchParams.get('v');
    } catch {
      return null;
    }
  }

  function getVideoTitle() {
    const selectors = [
      'ytd-watch-metadata #title h1 yt-formatted-string',
      'ytd-watch-metadata h1.ytd-watch-metadata',
      '#title h1 yt-formatted-string',
      'h1.ytd-watch-metadata',
    ];
    for (const s of selectors) {
      const el = document.querySelector(s);
      const t = el?.textContent?.trim();
      if (t) return t;
    }
    return document.title.replace(/\s*-\s*YouTube\s*$/, '').trim();
  }

  function getChannelName() {
    const selectors = [
      'ytd-watch-metadata #channel-name yt-formatted-string a',
      'ytd-watch-metadata ytd-channel-name a',
      '#channel-name a',
    ];
    for (const s of selectors) {
      const el = document.querySelector(s);
      const t = el?.textContent?.trim();
      if (t) return t;
    }
    return '';
  }

  async function getTranscript(videoId) {
    // Method 1: DOM scrape — click YouTube's own "Show transcript" button and read segments.
    // Most reliable because it uses YouTube's own auth/rendering.
    try {
      const t = await getTranscriptViaDom();
      log('DOM scrape succeeded, chars:', t.length);
      return t;
    } catch (e) {
      log('DOM scrape failed:', e.message, '— trying innertube API');
    }

    const res = await fetch(`/watch?v=${encodeURIComponent(videoId)}`, {
      credentials: 'include',
    });
    if (!res.ok) throw new Error(`Failed to load video page (${res.status})`);
    const html = await res.text();

    // Method 2: innertube /youtubei/v1/get_transcript.
    try {
      const t = await getTranscriptInnertube(html, videoId);
      log('innertube succeeded, chars:', t.length);
      return t;
    } catch (e) {
      log('innertube failed:', e.message, '— trying legacy caption URL');
    }

    // Method 3: legacy baseUrl fetch (often empty now, but kept as last resort).
    const playerResponse = extractPlayerResponse(html);
    if (!playerResponse) throw new Error('Could not parse player response from page HTML');

    const tracks = playerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
    if (!tracks?.length) throw new Error('No captions available for this video.');

    const track =
      tracks.find((t) => t.languageCode === 'en' && t.kind !== 'asr') ||
      tracks.find((t) => t.languageCode === 'en') ||
      tracks.find((t) => t.languageCode?.startsWith('en')) ||
      tracks[0];

    log('Selected caption track:', { lang: track.languageCode, kind: track.kind || 'manual' });

    try {
      return await fetchTranscriptJson3(track.baseUrl);
    } catch (e) {
      log('json3 failed:', e.message, '— falling back to XML');
      return await fetchTranscriptXml(track.baseUrl);
    }
  }

  // ---------- DOM scrape (preferred) ----------

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  function findShowTranscriptButton() {
    // 1. Embedded transcript section within description (most common, currently)
    const inDesc = document.querySelector(
      'ytd-video-description-transcript-section-renderer ytd-button-renderer button, ' +
      'ytd-video-description-transcript-section-renderer button'
    );
    if (inDesc) return inDesc;

    // 2. Generic text match — any button literally labeled "Show transcript"
    const buttons = document.querySelectorAll('button, tp-yt-paper-button');
    for (const b of buttons) {
      const text = (b.textContent || '').trim().toLowerCase();
      const label = (b.getAttribute('aria-label') || '').toLowerCase();
      if (text === 'show transcript' || label === 'show transcript') return b;
    }
    return null;
  }

  function scrapeTranscriptSegments() {
    return document.querySelectorAll(
      'ytd-transcript-segment-renderer, ytd-transcript-segment-list-renderer ytd-transcript-segment-renderer'
    );
  }

  function segmentsToText(nodes) {
    return Array.from(nodes)
      .map((n) => {
        const el =
          n.querySelector('.segment-text') ||
          n.querySelector('yt-formatted-string.segment-text') ||
          n.querySelector('yt-formatted-string');
        const text = (el?.textContent ?? n.textContent ?? '').trim().replace(/\s+/g, ' ');
        return text;
      })
      .filter(Boolean)
      .join(' ')
      .trim();
  }

  async function waitForSegments(timeoutMs = 8000) {
    const existing = scrapeTranscriptSegments();
    if (existing.length > 2) return existing; // already rendered, return immediately

    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (val, err) => {
        if (settled) return;
        settled = true;
        obs.disconnect();
        clearTimeout(timer);
        if (err) reject(err);
        else resolve(val);
      };
      const obs = new MutationObserver(() => {
        const nodes = scrapeTranscriptSegments();
        if (nodes.length > 2) finish(nodes);
      });
      obs.observe(document.body, { childList: true, subtree: true });
      const timer = setTimeout(
        () => finish(null, new Error('Timed out waiting for transcript panel to render')),
        timeoutMs
      );
    });
  }

  function tryClosePanel() {
    const closeBtn = document.querySelector(
      'ytd-engagement-panel-title-header-renderer button[aria-label*="Close" i], ' +
      '[target-id*="transcript"] button[aria-label*="Close" i]'
    );
    if (closeBtn) closeBtn.click();
  }

  async function getTranscriptViaDom() {
    // Already rendered? (User may have transcript open already.)
    const already = scrapeTranscriptSegments();
    if (already.length > 2) return segmentsToText(already);

    let btn = findShowTranscriptButton();

    // Expand description if button not yet in DOM
    if (!btn) {
      const expandBtn =
        document.querySelector('tp-yt-paper-button#expand') ||
        document.querySelector('#description #expand') ||
        document.querySelector('ytd-text-inline-expander #expand');
      if (expandBtn) {
        expandBtn.click();
        await sleep(250);
        btn = findShowTranscriptButton();
      }
    }

    if (!btn) throw new Error('"Show transcript" button not found on page');

    btn.click();
    const nodes = await waitForSegments(10000);
    const text = segmentsToText(nodes);

    // Hide the panel again so the user isn't left with it open
    tryClosePanel();

    if (!text) throw new Error('Transcript panel opened but no text extracted');
    return text;
  }

  // ---------- Innertube transcript (secondary) ----------

  async function getTranscriptInnertube(html, videoId) {
    const apiKey = matchOne(html, /"INNERTUBE_API_KEY"\s*:\s*"([^"]+)"/);
    const clientVersion =
      matchOne(html, /"INNERTUBE_CLIENT_VERSION"\s*:\s*"([^"]+)"/) || '2.20250101.00.00';
    const visitorData = matchOne(html, /"VISITOR_DATA"\s*:\s*"([^"]+)"/);
    if (!apiKey) throw new Error('no INNERTUBE_API_KEY in page');

    const initialDataJson = extractInitialData(html);
    if (!initialDataJson) throw new Error('no ytInitialData in page');
    let initialData;
    try {
      initialData = JSON.parse(initialDataJson);
    } catch {
      throw new Error('failed to parse ytInitialData');
    }

    const params = findTranscriptParams(initialData);
    if (!params) throw new Error('no transcript params — captions probably unavailable');

    const headers = {
      'Content-Type': 'application/json',
      'X-Youtube-Client-Name': '1',
      'X-Youtube-Client-Version': clientVersion,
    };
    if (visitorData) headers['X-Goog-Visitor-Id'] = visitorData;

    const body = {
      context: {
        client: {
          clientName: 'WEB',
          clientVersion,
          hl: 'en',
          gl: 'US',
          originalUrl: `https://www.youtube.com/watch?v=${videoId}`,
          ...(visitorData ? { visitorData } : {}),
        },
        user: { lockedSafetyMode: false },
        request: { useSsl: true },
      },
      params,
    };

    const res = await fetch(`/youtubei/v1/get_transcript?key=${apiKey}&prettyPrint=false`, {
      method: 'POST',
      credentials: 'include',
      headers,
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      let detail = '';
      try {
        detail = (await res.text()).slice(0, 300);
      } catch {}
      throw new Error(`innertube HTTP ${res.status}${detail ? ' — ' + detail : ''}`);
    }
    const data = await res.json();

    const texts = extractTranscriptTexts(data);
    if (!texts.length) throw new Error('innertube returned no segments');
    return texts.join(' ').replace(/\s+/g, ' ').trim();
  }

  function matchOne(str, re) {
    const m = str.match(re);
    return m ? m[1] : null;
  }

  function extractInitialData(html) {
    const markers = ['var ytInitialData = ', 'ytInitialData = '];
    for (const marker of markers) {
      const idx = html.indexOf(marker);
      if (idx === -1) continue;
      const start = html.indexOf('{', idx);
      if (start === -1) continue;
      const json = sliceBalancedJson(html, start);
      if (json) return json;
    }
    return null;
  }

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

  // Robust extractor that handles nested braces / multiple patterns.
  function extractPlayerResponse(html) {
    const markers = [
      'ytInitialPlayerResponse = ',
      'var ytInitialPlayerResponse = ',
      '"ytInitialPlayerResponse":',
    ];
    for (const marker of markers) {
      const idx = html.indexOf(marker);
      if (idx === -1) continue;
      const start = html.indexOf('{', idx);
      if (start === -1) continue;
      const jsonStr = sliceBalancedJson(html, start);
      if (!jsonStr) continue;
      try {
        return JSON.parse(jsonStr);
      } catch (e) {
        log('player response JSON parse failed, trying next pattern:', e.message);
      }
    }
    return null;
  }

  // Walks characters tracking brace depth and string escapes to extract a full JSON object.
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

  function withFmt(baseUrl, fmt) {
    // baseUrl is absolute — use a base for safety
    const url = new URL(baseUrl, 'https://www.youtube.com');
    if (fmt) url.searchParams.set('fmt', fmt);
    else url.searchParams.delete('fmt');
    return url.toString();
  }

  async function fetchTranscriptJson3(baseUrl) {
    const url = withFmt(baseUrl, 'json3');
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    if (!text.trim()) throw new Error('empty response');
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error('non-JSON response');
    }
    const transcript = (json.events || [])
      .filter((e) => e.segs)
      .map((e) => e.segs.map((s) => s.utf8 || '').join(''))
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (!transcript) throw new Error('empty transcript');
    return transcript;
  }

  async function fetchTranscriptXml(baseUrl) {
    // Default format is XML; strip fmt if present
    const url = withFmt(baseUrl, null);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`XML transcript fetch failed (${res.status})`);
    const text = await res.text();
    if (!text.trim()) throw new Error('Empty transcript response');

    const parser = new DOMParser();
    const doc = parser.parseFromString(text, 'text/xml');
    const parseErr = doc.querySelector('parsererror');
    if (parseErr) throw new Error('Invalid XML transcript');

    const nodes = doc.querySelectorAll('text');
    if (!nodes.length) throw new Error('No text nodes in XML transcript');

    // Decode HTML entities via a textarea (handles &#39;, &amp;, etc.)
    const decoder = document.createElement('textarea');
    const transcript = Array.from(nodes)
      .map((n) => {
        decoder.innerHTML = n.textContent || '';
        return decoder.value;
      })
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (!transcript) throw new Error('Empty transcript after XML parse');
    return transcript;
  }

  // ---------- Rendering ----------

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    }[c]));
  }

  // Tiny markdown renderer — escapes first, then applies transforms. Safe against XSS.
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
      .replace(/`([^`]+)`/g, '<code>$1</code>');
  }

  // ---------- Panel UI ----------

  function ensurePanel() {
    let panel = document.getElementById(PANEL_ID);
    if (panel) return panel;

    panel = document.createElement('div');
    panel.id = PANEL_ID;
    panel.innerHTML = `
      <div class="yts-header">
        <div class="yts-title">Summary</div>
        <div class="yts-actions">
          <button class="yts-btn-icon" data-action="copy" title="Copy markdown">⎘</button>
          <button class="yts-btn-icon" data-action="regenerate" title="Regenerate">↻</button>
          <button class="yts-btn-icon" data-action="close" title="Close">✕</button>
        </div>
      </div>
      <div class="yts-body"></div>
      <div class="yts-footer"></div>
    `;
    document.body.appendChild(panel);

    panel.addEventListener('click', (e) => {
      const action = e.target?.dataset?.action;
      if (!action) return;
      if (action === 'close') panel.classList.remove('yts-open');
      if (action === 'regenerate' && !isSummarizing) runSummarize();
      if (action === 'copy') {
        const md = panel.dataset.markdown || '';
        if (!md) return;
        navigator.clipboard.writeText(md).then(() => {
          const btn = e.target;
          const prev = btn.textContent;
          btn.textContent = '✓';
          setTimeout(() => (btn.textContent = prev), 1200);
        });
      }
    });

    return panel;
  }

  function showPanel(state, content, meta) {
    const panel = ensurePanel();
    panel.classList.add('yts-open');
    const body = panel.querySelector('.yts-body');
    const footer = panel.querySelector('.yts-footer');
    footer.textContent = '';

    if (state === 'loading') {
      body.innerHTML =
        '<div class="yts-loading"><div class="yts-spinner"></div><div>Summarizing…</div></div>';
    } else if (state === 'error') {
      body.innerHTML = `<div class="yts-error"><strong>Error</strong><div>${escapeHtml(content)}</div></div>`;
    } else if (state === 'summary') {
      panel.dataset.markdown = content;
      body.innerHTML = `<div class="yts-summary">${renderMarkdown(content)}</div>`;
      if (meta?.usage) {
        const { input_tokens = 0, output_tokens = 0 } = meta.usage;
        const providerLabel = meta.provider ? `${meta.provider}/` : '';
        footer.textContent = `${providerLabel}${meta.model || ''} · ${input_tokens} in / ${output_tokens} out`;
      } else if (meta?.model) {
        const providerLabel = meta.provider ? `${meta.provider}/` : '';
        footer.textContent = `${providerLabel}${meta.model}`;
      }
    }
  }

  async function runSummarize() {
    const videoId = getVideoId();
    if (!videoId) return;

    isSummarizing = true;
    showPanel('loading');

    try {
      const transcript = await getTranscript(videoId);
      const title = getVideoTitle();
      const channel = getChannelName();
      const images = await getImages(videoId);
      if (images.length) log(`collected ${images.length} image(s)`);

      const response = await chrome.runtime.sendMessage({
        type: 'summarize',
        transcript,
        title,
        channel,
        images,
      });

      if (response?.error) throw new Error(response.error);
      showPanel('summary', response.summary, {
        usage: response.usage,
        model: response.model,
        provider: response.provider,
      });
    } catch (e) {
      showPanel('error', e?.message || String(e));
    } finally {
      isSummarizing = false;
    }
  }

  // ---------- Image extraction (chapter thumbnails or main thumbnail) ----------

  async function getImages(videoId) {
    const images = [];

    // Try chapters from ytInitialData (we already fetched the page for transcript,
    // but let's re-fetch cheaply here — it'll be cached by the browser).
    try {
      const res = await fetch(`/watch?v=${encodeURIComponent(videoId)}`, {
        credentials: 'include',
      });
      if (res.ok) {
        const html = await res.text();
        const initialDataJson = extractInitialData(html);
        if (initialDataJson) {
          const data = JSON.parse(initialDataJson);
          const chapters = findChapters(data);
          if (chapters?.length) {
            const MAX = 10;
            const selected = chapters.slice(0, MAX);
            for (const ch of selected) {
              if (!ch.thumbnailUrl) continue;
              try {
                const base64 = await fetchAsBase64(ch.thumbnailUrl);
                images.push({ base64, label: ch.title, startSeconds: ch.startSeconds });
              } catch (e) {
                log('chapter thumbnail fetch failed:', e.message);
              }
            }
          }
        }
      }
    } catch (e) {
      log('chapter extraction failed:', e.message);
    }

    // Fallback: main video thumbnail
    if (!images.length) {
      const candidates = [
        `https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg`,
        `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
      ];
      for (const url of candidates) {
        try {
          const base64 = await fetchAsBase64(url);
          images.push({ base64, label: 'main thumbnail', startSeconds: 0 });
          break;
        } catch (e) {
          log('main thumbnail fetch failed:', url, e.message);
        }
      }
    }

    return images;
  }

  function findChapters(data) {
    const markersMap = deepFindByKey(data, 'markersMap');
    if (!Array.isArray(markersMap)) return null;

    const chapterMarker = markersMap.find((m) =>
      ['DESCRIPTION_CHAPTERS', 'AUTO_CHAPTERS'].includes(m?.key)
    );
    if (!chapterMarker) return null;

    const chapters = chapterMarker.value?.chapters;
    if (!Array.isArray(chapters) || chapters.length === 0) return null;

    return chapters
      .map((c) => {
        const r = c.chapterRenderer;
        if (!r) return null;
        const thumbs = r.thumbnail?.thumbnails || [];
        return {
          title: r.title?.simpleText || '',
          startSeconds: (r.timeRangeStartMillis || 0) / 1000,
          thumbnailUrl: thumbs[thumbs.length - 1]?.url || null,
        };
      })
      .filter(Boolean);
  }

  function deepFindByKey(obj, targetKey) {
    if (!obj || typeof obj !== 'object') return null;
    if (targetKey in obj) return obj[targetKey];
    for (const val of Object.values(obj)) {
      if (val && typeof val === 'object') {
        const found = deepFindByKey(val, targetKey);
        if (found !== null && found !== undefined) return found;
      }
    }
    return null;
  }

  async function fetchAsBase64(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const blob = await res.blob();
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onloadend = () => {
        const result = typeof r.result === 'string' ? r.result : '';
        const comma = result.indexOf(',');
        resolve(comma >= 0 ? result.slice(comma + 1) : result);
      };
      r.onerror = () => reject(new Error('FileReader error'));
      r.readAsDataURL(blob);
    });
  }

  // ---------- Button injection ----------

  function log(...args) {
    try { console.log('[YT Summarizer]', ...args); } catch {}
  }

  function makeButton(extraClass) {
    const btn = document.createElement('button');
    btn.id = BUTTON_ID;
    btn.className = 'yts-summarize-btn' + (extraClass ? ' ' + extraClass : '');
    btn.type = 'button';
    btn.innerHTML =
      '<span class="yts-btn-icon-inline">✨</span><span class="yts-btn-label">Summarize</span>';
    btn.addEventListener('click', () => {
      if (!isSummarizing) runSummarize();
      else ensurePanel().classList.add('yts-open');
    });
    return btn;
  }

  function isVisible(el) {
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function findActionRow() {
    // Every selector that has matched YouTube's action row across various layouts
    const selectors = [
      'ytd-watch-metadata #top-level-buttons-computed',
      '#above-the-fold #top-level-buttons-computed',
      'ytd-menu-renderer.ytd-watch-metadata #top-level-buttons-computed',
      '#actions-inner #top-level-buttons-computed',
      '#menu #top-level-buttons-computed',
      '#top-level-buttons-computed',
      'ytd-watch-metadata #actions #menu',
      '#above-the-fold #actions #menu',
    ];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el && isVisible(el)) return el;
    }
    return null;
  }

  function ensureInlineButton() {
    if (document.getElementById(BUTTON_ID)) return true;
    const row = findActionRow();
    if (row) {
      log('injecting inline into', row);
      row.appendChild(makeButton('yts-inline'));
      return true;
    }
    return false;
  }

  function ensureFloatingButton() {
    if (document.getElementById(BUTTON_ID)) return;
    log('falling back to floating button');
    document.body.appendChild(makeButton('yts-floating'));
  }

  function injectWithRetry() {
    if (ensureInlineButton()) return;
    let attempts = 0;
    const maxAttempts = 20; // ~5 seconds
    const iv = setInterval(() => {
      attempts++;
      if (ensureInlineButton()) {
        clearInterval(iv);
      } else if (attempts >= maxAttempts) {
        clearInterval(iv);
        // Fallback so user always has a way to summarize
        if (!document.getElementById(BUTTON_ID)) ensureFloatingButton();
      }
    }, 250);
  }

  // ---------- SPA navigation ----------

  function onNavigation() {
    const videoId = getVideoId();
    const existing = document.getElementById(BUTTON_ID);
    const panel = document.getElementById(PANEL_ID);

    if (!videoId) {
      existing?.remove();
      panel?.classList.remove('yts-open');
      currentVideoId = null;
      return;
    }

    if (videoId === currentVideoId && existing) return;

    existing?.remove();
    panel?.classList.remove('yts-open');
    currentVideoId = videoId;
    injectWithRetry();
  }

  // YouTube dispatches these during SPA nav
  window.addEventListener('yt-navigate-finish', onNavigation);
  document.addEventListener('yt-navigate-finish', onNavigation);

  // Fallback: observe URL changes
  let lastHref = location.href;
  setInterval(() => {
    if (location.href !== lastHref) {
      lastHref = location.href;
      onNavigation();
    }
  }, 500);

  onNavigation();
})();
