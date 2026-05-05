/**
 * PageMind — Background Service Worker
 * ─────────────────────────────────────
 * Responsibilities:
 *   • Receive messages from popup (SUMMARIZE_PAGE, HIGHLIGHT_PAGE, CLEAR_CACHE)
 *   • Make AI API requests (OpenAI / Anthropic / Gemini)
 *   • Cache results in chrome.storage.local keyed by URL
 *   • Inject highlight/clear functions into the active tab
 *
 * Security model:
 *   API keys are injected at BUILD TIME by webpack + dotenv-webpack.
 *   process.env.PAGEMIND_API_KEY is replaced with a string literal during
 *   `npm run build`. The .env file is gitignored — it never touches the repo.
 *   The built dist/ folder is also gitignored — each developer builds locally.
 */

// ─── Build-time constants (webpack replaces these with string literals) ───────
const API_KEY  = process.env.PAGEMIND_API_KEY;
const PROVIDER = process.env.PAGEMIND_PROVIDER || "anthropic";
const MODEL    = process.env.PAGEMIND_MODEL    || "";

const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

// ─── Message Router ───────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  // Validate message shape before processing
  if (!message || typeof message.type !== "string") return;

  switch (message.type) {
    case "SUMMARIZE_PAGE":
      handleSummarize(message.payload)
        .then(sendResponse)
        .catch((err) => sendResponse({ success: false, error: err.message }));
      return true; // keep the message channel open for async response

    case "HIGHLIGHT_PAGE":
      handleHighlight(message.payload)
        .then(sendResponse)
        .catch(() => sendResponse({ success: false }));
      return true;

    case "CLEAR_CACHE":
      clearCache()
        .then(() => sendResponse({ success: true }))
        .catch(() => sendResponse({ success: false }));
      return true;
  }
});

// ─── Summarize Handler ────────────────────────────────────────────────────────
async function handleSummarize({ url, content, title, wordCount, mode }) {
  // Guard: minimum content threshold
  if (!content || content.trim().length < 100) {
    throw new Error("NOT_ENOUGH_CONTENT");
  }

  // Guard: API key must have been injected at build time
  if (!API_KEY || API_KEY === "your-api-key-here") {
    throw new Error("NO_API_KEY");
  }

  // Return cached result if fresh
  const cached = await getCachedSummary(url);
  if (cached) {
    return { success: true, summary: cached, fromCache: true };
  }

  // Call the AI provider
  const summary = await callAI({
    content: content.slice(0, 12000), // cap to ~3k tokens
    title,
    wordCount,
    provider: PROVIDER,
    apiKey:   API_KEY,
    model:    MODEL,
    mode:     mode || "standard",
  });

  await cacheSummary(url, summary);
  return { success: true, summary, fromCache: false };
}

// ─── AI Provider Abstraction ──────────────────────────────────────────────────
async function callAI({ content, title, wordCount, provider, apiKey, model, mode }) {
  const prompt = buildPrompt(title, content, wordCount, mode);

  switch (provider) {
    case "openai":
      return callOpenAI(prompt, apiKey, model || "gpt-4o-mini");
    case "anthropic":
      return callAnthropic(prompt, apiKey, model || "claude-haiku-4-5");
    case "gemini":
      return callGemini(prompt, apiKey, model || "gemini-2.0-flash");
    default:
      throw new Error(`Unknown AI provider: "${provider}". Use openai, anthropic, or gemini.`);
  }
}

// ─── Prompt Builder ───────────────────────────────────────────────────────────
function buildPrompt(title, content, wordCount, mode) {
  const bulletCount = mode === "brief" ? 3 : mode === "detailed" ? 8 : 5;

  return `You are a precise content analyst. Analyze the webpage below and return ONLY valid JSON — no markdown fences, no explanation, no preamble.

Page Title: ${title}
Word Count: ~${wordCount}
Content:
${content}

Return exactly this JSON structure:
{
  "summary": "2–3 sentence overview of what this page is about",
  "bullets": ["point 1", "point 2", ... (exactly ${bulletCount} items)],
  "keyInsights": ["insight 1", "insight 2", "insight 3"],
  "readingTime": <integer, estimated minutes to read the full page>,
  "sentiment": "positive" | "neutral" | "negative" | "mixed",
  "topics": ["topic1", "topic2", "topic3"],
  "highlightPhrases": ["important phrase 1", "important phrase 2", "important phrase 3"]
}`;
}

// ─── OpenAI ───────────────────────────────────────────────────────────────────
async function callOpenAI(prompt, apiKey, model) {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: prompt }],
      temperature: 0.3,
      max_tokens: 1000,
    }),
  });
  await assertOk(res, "OpenAI");
  const data = await res.json();
  return parseAIResponse(data.choices[0].message.content);
}

// ─── Anthropic ────────────────────────────────────────────────────────────────
async function callAnthropic(prompt, apiKey, model) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      // Required header for direct browser/extension API access
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify({
      model,
      max_tokens: 1000,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  await assertOk(res, "Anthropic");
  const data = await res.json();
  return parseAIResponse(data.content[0].text);
}

// ─── Gemini ───────────────────────────────────────────────────────────────────
async function callGemini(prompt, apiKey, model) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.3, maxOutputTokens: 1000 },
    }),
  });
  await assertOk(res, "Gemini");
  const data = await res.json();
  return parseAIResponse(data.candidates[0].content.parts[0].text);
}

// ─── Response Parser ──────────────────────────────────────────────────────────
function parseAIResponse(text) {
  // Strip markdown code fences if model includes them despite instructions
  const cleaned = text.replace(/```json\s*/gi, "").replace(/```\s*/g, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    // Fallback: extract the first JSON object from the response
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) {
      try { return JSON.parse(match[0]); } catch {}
    }
    throw new Error("AI returned malformed JSON. Please try again.");
  }
}

// ─── HTTP Error Handler ───────────────────────────────────────────────────────
async function assertOk(res, provider) {
  if (res.ok) return;
  let msg = `${provider} API error: ${res.status}`;
  try {
    const body = await res.json();
    const detail = body?.error?.message || body?.message || JSON.stringify(body);
    msg += ` — ${detail}`;
  } catch { /* response body not JSON */ }
  throw new Error(msg);
}

// ─── Cache: chrome.storage.local keyed by URL ─────────────────────────────────
async function getCachedSummary(url) {
  const key = `cache:${url}`;
  const data = await chrome.storage.local.get(key);
  const entry = data[key];
  if (!entry) return null;
  // Evict stale entries on read
  if (Date.now() - entry.timestamp > CACHE_TTL_MS) {
    chrome.storage.local.remove(key);
    return null;
  }
  return entry.summary;
}

async function cacheSummary(url, summary) {
  const key = `cache:${url}`;
  await chrome.storage.local.set({
    [key]: { summary, timestamp: Date.now() },
  });
}

async function clearCache() {
  const all = await chrome.storage.local.get(null);
  const cacheKeys = Object.keys(all).filter((k) => k.startsWith("cache:"));
  if (cacheKeys.length) await chrome.storage.local.remove(cacheKeys);
}

// ─── Highlight Handler ────────────────────────────────────────────────────────
async function handleHighlight({ phrases, action }) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return { success: false };

  // Inject the appropriate function directly into the page context
  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: action === "clear" ? clearHighlightsInPage : applyHighlightsInPage,
    args: action === "clear" ? [] : [phrases],
  });

  return { success: true };
}

// These functions are serialized and injected into the page — they run in
// the page's context, NOT the extension context.
function applyHighlightsInPage(phrases) {
  // Clear any previous highlights first
  clearHighlightsInPage();
  if (!phrases?.length) return;

  // Walk all text nodes, skipping script/style
  const walker = document.createTreeWalker(
    document.body,
    NodeFilter.SHOW_TEXT,
    {
      acceptNode(node) {
        const tag = node.parentElement?.tagName?.toLowerCase();
        if (["script", "style", "noscript"].includes(tag)) {
          return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      },
    }
  );

  const textNodes = [];
  while (walker.nextNode()) textNodes.push(walker.currentNode);

  // Escape special regex characters in phrases
  const escaped = phrases.map((p) =>
    String(p).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  );
  const regex = new RegExp(`(${escaped.join("|")})`, "gi");

  textNodes.forEach((node) => {
    if (!node.textContent || !regex.test(node.textContent)) return;
    regex.lastIndex = 0;

    const container = document.createElement("span");
    container.setAttribute("data-pagemind", "highlight-container");
    // Safe: we're wrapping existing page text, not inserting AI content
    container.innerHTML = node.textContent.replace(
      regex,
      (match) =>
        `<mark data-pagemind="highlight" style="background:rgba(255,210,0,0.5);border-radius:3px;padding:1px 2px;color:inherit;">${match}</mark>`
    );
    node.parentNode?.replaceChild(container, node);
  });
}

function clearHighlightsInPage() {
  document
    .querySelectorAll("[data-pagemind='highlight-container']")
    .forEach((el) => el.replaceWith(document.createTextNode(el.textContent)));
}
