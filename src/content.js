/**
 * PageMind — Content Script
 * Extracts readable, meaningful content from the current page.
 * Uses heuristic filtering to prefer article content over chrome/nav.
 */

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === "EXTRACT_CONTENT") {
    try {
      const result = extractPageContent();
      sendResponse({ success: true, ...result });
    } catch (err) {
      sendResponse({ success: false, error: err.message });
    }
    return true;
  }
});

function extractPageContent() {
  const title = document.title || "Untitled Page";
  const url = location.href;

  // Score-based candidate selector
  const candidate = findBestContentElement();
  const rawText = candidate
    ? extractTextFromElement(candidate)
    : extractFallbackText();

  const cleanText = sanitizeText(rawText);
  const wordCount = countWords(cleanText);

  return { title, url, content: cleanText, wordCount };
}

// ─── Candidate Scoring ────────────────────────────────────────────────────────
const BOOST_SELECTORS = [
  "article",
  '[role="main"]',
  "main",
  ".post-content",
  ".entry-content",
  ".article-body",
  ".story-body",
  ".article__body",
  ".post-body",
  "#content",
  ".content",
  ".main-content",
];

const PENALTY_SELECTORS = [
  "header",
  "footer",
  "nav",
  "aside",
  ".sidebar",
  ".navigation",
  ".menu",
  ".ads",
  ".advertisement",
  ".comments",
  ".related",
  ".social",
  ".share",
  ".cookie",
  ".newsletter",
];

function findBestContentElement() {
  // 1. Try semantic article-first selectors
  for (const sel of BOOST_SELECTORS) {
    const el = document.querySelector(sel);
    if (el && getTextLength(el) > 300) return el;
  }

  // 2. Density scoring: find the <div>/<section> with highest text-to-node ratio
  const candidates = [...document.querySelectorAll("div, section, article")];
  let bestEl = null;
  let bestScore = 0;

  for (const el of candidates) {
    if (isPenalized(el)) continue;
    const score = scoreElement(el);
    if (score > bestScore) {
      bestScore = score;
      bestEl = el;
    }
  }

  return bestScore > 200 ? bestEl : null;
}

function scoreElement(el) {
  const text = getTextLength(el);
  if (text < 200) return 0;

  const linkText = getLinkTextLength(el);
  const linkRatio = linkText / (text || 1);
  if (linkRatio > 0.5) return 0; // nav-heavy, skip

  const paragraphs = el.querySelectorAll("p").length;
  const density = text / (el.querySelectorAll("*").length || 1);

  return text + paragraphs * 30 + density * 10;
}

function isPenalized(el) {
  for (const sel of PENALTY_SELECTORS) {
    if (el.matches(sel) || el.closest(sel)) return true;
  }
  return false;
}

function getTextLength(el) {
  return (el.textContent || "").trim().length;
}

function getLinkTextLength(el) {
  return [...el.querySelectorAll("a")]
    .reduce((sum, a) => sum + (a.textContent || "").length, 0);
}

// ─── Text Extraction ──────────────────────────────────────────────────────────
function extractTextFromElement(el) {
  // Clone to safely manipulate
  const clone = el.cloneNode(true);

  // Remove noise
  const noiseSelectors = [
    "script", "style", "noscript", "iframe", "img", "svg",
    "figure", "button", "input", "select", "form",
    ".ad", ".ads", ".advertisement", ".social-share",
    '[aria-hidden="true"]',
  ];
  noiseSelectors.forEach((sel) => {
    clone.querySelectorAll(sel).forEach((n) => n.remove());
  });

  // Preserve paragraph structure
  clone.querySelectorAll("p, h1, h2, h3, h4, li, blockquote").forEach((el) => {
    el.insertAdjacentText("afterend", "\n");
  });

  return clone.textContent || "";
}

function extractFallbackText() {
  // Last resort: body text minus penalized regions
  const body = document.body.cloneNode(true);
  PENALTY_SELECTORS.forEach((sel) => {
    body.querySelectorAll(sel).forEach((n) => n.remove());
  });
  ["script", "style", "noscript"].forEach((tag) => {
    body.querySelectorAll(tag).forEach((n) => n.remove());
  });
  return body.textContent || "";
}

// ─── Sanitization ─────────────────────────────────────────────────────────────
function sanitizeText(text) {
  return text
    .replace(/[ \t]+/g, " ")           // collapse horizontal whitespace
    .replace(/\n{3,}/g, "\n\n")        // max 2 consecutive newlines
    .replace(/[^\S\n]+\n/g, "\n")      // trailing spaces before newlines
    .trim();
}

function countWords(text) {
  return text.split(/\s+/).filter(Boolean).length;
}
