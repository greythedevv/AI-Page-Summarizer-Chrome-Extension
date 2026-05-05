/**
 * PageMind — Background Service Worker
 *
 * API keys are injected at BUILD TIME from .env via webpack + dotenv-webpack.
 * process.env.PAGEMIND_API_KEY is replaced with the literal key string
 * during `npm run build` — it never exists as a variable at runtime.
 *
 * The .env file is gitignored. The built dist/ folder is also gitignored.
 * Only .env.example (with no real values) is committed to the repo.
 */

// These are replaced with literal strings at build time by webpack
const BUILT_IN_API_KEY = process.env.PAGEMIND_API_KEY;
const BUILT_IN_PROVIDER = process.env.PAGEMIND_PROVIDER || "anthropic";
const BUILT_IN_MODEL = process.env.PAGEMIND_MODEL || "";

const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour cache per URL

// ─── Message Router ───────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "SUMMARIZE_PAGE") {
    handleSummarize(message.payload)
      .then(sendResponse)
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true; // keep async channel open
  }

  if (message.type === "CLEAR_CACHE") {
    clearCache().then(() => sendResponse({ success: true }));
    return true;
  }

  if (message.type === "HIGHLIGHT_PAGE") {
    handleHighlight(message.payload).then(sendResponse);
    return true;
  }
});

// ─── Summarize Handler ────────────────────────────────────────────────────────
async function handleSummarize({ url, content, title, wordCount, mode }) {
  if (!content || content.trim().length < 100) {
    throw new Error("NOT_ENOUGH_CONTENT");
  }

  // Return cached result if available and fresh
  const cached = await getCachedSummary(url);
  if (cached) {
    return { success: true, summary: cached, fromCache: true };
  }

  if (!BUILT_IN_API_KEY) {
    throw new Error("NO_API_KEY — rebuild the extension with a valid .env file");
  }

  const summary = await callAI({
    content: content.slice(0, 12000), // cap tokens
    title,
    wordCount,
    provider: BUILT_IN_PROVIDER,
    apiKey: BUILT_IN_API_KEY,
    model: BUILT_IN_MODEL,
    mode: mode || "standard",
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
      throw new Error(`Unknown provider: ${provider}`);
  }
}

function buildPrompt(title, content, wordCount, mode) {
  const bulletCount = mode === "brief" ? 3 : mode === "detailed" ? 8 : 5;
  return `You are a precise content analyst. Analyze this webpage and return ONLY valid JSON — no markdown fences, no preamble.

Page Title: ${title}
Word Count: ~${wordCount} words
Content:
${content}

Return exactly this JSON structure:
{
  "summary": "2-3 sentence overview of what this page is about",
  "bullets": ["bullet 1", "bullet 2", ...(${bulletCount} bullets)],
  "keyInsights": ["insight 1", "insight 2", "insight 3"],
  "readingTime": <integer minutes>,
  "sentiment": "positive|neutral|negative|mixed",
  "topics": ["topic1", "topic2", "topic3"],
  "highlightPhrases": ["phrase1", "phrase2", "phrase3"]
}`;
}

// ─── Provider Implementations ─────────────────────────────────────────────────
async function callOpenAI(prompt, apiKey, model) {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
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

async function callAnthropic(prompt, apiKey, model) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      // Required for direct browser/extension requests to Anthropic API
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

// ─── Helpers ──────────────────────────────────────────────────────────────────
function parseAIResponse(text) {
  const cleaned = text.replace(/```json\s*/gi, "").replace(/```\s*/g, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]);
    throw new Error("AI returned malformed JSON. Please try again.");
  }
}

async function assertOk(res, provider) {
  if (!res.ok) {
    let msg = `${provider} API error: ${res.status}`;
    try {
      const err = await res.json();
      msg += ` — ${err.error?.message || err.message || JSON.stringify(err)}`;
    } catch {}
    throw new Error(msg);
  }
}

// ─── Cache (chrome.storage.local, keyed by URL) ───────────────────────────────
async function getCachedSummary(url) {
  const key = `cache:${url}`;
  const data = await chrome.storage.local.get(key);
  const entry = data[key];
  if (!entry) return null;
  if (Date.now() - entry.timestamp > CACHE_TTL_MS) {
    chrome.storage.local.remove(key);
    return null;
  }
  return entry.summary;
}

async function cacheSummary(url, summary) {
  const key = `cache:${url}`;
  await chrome.storage.local.set({ [key]: { summary, timestamp: Date.now() } });
}

async function clearCache() {
  const all = await chrome.storage.local.get(null);
  const keys = Object.keys(all).filter((k) => k.startsWith("cache:"));
  if (keys.length) await chrome.storage.local.remove(keys);
}

// ─── Highlight Handler ────────────────────────────────────────────────────────
async function handleHighlight({ phrases, action }) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return { success: false };

  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: action === "clear" ? clearHighlightsInPage : applyHighlightsInPage,
    args: action === "clear" ? [] : [phrases],
  });

  return { success: true };
}

function applyHighlightsInPage(phrases) {
  clearHighlightsInPage();
  if (!phrases?.length) return;

  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => {
      const tag = node.parentElement?.tagName?.toLowerCase();
      if (["script", "style", "noscript"].includes(tag)) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });

  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);

  const escaped = phrases.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const regex = new RegExp(`(${escaped.join("|")})`, "gi");

  nodes.forEach((node) => {
    if (!regex.test(node.textContent)) return;
    regex.lastIndex = 0;
    const span = document.createElement("span");
    span.setAttribute("data-pagemind", "highlight-container");
    span.innerHTML = node.textContent.replace(
      regex,
      '<mark data-pagemind="highlight" style="background:rgba(255,210,0,0.45);border-radius:2px;padding:0 2px;">$1</mark>'
    );
    node.parentNode.replaceChild(span, node);
  });
}

function clearHighlightsInPage() {
  document.querySelectorAll("[data-pagemind='highlight-container']").forEach((el) => {
    el.replaceWith(document.createTextNode(el.textContent));
  });
}