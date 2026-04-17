const status = document.getElementById('status');
const opt = document.getElementById('opt');

chrome.storage.sync.get().then((all) => {
  const activeProvider = all.activeProvider || (all.apiKey ? 'anthropic' : null);
  const providerCfg = all.providers?.[activeProvider] || {};

  // Backward-compat read for v1.0.x storage
  const hasAnthropicKey = providerCfg.apiKey || all.apiKey;

  const hasCreds = (() => {
    if (!activeProvider) return false;
    if (activeProvider === 'anthropic') return !!hasAnthropicKey;
    if (activeProvider === 'openai' || activeProvider === 'gemini') return !!providerCfg.apiKey;
    if (activeProvider === 'ollama') return true; // baseUrl has a default
    return false;
  })();

  if (!activeProvider || !hasCreds) {
    status.className = 'status warn';
    status.textContent = '⚠ Not configured — open Settings.';
  } else {
    const label =
      activeProvider === 'anthropic'
        ? 'Anthropic'
        : activeProvider === 'openai'
        ? 'OpenAI'
        : activeProvider === 'gemini'
        ? 'Gemini'
        : 'Ollama';
    const model = providerCfg.model || all.model || '';
    status.className = 'status ok';
    status.textContent = `✓ Ready · ${label}${model ? ' / ' + model : ''}`;
  }
});

opt.addEventListener('click', () => chrome.runtime.openOptionsPage());
