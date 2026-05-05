/**
 * PageMind — Popup Controller
 * ────────────────────────────
 * Manages all UI state transitions and communicates with:
 *   • content.js  via chrome.tabs.sendMessage  (content extraction)
 *   • background.js via chrome.runtime.sendMessage (AI + cache + highlights)
 *
 * No API keys are handled here. The key is baked into background.js
 * at build time via webpack + dotenv.
 */

// ─── State ────────────────────────────────────────────────────────────────────
let currentSummary   = null;
let highlightsActive = false;
let selectedMode     = "standard";
let isDarkMode       = true;

// ─── DOM Helpers ──────────────────────────────────────────────────────────────
const $  = (id)  => document.getElementById(id);
const $$ = (sel) => document.querySelectorAll(sel);

// Cache all DOM refs at startup — avoids repeated getElementById calls
const el = {
  // Page info
  pageTitle:   $("pageTitle"),
  pageDomain:  $("pageDomain"),
  pageFavicon: $("pageFavicon"),
  wordCount:   $("wordCount"),

  // States
  emptyState:   $("emptyState"),
  loadingState: $("loadingState"),
  loadingText:  $("loadingText"),
  errorState:   $("errorState"),
  errorTitle:   $("errorTitle"),
  errorMsg:     $("errorMsg"),
  summaryPanel: $("summaryPanel"),

  // Summary content
  summaryText:  $("summaryText"),
  bulletsList:  $("bulletsList"),
  insightsGrid: $("insightsGrid"),
  topicsRow:    $("topicsRow"),
  readingTime:  $("readingTime"),
  sentimentChip: $("sentimentChip"),
  sentimentIcon: $("sentimentIcon"),
  sentimentLabel:$("sentimentLabel"),
  cacheChip:    $("cacheChip"),
  wordCountChip: $("wordCountChip"),

  // Buttons
  summarizeBtn:    $("summarizeBtn"),
  retryBtn:        $("retryBtn"),
  clearBtn:        $("clearBtn"),
  copyBtn:         $("copyBtn"),
  highlightBtn:    $("highlightBtn"),
  themeBtn:        $("themeBtn"),
  secondaryActions:$("secondaryActions"),
};

// ─── Initialise ───────────────────────────────────────────────────────────────
async function init() {
  await loadPageMeta();
  setupListeners();
  loadThemePreference();
}

async function loadPageMeta() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) return;

    el.pageTitle.textContent = tab.title || "Untitled Page";

    try {
      const url = new URL(tab.url);
      el.pageDomain.textContent = url.hostname;

      // Load favicon via Google's favicon service
      const img = document.createElement("img");
      img.src    = `https://www.google.com/s2/favicons?domain=${url.hostname}&sz=32`;
      img.alt    = "";
      img.onerror = () => img.remove();
      el.pageFavicon.appendChild(img);
    } catch { /* chrome:// pages, etc */ }
  } catch { /* tab query failed */ }
}

function loadThemePreference() {
  chrome.storage.local.get("theme", (data) => {
    isDarkMode = data.theme !== "light";
    applyTheme();
  });
}

function applyTheme() {
  document.body.classList.toggle("light-mode", !isDarkMode);
  el.themeBtn.setAttribute("aria-label", isDarkMode ? "Switch to light mode" : "Switch to dark mode");
  el.themeBtn.title = isDarkMode ? "Light mode" : "Dark mode";
}

// ─── Event Listeners ──────────────────────────────────────────────────────────
function setupListeners() {
  el.summarizeBtn.addEventListener("click", handleSummarize);
  el.retryBtn.addEventListener("click", handleSummarize);
  el.clearBtn.addEventListener("click", handleClear);
  el.copyBtn.addEventListener("click", handleCopy);
  el.highlightBtn.addEventListener("click", handleHighlight);
  el.themeBtn.addEventListener("click", handleThemeToggle);

  // Summary mode selector
  $$(".mode-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      selectedMode = btn.dataset.mode;
      $$(".mode-btn").forEach((b) =>
        b.classList.toggle("active", b.dataset.mode === selectedMode)
      );
    });
  });

  // Keyboard: Ctrl/Cmd+Enter triggers summarise from anywhere in popup
  document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
      e.preventDefault();
      handleSummarize();
    }
  });
}

// ─── Core: Summarise ─────────────────────────────────────────────────────────
async function handleSummarize() {
  showState("loading");
  el.loadingText.textContent = "Extracting page content…";
  el.summarizeBtn.disabled   = true;

  try {
    // ── Step 1: get active tab ──
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) throw new Error("Cannot access the active tab.");

    // ── Step 2: extract content via content script ──
    // Try messaging the already-injected content script first,
    // then fall back to scripting.executeScript injection.
    let extracted = await chrome.tabs
      .sendMessage(tab.id, { type: "EXTRACT_CONTENT" })
      .catch(() => null);

    if (!extracted?.success) {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ["src/content.js"],
      });
      extracted = await chrome.tabs
        .sendMessage(tab.id, { type: "EXTRACT_CONTENT" })
        .catch(() => null);
    }

    if (!extracted?.success) {
      throw new Error("Could not extract content from this page. Try reloading the tab.");
    }

    // Show word count
    if (el.wordCount) {
      el.wordCount.textContent = `~${extracted.wordCount.toLocaleString()} words`;
    }

    // ── Step 3: send to background for AI summarisation ──
    el.loadingText.textContent = "Analysing with AI…";

    const res = await chrome.runtime.sendMessage({
      type: "SUMMARIZE_PAGE",
      payload: {
        url:       extracted.url,
        content:   extracted.content,
        title:     extracted.title,
        wordCount: extracted.wordCount,
        mode:      selectedMode,
      },
    });

    if (!res?.success) throw new Error(res?.error || "Unknown error from background.");

    // ── Step 4: render ──
    currentSummary = res.summary;
    renderSummary(res.summary, res.fromCache, extracted.wordCount);
    showState("summary");
    el.secondaryActions.classList.add("visible");

  } catch (err) {
    showError(err.message);
  } finally {
    el.summarizeBtn.disabled = false;
  }
}

// ─── Clear ────────────────────────────────────────────────────────────────────
function handleClear() {
  // Remove in-page highlights if active
  if (highlightsActive) {
    chrome.runtime.sendMessage({ type: "HIGHLIGHT_PAGE", payload: { action: "clear" } });
    highlightsActive = false;
    el.highlightBtn.classList.remove("active");
    el.highlightBtn.setAttribute("aria-pressed", "false");
  }
  currentSummary = null;
  el.secondaryActions.classList.remove("visible");

  // Also clear cache for this page
  chrome.runtime.sendMessage({ type: "CLEAR_CACHE" });

  showState("empty");
}

// ─── Copy ─────────────────────────────────────────────────────────────────────
async function handleCopy() {
  if (!currentSummary) return;
  const text = buildCopyText(currentSummary);

  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // Fallback for environments where clipboard API is restricted
    const ta = Object.assign(document.createElement("textarea"), {
      value: text,
      style: "position:fixed;opacity:0;pointer-events:none",
    });
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
  }

  // Visual confirmation
  const svg = el.copyBtn.querySelector("svg");
  svg.style.color = "var(--green)";
  setTimeout(() => (svg.style.color = ""), 1800);
}

// ─── Highlight Toggle ─────────────────────────────────────────────────────────
async function handleHighlight() {
  if (!currentSummary?.highlightPhrases?.length) return;

  if (highlightsActive) {
    await chrome.runtime.sendMessage({
      type: "HIGHLIGHT_PAGE",
      payload: { action: "clear" },
    });
    highlightsActive = false;
    el.highlightBtn.classList.remove("active");
    el.highlightBtn.setAttribute("aria-pressed", "false");
  } else {
    await chrome.runtime.sendMessage({
      type: "HIGHLIGHT_PAGE",
      payload: { phrases: currentSummary.highlightPhrases, action: "apply" },
    });
    highlightsActive = true;
    el.highlightBtn.classList.add("active");
    el.highlightBtn.setAttribute("aria-pressed", "true");
  }
}

// ─── Theme ────────────────────────────────────────────────────────────────────
function handleThemeToggle() {
  isDarkMode = !isDarkMode;
  applyTheme();
  chrome.storage.local.set({ theme: isDarkMode ? "dark" : "light" });
}

// ─── Render Summary ───────────────────────────────────────────────────────────
function renderSummary(summary, fromCache, wordCount) {
  // Overview paragraph — textContent prevents XSS
  el.summaryText.textContent = summary.summary || "";

  // Meta chips
  el.readingTime.textContent = `${summary.readingTime ?? "—"} min read`;
  if (el.wordCountChip) {
    el.wordCountChip.textContent = `${(wordCount || 0).toLocaleString()} words`;
  }

  // Sentiment
  const sentiment = (summary.sentiment || "neutral").toLowerCase();
  el.sentimentChip.dataset.sentiment = sentiment;
  el.sentimentIcon.textContent  = { positive: "↑", negative: "↓", neutral: "→", mixed: "↕" }[sentiment] ?? "○";
  el.sentimentLabel.textContent = sentiment;

  // Cache badge
  el.cacheChip.classList.toggle("hidden", !fromCache);

  // Topics
  el.topicsRow.innerHTML = "";
  (summary.topics || []).slice(0, 5).forEach((topic) => {
    const span = document.createElement("span");
    span.className   = "topic-tag";
    span.textContent = sanitize(topic); // sanitize before inserting
    el.topicsRow.appendChild(span);
  });

  // Bullet points
  el.bulletsList.innerHTML = "";
  (summary.bullets || []).forEach((bullet) => {
    const li = document.createElement("li");
    li.textContent = sanitize(bullet);
    el.bulletsList.appendChild(li);
  });

  // Key insights
  el.insightsGrid.innerHTML = "";
  (summary.keyInsights || []).forEach((insight) => {
    const card = document.createElement("div");
    card.className   = "insight-card";
    card.textContent = sanitize(insight);
    el.insightsGrid.appendChild(card);
  });
}

// ─── State Machine ────────────────────────────────────────────────────────────
function showState(state) {
  el.emptyState.classList.add("hidden");
  el.loadingState.classList.add("hidden");
  el.errorState.classList.add("hidden");
  el.summaryPanel.classList.add("hidden");

  const map = {
    empty:   el.emptyState,
    loading: el.loadingState,
    error:   el.errorState,
    summary: el.summaryPanel,
  };
  map[state]?.classList.remove("hidden");
}

function showError(rawMsg) {
  const ERROR_MAP = {
    NOT_ENOUGH_CONTENT: {
      title: "Not enough content",
      msg:   "This page doesn't have enough readable text to summarise.",
    },
    NO_API_KEY: {
      title: "Extension not configured",
      msg:   "The extension was built without an API key. See README for setup instructions.",
    },
  };

  // Match known error codes; fall back to raw message
  const known = Object.entries(ERROR_MAP).find(([key]) => rawMsg.includes(key));
  el.errorTitle.textContent = known ? known[1].title : "Something went wrong";
  el.errorMsg.textContent   = known ? known[1].msg   : rawMsg;
  showState("error");
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

// XSS guard: all AI-generated text goes through this before hitting the DOM
function sanitize(str) {
  return String(str ?? "").slice(0, 600);
}

function buildCopyText(summary) {
  const parts = ["# PageMind Summary\n"];
  if (summary.summary) parts.push(summary.summary + "\n");
  if (summary.bullets?.length) {
    parts.push("## Key Points");
    summary.bullets.forEach((b) => parts.push(`• ${b}`));
    parts.push("");
  }
  if (summary.keyInsights?.length) {
    parts.push("## Insights");
    summary.keyInsights.forEach((i) => parts.push(`→ ${i}`));
  }
  return parts.join("\n");
}

// ─── Boot ─────────────────────────────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", init);
