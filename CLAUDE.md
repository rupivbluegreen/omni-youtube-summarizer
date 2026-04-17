# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Chrome Manifest V3 extension that summarizes YouTube videos. Multi-provider (Anthropic / OpenAI / Gemini / Ollama), optional multi-modal (chapter thumbnails), vanilla JS, zero build step. User-facing docs are `README.md`.

## Priority task: push this repo to GitHub

This directory is **not yet a git repo** (no `.git` dir). First time setup:

**Prerequisites:**
```bash
git --version
gh --version     # optional but preferred
gh auth status   # verify if gh is installed
```

### Path A — `gh` CLI available and authenticated

```bash
git init -b main
git add .
git commit -m "Initial commit: omni-youtube-summarizer v1.1.0"

gh repo create omni-youtube-summarizer \
  --public \
  --source=. \
  --remote=origin \
  --push \
  --description "Chrome extension: summarize YouTube videos with Claude, GPT, Gemini, or Ollama"
```

### Path B — no `gh` CLI, manual remote

1. Ask the user their GitHub username.
2. Have them create an **empty** public repo at https://github.com/new named `omni-youtube-summarizer` (no README, no .gitignore, no LICENSE — empty, so the push is clean).
3. Then:
   ```bash
   git init -b main
   git add .
   git commit -m "Initial commit: omni-youtube-summarizer v1.1.0"
   git remote add origin https://github.com/<USERNAME>/omni-youtube-summarizer.git
   git push -u origin main
   ```

### After the first push — fix placeholders

Four files contain `YOUR_USERNAME`: `README.md`, `PRIVACY.md`, `extension/manifest.json` (`homepage_url`), `store-assets/listing.md`.

```bash
sed -i.bak "s/YOUR_USERNAME/<actual-username>/g" \
  README.md PRIVACY.md extension/manifest.json store-assets/listing.md
rm *.bak extension/*.bak store-assets/*.bak 2>/dev/null

git add -A
git commit -m "Fix GitHub username in links"
git push
```

## Architecture

Two JS files carry almost all the logic. Understand both before editing either.

### `extension/background.js` — service worker, provider dispatcher

- Central `PROVIDERS` registry (one entry per provider) declares `label`, `needsApiKey` / `needsBaseUrl`, `defaultModel`, `modelOptions`, `supportsVision`, and a `call()` function. Adding a new provider = adding one entry plus one `callXxx()` function; options page picks up `modelOptions` and conditional fields from `getProviders` message automatically.
- `summarize()` is the single dispatcher: loads config, truncates transcript to 500k chars, composes `system` + `userText`, forwards to the active provider's `call()`. Each `call()` is responsible for shaping the request to its provider's native format (Anthropic `type: image`, OpenAI `image_url`, Gemini `inline_data`, Ollama `images[]`) and returning the normalized `{summary, usage, model, provider}`.
- `getConfig()` performs one-shot migration from v1.0.x flat keys (`apiKey`, `model`) into the nested v1.1 shape (`activeProvider`, `providers.{name}.{apiKey|baseUrl|model}`). Preserve this migration until v1.0.x users are fully washed out.
- Errors from providers go through `apiError()` which extracts `body.error.message` when available — keep user-visible strings short and actionable.

### `extension/content.js` — injected into YouTube watch pages

- **Transcript extraction (`getTranscript`) uses three strategies in order** — each method is load-bearing because YouTube breaks the others periodically:
  1. **DOM scrape** (preferred) — find & click YouTube's own "Show transcript" button, wait via `MutationObserver` for `ytd-transcript-segment-renderer` nodes, read `.segment-text`, then close the panel. Uses YouTube's own auth, so it bypasses every token/signature issue.
  2. **Innertube** — POST to `/youtubei/v1/get_transcript` with `INNERTUBE_API_KEY`, `VISITOR_DATA`, `X-Goog-Visitor-Id`, and the transcript `params` token found by walking `ytInitialData.engagementPanels`. `extractTranscriptTexts` handles both `transcriptSegmentRenderer` (new) and `transcriptCueRenderer` (older) shapes.
  3. **Legacy caption URLs** — parse `ytInitialPlayerResponse.captions…captionTracks`, fetch `baseUrl` with `fmt=json3`, fall back to XML via `DOMParser`. Usually empty now, kept as last resort.
- `sliceBalancedJson()` is used for extracting `ytInitialData` / `ytInitialPlayerResponse` — it walks characters tracking brace depth and string escapes. **Do not** replace it with a regex; nested braces in YouTube's JSON broke that in the past.
- **Image pipeline (`getImages`)** — if the video has chapters (`markersMap` keyed `DESCRIPTION_CHAPTERS` or `AUTO_CHAPTERS`), fetch up to 10 chapter thumbnails with their titles and start times. Otherwise fall back to `maxresdefault.jpg` → `hqdefault.jpg`. All images are base64-encoded JPEGs sent to the provider only if `includeImages` is on in settings.
- **Button injection** tries a list of 8 action-row selectors covering current YouTube layouts. If none match within ~5 s, falls back to a floating button so the user always has an entry point.
- **SPA navigation** — listens on `yt-navigate-finish` and polls `location.href` every 500 ms. Button + panel are cleared and re-injected on every video change.
- `renderMarkdown()` is a deliberately tiny renderer that **escapes first, then applies transforms** — safe against XSS from model output. Do not replace with a library.

### Storage schema (`chrome.storage.sync`)

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

## Development

No build step. Edit `extension/` files directly, reload the extension in `chrome://extensions`, reload the YouTube tab.

Syntax-check before committing:

```bash
node --check extension/background.js
node --check extension/content.js
node --check extension/options.js
node --check extension/popup.js
python3 -c "import json; json.load(open('extension/manifest.json'))"
```

## Cut a new release

1. Bump `version` in `extension/manifest.json` (semver).
2. Add a `## [X.Y.Z] - YYYY-MM-DD` section at the top of `CHANGELOG.md`.
3. Commit, tag, push:
   ```bash
   VERSION=1.1.1
   git commit -am "Release v${VERSION}"
   git tag "v${VERSION}"
   git push && git push --tags
   ```
4. Build the Chrome Web Store zip (ship only the contents of `extension/`):
   ```bash
   cd extension
   zip -r "../omni-youtube-summarizer-v${VERSION}.zip" . -x '.DS_Store' -x '*.bak'
   cd ..
   ```
5. GitHub release + Web Store upload:
   ```bash
   gh release create "v${VERSION}" "omni-youtube-summarizer-v${VERSION}.zip" \
     --title "v${VERSION}" --notes "See CHANGELOG.md"
   ```
   Then upload the same zip at https://chrome.google.com/webstore/devconsole (1–3 business day review).

## Code conventions

- Vanilla JS, 2-space indent, no framework, no bundler, no minifier (Chrome Web Store reviewers read the source).
- Console logs go through `log(...)` in `content.js` which prefixes `[YT Summarizer]`.
- User-visible errors: short, actionable strings.
- Keep `manifest.json` `permissions` / `host_permissions` minimal — every addition extends the Web Store review. Current set: `storage` + hosts for `www.youtube.com`, `i.ytimg.com`, the four provider APIs, and `localhost`/`127.0.0.1` (Ollama).

## Do not

- Do not add `<all_urls>`, `tabs`, or `scripting` permissions unless strictly required.
- Do not bundle or minify.
- Do not add analytics, telemetry, or error-reporting services — the privacy promise in `PRIVACY.md` is absolute.
- Do not embed API keys or secrets anywhere in the repo.
- Do not replace `sliceBalancedJson` with a regex, or `renderMarkdown` with a library (see architecture notes).
