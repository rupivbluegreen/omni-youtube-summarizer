// content.js — injects Summarize button + side panel on YouTube watch pages.
// Requires lib/parsers.js to be loaded before this (see manifest.json content_scripts.js).

(() => {
  const {
    sliceBalancedJson,
    escapeHtml,
    renderMarkdown,
    findTranscriptParams,
    extractTranscriptTexts,
  } = (typeof globalThis !== 'undefined' ? globalThis : self).YTS;

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

  // 24-hour transcript cache in chrome.storage.local. Keyed on videoId.
  const TRANSCRIPT_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
  const TRANSCRIPT_CACHE_MAX_ENTRIES = 50;

  async function getCachedTranscript(videoId) {
    try {
      const key = `tr:${videoId}`;
      const res = await chrome.storage.local.get(key);
      const hit = res[key];
      // Validate shape — earlier versions or storage corruption could produce malformed entries.
      if (!hit || typeof hit.ts !== 'number' || typeof hit.text !== 'string') {
        if (hit) chrome.storage.local.remove(key);
        return null;
      }
      if (Date.now() - hit.ts > TRANSCRIPT_CACHE_TTL_MS) {
        chrome.storage.local.remove(key);
        return null;
      }
      return hit.text;
    } catch { return null; }
  }

  // Only scan-and-evict every Nth write to amortize cost on the hot path.
  let transcriptCacheWriteCount = 0;
  const TRANSCRIPT_CACHE_EVICT_EVERY = 10;

  async function setCachedTranscript(videoId, text) {
    try {
      const key = `tr:${videoId}`;
      await chrome.storage.local.set({ [key]: { text, ts: Date.now() } });
      transcriptCacheWriteCount++;
      if (transcriptCacheWriteCount % TRANSCRIPT_CACHE_EVICT_EVERY !== 0) return;

      const all = await chrome.storage.local.get(null);
      const trs = Object.entries(all).filter(([k]) => k.startsWith('tr:'));
      if (trs.length > TRANSCRIPT_CACHE_MAX_ENTRIES) {
        trs.sort((a, b) => (a[1].ts || 0) - (b[1].ts || 0));
        const toRemove = trs.slice(0, trs.length - TRANSCRIPT_CACHE_MAX_ENTRIES).map(([k]) => k);
        chrome.storage.local.remove(toRemove);
      }
    } catch (e) { log('cache write failed:', e.message); }
  }

  async function getTranscript(videoId) {
    const cached = await getCachedTranscript(videoId);
    if (cached) {
      log('transcript cache hit, chars:', cached.length);
      return cached;
    }

    // Method 1: DOM scrape — click YouTube's own "Show transcript" button and read segments.
    // Most reliable because it uses YouTube's own auth/rendering.
    try {
      const t = await getTranscriptViaDom();
      log('DOM scrape succeeded, chars:', t.length);
      setCachedTranscript(videoId, t);
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
      setCachedTranscript(videoId, t);
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

    let text;
    try {
      text = await fetchTranscriptJson3(track.baseUrl);
    } catch (e) {
      log('json3 failed:', e.message, '— falling back to XML');
      text = await fetchTranscriptXml(track.baseUrl);
    }
    setCachedTranscript(videoId, text);
    return text;
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
  // escapeHtml and renderMarkdown come from YTS (lib/parsers.js).

  function seekVideo(seconds) {
    const video =
      document.querySelector('#movie_player video') || document.querySelector('video');
    if (!video) return;
    const target = Math.max(0, Math.min(video.duration || seconds, seconds));
    video.currentTime = target;
    if (video.paused) video.play().catch(() => {});
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
      const ts = e.target?.closest?.('.yts-ts');
      if (ts) {
        e.preventDefault();
        const s = Number(ts.dataset.seconds);
        if (!Number.isNaN(s)) seekVideo(s);
        return;
      }

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
    } else if (state === 'streaming') {
      // renderMarkdown escapes HTML before applying markdown transforms (see function), so this is XSS-safe.
      panel.dataset.markdown = content;
      body.innerHTML = `<div class="yts-summary">${renderMarkdown(content)}<span class="yts-cursor"></span></div>`;
    } else if (state === 'summary') {
      panel.dataset.markdown = content;
      body.innerHTML = `<div class="yts-summary">${renderMarkdown(content)}</div>`;
      const parts = [];
      if (meta?.provider) parts.push(`${meta.provider}/${meta.model || ''}`);
      else if (meta?.model) parts.push(meta.model);
      if (meta?.usage) {
        const { input_tokens = 0, output_tokens = 0 } = meta.usage;
        parts.push(`${input_tokens} in / ${output_tokens} out`);
      }
      if (meta?.truncated) parts.push('⚠ stream ended early — click ↻ to regenerate');
      footer.textContent = parts.join(' · ');
    }
  }

  async function runSummarize() {
    const videoId = getVideoId();
    if (!videoId) return;

    isSummarizing = true;
    showPanel('loading');

    let transcript, title, channel, images;
    try {
      transcript = await getTranscript(videoId);
      title = getVideoTitle();
      channel = getChannelName();
      images = await getImages(videoId);
      if (images.length) log(`collected ${images.length} image(s)`);
    } catch (e) {
      showPanel('error', e?.message || String(e));
      isSummarizing = false;
      return;
    }

    // Stream the response through a long-lived port.
    const port = chrome.runtime.connect({ name: 'summarize' });
    let accumulated = '';
    let completed = false;

    port.onMessage.addListener((msg) => {
      if (msg.type === 'chunk') {
        accumulated += msg.text;
        showPanel('streaming', accumulated);
      } else if (msg.type === 'done') {
        completed = true;
        showPanel('summary', msg.summary || accumulated, {
          usage: msg.usage, model: msg.model, provider: msg.provider,
        });
        isSummarizing = false;
      } else if (msg.type === 'error') {
        completed = true;
        showPanel('error', msg.message);
        isSummarizing = false;
      }
    });
    port.onDisconnect.addListener(() => {
      if (completed) return;
      if (accumulated) {
        showPanel('summary', accumulated, { truncated: true });
      } else {
        showPanel('error', 'Summarization ended unexpectedly. Try again.');
      }
      isSummarizing = false;
    });

    port.postMessage({ type: 'start', transcript, title, channel, images });
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
