# Chrome Web Store Listing

Copy the fields below into the Chrome Web Store developer console at [chrome.google.com/webstore/devconsole](https://chrome.google.com/webstore/devconsole).

---

## Title

```
Omni YouTube Summarizer
```

## Summary (132 character max — shown in search results)

```
Summarize YouTube videos with Claude. TL;DR, key points, takeaways. Bring your own Anthropic API key. No backend, no tracking.
```

## Description (plain text — Markdown is not rendered)

```
Summarize any YouTube video with Claude, without leaving the page.

HOW IT WORKS
Click the Summarize button added to YouTube's action row (next to Like, Share, Save, Download). A side panel slides in with a structured summary: TL;DR, key points, and takeaways. Copy as markdown, regenerate, or close.

WHY IT'S DIFFERENT
• No backend. Your Anthropic API key stays in your browser. Transcripts go directly to api.anthropic.com. Nothing is logged by this extension.
• No subscription. Bring your own API key, pay Anthropic's standard per-token rates. A typical video with Haiku 4.5 costs a fraction of a cent.
• Three transcript strategies (DOM scrape, YouTube's internal API, legacy caption URLs) for reliability across YouTube's frequent API changes.
• Model choice: Claude Haiku 4.5 (fast, cheap), Sonnet 4.6 (balanced), or Opus 4.7 (best quality).
• Open source. Code at github.com/rupivbluegreen/omni-youtube-summarizer (MIT license).
• Customizable system prompt if you want summaries in a specific style.

SETUP (one-time)
1. Install the extension.
2. Click the toolbar icon → Settings.
3. Paste your Anthropic API key (get one at console.anthropic.com/settings/keys).
4. Pick a model. Haiku 4.5 is the default.

Click Summarize on any YouTube video with captions.

LIMITATIONS
• Requires captions (manual or auto-generated).
• Transcript-only — purely visual content without narration can't be summarized.

PRIVACY
• No data collection by this extension.
• Your API key is stored in Chrome's synced storage (local + Google sync).
• Transcripts and video titles are sent only to api.anthropic.com.
Full privacy policy: github.com/rupivbluegreen/omni-youtube-summarizer/blob/main/PRIVACY.md

SOURCE CODE
github.com/rupivbluegreen/omni-youtube-summarizer
```

## Category

```
Productivity
```

## Language

```
English (United States)
```

---

## Screenshots (required — upload 1 to 5)

Take these on a real YouTube watch page. Required dimensions: **1280×800** or **640×400** (PNG or JPG).

Suggested shots:

1. **Summarize button in the action row** — crop showing Like/Share/Save/Download + the ✨ Summarize button.
2. **Summary panel open** — side panel showing a real TL;DR / Key Points / Takeaways summary on a video.
3. **Options page** — model selector + API key field (blur the key).
4. (Optional) Copy markdown UX — hover state with the `⎘` tooltip showing.

Save them as PNG into `store-assets/screenshots/` in the repo.

## Promotional images (optional but recommended)

- Small promo tile: **440×280** PNG/JPG
- Large promo tile: **920×680** PNG/JPG
- Marquee: **1400×560** PNG/JPG

## Privacy practices section

When filling out the "Privacy practices" form in the Chrome Web Store console, the answers are:

- **Single purpose:** "Summarize YouTube videos using the Anthropic Claude API."
- **Permission justifications:**
  - `storage` → "Store the user's Anthropic API key, model selection, and custom system prompt locally, synced with their Chrome profile."
  - Host permission `https://www.youtube.com/*` → "The content script runs on YouTube watch pages to inject the Summarize button, extract the video's transcript, and render the summary panel."
  - Host permission `https://api.anthropic.com/*` → "The service worker calls the Anthropic Messages API to generate the summary."
- **Remote code:** No.
- **Data usage disclosures:**
  - "Personally identifiable information": No.
  - "Health information": No.
  - "Financial and payment information": No.
  - "Authentication information": **Yes** — user's Anthropic API key stored locally and transmitted to api.anthropic.com only.
  - "Personal communications": No.
  - "Location": No.
  - "Web history": No.
  - "User activity": No.
  - "Website content": **Yes** — YouTube video transcripts are read from the current page and sent to Anthropic for summarization.

- **Certifications:**
  - ✅ I do not sell or transfer user data to third parties, outside of the approved use cases.
  - ✅ I do not use or transfer user data for purposes unrelated to my item's single purpose.
  - ✅ I do not use or transfer user data to determine creditworthiness or for lending purposes.

- **Privacy policy URL:**
  ```
  https://github.com/rupivbluegreen/omni-youtube-summarizer/blob/main/PRIVACY.md
  ```

## Pricing

Free.

## Distribution

Public. All regions.

---

## Review notes

First-time submissions usually take 1–3 business days. Common rejection reasons for extensions like this:

- **Vague permission justifications** — the ones above are specific enough to pass.
- **Privacy policy not reachable** — make sure PRIVACY.md is pushed to GitHub before submitting.
- **Screenshots with irrelevant content** — keep them focused on the extension's UI, not full YouTube pages.

If rejected, the console shows the specific policy clause. Fix and resubmit.
