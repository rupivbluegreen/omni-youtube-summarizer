# Contributing

Thanks for your interest in improving Omni YouTube Summarizer.

## Setup

```bash
git clone https://github.com/YOUR_USERNAME/omni-youtube-summarizer.git
cd omni-youtube-summarizer
```

Load `extension/` via `chrome://extensions` → Developer mode → **Load unpacked**.

No build step, no dependencies. Edit, reload the extension card, reload the YouTube tab.

## Code style

- Vanilla JavaScript, no framework, no transpiler.
- 2-space indentation.
- Keep `manifest.json` permissions minimal — adding broader permissions triggers a longer Chrome Web Store review.
- Prefix console logs with `[YT Summarizer]`.
- Prefer structured error messages (`throw new Error('specific reason')`) over generic ones.

## Testing checklist before opening a PR

- [ ] Watch page with English captions → summary appears
- [ ] Watch page without captions → clean error ("No captions available")
- [ ] Non-English captions → still produces a summary
- [ ] Options page → API key persists, model selection persists
- [ ] Popup → shows ready state when key is set, warn state when not
- [ ] No console errors beyond the expected `[YT Summarizer]` logs
- [ ] SPA navigation: open a video → navigate to another video → Summarize button is re-injected

## PR checklist

1. Bump `extension/manifest.json` `version` (semver: patch for fixes, minor for features, major for breaking changes).
2. Update `CHANGELOG.md` with the change.
3. Describe what you changed and why.
4. Keep diffs focused — one topic per PR.

## Areas of interest

- Transcript caching to avoid re-calls
- Streaming rendering (SSE)
- Non-English video support
- Alternative transcript sources (yt-dlp-style, third-party APIs)
- Accessibility (ARIA labels on panel, keyboard navigation)
- Dark/light theme detection for the panel
