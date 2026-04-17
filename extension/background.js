// background.js — service worker. Multi-provider LLM dispatcher with optional image input.

importScripts('lib/parsers.js');
const { sseEvents, ndjson } = YTS;

const DEFAULT_PROMPT = `You are summarizing a YouTube video transcript. Produce a concise, high-signal summary.

Output format (markdown):

## TL;DR
2-3 sentences capturing the essence.

## Key Points
- 5-8 bullets with the most important ideas, claims, or moments
- Include specific numbers, names, and examples when present
- Lead with the insight, not the buildup
- When a point has a clear moment in the video, append a timestamp like [mm:ss] or [h:mm:ss] (lowest useful precision). Only include a timestamp when the reader would meaningfully benefit from jumping there.

## Takeaways
Brief paragraph on what to remember or act on.

Rules:
- Prefer substance. Don't say "the speaker discusses X" — state what was said.
- If it's a how-to, extract the actual steps.
- If it's an opinion piece, extract the argument structure.
- If images are provided, they are chapter thumbnails or a main thumbnail; reference them only when they add signal. Use the image's timestamp label verbatim if you cite it.
- Match depth to content. Don't pad.`;

const PROVIDERS = {
  anthropic: {
    label: 'Anthropic (Claude)',
    needsApiKey: true,
    needsBaseUrl: false,
    defaultModel: 'claude-haiku-4-5-20251001',
    modelOptions: [
      'claude-haiku-4-5-20251001',
      'claude-sonnet-4-6',
      'claude-opus-4-7',
    ],
    supportsVision: true,
    call: callAnthropic,
  },
  openai: {
    label: 'OpenAI (GPT)',
    needsApiKey: true,
    needsBaseUrl: false,
    defaultModel: 'gpt-4o-mini',
    modelOptions: ['gpt-4o-mini', 'gpt-4o', 'gpt-4.1', 'gpt-4.1-mini', 'o3-mini'],
    supportsVision: true,
    call: callOpenAI,
  },
  gemini: {
    label: 'Google Gemini',
    needsApiKey: true,
    needsBaseUrl: false,
    defaultModel: 'gemini-2.0-flash',
    modelOptions: [
      'gemini-2.0-flash',
      'gemini-1.5-pro',
      'gemini-1.5-flash',
      'gemini-2.5-pro',
    ],
    supportsVision: true,
    call: callGemini,
  },
  ollama: {
    label: 'Ollama (local)',
    needsApiKey: false,
    needsBaseUrl: true,
    defaultBaseUrl: 'http://localhost:11434',
    defaultModel: 'llama3.2',
    modelOptions: ['llama3.2', 'llama3.3', 'qwen2.5-coder:7b', 'llava', 'llama3.2-vision'],
    supportsVision: true, // model-dependent; user's responsibility
    call: callOllama,
  },
};

// Messaging — only 'getProviders' is handled here. Summarization goes through
// the long-lived `onConnect` port below so we can stream deltas back to the UI.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== 'getProviders') return false;
  const meta = {};
  for (const [key, p] of Object.entries(PROVIDERS)) {
    meta[key] = {
      label: p.label,
      needsApiKey: p.needsApiKey,
      needsBaseUrl: p.needsBaseUrl,
      defaultModel: p.defaultModel,
      defaultBaseUrl: p.defaultBaseUrl || '',
      modelOptions: p.modelOptions,
      supportsVision: p.supportsVision,
    };
  }
  sendResponse({ providers: meta });
  return false;
});

// Streaming: content script opens a long-lived port and posts a 'start' message.
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'summarize') return;
  let active = true;
  port.onDisconnect.addListener(() => { active = false; });

  port.onMessage.addListener(async (msg) => {
    if (msg?.type !== 'start') return;
    try {
      await summarize(msg, (chunk) => {
        if (active) port.postMessage({ type: 'chunk', text: chunk });
      }).then((result) => {
        if (active) {
          port.postMessage({ type: 'done', ...result });
          port.disconnect();
        }
      });
    } catch (e) {
      if (active) {
        port.postMessage({ type: 'error', message: e?.message || String(e) });
        port.disconnect();
      }
    }
  });
});

// ---------- Config storage with migration from v1.0.x shape ----------

async function getConfig() {
  const all = await chrome.storage.sync.get();
  if (all.apiKey && !all.activeProvider) {
    // Migrate old flat keys into new nested shape
    const migrated = {
      activeProvider: 'anthropic',
      providers: {
        anthropic: {
          apiKey: all.apiKey,
          model: all.model || PROVIDERS.anthropic.defaultModel,
        },
      },
      customPrompt: all.customPrompt || '',
      includeImages: false,
    };
    await chrome.storage.sync.set(migrated);
    await chrome.storage.sync.remove(['apiKey', 'model']);
    return migrated;
  }
  return {
    activeProvider: all.activeProvider || 'anthropic',
    providers: all.providers || {},
    customPrompt: all.customPrompt || '',
    includeImages: !!all.includeImages,
  };
}

// ---------- Dispatcher ----------

async function summarize({ transcript, title, channel, images = [] }, onDelta = null) {
  const cfg = await getConfig();
  const provider = PROVIDERS[cfg.activeProvider];
  if (!provider) throw new Error(`Unknown provider: ${cfg.activeProvider}`);

  const providerCfg = cfg.providers?.[cfg.activeProvider] || {};

  const MAX_CHARS = 500_000;
  const clipped =
    transcript.length > MAX_CHARS
      ? transcript.slice(0, MAX_CHARS) + '\n\n[Transcript truncated]'
      : transcript;

  const system = (cfg.customPrompt && cfg.customPrompt.trim()) || DEFAULT_PROMPT;

  let imageSection = '';
  if (images.length && cfg.includeImages) {
    const labels = images
      .map((img, i) => {
        const ts =
          typeof img.startSeconds === 'number'
            ? ` @ ${formatTime(img.startSeconds)}`
            : '';
        return `${i + 1}. ${img.label || 'thumbnail'}${ts}`;
      })
      .join('\n');
    imageSection = `\n\nImages attached (in order):\n${labels}\n`;
  }
  const userText = `Video title: "${title}"\nChannel: ${channel || 'unknown'}${imageSection}\nTranscript:\n${clipped}`;

  const effectiveImages = cfg.includeImages ? images : [];

  return provider.call(providerCfg, { system, userText, images: effectiveImages, onDelta });
}

function formatTime(s) {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60).toString().padStart(2, '0');
  return `${m}:${sec}`;
}

// ---------- Provider implementations (streaming) ----------
//
// All providers always request streaming responses from the API; `onDelta` is optional
// and only controls whether we forward tokens to the UI as they arrive. The returned
// object always contains the fully-accumulated summary so non-streaming callers still work.

// Per-stream idle timeout: if no chunk has arrived in this many ms, abort the fetch.
// Resets on every chunk/event; prevents hung streams from wedging the UI indefinitely.
const STREAM_IDLE_TIMEOUT_MS = 60_000;

function idleAbort(timeoutMs) {
  const controller = new AbortController();
  let timer = setTimeout(() => controller.abort(new DOMException('Idle timeout', 'AbortError')), timeoutMs);
  return {
    signal: controller.signal,
    reset() {
      clearTimeout(timer);
      timer = setTimeout(() => controller.abort(new DOMException('Idle timeout', 'AbortError')), timeoutMs);
    },
    cleanup() { clearTimeout(timer); },
  };
}

// Wraps a provider's streaming body in a uniform idle-timeout + error-translation layer.
async function withStreamTimeout(label, runStream) {
  const timer = idleAbort(STREAM_IDLE_TIMEOUT_MS);
  try {
    return await runStream(timer);
  } catch (e) {
    if (e?.name === 'AbortError') {
      throw new Error(`${label} stream stalled — no data for ${STREAM_IDLE_TIMEOUT_MS / 1000}s. Try again.`);
    }
    throw e;
  } finally {
    timer.cleanup();
  }
}

async function callAnthropic(cfg, { system, userText, images, onDelta }) {
  if (!cfg.apiKey) throw new Error('Anthropic API key not set.');
  const model = cfg.model || PROVIDERS.anthropic.defaultModel;

  const content = [
    ...images.map((img) => ({
      type: 'image',
      source: { type: 'base64', media_type: 'image/jpeg', data: img.base64 },
    })),
    { type: 'text', text: userText },
  ];

  return withStreamTimeout('Anthropic', async (t) => {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: t.signal,
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': cfg.apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({
        model,
        max_tokens: 1500,
        system,
        messages: [{ role: 'user', content }],
        stream: true,
      }),
    });
    if (!res.ok) throw await apiError(res, 'Anthropic');

    let summary = '';
    let usage = { input_tokens: 0, output_tokens: 0 };
    let finalModel = model;
    for await (const ev of sseEvents(res)) {
      t.reset();
      if (ev.type === 'message_start') {
        finalModel = ev.message?.model || finalModel;
        if (ev.message?.usage) usage.input_tokens = ev.message.usage.input_tokens || 0;
      } else if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
        const d = ev.delta.text || '';
        summary += d;
        if (onDelta && d) onDelta(d);
      } else if (ev.type === 'message_delta') {
        if (ev.usage?.output_tokens != null) usage.output_tokens = ev.usage.output_tokens;
      }
    }
    return { summary, usage, model: finalModel, provider: 'anthropic' };
  });
}

async function callOpenAI(cfg, { system, userText, images, onDelta }) {
  if (!cfg.apiKey) throw new Error('OpenAI API key not set.');
  const model = cfg.model || PROVIDERS.openai.defaultModel;

  const userContent = images.length
    ? [
        { type: 'text', text: userText },
        ...images.map((img) => ({
          type: 'image_url',
          image_url: { url: `data:image/jpeg;base64,${img.base64}` },
        })),
      ]
    : userText;

  return withStreamTimeout('OpenAI', async (t) => {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      signal: t.signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${cfg.apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: userContent },
        ],
        max_tokens: 1500,
        stream: true,
        stream_options: { include_usage: true },
      }),
    });
    if (!res.ok) throw await apiError(res, 'OpenAI');

    let summary = '';
    let usage = null;
    let finalModel = model;
    for await (const ev of sseEvents(res)) {
      t.reset();
      finalModel = ev.model || finalModel;
      const delta = ev.choices?.[0]?.delta?.content;
      if (delta) {
        summary += delta;
        if (onDelta) onDelta(delta);
      }
      if (ev.usage) {
        usage = {
          input_tokens: ev.usage.prompt_tokens,
          output_tokens: ev.usage.completion_tokens,
        };
      }
    }
    return { summary, usage, model: finalModel, provider: 'openai' };
  });
}

async function callGemini(cfg, { system, userText, images, onDelta }) {
  if (!cfg.apiKey) throw new Error('Gemini API key not set.');
  const model = cfg.model || PROVIDERS.gemini.defaultModel;

  const parts = [
    { text: userText },
    ...images.map((img) => ({
      inline_data: { mime_type: 'image/jpeg', data: img.base64 },
    })),
  ];

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
    model
  )}:streamGenerateContent?alt=sse&key=${encodeURIComponent(cfg.apiKey)}`;

  return withStreamTimeout('Gemini', async (t) => {
    const res = await fetch(url, {
      method: 'POST',
      signal: t.signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: 'user', parts }],
        generationConfig: { maxOutputTokens: 1500 },
      }),
    });
    if (!res.ok) throw await apiError(res, 'Gemini');

    let summary = '';
    let usage = null;
    for await (const ev of sseEvents(res)) {
      t.reset();
      const partsOut = ev.candidates?.[0]?.content?.parts || [];
      for (const p of partsOut) {
        const d = p.text || '';
        if (d) {
          summary += d;
          if (onDelta) onDelta(d);
        }
      }
      if (ev.usageMetadata) {
        usage = {
          input_tokens: ev.usageMetadata.promptTokenCount,
          output_tokens: ev.usageMetadata.candidatesTokenCount,
        };
      }
    }
    return { summary, usage, model, provider: 'gemini' };
  });
}

async function callOllama(cfg, { system, userText, images, onDelta }) {
  const baseUrl = (cfg.baseUrl || PROVIDERS.ollama.defaultBaseUrl).replace(/\/$/, '');
  const model = cfg.model || PROVIDERS.ollama.defaultModel;

  const userMessage = { role: 'user', content: userText };
  if (images.length) userMessage.images = images.map((i) => i.base64);

  return withStreamTimeout('Ollama', async (t) => {
    const res = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      signal: t.signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [{ role: 'system', content: system }, userMessage],
        stream: true,
      }),
    }).catch((e) => {
      if (e?.name === 'AbortError') throw e;
      throw new Error(
        `Ollama fetch failed: ${e.message}. Is Ollama running? Set OLLAMA_ORIGINS=chrome-extension://* and restart ollama serve.`
      );
    });
    if (!res.ok) throw await apiError(res, 'Ollama');

    let summary = '';
    let usage = null;
    let finalModel = model;
    for await (const chunk of ndjson(res)) {
      t.reset();
      finalModel = chunk.model || finalModel;
      const d = chunk.message?.content || '';
      if (d) {
        summary += d;
        if (onDelta) onDelta(d);
      }
      if (chunk.done) {
        if (chunk.prompt_eval_count || chunk.eval_count) {
          usage = {
            input_tokens: chunk.prompt_eval_count || 0,
            output_tokens: chunk.eval_count || 0,
          };
        }
      }
    }
    return { summary, usage, model: finalModel, provider: 'ollama' };
  });
}

async function apiError(res, label) {
  let msg = `${label} HTTP ${res.status}`;
  try {
    const body = await res.json();
    const detail = body?.error?.message || body?.error || body?.message;
    if (detail) msg += ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`;
  } catch {
    try {
      const t = await res.text();
      if (t) msg += ` — ${t.slice(0, 200)}`;
    } catch {}
  }
  return new Error(msg);
}
