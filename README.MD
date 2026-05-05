# PageMind — AI Page Summarizer

> A Chrome Extension (Manifest V3) that extracts meaningful content from any webpage and delivers structured AI summaries — bullet points, key insights, reading time, sentiment, and optional in-page highlights.

---


## Features

| Feature | Details |
|---|---|
| Smart extraction | Heuristic scoring — prefers article body, excludes nav/ads/sidebars |
| AI summaries | Overview, bullet points, key insights, reading time, sentiment |
| Three modes | Brief (3 bullets) · Standard (5) · Detailed (8) |
| In-page highlights | Marks key phrases on the page, toggleable |
| Copy to clipboard | Clean markdown format |
| Dark / Light mode | Persisted via `chrome.storage.local` |
| Summary caching | Per-URL, 1-hour TTL — no duplicate API calls |
| Multi-provider | OpenAI · Anthropic · Google Gemini |
| Build-time secrets | API key injected via webpack + dotenv, never in source |

---

## Local Installation (Load Unpacked)

> The extension is **not** published to the Chrome Web Store. Follow these steps to install it locally.

### Prerequisites

- Node.js ≥ 18
- npm ≥ 9
- Google Chrome (or any Chromium browser)
- An API key from one of:
  - **Anthropic**: https://console.anthropic.com
  - **OpenAI**: https://platform.openai.com/api-keys
  - **Google Gemini**: https://aistudio.google.com/app/apikey

### Step 1 — Clone the repository

```bash
git clone https://github.com/YOUR_USERNAME/pagemind-extension.git
cd pagemind-extension
```

### Step 2 — Install dependencies

```bash
npm install
```

### Step 3 — Configure your API key

```bash
cp .env.example .env
```

Open `.env` and fill in your values:

```env
PAGEMIND_PROVIDER=anthropic          # or: openai | gemini
PAGEMIND_API_KEY=your-key-here
PAGEMIND_MODEL=                      # optional; leave blank for default
```

> ⚠️ **Never commit `.env`** — it is gitignored. Only `.env.example` (with no real values) is committed.

### Step 4 — Build the extension

```bash
npm run build
```

This generates a `dist/` folder containing the installable extension.

### Step 5 — Load into Chrome

1. Open Chrome and navigate to `chrome://extensions`
2. Enable **Developer mode** (toggle in the top-right corner)
3. Click **"Load unpacked"**
4. Select the `dist/` folder

The PageMind icon (yellow star) appears in your toolbar. **Pin it** for easy access.

### Step 6 — Use it

Navigate to any article or webpage → click the PageMind icon → click **Summarize Page**.

---

## Project Structure

```
pagemind-extension/
│
├── src/                        # Source files (compiled by webpack)
│   ├── background.js           # Service worker: AI calls, caching, highlights
│   ├── content.js              # Content script: heuristic page extraction
│   └── popup.js                # Popup controller: UI state + message passing
│
├── public/                     # Static assets (copied to dist/ as-is)
│   ├── manifest.json           # Manifest V3 config
│   ├── popup.html              # Popup markup
│   ├── popup.css               # Popup styles (dark + light mode)
│   └── icons/                  # 16 / 32 / 48 / 128 px PNG icons
│
├── dist/                       # ← BUILD OUTPUT (gitignored)
│                               #   Load this folder as the extension
│
├── .env                        # ← YOUR SECRETS (gitignored, never committed)
├── .env.example                # Shape of .env — safe to commit
├── .gitignore
├── package.json
├── webpack.config.js           # Bundles src/, injects env vars at build time
└── README.md
```

---

## Architecture

### Message Flow

```
┌─────────────────────────────────────────────────────────────┐
│  User clicks "Summarize Page"                               │
│         │                                                   │
│         ▼                                                   │
│  popup.js  ──sendMessage(EXTRACT_CONTENT)──▶  content.js   │
│         │       (chrome.tabs.sendMessage)        │         │
│         │                                        │         │
│         │  ◀── { content, title, url, wordCount }┘         │
│         │                                                   │
│         │  ──sendMessage(SUMMARIZE_PAGE)──▶  background.js │
│         │       (chrome.runtime.sendMessage)     │         │
│         │                                        │         │
│         │                              check cache         │
│         │                                  │               │
│         │                              cache hit?          │
│         │                             ╱         ╲          │
│         │                           YES          NO        │
│         │                            │            │        │
│         │                            │        call AI API  │
│         │                            │            │        │
│         │  ◀── { success, summary, fromCache } ───┘        │
│         │                                                   │
│         ▼                                                   │
│  renderSummary() — textContent only, no innerHTML           │
└─────────────────────────────────────────────────────────────┘
```

### Content Extraction Strategy (`src/content.js`)

The content script uses a **two-pass heuristic algorithm** to find the main article body:

**Pass 1 — Semantic selectors (fast path)**
Checks a priority-ordered list of known content containers:
`article` → `[role="main"]` → `main` → `.post-content` → `.entry-content` → …

**Pass 2 — Density scoring (fallback)**
If no semantic element is found, every `<div>` and `<section>` is scored:

```
score = textLength + (paragraphCount × 30) + (textDensity × 10)
```

Elements are excluded (penalised) if they match: `header`, `footer`, `nav`, `aside`, `.sidebar`, `.ads`, `.comments`, `.social`, etc.

Elements with a link-to-text ratio above 50% are treated as navigation and skipped.

**Pass 3 — Fallback**
If neither pass finds a good candidate, the full `<body>` is used after stripping penalised regions.

### AI Integration (`src/background.js`)

```
callAI()
  │
  ├── provider === "openai"    → callOpenAI()    → POST /v1/chat/completions
  ├── provider === "anthropic" → callAnthropic() → POST /v1/messages
  └── provider === "gemini"    → callGemini()    → POST /v1beta/models/:model:generateContent
```

All three providers receive the same structured prompt asking for a fixed JSON schema:

```json
{
  "summary": "string",
  "bullets": ["string"],
  "keyInsights": ["string"],
  "readingTime": 5,
  "sentiment": "positive|neutral|negative|mixed",
  "topics": ["string"],
  "highlightPhrases": ["string"]
}
```

The response parser strips markdown fences and falls back to regex JSON extraction if the model adds unexpected preamble.

### Caching (`chrome.storage.local`)

- Key format: `cache:<url>`
- Value: `{ summary: {...}, timestamp: <ms> }`
- TTL: 1 hour — stale entries are evicted on read
- `CLEAR_CACHE` message removes all `cache:` prefixed keys

---

## Security Decisions

### 1. API key — build-time injection, not runtime input

**Problem**: The extension must work out-of-the-box without the user entering credentials, but the key must not appear in any committed file.

**Solution**: `webpack` + `dotenv-webpack` replaces `process.env.PAGEMIND_API_KEY` with a **string literal** at build time. The compiled `dist/` folder contains the baked-in key, but `dist/` is gitignored. Only `.env.example` (with placeholder values) is committed.

```
Source code:  const API_KEY = process.env.PAGEMIND_API_KEY;
After build:  const API_KEY = "sk-ant-...";   ← literal, in dist only
```

### 2. All AI calls run in the background service worker

The content script and popup have no access to the API key. Only `background.js` makes outbound requests. This means:

- Web pages cannot intercept the key via script injection
- The popup's CSP (`script-src 'self'`) blocks any injected scripts

### 3. XSS prevention — `.textContent` only

Every piece of AI-generated text is inserted using `.textContent`, never `.innerHTML`. This means even if the AI returned `<script>alert(1)</script>`, it would be rendered as literal text.

A `sanitize()` helper also enforces a 600-character length cap per field.

### 4. Minimal permissions

```json
"permissions": ["activeTab", "storage", "scripting"]
```

- `activeTab`: access only the currently active tab (not all tabs)
- `storage`: for caching and theme preference only
- `scripting`: to inject the content script when the auto-injection hasn't run yet

No `tabs` permission (broader tab access), no `<all_urls>` permission.

### 5. Message validation

The background service worker validates `message.type` before dispatching. Unknown message types are silently ignored, preventing message injection attacks.

---

## Trade-offs

| Decision | Why | Cost |
|---|---|---|
| No readability.js | Zero bundle size; custom heuristics handle 90% of pages | Occasional misses on unusual layouts |
| 12,000 char content cap | Keeps token cost low and latency fast | Very long pages are truncated |
| 1-hour cache TTL | Balances freshness with API cost savings | Live pages won't re-summarise for an hour |
| No build-time minification of CSS/HTML | Simpler pipeline; Chrome doesn't require it | Slightly larger popup files |
| dist/ gitignored | Forces each user to build with their own key | Extra setup step for collaborators |
| Direct browser→AI API calls | No proxy server needed; simpler architecture | Key visible in DevTools → Network tab of extension pages |

---

## Default Models

| Provider | Default Model | Notes |
|---|---|---|
| Anthropic | `claude-haiku-4-5` | Fast, cheap, great instruction following |
| OpenAI | `gpt-4o-mini` | Fast, cheap, widely available |
| Gemini | `gemini-2.0-flash` | Fast, free tier available |

Override by setting `PAGEMIND_MODEL` in `.env`.

---

## Development

```bash
# Watch mode — rebuilds on every file save
npm run dev

# Production build
npm run build
```

After any rebuild, go to `chrome://extensions` and click the **↺ refresh icon** on the PageMind card.

### Adding a new AI provider

1. Add a `callYourProvider()` function in `src/background.js`
2. Add a `case "yourprovider":` in `callAI()`
3. Add the API domain to `host_permissions` in `public/manifest.json`
4. Update `PAGEMIND_PROVIDER` in `.env`

---

## Known Limitations

- Does not work on `chrome://` pages (browser restriction)
- PDF pages are not supported
- Heavy JavaScript-rendered pages may need a moment after load before extracting
- The API key is visible in `chrome://extensions → inspect views → background page → Network tab` — this is a fundamental constraint of direct browser-to-API calls without a proxy server

---

## Submission

**Slack Display Name**: [your name here]  
**Deadline**: 5th May 2026
