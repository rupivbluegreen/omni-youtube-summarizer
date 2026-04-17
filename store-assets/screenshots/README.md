# Screenshots

Current assets (used by README, GitHub Pages site, and Chrome Web Store listing):

- `demo.gif` — top-of-README animated demo.
- `screenshot-1-hero.png` — product overview / hero shot.
- `screenshot-2-summary.png` — side panel open on a real video.
- `screenshot-3-byom.png` — Settings page showing the provider dropdown.

## Chrome Web Store dimensions

- **1280×800** (preferred) or **640×400**
- PNG or JPG, max 16 MB each
- 1 to 5 screenshots

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
