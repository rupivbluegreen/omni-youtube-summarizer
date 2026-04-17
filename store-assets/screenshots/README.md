# Screenshots

Drop your Chrome Web Store screenshots here before submitting.

## Required dimensions

- **1280×800** (preferred) or **640×400**
- PNG or JPG, max 16 MB each
- 1 to 5 screenshots

## Recommended shots (in order)

1. `01-button-in-action-row.png` — crop of the YouTube action row with the ✨ Summarize button next to Like/Share/Save/Download.
2. `02-summary-panel.png` — side panel open on a watch page, showing a real TL;DR / Key Points / Takeaways summary.
3. `03-options-page.png` — Settings page with model selector visible. **Blur or redact the API key field.**
4. `04-popup.png` (optional) — extension toolbar popup showing the "Ready" status.

## Taking the screenshots

macOS: `Cmd+Shift+4` then drag. Save as PNG.
Windows: Win+Shift+S.
Chrome DevTools: Open DevTools → ⋮ menu → Run command → "Capture full size screenshot" (for the options page).

## Promotional images (optional)

- `promo-440x280.png` — small tile shown in search results
- `promo-920x680.png` — large tile
- `promo-marquee-1400x560.png` — marquee for featured placements

## Demo GIF for the README

The top of `README.md` references `store-assets/screenshots/demo.gif`. Drop a short (5–12 s) recording there and it'll render automatically.

Recording:

- macOS: QuickTime → File → New Screen Recording. Crop in Finder/Preview.
- Linux: `peek`, `kooha`, or `byzanz-record` — all record a window to GIF.
- Convert MP4 → GIF with ffmpeg:
  ```bash
  ffmpeg -i demo.mp4 -vf "fps=15,scale=900:-1:flags=lanczos" -loop 0 demo.gif
  ```

Keep it under ~5 MB so GitHub embeds reliably. Show: watch page → click ✨ Summarize → panel slides in with result.
