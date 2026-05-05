
// ─── State ─────────────────────────────────────────────────────────────────────
let currentSummary = null;
let highlightsActive = false;
let selectedMode = "standard";

// ─── DOM Refs ──────────────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);

const els = {
  pageTitle:        $("pageTitle"),
  pageDomain:       $("pageDomain"),
  pageFavicon:      $("pageFavicon"),
  emptyState:       $("emptyState"),
  loadingState:     $("loadingState"),
  loadingText:      $("loadingText"),
  errorState:       $("errorState"),
  errorTitle:       $("errorTitle"),
  errorMsg:         $("errorMsg"),
  summaryPanel:     $("summaryPanel"),
  summaryText:      $("summaryText"),
  bulletsList:      $("bulletsList"),
  insightsGrid:     $("insightsGrid"),
  readingTime:      $("readingTime"),
  sentimentChip:    $("sentimentChip"),
  sentimentLabel:   $("sentimentLabel"),
  sentimentIcon:    $("sentimentIcon"),
  topicsRow:        $("topicsRow"),
  cacheChip:        $("cacheChip"),
  secondaryActions: $("secondaryActions"),
  settingsOverlay:  $("settingsOverlay"),
  providerSelect:   $("providerSelect"),
  apiKeyInput:      $("apiKeyInput"),
  modelInput:       $("modelInput"),
  keyStatus:        $("keyStatus"),
  summarizeBtn:     $("summarizeBtn"),
  highlightBtn:     $("highlightBtn"),
  copyBtn:          $("copyBtn"),
  clearBtn:         $("clearBtn"),
  retryBtn:         $("retryBtn"),
  settingsBtn:      $("settingsBtn"),
  closeSettingsBtn: $("closeSettingsBtn"),
  saveSettingsBtn:  $("saveSettingsBtn"),
  clearCacheBtn:    $("clearCacheBtn"),
  toggleKeyBtn:     $("toggleKeyBtn"),
};

// ─── Init ──────────────────────────────────────────────────────────────────────
async function init() {
  await loadPageInfo();
  await loadSettings();
  setupListeners();
}

async function loadPageInfo() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) return;

    els.pageTitle.textContent = tab.title || "Untitled";
    try {
      const url = new URL(tab.url);
      els.pageDomain.textContent = url.hostname;

      // Favicon
      const img = document.createElement("img");
      img.src = `https://www.google.com/s2/favicons?domain=${url.hostname}&sz=32`;
      img.alt = "";
      img.onerror = () => img.remove();
      els.pageFavicon.appendChild(img);
    } catch {}
  } catch {}
}

async function loadSettings() {
  const res = await sendMessage({ type: "GET_SETTINGS" });
  if (!res) return;

  if (res.provider)  els.providerSelect.value = res.provider;
  if (res.apiKey)    els.apiKeyInput.value = res.apiKey;
  if (res.model)     els.modelInput.value = res.model;
  if (res.apiKey)    els.keyStatus.textContent = "✓ API key saved";
  if (res.summaryMode) {
    selectedMode = res.summaryMode;
    updateModeUI(selectedMode);
  }
}

// ─── Event Listeners ────────────────────────────────────────────────────────────
function setupListeners() {
  els.summarizeBtn.addEventListener("click", handleSummarize);
  els.retryBtn.addEventListener("click", handleSummarize);
  els.clearBtn.addEventListener("click", handleClear);
  els.copyBtn.addEventListener("click", handleCopy);
  els.highlightBtn.addEventListener("click", handleHighlight);

  els.settingsBtn.addEventListener("click", () => els.settingsOverlay.classList.remove("hidden"));
  els.closeSettingsBtn.addEventListener("click", () => els.settingsOverlay.classList.add("hidden"));
  els.settingsOverlay.addEventListener("click", (e) => {
    if (e.target === els.settingsOverlay) els.settingsOverlay.classList.add("hidden");
  });

  els.saveSettingsBtn.addEventListener("click", handleSaveSettings);
  els.clearCacheBtn.addEventListener("click", handleClearCache);

  els.toggleKeyBtn.addEventListener("click", () => {
    const isPassword = els.apiKeyInput.type === "password";
    els.apiKeyInput.type = isPassword ? "text" : "password";
  });

  // Mode selector
  document.querySelectorAll(".mode-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      selectedMode = btn.dataset.mode;
      updateModeUI(selectedMode);
    });
  });

  // Keyboard shortcuts
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      if (!els.settingsOverlay.classList.contains("hidden")) {
        els.settingsOverlay.classList.add("hidden");
      }
    }
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
      handleSummarize();
    }
  });
}

function updateModeUI(mode) {
  document.querySelectorAll(".mode-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.mode === mode);
  });
}

// ─── Core Actions ──────────────────────────────────────────────────────────────
async function handleSummarize() {
  showState("loading");
  els.loadingText.textContent = "Extracting content...";
  setSummarizeDisabled(true);

  try {
    // 1. Extract content from the page
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) throw new Error("Could not access the active tab.");

    let extracted;
    try {
      [extracted] = await chrome.tabs.sendMessage(tab.id, { type: "EXTRACT_CONTENT" })
        .then((r) => [r])
        .catch(() => [null]);
    } catch {}

    // Fallback: inject script directly if content script not ready
    if (!extracted?.success) {
      const results = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ["src/content.js"],
      });
      [extracted] = await chrome.tabs.sendMessage(tab.id, { type: "EXTRACT_CONTENT" })
        .then((r) => [r])
        .catch(() => [null]);
    }

    if (!extracted?.success) {
      throw new Error("Could not extract content from this page. Try reloading.");
    }

    els.loadingText.textContent = "Analyzing with AI...";

    // 2. Send to background for AI summarization
    const res = await sendMessage({
      type: "SUMMARIZE_PAGE",
      payload: {
        url: extracted.url,
        content: extracted.content,
        title: extracted.title,
        wordCount: extracted.wordCount,
        mode: selectedMode,
      },
    });

    if (!res?.success) {
      throw new Error(res?.error || "Unknown error");
    }

    currentSummary = res.summary;
    renderSummary(res.summary, res.fromCache);
    showState("summary");
    els.secondaryActions.classList.add("visible");

  } catch (err) {
    showError(err.message);
  } finally {
    setSummarizeDisabled(false);
  }
}

function handleClear() {
  currentSummary = null;
  if (highlightsActive) {
    sendMessage({ type: "HIGHLIGHT_PAGE", payload: { action: "clear" } });
    highlightsActive = false;
    els.highlightBtn.classList.remove("active");
  }
  showState("empty");
  els.secondaryActions.classList.remove("visible");
}

async function handleCopy() {
  if (!currentSummary) return;
  const text = buildCopyText(currentSummary);
  try {
    await navigator.clipboard.writeText(text);
    const icon = els.copyBtn.querySelector("svg");
    icon.style.color = "var(--positive)";
    setTimeout(() => (icon.style.color = ""), 1500);
  } catch {
    // Fallback
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.cssText = "position:fixed;opacity:0";
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
  }
}

async function handleHighlight() {
  if (!currentSummary?.highlightPhrases?.length) return;

  if (highlightsActive) {
    await sendMessage({ type: "HIGHLIGHT_PAGE", payload: { action: "clear" } });
    highlightsActive = false;
    els.highlightBtn.classList.remove("active");
  } else {
    await sendMessage({
      type: "HIGHLIGHT_PAGE",
      payload: { phrases: currentSummary.highlightPhrases, action: "apply" },
    });
    highlightsActive = true;
    els.highlightBtn.classList.add("active");
  }
}

async function handleSaveSettings() {
  const settings = {
    provider: els.providerSelect.value,
    apiKey: els.apiKeyInput.value.trim(),
    model: els.modelInput.value.trim() || undefined,
    summaryMode: selectedMode,
  };

  const res = await sendMessage({ type: "SAVE_SETTINGS", payload: settings });
  if (res?.success) {
    els.keyStatus.textContent = "✓ Settings saved";
    setTimeout(() => els.settingsOverlay.classList.add("hidden"), 800);
  }
}

async function handleClearCache() {
  await sendMessage({ type: "CLEAR_CACHE" });
  els.clearCacheBtn.textContent = "✓ Cleared";
  setTimeout(() => (els.clearCacheBtn.textContent = "Clear Cache"), 1500);
}

// ─── Render ───────────────────────────────────────────────────────────────────
function renderSummary(summary, fromCache) {
  // Overview
  els.summaryText.textContent = summary.summary || "";

  // Reading time
  els.readingTime.textContent = `${summary.readingTime ?? "—"} min read`;

  // Sentiment
  const sentiment = (summary.sentiment || "neutral").toLowerCase();
  els.sentimentChip.dataset.sentiment = sentiment;
  const icons = { positive: "↑", negative: "↓", neutral: "→", mixed: "↕" };
  els.sentimentIcon.textContent = icons[sentiment] || "○";
  els.sentimentLabel.textContent = sentiment;

  // Cache badge
  els.cacheChip.classList.toggle("hidden", !fromCache);

  // Topics
  els.topicsRow.innerHTML = "";
  (summary.topics || []).forEach((t) => {
    const span = document.createElement("span");
    span.className = "topic-tag";
    span.textContent = sanitizeText(t);
    els.topicsRow.appendChild(span);
  });

  // Bullets
  els.bulletsList.innerHTML = "";
  (summary.bullets || []).forEach((b) => {
    const li = document.createElement("li");
    li.textContent = sanitizeText(b);
    els.bulletsList.appendChild(li);
  });

  // Insights
  els.insightsGrid.innerHTML = "";
  (summary.keyInsights || []).forEach((insight) => {
    const card = document.createElement("div");
    card.className = "insight-card";
    card.textContent = sanitizeText(insight);
    els.insightsGrid.appendChild(card);
  });
}

// ─── State Management ─────────────────────────────────────────────────────────
function showState(state) {
  els.emptyState.classList.add("hidden");
  els.loadingState.classList.add("hidden");
  els.errorState.classList.add("hidden");
  els.summaryPanel.classList.add("hidden");

  switch (state) {
    case "empty":   els.emptyState.classList.remove("hidden"); break;
    case "loading": els.loadingState.classList.remove("hidden"); break;
    case "error":   els.errorState.classList.remove("hidden"); break;
    case "summary": els.summaryPanel.classList.remove("hidden"); break;
  }
}

function showError(msg) {
  const errorMap = {
    NO_API_KEY: {
      title: "No API key configured",
      msg: 'Open Settings (⚙) and add your API key to get started.',
    },
    NOT_ENOUGH_CONTENT: {
      title: "Not enough content",
      msg: "This page doesn't have enough readable text to summarize.",
    },
  };

  const mapped = errorMap[msg];
  els.errorTitle.textContent = mapped?.title || "Something went wrong";
  els.errorMsg.textContent = mapped?.msg || msg;
  showState("error");
}

function setSummarizeDisabled(disabled) {
  els.summarizeBtn.disabled = disabled;
  els.summarizeBtn.style.opacity = disabled ? "0.6" : "";
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
// XSS prevention: only set text content, never innerHTML from AI output
function sanitizeText(str) {
  return String(str || "").slice(0, 500);
}

function buildCopyText(summary) {
  const lines = ["# Page Summary\n"];
  if (summary.summary) lines.push(`${summary.summary}\n`);
  if (summary.bullets?.length) {
    lines.push("## Key Points");
    summary.bullets.forEach((b) => lines.push(`• ${b}`));
    lines.push("");
  }
  if (summary.keyInsights?.length) {
    lines.push("## Insights");
    summary.keyInsights.forEach((i) => lines.push(`→ ${i}`));
  }
  return lines.join("\n");
}

async function sendMessage(msg) {
  try {
    return await chrome.runtime.sendMessage(msg);
  } catch (err) {
    console.error("[PageMind] Message error:", err);
    return null;
  }
}

// ─── Boot ─────────────────────────────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", init);
