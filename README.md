# Omni YouTube Summarizer

A Chrome extension that summarizes YouTube videos with your choice of LLM — **Claude, GPT, Gemini, or local Ollama**. Multi-modal: can attach chapter thumbnails alongside the transcript. No backend, no data collection — your API key stays in your browser.

[![CI](https://github.com/rupivbluegreen/omni-youtube-summarizer/actions/workflows/ci.yml/badge.svg)](https://github.com/rupivbluegreen/omni-youtube-summarizer/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/rupivbluegreen/omni-youtube-summarizer?sort=semver)](https://github.com/rupivbluegreen/omni-youtube-summarizer/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/rupivbluegreen/omni-youtube-summarizer/total)](https://github.com/rupivbluegreen/omni-youtube-summarizer/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Manifest V3](https://img.shields.io/badge/Manifest-V3-blue.svg)](https://developer.chrome.com/docs/extensions/mv3/intro/)
[![Providers](https://img.shields.io/badge/Providers-4-green.svg)](#providers)
[![Stars](https://img.shields.io/github/stars/rupivbluegreen/omni-youtube-summarizer?style=social)](https://github.com/rupivbluegreen/omni-youtube-summarizer/stargazers)

![Demo](store-assets/screenshots/demo.gif)
<sub>📽️ Drop a `demo.gif` into `store-assets/screenshots/` and this image will render. See [store-assets/screenshots/README.md](store-assets/screenshots/README.md) for recording tips.</sub>

## Features

- **BYO model** — pick one of: Anthropic Claude, OpenAI GPT, Google Gemini, or Ollama (local). Switch anytime in Settings.
- **Multi-modal** — optional: sends chapter thumbnails (or the main thumbnail) to vision-capable models for visually-grounded summaries.
- **Inline button** in YouTube's action row (next to Like / Share / Download).
- **Structured output**: TL;DR, Key Points, Takeaways — in a side panel.
- **Three fallback transcript-extraction strategies** (DOM scrape → innertube API → legacy URLs) to survive YouTube's frequent API changes.
- **Copy markdown · Regenerate · Close** directly from the panel.
- **Customizable system prompt** if you want a different output format.
- **Zero backend**: keys stored in `chrome.storage.sync`, requests go directly to the provider.

## Install

### From source

```bash
git clone https://github.com/rupivbluegreen/omni-youtube-summarizer.git
```

1. Open `chrome://extensions` → enable **Developer mode** (top right)
2. Click **Load unpacked** → select the `extension/` folder
3. Click the extension icon in the toolbar → **Settings**
4. Pick a provider, paste your API key (or configure Ollama), save

### From Chrome Web Store

Coming soon.

## Usage

Open any YouTube watch page. A **✨ Summarize** button appears in the action row. Click it. A side panel slides in with the summary.

Panel controls: `↻` regenerate · `⎘` copy markdown · `✕` close.

## Providers

| Provider | Get a key | Vision-capable | Notes |
|---|---|---|---|
| **Anthropic** (Claude) | [console.anthropic.com](https://console.anthropic.com/settings/keys) | Yes (all models) | Default. Haiku 4.5 is fastest/cheapest. |
| **OpenAI** (GPT) | [platform.openai.com](https://platform.openai.com/api-keys) | Yes (GPT-4o family) | GPT-4o-mini is a solid default. |
| **Google Gemini** | [aistudio.google.com/apikey](https://aistudio.google.com/apikey) | Yes (all recent) | Gemini 2.0 Flash is fast and free-tier friendly. |
| **Ollama** (local) | — | Depends on model (e.g., `llava`, `llama3.2-vision`) | Requires `OLLAMA_ORIGINS=chrome-extension://*` set before `ollama serve`. |

### Ollama setup

Ollama blocks cross-origin requests by default. To let the extension talk to it:

```bash
# macOS / Linux
export OLLAMA_ORIGINS='chrome-extension://*'
ollama serve

# or permanent on macOS
launchctl setenv OLLAMA_ORIGINS 'chrome-extension://*'
```

Then in Settings, pick "Ollama (local)", set base URL to `http://localhost:11434`, and a model you've pulled (`ollama pull llama3.2`).

## Multi-modal

Toggle "Include video thumbnails" in Settings. When on:

- If the video has **chapters**, each chapter's thumbnail is attached (up to 10) with the chapter's title and start time.
- Otherwise, the video's main thumbnail (`maxresdefault.jpg`) is attached.

All images are base64-encoded JPEGs. The provider call includes them in its native image format (Anthropic `type: image`, OpenAI `image_url`, Gemini `inline_data`, Ollama `images[]`). Your model must be vision-capable.

## How it works

### Transcript extraction

Three methods, tried in order:

1. **DOM scrape** — programmatically clicks YouTube's "Show transcript" button, observes rendered `<ytd-transcript-segment-renderer>` nodes via `MutationObserver`, reads text from `.segment-text`. Auto-closes the panel.
2. **Innertube API** — POSTs to `/youtubei/v1/get_transcript` with `INNERTUBE_API_KEY`, `visitorData`, and the transcript `params` token extracted from `ytInitialData.engagementPanels`.
3. **Legacy caption URLs** — fetches `baseUrl` from `ytInitialPlayerResponse.captions…captionTracks` with `fmt=json3`, falls back to XML parsed by `DOMParser`.

### Summarization

Request body is built per provider. The service worker's dispatcher routes to the provider's `call()` function, which handles the API-specific shape and returns a normalized `{summary, usage, model, provider}`.

### Storage

Schema (in `chrome.storage.sync`):

```js
{
  activeProvider: 'anthropic' | 'openai' | 'gemini' | 'ollama',
  providers: {
    anthropic: { apiKey, model },
    openai:    { apiKey, model },
    gemini:    { apiKey, model },
    ollama:    { baseUrl, model },
  },
  customPrompt: string,
  includeImages: boolean,
}
```

v1.0.x users are auto-migrated on first load.

## Privacy

- API keys are stored in `chrome.storage.sync` (synced with your Chrome profile).
- Transcripts and thumbnails are sent only to the provider you've selected — nothing goes to the extension author.
- No telemetry, no analytics, no data collection by this extension.
- See [PRIVACY.md](PRIVACY.md) for the full policy.

## Development

No build step. Plain JS/CSS/HTML. Edit files under `extension/`, reload the extension card in `chrome://extensions`, reload the YouTube tab.

Syntax-check + tests before committing:

```bash
for f in extension/lib/parsers.js extension/background.js extension/content.js extension/options.js extension/popup.js; do node --check $f; done
python3 -c "import json; json.load(open('extension/manifest.json'))"
node --test tests/
```

## Contributing

PRs welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) and the [good first issues](https://github.com/rupivbluegreen/omni-youtube-summarizer/issues?q=is%3Aopen+label%3A%22good+first+issue%22).

## Contributors

<table>
  <tr>
    <td align="center">
      <a href="https://github.com/rupivbluegreen">
        <img src="https://github.com/rupivbluegreen.png" width="80" alt="rupivbluegreen"><br>
        <sub><b>rupivbluegreen</b></sub>
      </a><br>
      <sub>Maintainer</sub>
    </td>
    <td align="center">
      <a href="https://claude.com/claude-code">
        <img src="https://avatars.githubusercontent.com/u/186046598?s=200" width="80" alt="Claude"><br>
        <sub><b>Claude</b></sub>
      </a><br>
      <sub>AI pair-programmer<br>(see commit co-authorship)</sub>
    </td>
  </tr>
</table>

From v1.2.1 onward, commits written with [Claude Code](https://claude.com/claude-code) assistance include a `Co-Authored-By: Claude …` trailer — searchable via `git log --grep "Co-Authored-By: Claude"`.

## License

MIT. See [LICENSE](LICENSE).

## Changelog

See [CHANGELOG.md](CHANGELOG.md).
