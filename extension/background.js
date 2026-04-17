// background.js — service worker. Multi-provider LLM dispatcher with optional image input.

const DEFAULT_PROMPT = `You are summarizing a YouTube video transcript. Produce a concise, high-signal summary.

Output format (markdown):

## TL;DR
2-3 sentences capturing the essence.

## Key Points
- 5-8 bullets with the most important ideas, claims, or moments
- Include specific numbers, names, and examples when present
- Lead with the insight, not the buildup

## Takeaways
Brief paragraph on what to remember or act on.

Rules:
- Prefer substance. Don't say "the speaker discusses X" — state what was said.
- If it's a how-to, extract the actual steps.
- If it's an opinion piece, extract the argument structure.
- If images are provided, they are chapter thumbnails or a main thumbnail; reference them only when they add signal.
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

// Messaging
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'getProviders') {
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
  }

  if (msg?.type === 'summarize') {
    summarize(msg)
      .then(sendResponse)
      .catch((e) => sendResponse({ error: e?.message || String(e) }));
    return true; // async
  }
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

async function summarize({ transcript, title, channel, images = [] }) {
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

  return provider.call(providerCfg, { system, userText, images: effectiveImages });
}

function formatTime(s) {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60).toString().padStart(2, '0');
  return `${m}:${sec}`;
}

// ---------- Provider implementations ----------

async function callAnthropic(cfg, { system, userText, images }) {
  if (!cfg.apiKey) throw new Error('Anthropic API key not set.');
  const model = cfg.model || PROVIDERS.anthropic.defaultModel;

  const content = [
    ...images.map((img) => ({
      type: 'image',
      source: { type: 'base64', media_type: 'image/jpeg', data: img.base64 },
    })),
    { type: 'text', text: userText },
  ];

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
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
    }),
  });
  if (!res.ok) throw await apiError(res, 'Anthropic');
  const data = await res.json();
  const text = (data.content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
  return { summary: text, usage: data.usage, model: data.model, provider: 'anthropic' };
}

async function callOpenAI(cfg, { system, userText, images }) {
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

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
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
    }),
  });
  if (!res.ok) throw await apiError(res, 'OpenAI');
  const data = await res.json();
  return {
    summary: data.choices?.[0]?.message?.content || '',
    usage: data.usage
      ? { input_tokens: data.usage.prompt_tokens, output_tokens: data.usage.completion_tokens }
      : null,
    model: data.model,
    provider: 'openai',
  };
}

async function callGemini(cfg, { system, userText, images }) {
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
  )}:generateContent?key=${encodeURIComponent(cfg.apiKey)}`;

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: 'user', parts }],
      generationConfig: { maxOutputTokens: 1500 },
    }),
  });
  if (!res.ok) throw await apiError(res, 'Gemini');
  const data = await res.json();
  const text = (data.candidates?.[0]?.content?.parts || [])
    .map((p) => p.text || '')
    .join('');
  return {
    summary: text,
    usage: data.usageMetadata
      ? {
          input_tokens: data.usageMetadata.promptTokenCount,
          output_tokens: data.usageMetadata.candidatesTokenCount,
        }
      : null,
    model,
    provider: 'gemini',
  };
}

async function callOllama(cfg, { system, userText, images }) {
  const baseUrl = (cfg.baseUrl || PROVIDERS.ollama.defaultBaseUrl).replace(/\/$/, '');
  const model = cfg.model || PROVIDERS.ollama.defaultModel;

  const userMessage = { role: 'user', content: userText };
  if (images.length) userMessage.images = images.map((i) => i.base64);

  const res = await fetch(`${baseUrl}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [{ role: 'system', content: system }, userMessage],
      stream: false,
    }),
  }).catch((e) => {
    throw new Error(
      `Ollama fetch failed: ${e.message}. Is Ollama running? Set OLLAMA_ORIGINS=chrome-extension://* and restart ollama serve.`
    );
  });
  if (!res.ok) throw await apiError(res, 'Ollama');
  const data = await res.json();
  return {
    summary: data.message?.content || '',
    usage:
      data.prompt_eval_count || data.eval_count
        ? { input_tokens: data.prompt_eval_count || 0, output_tokens: data.eval_count || 0 }
        : null,
    model: data.model,
    provider: 'ollama',
  };
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
