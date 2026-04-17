# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.1.0] - 2026-04-17

### Added
- **Bring Your Own Model (BYOM)** — support for four providers, switchable per user in Settings:
  - Anthropic (Claude)
  - OpenAI (GPT)
  - Google Gemini
  - Ollama (local)
- **Multi-modal** — optional toggle to send video thumbnails alongside the transcript. Uses chapter thumbnails (one per chapter, up to 10) if the video has chapters, otherwise the main `maxresdefault.jpg`. Requires a vision-capable model on the selected provider.
- Provider registry in `background.js` with per-provider request/response translators.
- Automatic storage migration from v1.0.x flat keys (`apiKey`, `model`) to the new nested shape (`activeProvider`, `providers.{name}.*`).
- Per-provider model presets plus a custom model input.
- Panel footer now shows provider + model + token usage.

### Changed
- Options page redesigned for the provider dropdown with conditional fields.
- `manifest.json` `host_permissions` expanded for new providers: `api.openai.com`, `generativelanguage.googleapis.com`, `localhost`, `127.0.0.1`, and `i.ytimg.com` for thumbnails.

### Notes
- Ollama requires setting `OLLAMA_ORIGINS=chrome-extension://*` before `ollama serve` to allow CORS from the extension.

## [1.0.4] - 2026-04-17

### Added
- **DOM-scrape primary transcript method**: programmatically clicks YouTube's "Show transcript" button and reads rendered segments via `MutationObserver`. Uses YouTube's own auth — bypasses all token/signature issues. Auto-closes the panel when done.
- `VISITOR_DATA` extraction and `X-Goog-Visitor-Id` header for innertube requests.
- Detailed response-body logging on innertube 4xx/5xx errors.

### Changed
- Method order: DOM scrape → innertube → legacy baseUrl (json3 → XML).

## [1.0.3] - 2026-04-17

### Added
- Innertube `/youtubei/v1/get_transcript` as primary transcript method — uses YouTube's internal API rather than public caption URLs.
- Recursive walker for innertube response that handles both `transcriptSegmentRenderer` (new) and `transcriptCueRenderer` (older) shapes.

## [1.0.2] - 2026-04-17

### Added
- XML + `DOMParser` fallback when `fmt=json3` returns empty.
- Balanced-brace JSON extractor for `ytInitialPlayerResponse` (replaces fragile non-greedy regex that could stop short inside nested objects).

### Fixed
- "Failed to execute 'json' on 'Response'" error when caption URL returned empty body.

## [1.0.1] - 2026-04-17

### Added
- Floating red button fallback when YouTube's action row cannot be located.
- `[YT Summarizer]` console logging for diagnostics.
- Multiple selector strategies for the action row (8 variants covering current YouTube layouts).

### Changed
- Retry window extended for action-row detection.

## [1.0.0] - 2026-04-17

### Added
- Initial release.
- Manifest V3 Chrome extension.
- Inline "Summarize" button in YouTube action row.
- Side panel with TL;DR, Key Points, Takeaways.
- Model selection: Haiku 4.5 (default), Sonnet 4.6, Opus 4.7.
- Configurable system prompt.
- Copy-as-markdown and regenerate actions.
