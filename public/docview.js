"use strict";

/* ============================ Technical Doc Preview Mode =================== */
// A beautiful, ergonomically styled technical documentation viewer that sits
// in place of the Monaco code editor. It renders chapters like GitHub/GitBook/
// Notion documentation preview: crisp typography, comfortable line height,
// reading time estimates, paragraph highlighting, and smooth mobile touch gestures.

const docView = {
  host: null,
  body: null,
  curChapter: null,

  init() {
    this.host = $("#doc-host");
    if (!this.host) return;
    this.host.addEventListener("scroll", () => {
      if (!state.current || !isDocMode()) return;
      updatePos();
      extEvent("scroll");
      clearTimeout(state.saveTimer);
      state.saveTimer = setTimeout(() => saveProgress(view.ratio), 700);
    }, { passive: true });

    // Handle clicks for paragraph highlights, chapter links and nav buttons
    this.host.addEventListener("click", (e) => {
      const navBtn = e.target.closest("[data-nav-delta]");
      if (navBtn) {
        e.preventDefault();
        const delta = parseInt(navBtn.dataset.navDelta, 10);
        if (!isNaN(delta)) navChapter(delta);
        return;
      }

      const hlEl = e.target.closest(".doc-hl");
      if (hlEl) {
        const pIdx = parseInt(hlEl.dataset.p, 10);
        const start = parseInt(hlEl.dataset.start, 10);
        if (!isNaN(pIdx) && !isNaN(start)) {
          removeHighlightAt(pIdx, start);
          this.paintHighlights();
        }
        return;
      }
    });

    // Handle text selection highlighting
    this.host.addEventListener("mouseup", () => {
      if (!state.current || state.settings.camo || !isDocMode()) return;
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || !sel.rangeCount) return;
      const range = sel.getRangeAt(0);
      const pEl = range.commonAncestorContainer.nodeType === Node.ELEMENT_NODE
        ? range.commonAncestorContainer.closest("[data-p]")
        : range.commonAncestorContainer.parentElement.closest("[data-p]");
      if (!pEl) return;
      const pIdx = parseInt(pEl.dataset.p, 10);
      if (isNaN(pIdx)) return;

      const rawText = pEl.textContent || "";
      const selectedText = sel.toString().trim();
      if (selectedText.length < 2) return;
      const start = rawText.indexOf(selectedText);
      if (start >= 0) {
        addHighlight(pIdx, start, start + selectedText.length);
        sel.removeAllRanges();
        this.paintHighlights();
      }
    });
  },

  get top() {
    return this.host ? this.host.scrollTop : 0;
  },
  set top(v) {
    if (this.host) this.host.scrollTop = Math.max(0, v);
  },
  get max() {
    if (!this.host) return 0;
    return Math.max(0, this.host.scrollHeight - this.host.clientHeight);
  },

  paintHighlights() {
    if (!this.host || !state.current || isDocMode() === false) return;
    const pElements = this.host.querySelectorAll("[data-p]");
    const highlights = state.hl || [];

    // Group highlights by paragraph
    const hlByP = {};
    for (const h of highlights) {
      if (!hlByP[h.p]) hlByP[h.p] = [];
      hlByP[h.p].push(h);
    }

    pElements.forEach((el) => {
      const pIdx = parseInt(el.dataset.p, 10);
      const originalText = el.dataset.rawText || el.textContent;
      el.dataset.rawText = originalText;
      const pHighlights = hlByP[pIdx];

      if (!pHighlights || !pHighlights.length || state.settings.camo) {
        el.textContent = originalText;
        return;
      }

      // Sort highlights by start
      pHighlights.sort((a, b) => a.start - b.start);
      const frag = document.createDocumentFragment();
      let lastIdx = 0;

      for (const h of pHighlights) {
        if (h.start > lastIdx) {
          frag.appendChild(document.createTextNode(originalText.slice(lastIdx, h.start)));
        }
        const span = document.createElement("span");
        span.className = "doc-hl";
        span.dataset.p = String(pIdx);
        span.dataset.start = String(h.start);
        span.title = "Click to remove highlight";
        span.textContent = originalText.slice(h.start, h.end);
        frag.appendChild(span);
        lastIdx = Math.max(lastIdx, h.end);
      }
      if (lastIdx < originalText.length) {
        frag.appendChild(document.createTextNode(originalText.slice(lastIdx)));
      }
      el.innerHTML = "";
      el.appendChild(frag);
    });
  },

  render(ch) {
    if (!this.host) this.init();
    this.curChapter = ch;
    const host = this.host;
    host.innerHTML = "";

    const cur = state.current;
    const book = cur.book;
    const chapters = book && book._chapters ? book._chapters : [];
    const curIdx = ch.idx;

    const article = document.createElement("article");
    article.className = "doc-article";

    // Header info bar
    const headBar = document.createElement("div");
    headBar.className = "doc-meta-bar";

    const pathTag = document.createElement("span");
    pathTag.className = "doc-badge path";
    pathTag.textContent = `src/${cur.code_name}/${fileLabel(ch)}`;
    headBar.appendChild(pathTag);

    const modeBadge = document.createElement("span");
    modeBadge.className = "doc-badge mode";
    modeBadge.textContent = "Markdown Preview";
    headBar.appendChild(modeBadge);

    // Calculate approximate word count & read time
    const blocks = ch._blocks || ch.blocks || [];
    let charCount = 0;
    blocks.forEach((b) => { charCount += (b.text || "").length; });
    const approxWords = Math.round(charCount / 5);
    const readMin = Math.max(1, Math.round(approxWords / 200));

    const timeBadge = document.createElement("span");
    timeBadge.className = "doc-badge time";
    timeBadge.textContent = `~${readMin} min read · ${charCount.toLocaleString()} chars`;
    headBar.appendChild(timeBadge);

    article.appendChild(headBar);

    // Chapter Title
    const titleEl = document.createElement("h1");
    titleEl.className = "doc-title";
    titleEl.textContent = ch.title || fileLabel(ch);
    article.appendChild(titleEl);

    // Content paragraphs
    const bodyEl = document.createElement("div");
    bodyEl.className = "doc-prose";
    this.body = bodyEl;

    const camo = state.settings.camo;
    const firstIsHeading = blocks.length && blocks[0].type !== "p";
    let startIdx = 0;
    if (firstIsHeading && blocks[0].text === ch.title) {
      startIdx = 1;
    }

    for (let bi = startIdx; bi < blocks.length; bi++) {
      const b = blocks[bi];
      const text = (b.text || "").trim();
      if (!text) continue;

      if (b.type === "h1" || b.type === "h2" || b.type === "h3") {
        const h = document.createElement(b.type);
        h.className = `doc-heading ${b.type}`;
        h.textContent = camo ? `// ${text}` : text;
        bodyEl.appendChild(h);
      } else {
        const p = document.createElement("p");
        p.dataset.p = String(bi);
        p.dataset.rawText = text;
        if (camo) {
          if (state.settings.camoStyle !== "comment") {
            p.className = "doc-p camo-docstring";
            p.innerHTML = `<span class="camo-syntax">/**<br>&nbsp;* @summary</span> ${esc(text)}<br><span class="camo-syntax">&nbsp;*/</span>`;
          } else {
            p.className = "doc-p camo-p";
            p.textContent = `// ${text}`;
          }
        } else {
          p.className = "doc-p";
          p.textContent = text;
        }
        bodyEl.appendChild(p);
      }
    }
    article.appendChild(bodyEl);

    // Bottom Chapter Navigation Cards
    const footerNav = document.createElement("div");
    footerNav.className = "doc-footer-nav";

    if (curIdx > 0 && chapters[curIdx - 1]) {
      const prevCh = chapters[curIdx - 1];
      const prevCard = document.createElement("button");
      prevCard.type = "button";
      prevCard.className = "doc-nav-card prev";
      prevCard.dataset.navDelta = "-1";
      prevCard.innerHTML = `
        <span class="doc-nav-dir">◄ Previous</span>
        <span class="doc-nav-title">${esc(displayName(prevCh))}</span>
      `;
      footerNav.appendChild(prevCard);
    } else {
      footerNav.appendChild(document.createElement("div")); // spacer
    }

    if (curIdx < chapters.length - 1 && chapters[curIdx + 1]) {
      const nextCh = chapters[curIdx + 1];
      const nextCard = document.createElement("button");
      nextCard.type = "button";
      nextCard.className = "doc-nav-card next";
      nextCard.dataset.navDelta = "1";
      nextCard.innerHTML = `
        <span class="doc-nav-dir">Next ►</span>
        <span class="doc-nav-title">${esc(displayName(nextCh))}</span>
      `;
      footerNav.appendChild(nextCard);
    }

    article.appendChild(footerNav);
    host.appendChild(article);
    this.paintHighlights();
  },
};

function isDocMode() {
  return state.settings.viewMode === "doc";
}

function setViewMode(mode) {
  if (state.settings.viewMode === mode) return;
  state.settings.viewMode = mode;
  saveSettings();
  updateViewModeDOM();
  rerender();
}

function toggleViewMode() {
  setViewMode(isDocMode() ? "code" : "doc");
}

function updateViewModeDOM() {
  const isDoc = isDocMode();
  const btn = $("#btn-toggle-viewmode");
  if (btn) {
    btn.classList.toggle("active", isDoc);
    btn.title = isDoc ? "Switch to Monaco Code View" : "Switch to Technical Doc Preview";
    const icoName = isDoc ? "file-code" : "book";
    btn.dataset.icon = icoName;
    btn.className = `tb-icon ico codicon codicon-${icoName}` + (isDoc ? " active" : "");
  }
}

window.docView = docView;
window.isDocMode = isDocMode;
window.setViewMode = setViewMode;
window.toggleViewMode = toggleViewMode;
