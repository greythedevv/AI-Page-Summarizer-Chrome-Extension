/**
 * PageMind — Content Script
 * ──────────────────────────
 * Runs in the context of every page at document_idle.
 * Responds to EXTRACT_CONTENT messages from the popup.
 *
 * Extraction strategy (in order):
 *   1. Semantic selectors  — article, main, [role=main], known CMS classes
 *   2. Density scoring     — score every div/section by text length,
 *                            paragraph count, and text-to-node ratio
 *   3. Fallback            — strip penalties from body and use remainder
 */

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "EXTRACT_CONTENT") return;

  try {
    const result = extractPageContent();
    sendResponse({ success: true, ...result });
  } catch (err) {
    sendResponse({ success: false, error: err.message });
  }

  return true; // keep async channel open
});

// ─── Entry Point ──────────────────────────────────────────────────────────────
function extractPageContent() {
  const title     = document.title || "Untitled Page";
  const url       = location.href;
  const candidate = findBestContentElement();
  const rawText   = candidate
    ? extractTextFromElement(candidate)
    : extractFallbackText();

  const content   = sanitizeText(rawText);
  const wordCount = countWords(content);

  return { title, url, content, wordCount };
}

// ─── Selector Lists ───────────────────────────────────────────────────────────

// Elements that are likely to contain the main article content
const BOOST_SELECTORS = [
  "article",
  '[role="main"]',
  "main",
  ".post-content",
  ".entry-content",
  ".article-body",
  ".article__body",
  ".story-body",
  ".post-body",
  ".td-post-content",
  ".mkd-post-text",
  "#article-body",
  "#main-content",
  ".main-content",
  "#content",
  ".content",
];

// Elements that are unlikely to contain useful reading content
const PENALTY_SELECTORS = [
  "header", "footer", "nav", "aside",
  ".sidebar", ".side-bar",
  ".navigation", ".nav", ".menu",
  ".ads", ".ad", ".advertisement", ".advert",
  ".comments", ".comment-section",
  ".related", ".related-posts",
  ".social", ".social-share", ".share-buttons",
  ".cookie", ".cookie-banner",
  ".newsletter", ".subscribe",
  ".popup", ".modal",
  '[aria-label="advertisement"]',
];

// ─── Candidate Finder ─────────────────────────────────────────────────────────
function findBestContentElement() {
  // Pass 1: semantic selectors in priority order
  for (const sel of BOOST_SELECTORS) {
    const el = document.querySelector(sel);
    if (el && getTextLength(el) > 300) return el;
  }

  // Pass 2: density scoring across all block elements
  const candidates = [...document.querySelectorAll("div, section, article")];
  let bestEl    = null;
  let bestScore = 0;

  for (const el of candidates) {
    if (isPenalized(el)) continue;
    const score = scoreElement(el);
    if (score > bestScore) {
      bestScore = score;
      bestEl    = el;
    }
  }

  return bestScore > 200 ? bestEl : null;
}

function scoreElement(el) {
  const textLen = getTextLength(el);
  if (textLen < 200) return 0;

  // Heavily nav-linked elements are likely menus, not articles
  const linkLen   = getLinkTextLength(el);
  const linkRatio = linkLen / (textLen || 1);
  if (linkRatio > 0.5) return 0;

  const paragraphs = el.querySelectorAll("p").length;
  const nodeCount  = el.querySelectorAll("*").length || 1;
  const density    = textLen / nodeCount;

  // Weight: raw length + paragraph bonus + density bonus
  return textLen + paragraphs * 30 + density * 10;
}

function isPenalized(el) {
  for (const sel of PENALTY_SELECTORS) {
    if (el.matches?.(sel) || el.closest?.(sel)) return true;
  }
  return false;
}

function getTextLength(el) {
  return (el.textContent || "").trim().length;
}

function getLinkTextLength(el) {
  return [...el.querySelectorAll("a")]
    .reduce((sum, a) => sum + (a.textContent || "").trim().length, 0);
}

// ─── Text Extraction ──────────────────────────────────────────────────────────
function extractTextFromElement(el) {
  const clone = el.cloneNode(true);

  // Remove noise nodes
  [
    "script", "style", "noscript", "iframe",
    "img", "svg", "figure", "picture",
    "button", "input", "select", "textarea", "form",
    ".ad", ".ads", ".advertisement",
    ".social-share", ".share",
    '[aria-hidden="true"]',
  ].forEach((sel) => {
    clone.querySelectorAll(sel).forEach((n) => n.remove());
  });

  // Insert newlines after block-level elements to preserve structure
  clone.querySelectorAll("p, h1, h2, h3, h4, h5, h6, li, blockquote, td").forEach((node) => {
    node.insertAdjacentText("afterend", "\n");
  });

  return clone.textContent || "";
}

function extractFallbackText() {
  const clone = document.body.cloneNode(true);

  // Remove penalized regions entirely
  PENALTY_SELECTORS.forEach((sel) => {
    clone.querySelectorAll(sel).forEach((n) => n.remove());
  });
  ["script", "style", "noscript", "iframe"].forEach((tag) => {
    clone.querySelectorAll(tag).forEach((n) => n.remove());
  });

  return clone.textContent || "";
}

// ─── Text Utilities ───────────────────────────────────────────────────────────
function sanitizeText(text) {
  return text
    .replace(/[ \t]+/g, " ")       // collapse horizontal whitespace
    .replace(/\n{3,}/g, "\n\n")    // max two consecutive newlines
    .replace(/[^\S\n]+\n/g, "\n")  // no trailing spaces before newlines
    .trim();
}

function countWords(text) {
  return text.split(/\s+/).filter(Boolean).length;
}
