const $ = (id) => document.getElementById(id);

let PROVIDERS = {};
let currentConfig = null;

const HINTS = {
  anthropic: {
    provider: 'Claude models. Requires API key from console.anthropic.com.',
    apiKey: 'Your Anthropic API key. Starts with sk-ant-.',
  },
  openai: {
    provider: 'GPT models. Requires API key from platform.openai.com.',
    apiKey: 'Your OpenAI API key. Starts with sk-.',
  },
  gemini: {
    provider: 'Google Gemini models. Get a key at aistudio.google.com/apikey.',
    apiKey: 'Your Google AI Studio API key.',
  },
  ollama: {
    provider:
      'Run models locally via Ollama. You must start Ollama with OLLAMA_ORIGINS=chrome-extension://* set (otherwise CORS will block requests).',
    baseUrl: 'Where your Ollama server is running. Default: http://localhost:11434.',
  },
};

async function loadProviders() {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'getProviders' }, (response) => {
      resolve(response?.providers || {});
    });
  });
}

async function loadConfig() {
  const all = await chrome.storage.sync.get();
  return {
    activeProvider: all.activeProvider || 'anthropic',
    providers: all.providers || {},
    customPrompt: all.customPrompt || '',
    includeImages: !!all.includeImages,
  };
}

function populateProviderSelect() {
  const sel = $('provider');
  sel.innerHTML = '';
  for (const [key, p] of Object.entries(PROVIDERS)) {
    const opt = document.createElement('option');
    opt.value = key;
    opt.textContent = p.label;
    sel.appendChild(opt);
  }
}

function populateModelSelect(providerKey) {
  const sel = $('modelPreset');
  sel.innerHTML = '';
  const models = PROVIDERS[providerKey]?.modelOptions || [];
  for (const m of models) {
    const opt = document.createElement('option');
    opt.value = m;
    opt.textContent = m;
    sel.appendChild(opt);
  }
  const opt = document.createElement('option');
  opt.value = '__custom';
  opt.textContent = '— custom —';
  sel.appendChild(opt);
}

function renderFieldsForProvider(providerKey) {
  const p = PROVIDERS[providerKey];
  if (!p) return;

  $('providerHint').textContent = HINTS[providerKey]?.provider || '';

  // API key field
  $('field-apiKey').style.display = p.needsApiKey ? 'block' : 'none';
  $('apiKeyHint').textContent = HINTS[providerKey]?.apiKey || '';

  // Base URL field
  $('field-baseUrl').style.display = p.needsBaseUrl ? 'block' : 'none';
  $('baseUrlHint').textContent = HINTS[providerKey]?.baseUrl || '';
  if (p.needsBaseUrl) {
    $('baseUrl').placeholder = p.defaultBaseUrl || '';
  }

  populateModelSelect(providerKey);
}

function loadProviderValues(providerKey, cfg) {
  const pCfg = cfg.providers?.[providerKey] || {};
  const p = PROVIDERS[providerKey];

  $('apiKey').value = pCfg.apiKey || '';
  $('baseUrl').value = pCfg.baseUrl || '';

  const model = pCfg.model || p.defaultModel || '';
  if (p.modelOptions.includes(model)) {
    $('modelPreset').value = model;
    $('modelCustom').value = '';
  } else if (model) {
    $('modelPreset').value = '__custom';
    $('modelCustom').value = model;
  } else {
    $('modelPreset').value = p.modelOptions[0] || '__custom';
    $('modelCustom').value = '';
  }
}

function readCurrentModel() {
  const preset = $('modelPreset').value;
  if (preset && preset !== '__custom') return preset;
  return $('modelCustom').value.trim();
}

async function save() {
  const activeProvider = $('provider').value;
  const p = PROVIDERS[activeProvider];

  const providerData = {};
  if (p.needsApiKey) providerData.apiKey = $('apiKey').value.trim();
  if (p.needsBaseUrl) providerData.baseUrl = $('baseUrl').value.trim() || p.defaultBaseUrl;
  providerData.model = readCurrentModel() || p.defaultModel;

  const allProviders = currentConfig.providers || {};
  allProviders[activeProvider] = providerData;

  const newConfig = {
    activeProvider,
    providers: allProviders,
    customPrompt: $('customPrompt').value.trim(),
    includeImages: $('includeImages').checked,
  };

  await chrome.storage.sync.set(newConfig);
  // Clean up old v1.0.x flat keys if still present
  await chrome.storage.sync.remove(['apiKey', 'model']);
  currentConfig = newConfig;

  const status = $('status');
  status.textContent = 'Saved';
  setTimeout(() => (status.textContent = ''), 1500);
}

async function init() {
  PROVIDERS = await loadProviders();
  currentConfig = await loadConfig();

  populateProviderSelect();

  $('provider').value = currentConfig.activeProvider;
  renderFieldsForProvider(currentConfig.activeProvider);
  loadProviderValues(currentConfig.activeProvider, currentConfig);

  $('customPrompt').value = currentConfig.customPrompt || '';
  $('includeImages').checked = !!currentConfig.includeImages;

  $('provider').addEventListener('change', (e) => {
    const key = e.target.value;
    renderFieldsForProvider(key);
    loadProviderValues(key, currentConfig);
  });

  $('modelPreset').addEventListener('change', (e) => {
    if (e.target.value === '__custom') {
      $('modelCustom').focus();
    } else {
      $('modelCustom').value = '';
    }
  });

  $('save').addEventListener('click', save);
  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 's') {
      e.preventDefault();
      save();
    }
  });
}

init();
