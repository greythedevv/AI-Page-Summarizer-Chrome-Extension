# PageMind — AI Page Summarizer

> A Chrome Extension that extracts meaningful content from any webpage and delivers structured AI summaries — bullet points, key insights, reading time, and in-page highlights.

---

## Features

- **Smart content extraction** — heuristic scoring avoids nav/footer clutter, prefers article body
- **AI-powered summaries** — bullet points, key insights, overview, reading time, sentiment
- **In-page highlighting** — marks key phrases directly on the page
- **Multi-provider AI support** — OpenAI, Anthropic (Claude), Google Gemini
- **Summary caching** — avoids duplicate API calls per URL (1-hour TTL)
- **Three summary modes** — Brief (3 bullets), Standard (5), Detailed (8)
- **Copy to clipboard** — clean markdown format
- **Dark, typographic UI** — clean, minimal popup with no clutter

---

## Setup Instructions

### Prerequisites
- Google Chrome (or any Chromium browser)
- An API key from one of: [OpenAI](https://platform.openai.com/api-keys), [Anthropic](https://console.anthropic.com), or [Google AI Studio](https://aistudio.google.com/app/apikey)

### Installation (Local Extension)

1. **Download** this repository as a ZIP, or clone it:
   ```bash
   git clone https://github.com/your-username/ai-page-summarizer.git
   ```

2. Open Chrome and navigate to:
   ```
   chrome://extensions
   ```

3. Enable **Developer mode** (toggle in the top-right corner).

4. Click **"Load unpacked"** and select the `ai-page-summarizer` folder.

5. The PageMind extension will appear in your extensions bar.  
   Pin it for easy access.

6. Click the extension icon → click **⚙ Settings** → enter your AI provider and API key → **Save**.

7. Navigate to any article or webpage and click **Summarize Page**.

---

## Architecture

```
ai-page-summarizer/
├── manifest.json          # Manifest V3 config
├── popup.html             # Extension popup UI
├── popup.css              # Popup styles
├── popup.js               # Popup interaction logic
├── icons/                 # Extension icons (16, 32, 48, 128px)
└── src/
    ├── background.js      # Service worker: AI calls, caching, routing
    └── content.js         # Content script: page extraction
```

### Message Flow

```
User clicks "Summarize"
        │
        ▼
  popup.js (UI)
        │  chrome.tabs.sendMessage →
        ▼
  content.js (EXTRACT_CONTENT)
        │  Returns { content, title, url, wordCount }
        ▼
  popup.js
        │  chrome.runtime.sendMessage →
        ▼
  background.js (service worker)
        │  Checks cache → calls AI API
        ▼
  AI Provider (OpenAI / Anthropic / Gemini)
        │  Returns structured JSON
        ▼
  background.js → caches result → responds
        │
        ▼
  popup.js → renders summary UI
```

### Content Extraction Strategy

`content.js` uses a **heuristic scoring algorithm**:

1. **Semantic selectors first**: Checks for `<article>`, `[role="main"]`, `<main>`, and common CMS class patterns.
2. **Density scoring**: For each `<div>` and `<section>`, scores by text length, paragraph count, and text-to-node density ratio.
3. **Penalty selectors**: Elements matching `header`, `footer`, `nav`, `.sidebar`, `.ads` etc. are excluded.
4. **Fallback**: If no good candidate found, strips penalty regions from `<body>` and uses all remaining text.
5. **Sanitization**: Collapses whitespace, removes script/style content, normalizes newlines.

---

## AI Integration

### Providers Supported

| Provider | Default Model | Notes |
|----------|--------------|-------|
| OpenAI | `gpt-4o-mini` | Fast, cheap, high quality |
| Anthropic | `claude-3-5-haiku-20241022` | Excellent instruction following |
| Google | `gemini-1.5-flash` | Free tier available |

### Prompt Design

The background script sends a structured prompt instructing the model to return **only valid JSON** with a fixed schema:

```json
{
  "summary": "2-3 sentence overview",
  "bullets": ["point 1", ...],
  "keyInsights": ["insight 1", ...],
  "readingTime": 5,
  "sentiment": "positive|neutral|negative|mixed",
  "topics": ["topic1", ...],
  "highlightPhrases": ["phrase1", ...]
}
```

Content is capped at **12,000 characters** before sending to control token costs.

### Response Parsing

Responses are cleaned of markdown fences (`\`\`\`json`) and then `JSON.parse`'d. A regex fallback extracts the JSON object if the model returns unexpected preamble.

---

## Security Decisions

### API Key Handling
- **Never in source code** — keys are entered by the user via the popup settings UI
- **Stored in `chrome.storage.local`** — sandboxed to the extension, inaccessible to web pages
- **Never logged or transmitted** — only sent directly to the chosen AI provider endpoint

### Content Security Policy
```json
"content_security_policy": {
  "extension_pages": "script-src 'self'; object-src 'self'"
}
```
Prevents inline scripts and external script loading in extension pages.

### XSS Prevention
- All AI-generated text is set via `.textContent`, never `.innerHTML`
- A `sanitizeText()` utility enforces length limits
- In-page highlights use a controlled DOM injection via `chrome.scripting.executeScript`, which runs in the page's context but only touches text nodes

### Minimal Permissions
```json
"permissions": ["activeTab", "storage", "scripting"]
```
- `activeTab`: Access only the currently active tab (not all tabs)
- `storage`: For caching and settings only
- `scripting`: To inject content scripts and the highlighter
- No `<all_urls>` tab access; host permissions limited to the three AI API domains

### Message Validation
All `chrome.runtime.onMessage` handlers check `message.type` before processing. Unknown message types are silently ignored.

---

## Trade-offs

| Decision | Rationale |
|----------|-----------|
| **No readability.js bundling** | Keeps extension size tiny; custom heuristics handle 90% of cases |
| **12,000 char content cap** | Balances cost/quality; most articles are under this |
| **1-hour cache TTL** | Fresh enough for daily use, reduces redundant API calls |
| **Single-file architecture** | No build step required — load unpacked and it works |
| **No proxy server** | Simpler setup; API key stays local; tradeoff is browser-visible network requests |
| **Module-type service worker** | Enables cleaner imports; `"type": "module"` in manifest |

---

## Limitations

- Does not work on `chrome://` pages (browser restrictions)
- PDF pages are not supported
- Heavy JavaScript-rendered content may need a moment to load before extracting
- API keys are visible in DevTools → Application → Extension Storage (as with all local-only extensions)

---

## Development Notes

No build tools required. Edit files and click **"Update"** in `chrome://extensions` to reload.

To add a new AI provider:
1. Add a case in `callAI()` inside `background.js`
2. Add an `<option>` to `#providerSelect` in `popup.html`
3. Add the API domain to `host_permissions` in `manifest.json`
