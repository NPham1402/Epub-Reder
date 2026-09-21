"use strict";

/* ============================ Icons (VS Code codicons) ===================== */
const CODI = {
  logo: "code", files: "files", search: "search", "git-branch": "source-control",
  run: "debug-alt", extensions: "extensions", account: "account", settings: "settings-gear",
  plus: "add", import: "cloud-download", eye: "eye", close: "close",
  "win-min": "chrome-minimize", "win-max": "chrome-maximize", "win-close": "chrome-close",
  error: "error", warning: "warning", sync: "sync", bell: "bell", terminal: "terminal",
  file: "file-code", folder: "folder", "folder-open": "folder-opened",
  "chevron-right": "chevron-right", "chevron-down": "chevron-down", trash: "trash",
};
const codiName = (name) => CODI[name] || name;
const codiCls = (name, extra) => "codicon codicon-" + codiName(name) + (extra ? " " + extra : "");
function injectIcons(root = document) {
  root.querySelectorAll("[data-icon]").forEach((e) => {
    const c = CODI[e.dataset.icon];
    if (c) e.classList.add("codicon", "codicon-" + c);
  });
}

/* ============================ State ======================================== */
const DEFAULT_PANIC_CODE = "unlock";
const state = {
  books: [],
  expanded: new Set(),
  tabs: [], // [{bookId, idx}]
  activeKey: null, // "bookId:idx"
  current: null,
  scroll: {}, // key -> scrollTop
  revealTitles: false,
  saveTimer: null,
  settings: loadSettings(),
};

const $ = (s) => document.querySelector(s);
const el = (t, c, txt) => {
  const n = document.createElement(t);
  if (c) n.className = c;
  if (txt != null) n.textContent = txt;
  return n;
};
const esc = (s) =>
  String(s).replace(/[&<>"']/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]));
const tabKey = (b, i) => `${b}:${i}`;
// Tabs are either a chapter {bookId, idx} or an extension page {ext}.
const extKey = (id) => "ext:" + id;
const isExtKey = (k) => typeof k === "string" && k.startsWith("ext:");
const tabId = (t) => (t.ext ? extKey(t.ext) : tabKey(t.bookId, t.idx));
// extensions.js listens; safe to call before/without it.
function extEvent(name) { if (typeof onExtEvent === "function") onExtEvent(name); }

/* ============================ Reader (Monaco) ============================== */
// The reading pane is a real Monaco editor (the editor VS Code itself is
// built on): real line numbers, minimap, find widget (Ctrl+F) and selection.
// Each paragraph is one model line followed by a blank line, so highlights are
// still stored as (paragraph, start, end).
const READER_LANG = "devdocs-prose";
const reader = {
  ed: null,       // the Monaco editor, created on first use
  creating: null, // promise while it is being created
  meta: [],       // per model line (0-based): { kind, p? }
  paraLine: [],   // paragraph index -> 1-based model line
  hl: null,       // decoration collections, recreated with each model
  focus: null,
  nav: null,
  raf: 0,
};

// Monaco is ~3 MB, so it loads on first use (and is warmed up after login).
let monacoLoading = null;
function ensureMonaco() {
  if (window.monaco) return Promise.resolve(window.monaco);
  if (monacoLoading) return monacoLoading;
  monacoLoading = new Promise((resolve, reject) => {
    const css = document.createElement("link");
    css.rel = "stylesheet";
    css.href = "/vendor/monaco/monaco.css";
    document.head.appendChild(css);
    const s = document.createElement("script");
    s.src = "/vendor/monaco/monaco.js";
    s.onload = () => (window.monaco ? resolve(window.monaco) : reject(new Error("editor missing")));
    s.onerror = () => reject(new Error("could not load the editor"));
    document.head.appendChild(s);
  }).catch((err) => { monacoLoading = null; throw err; });
  return monacoLoading;
}

const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const hex = (v, fallback) => (/^#[0-9a-f]{6}$/i.test(v) ? v : fallback);

function setupMonaco(monaco) {
  monaco.languages.register({ id: READER_LANG });
  monaco.languages.setMonarchTokensProvider(READER_LANG, {
    tokenizer: {
      root: [
        [/^\s*\/\/.*$/, "comment"],
        [/^(#{1,6} )(.*)$/, ["comment", "heading"]],
        [/"[^"]*"|“[^”]*”|«[^»]*»/, "string"],
        [/[^"“«]+/, ""],
        [/./, ""],
      ],
    },
  });
  defineReaderTheme(monaco);
}

// (Re)builds the editor's theme from the current CSS variables; called at start
// and whenever the color theme changes.
function defineReaderTheme(monaco) {
  const light = document.documentElement.style.colorScheme === "light";
  monaco.editor.defineTheme("devdocs", {
    base: light ? "vs" : "vs-dark",
    inherit: true,
    rules: [
      { token: "comment", foreground: hex(cssVar("--tok-comment"), "#6a9955").slice(1) },
      { token: "heading", foreground: hex(cssVar("--tok-heading"), "#569cd6").slice(1), fontStyle: "bold" },
      { token: "string", foreground: hex(cssVar("--tok-string"), "#ce9178").slice(1), fontStyle: "bold" },
    ],
    colors: {
      "editor.background": hex(cssVar("--editor-bg"), "#1e1e1e"),
      "editor.foreground": hex(cssVar("--editor-fg"), "#d4d4d4"),
      "editorLineNumber.foreground": hex(cssVar("--ln"), "#858585"),
      "editorLineNumber.activeForeground": hex(cssVar("--ln-active"), "#c6c6c6"),
      "editor.selectionBackground": hex(cssVar("--selection"), "#264f78"),
      "editor.inactiveSelectionBackground": hex(cssVar("--list-inactive"), "#3a3d41"),
      "scrollbarSlider.background": light ? "#64646466" : "#79797966",
      "scrollbarSlider.hoverBackground": light ? "#646464b3" : "#646464b3",
      "scrollbarSlider.activeBackground": light ? "#00000099" : "#bfbfbf66",
    },
  });
}

function readerOptions() {
  const serif = !!state.settings.serif;
  const size = state.settings.fontSize;
  return {
    fontFamily: serif
      ? 'Cambria, "Palatino Linotype", Georgia, "Times New Roman", serif'
      : '"Cascadia Code", "Consolas", "Droid Sans Mono", "Courier New", monospace',
    fontSize: size,
    lineHeight: Math.round(size * (serif ? 1.9 : 1.6)),
    wordWrapColumn: state.settings.readWidth,
  };
}
function applyReaderOptions() {
  if (!reader.ed) return;
  reader.ed.updateOptions(readerOptions());
  paintFocus();
}

// One place that knows how to read/set the reader's scroll position, so the
// progress, keyboard and session code doesn't care what draws the text.
const view = {
  get top() { return reader.ed ? reader.ed.getScrollTop() : 0; },
  set top(v) { if (reader.ed) reader.ed.setScrollTop(Math.max(0, v)); },
  get max() {
    const e = reader.ed;
    return e ? Math.max(0, e.getScrollHeight() - e.getLayoutInfo().height) : 0;
  },
  get ratio() { const m = this.max; return m > 0 ? this.top / m : 0; },
};

function getReader() {
  if (reader.ed) return Promise.resolve(reader.ed);
  if (reader.creating) return reader.creating;
  reader.creating = ensureMonaco().then((monaco) => {
    setupMonaco(monaco);
    const ed = monaco.editor.create($("#monaco-host"), {
      model: null,
      language: READER_LANG,
      theme: "devdocs",
      ...readerOptions(),
      readOnly: true,
      domReadOnly: true,
      automaticLayout: true,
      lineNumbers: "on",
      lineNumbersMinChars: 4,
      lineDecorationsWidth: 24,
      glyphMargin: false,
      folding: false,
      wordWrap: "bounded",
      wrappingIndent: "none",
      minimap: { enabled: true, renderCharacters: false, maxColumn: 60 },
      scrollBeyondLastLine: true,
      renderLineHighlight: "none",
      occurrencesHighlight: "off",
      selectionHighlight: false,
      matchBrackets: "never",
      contextmenu: false,
      links: false,
      hover: { enabled: false },
      quickSuggestions: false,
      dragAndDrop: false,
      emptySelectionClipboard: false,
      guides: { indentation: false },
      overviewRulerLanes: 0,
      hideCursorInOverviewRuler: true,
      overviewRulerBorder: false,
      stickyScroll: { enabled: false },
      padding: { top: 4 },
      scrollbar: { useShadows: false, verticalScrollbarSize: 14, alwaysConsumeMouseWheel: false },
      // Vietnamese/Chinese text must not get "ambiguous character" boxes.
      unicodeHighlight: { ambiguousCharacters: false, invisibleCharacters: false, nonBasicASCII: false },
      find: { addExtraSpaceOnTop: false, seedSearchStringFromSelection: "selection" },
    });

    // Select prose to mark it; click a mark to remove it; click an "import"
    // line to change chapter.
    ed.onMouseUp((e) => {
      if (!state.current || !e.event.leftButton) return;
      const sel = ed.getSelection();
      if (sel && !sel.isEmpty()) {
        if (state.settings.camo || sel.startLineNumber !== sel.endLineNumber) return;
        const m = reader.meta[sel.startLineNumber - 1];
        if (!m || m.kind !== "p") return;
        addHighlight(m.p, sel.startColumn - 1, sel.endColumn - 1);
        ed.setSelection(new monaco.Selection(sel.startLineNumber, 1, sel.startLineNumber, 1));
        return;
      }
      const pos = e.target.position;
      const m = pos && reader.meta[pos.lineNumber - 1];
      if (!m) return;
      if (m.kind === "navPrev") navChapter(-1);
      else if (m.kind === "navNext") navChapter(1);
      else if (m.kind === "p") removeHighlightAt(m.p, pos.column - 1);
    });
    ed.onDidScrollChange((e) => {
      if (!e.scrollTopChanged || !state.current) return;
      updatePos();
      extEvent("scroll");
      if (!reader.raf) reader.raf = requestAnimationFrame(() => { reader.raf = 0; paintFocus(); });
      clearTimeout(state.saveTimer);
      state.saveTimer = setTimeout(() => saveProgress(view.ratio), 700);
    });
    reader.ed = ed;
    return ed;
  }).catch((err) => { reader.creating = null; throw err; });
  return reader.creating;
}

// ---- Manual highlighter (marker) -------------------------------------------
const hlKey = (bookId, idx) => `devdocs.hl:${bookId}:${idx}`;
function loadHighlights(bookId, idx) {
  try { return JSON.parse(localStorage.getItem(hlKey(bookId, idx)) || "[]"); } catch { return []; }
}
function saveHighlights() {
  if (!state.current) return;
  localStorage.setItem(hlKey(state.current.bookId, state.current.idx), JSON.stringify(state.hl));
  if (typeof syncHighlightsSoon === "function") syncHighlightsSoon(state.current.bookId, state.current.idx);
}
function paintHighlights() {
  const ed = reader.ed;
  if (!ed || !reader.hl) return;
  const R = window.monaco.Range;
  reader.hl.set(state.settings.camo ? [] : (state.hl || [])
    .filter((h) => reader.paraLine[h.p])
    .map((h) => {
      const ln = reader.paraLine[h.p];
      return { range: new R(ln, h.start + 1, ln, h.end + 1), options: { inlineClassName: "hl" } };
    }));
}
function addHighlight(p, start, end) {
  state.hl.push({ p, start, end });
  saveHighlights();
  paintHighlights();
}
function removeHighlightAt(p, pos) {
  const before = state.hl.length;
  state.hl = state.hl.filter((h) => !(h.p === p && pos >= h.start && pos < h.end));
  if (state.hl.length !== before) { saveHighlights(); paintHighlights(); }
}

// ---- Focus current paragraph ------------------------------------------------
// Paragraphs are dimmed by CSS; the one nearest the reading line (42% down the
// viewport) is marked so it stays bright.
function activeParagraphLine() {
  const ed = reader.ed;
  const lines = reader.paraLine;
  if (!ed || !lines.length) return 0;
  const y = ed.getScrollTop() + ed.getLayoutInfo().height * 0.42;
  let lo = 0, hi = lines.length - 1, best = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (ed.getTopForLineNumber(lines[mid]) <= y) { best = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return lines[best];
}
function paintFocus() {
  const ed = reader.ed;
  if (!ed || !reader.focus) return;
  const on = !!state.settings.readFocus && !state.settings.camo;
  $("#monaco-host").classList.toggle("focusread", on);
  if (!on) { reader.focus.clear(); return; }
  const ln = activeParagraphLine();
  const model = ed.getModel();
  reader.focus.set(ln && model
    ? [{ range: new window.monaco.Range(ln, 1, ln, model.getLineMaxColumn(ln)), options: { inlineClassName: "reading-text" } }]
    : []);
}

function loadSettings() {
  let s = {};
  try { s = JSON.parse(localStorage.getItem("devdocs.settings") || "{}"); } catch {}
  return {
    blurHide: !!s.blurHide,
    camo: !!s.camo,
    serif: !!s.serif,
    readFocus: s.readFocus !== false,
    fontSize: s.fontSize || 15,
    readWidth: s.readWidth || 82,
    panicCode: (s.panicCode || DEFAULT_PANIC_CODE).toLowerCase(),
    extensions: s.extensions && typeof s.extensions === "object" ? s.extensions : {},
    theme: s.theme || "dark",
    readSpeed: s.readSpeed || 900,
    remindMin: s.remindMin == null ? 60 : s.remindMin,
    librarySort: s.librarySort || "recent",
  };
}
function saveSettings() {
  localStorage.setItem("devdocs.settings", JSON.stringify(state.settings));
  if (typeof syncSettingsSoon === "function") syncSettingsSoon();
}
function saveSession() {
  localStorage.setItem("devdocs.session", JSON.stringify({ tabs: state.tabs, activeKey: state.activeKey }));
}

/* ============================ API ========================================== */
async function api(path, opts = {}) {
  return fetch(path, {
    credentials: "same-origin",
    headers: opts.body && !(opts.body instanceof FormData) ? { "content-type": "application/json" } : undefined,
    ...opts,
  });
}

/* ============================ Boot / auth ================================== */
async function boot() {
  const res = await api("/api/books");
  if (res.status === 401) { showLogin(); return; }
  const data = await res.json();
  state.books = data.books || [];
  $("#app").hidden = false;
  applySettingsToDom();
  await restoreSession();
  renderTree();
  const warm = () => ensureMonaco().catch(() => {});
  if ("requestIdleCallback" in window) requestIdleCallback(warm); else setTimeout(warm, 1500);
  if (typeof syncBoot === "function") syncBoot();
}

function showLogin() {
  $("#login").hidden = false;
  setTimeout(() => $("#login-pass").focus(), 50);
}
$("#login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const res = await api("/api/auth", { method: "POST", body: JSON.stringify({ passcode: $("#login-pass").value }) });
  if (res.ok) {
    $("#login").hidden = true;
    $("#login-pass").value = "";
    boot();
  } else {
    const wait = Number(res.headers.get("retry-after")) || 0;
    $("#login-error").textContent = res.status === 429
      ? `Too many attempts. Try again in ${Math.max(1, Math.ceil(wait / 60))} min.`
      : "Invalid access key.";
    $("#login-error").hidden = false;
    $("#login-pass").select();
  }
});

/* ============================ Helpers ====================================== */
function extOf(name) { const m = name.match(/\.([a-z0-9]+)$/i); return m ? m[1].toLowerCase() : ""; }
function extClass(name) {
  const e = extOf(name);
  return ["ts", "tsx", "md", "py", "go", "rs", "sql", "java", "kt", "yaml"].includes(e) ? "ext-" + e : "ext-default";
}
function langOf(name) {
  const map = { ts: "TypeScript", tsx: "TypeScript JSX", md: "Markdown", py: "Python", go: "Go", rs: "Rust", sql: "SQL", java: "Java", yaml: "YAML", kt: "Kotlin" };
  return map[extOf(name)] || "Markdown";
}
// Parse the real chapter number from a title (Chương/Chapter/Hồi/Quyển N, 第N章…).
function parseChapterNo(title) {
  if (!title) return null;
  let m = String(title).match(/(?:chương|chapter|chap|hồi|quyển|tập)\s*\.?\s*0*(\d{1,5})/i);
  if (m) return parseInt(m[1], 10);
  m = String(title).match(/第\s*0*(\d{1,5})\s*[章回]/);
  if (m) return parseInt(m[1], 10);
  return null;
}
// "0025_mesh_store.java" -> "mesh_store.java"
function suffixOf(fileName) { return String(fileName).replace(/^\d+_/, ""); }

// Align the fake file number with the book's real chapter numbers so the tree
// number matches "Chương N". Front matter (no number) stays unnumbered. If no
// chapter in the book has a parseable number, keep the original sequence.
function computeLabels(chapters) {
  const hasNumbers = chapters.some((c) => parseChapterNo(c.title) != null);
  for (const ch of chapters) {
    if (!hasNumbers) { ch._label = ch.file_name; continue; }
    const no = parseChapterNo(ch.title);
    ch._label = no != null ? String(no).padStart(4, "0") + "_" + suffixOf(ch.file_name) : suffixOf(ch.file_name);
  }
}
function fileLabel(ch) { return ch._label || ch.file_name; }
function displayName(ch) { return state.revealTitles ? (ch.title || fileLabel(ch)) : fileLabel(ch); }
function bookLabel(book) { return state.revealTitles && book && book.title ? book.title : book.code_name; }
function bookById(id) { return state.books.find((b) => b.id === id); }
function chapterOf(bookId, idx) { const b = bookById(bookId); return b && b._chapters ? b._chapters[idx] : null; }

// Load only the chapter index (metadata, a few KB). Chapter text is fetched
// lazily, one chapter at a time. Auto-migrates old single-blob books.
async function loadBookIndex(book) {
  if (book._chapters) return true;
  let res = await api(`/api/books/${book.id}/index`);
  if (!res.ok) return false;
  let data = await res.json();
  if (data.ingest_done === 0) {
    // A re-index that was interrupted: pick it up where it stopped.
    await ingestChapters(book.id).catch(() => {});
    res = await api(`/api/books/${book.id}/index`);
    if (!res.ok) return false;
    data = await res.json();
  } else if ((!data.chapters || !data.chapters.length) && data.chapter_count > 0) {
    // Old-format book (content stored as one blob) — re-index from its .epub.
    await api(`/api/books/${book.id}/reindex`, { method: "POST" }).catch(() => {});
    await ingestChapters(book.id).catch(() => {});
    res = await api(`/api/books/${book.id}/index`);
    if (!res.ok) return false;
    data = await res.json();
  }
  book._chapters = (data.chapters || []).map((c) => ({ ...c, title: c.title ? c.title.normalize("NFC") : c.title }));
  computeLabels(book._chapters);
  book._progress = data.progress || null;
  if (data.code_name) book.code_name = data.code_name;
  if (data.title) book.title = data.title.normalize("NFC");
  if (data.progress && data.progress.furthest_idx != null) book._furthest = { idx: data.progress.furthest_idx, ratio: data.progress.furthest_ratio || 0 };
  if (typeof syncBookHighlights === "function") syncBookHighlights(book.id);
  return true;
}

// Fetch and cache a single chapter's blocks on demand.
async function loadChapter(book, idx) {
  const ch = book._chapters && book._chapters[idx];
  if (!ch) return null;
  if (ch._blocks) return ch;
  const res = await api(`/api/books/${book.id}/chapters/${idx}`);
  if (!res.ok) return null;
  const data = await res.json();
  // Normalize to NFC so combining Vietnamese diacritics compose into single
  // glyphs — otherwise serif fonts render "a + ◌̂ + ◌́" as a broken "ấ".
  ch._blocks = (data.blocks || []).map((b) => ({ type: b.type, text: (b.text || "").normalize("NFC") }));
  return ch;
}

// Prefetch neighbouring chapters so paging feels instant while staying lazy.
function prefetchAround(book, idx) {
  if (document.hidden || panicVisible) return; // nobody is reading; don't spend the bandwidth
  loadChapter(book, idx + 1).catch(() => {});
  if (idx > 0) loadChapter(book, idx - 1).catch(() => {});
}

/* ============================ Tree ========================================= */
function renderTree() {
  const tree = $("#tree");
  tree.innerHTML = "";
  for (const book of state.books) {
    const node = el("div", "tree-book");
    const row = el("div", "tree-row");
    const open = state.expanded.has(book.id);
    const caret = el("span", "tree-caret " + codiCls(open ? "chevron-down" : "chevron-right"));
    const fico = el("span", "tree-ico tree-folder " + codiCls(open ? "folder-open" : "folder"));
    row.appendChild(caret);
    row.appendChild(fico);
    row.appendChild(el("span", "tree-label", bookLabel(book)));
    const del = el("span", "tree-del " + codiCls("trash"));
    del.title = "Remove module";
    del.addEventListener("click", (e) => { e.stopPropagation(); removeBook(book); });
    row.appendChild(del);
    row.addEventListener("click", () => toggleBook(book.id));
    node.appendChild(row);

    const children = el("div", "tree-children" + (open ? "" : " collapsed"));
    if (open && book._chapters) {
      for (const ch of book._chapters) {
        const f = el("div", "tree-row tree-file");
        if (state.activeKey === tabKey(book.id, ch.idx)) f.classList.add("active");
        const ico = el("span", "tree-ico " + codiCls("file", extClass(fileLabel(ch))));
        f.appendChild(ico);
        f.appendChild(el("span", "tree-label", displayName(ch)));
        f.addEventListener("click", () => openTab(book.id, ch.idx));
        children.appendChild(f);
      }
    }
    node.appendChild(children);
    tree.appendChild(node);
  }
  const n = state.books.length;
  $("#sb-footer").textContent = `${n} module${n === 1 ? "" : "s"}`;
}

async function toggleBook(bookId) {
  const book = bookById(bookId);
  if (!book) return;
  if (state.expanded.has(bookId)) { state.expanded.delete(bookId); renderTree(); return; }
  if (!(await loadBookIndex(book))) return;
  state.expanded.add(bookId);
  renderTree();
  // First open of a book with no tab yet: resume from saved progress.
  if (book._progress && !state.tabs.some((t) => t.bookId === bookId)) {
    openTab(bookId, book._progress.chapter_idx || 0);
  }
}

async function removeBook(book) {
  if (!confirm(`Remove module "${book.code_name}"? This deletes it permanently.`)) return;
  const res = await api(`/api/books/${book.id}`, { method: "DELETE" });
  if (!res.ok) return;
  state.books = state.books.filter((b) => b.id !== book.id);
  state.expanded.delete(book.id);
  state.tabs = state.tabs.filter((t) => t.bookId !== book.id);
  if (state.current && state.current.bookId === book.id) {
    state.activeKey = null;
    if (state.tabs.length) activate(tabId(state.tabs[0]));
    else showWelcome();
  }
  renderTabs();
  renderTree();
  saveSession();
}

/* ============================ Tabs ========================================= */
function openTab(bookId, idx) {
  if (!state.tabs.some((t) => t.bookId === bookId && t.idx === idx)) state.tabs.push({ bookId, idx });
  activate(tabKey(bookId, idx));
}

async function activate(key) {
  if (isExtKey(key)) return activateExt(key.slice(4));
  const [bookId, idxStr] = key.split(":");
  const idx = Number(idxStr);
  const book = bookById(bookId);
  if (!book) return;
  if (!(await loadBookIndex(book))) return;
  if (idx < 0 || idx >= book._chapters.length) return;

  captureScroll();
  state.activeKey = key;
  state.expanded.add(bookId);
  const ch = await loadChapter(book, idx);
  if (!ch) return;
  state.current = { bookId, idx, code_name: book.code_name, fileName: fileLabel(ch), title: ch.title, book };
  await renderContent(ch);
  if (state.activeKey !== key) return; // superseded while the editor was loading
  renderTabs();
  renderTree();
  renderBreadcrumbs();
  updateStatusFile();
  restoreScroll(key, book, idx);
  saveSession();
  extEvent("chapter");
  prefetchAround(book, idx);
}

function navChapter(delta) {
  if (!state.activeKey) return;
  const [b, iStr] = state.activeKey.split(":");
  const idx = Number(iStr) + delta;
  const book = bookById(b);
  if (!book || !book._chapters || idx < 0 || idx >= book._chapters.length) return;
  const ti = state.tabs.findIndex((t) => tabId(t) === state.activeKey);
  if (ti >= 0) state.tabs[ti] = { bookId: b, idx };
  activate(tabKey(b, idx));
}

function switchToTabIndex(i) {
  if (i < 0 || i >= state.tabs.length) return;
  activate(tabId(state.tabs[i]));
}

function closeTab(key) {
  const i = state.tabs.findIndex((t) => tabId(t) === key);
  if (i < 0) return;
  state.tabs.splice(i, 1);
  delete state.scroll[key];
  if (state.activeKey === key) {
    if (state.tabs.length) {
      const n = Math.min(i, state.tabs.length - 1);
      activate(tabId(state.tabs[n]));
    } else {
      state.activeKey = null;
      showWelcome();
      renderTabs();
      renderTree();
      saveSession();
    }
  } else {
    renderTabs();
  }
}

function renderTabs() {
  const tabs = $("#tabs");
  tabs.innerHTML = "";
  for (const t of state.tabs) {
    const ch = t.ext ? null : chapterOf(t.bookId, t.idx);
    const key = tabId(t);
    const tab = el("div", "tab" + (key === state.activeKey ? " active" : ""));
    const ico = t.ext
      ? el("span", "tab-ico " + codiCls("extensions"))
      : el("span", "tab-ico " + codiCls("file", ch ? extClass(fileLabel(ch)) : "ext-default"));
    tab.appendChild(ico);
    const label = t.ext ? "Extension: " + ((EXT_BY_ID[t.ext] && EXT_BY_ID[t.ext].name) || t.ext) : ch ? displayName(ch) : "…";
    tab.appendChild(el("span", "tab-name", label));
    const close = el("span", "tab-close " + codiCls("close"));
    close.addEventListener("click", (e) => { e.stopPropagation(); closeTab(key); });
    tab.appendChild(close);
    tab.addEventListener("click", () => activate(key));
    tab.addEventListener("mousedown", (e) => { if (e.button === 1) { e.preventDefault(); closeTab(key); } });
    tabs.appendChild(tab);
  }
}

function renderBreadcrumbs() {
  const bc = $("#breadcrumbs");
  bc.innerHTML = "";
  if (isExtKey(state.activeKey) && typeof extCrumb === "function") { extCrumb(bc, state.activeKey.slice(4)); return; }
  if (!state.current) return;
  const ch = chapterOf(state.current.bookId, state.current.idx);
  const book = bookById(state.current.bookId);
  const parts = [
    { icon: "folder", text: "src" },
    { icon: "folder", text: book ? bookLabel(book) : state.current.code_name },
    { icon: "file", text: ch ? displayName(ch) : state.current.fileName, ext: extClass(state.current.fileName) },
  ];
  parts.forEach((p, i) => {
    if (i > 0) { const sep = el("span", "sep " + codiCls("chevron-right")); bc.appendChild(sep); }
    const crumb = el("span", "crumb");
    const ico = el("span", codiCls(p.icon, p.ext || ""));
    crumb.appendChild(ico);
    crumb.appendChild(el("span", null, p.text));
    bc.appendChild(crumb);
  });

  // Prev / next chapter buttons (also bound to the ← / → keys).
  const total = book && book._chapters ? book._chapters.length : 0;
  const nav = el("span", "bc-nav");
  const prev = el("button", "bc-btn codicon codicon-chevron-left");
  prev.title = "Previous chapter (←)";
  prev.disabled = state.current.idx <= 0;
  prev.addEventListener("click", () => navChapter(-1));
  const next = el("button", "bc-btn codicon codicon-chevron-right");
  next.title = "Next chapter (→)";
  next.disabled = total > 0 && state.current.idx >= total - 1;
  next.addEventListener("click", () => navChapter(1));
  nav.appendChild(prev);
  nav.appendChild(next);
  bc.appendChild(nav);
}

function updateStatusFile() {
  $("#st-lang").textContent = state.current ? langOf(state.current.fileName) : "Markdown";
  if (state.current) {
    const ch = chapterOf(state.current.bookId, state.current.idx);
    document.title = `${ch ? displayName(ch) : state.current.fileName} — devdocs`;
  }
}

function showWelcome() {
  state.current = null;
  $("#monaco-host").hidden = true;
  $("#ext-page").hidden = true;
  $("#welcome").hidden = false;
  $("#breadcrumbs").innerHTML = "";
  document.title = "workspace — devdocs";
}

/* ============================ Content rendering ============================ */
// Builds the text the editor shows: one model line per paragraph, with a
// blank line after it, plus the disguise comments and chapter "imports".
function buildDoc(ch) {
  const camo = state.settings.camo;
  const lines = [];
  const meta = [];
  const paraLine = [];
  // Model lines must map 1:1 to paragraphs: fold every kind of line break to a space.
  const oneLine = (s) => String(s).replace(new RegExp("\r\n|[\r\n\u2028\u2029\u0085\v\f]", "g"), " ");
  const push = (text, kind, extra) => { lines.push(text); meta.push({ kind, ...extra }); return lines.length; };
  const blank = () => push("", "blank");
  const heading = (text, level) => {
    blank();
    push("#".repeat(level) + " " + oneLine(text), "h");
    blank();
  };

  // File path header comment (disguise, no title duplication).
  push(`// src/${state.current.code_name}/${fileLabel(ch)}`, "c");
  blank();

  const blocks = ch._blocks || ch.blocks || [];
  const firstIsHeading = blocks.length && blocks[0].type !== "p";
  if (!firstIsHeading && ch.title) heading(ch.title, 1);

  blocks.forEach((b, bi) => {
    if (b.type === "h1" || b.type === "h2" || b.type === "h3") {
      heading(b.text, b.type === "h1" ? 1 : b.type === "h2" ? 2 : 3);
    } else if (camo) {
      push("// " + oneLine(b.text), "c");
      blank();
    } else {
      paraLine[bi] = push(oneLine(b.text), "p", { p: bi });
      blank();
    }
  });

  // Prev / next chapter, disguised as import comments.
  const chapters = state.current.book._chapters;
  const cur = ch.idx;
  blank();
  push("// ─────────────────────────────", "c");
  if (cur > 0) push(`// ◄ import ./${fileLabel(chapters[cur - 1])}`, "navPrev");
  if (cur < chapters.length - 1) push(`// ► import ./${fileLabel(chapters[cur + 1])}`, "navNext");

  return { text: lines.join("\n"), meta, paraLine };
}

async function renderContent(ch) {
  const cur = state.current;
  const host = $("#monaco-host");
  $("#ext-page").hidden = true;
  $("#welcome").hidden = true;
  host.hidden = false;
  let ed;
  try {
    ed = await getReader();
  } catch (err) {
    console.error(err);
    host.hidden = true;
    const w = $("#welcome");
    w.hidden = false;
    w.querySelector("p").textContent = "The editor failed to load. Reload the page to try again.";
    return;
  }
  if (state.current !== cur) return; // another chapter was opened meanwhile

  const doc = buildDoc(ch);
  reader.meta = doc.meta;
  reader.paraLine = doc.paraLine;
  state.hl = loadHighlights(cur.bookId, ch.idx);

  ed.updateOptions(readerOptions());
  const old = ed.getModel();
  ed.setModel(window.monaco.editor.createModel(doc.text, READER_LANG));
  if (old) old.dispose();
  reader.hl = ed.createDecorationsCollection([]);
  reader.focus = ed.createDecorationsCollection([]);
  reader.nav = ed.createDecorationsCollection(
    doc.meta.flatMap((m, i) => (m.kind === "navPrev" || m.kind === "navNext")
      ? [{ range: new window.monaco.Range(i + 1, 1, i + 1, doc.text.split("\n")[i].length + 1), options: { inlineClassName: "navline" } }]
      : []),
  );
  paintHighlights();
  paintFocus();
}

/* ============================ Scroll / progress =========================== */
function captureScroll() { if (state.activeKey) state.scroll[state.activeKey] = view.top; }
function restoreScroll(key, book, idx) {
  let tries = 0;
  const apply = () => {
    if (!reader.ed || state.activeKey !== key) return;
    reader.ed.layout();
    let top = 0;
    let wantRatio = 0;
    if (key in state.scroll) top = state.scroll[key];
    else if (book._progress && book._progress.chapter_idx === idx) {
      wantRatio = book._progress.scroll_ratio || 0;
      top = wantRatio * view.max;
    }
    // Layout can lag a frame behind the new model; don't "restore" to 0 (and
    // then save that over the real position) until it has caught up.
    if (top === 0 && wantRatio > 0 && view.max === 0 && tries++ < 20) { requestAnimationFrame(apply); return; }
    view.top = top;
    if (state.reveal && state.reveal.key === key) {
      const ln = reader.paraLine[state.reveal.p];
      if (ln) reader.ed.revealLineInCenter(ln);
      state.reveal = null;
    }
    updatePos();
    paintFocus();
    // Opening a chapter is itself progress (other devices resume from it), even
    // if the reader never scrolls.
    clearTimeout(state.saveTimer);
    state.saveTimer = setTimeout(() => saveProgress(view.ratio), 700);
  };
  requestAnimationFrame(apply);
}
function updatePos() {
  if (!reader.ed) return;
  const r = reader.ed.getVisibleRanges()[0];
  $("#st-pos").textContent = `Ln ${r ? r.startLineNumber : 1}, Col 1  ${Math.round(view.ratio * 100)}%`;
}

// "% read" uses the furthest point reached, which only ever moves forward.
function noteFurthest(book, idx, ratio) {
  if (!book) return;
  const f = book._furthest || (book.furthest_idx != null ? { idx: book.furthest_idx, ratio: book.furthest_ratio || 0 } : null);
  if (!f || idx > f.idx || (idx === f.idx && ratio > f.ratio)) book._furthest = { idx, ratio };
}
async function saveProgress(ratio) {
  if (!state.current) return;
  const book = state.current.book;
  if (book) { book._progress = { chapter_idx: state.current.idx, scroll_ratio: ratio }; book.last_read_at = Date.now(); noteFurthest(book, state.current.idx, ratio); }
  api(`/api/books/${state.current.bookId}/progress`, {
    method: "POST",
    body: JSON.stringify({ chapter_idx: state.current.idx, scroll_ratio: ratio, client_ts: Date.now() }),
  }).catch(() => {});
}
function beaconProgress() {
  if (!state.current) return;
  const ratio = view.ratio;
  const body = JSON.stringify({ chapter_idx: state.current.idx, scroll_ratio: ratio, client_ts: Date.now() });
  try { navigator.sendBeacon(`/api/books/${state.current.bookId}/progress`, new Blob([body], { type: "application/json" })); } catch {}
}
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") { captureScroll(); beaconProgress(); saveSession(); }
});
window.addEventListener("pagehide", () => { beaconProgress(); saveSession(); });

/* ============================ Session restore ============================= */
async function restoreSession() {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem("devdocs.session") || "{}"); } catch {}
  const tabs = (saved.tabs || []).filter((t) => (t.ext ? !!EXT_BY_ID[t.ext] : bookById(t.bookId)));
  state.tabs = tabs;
  for (const t of tabs) if (t.bookId) state.expanded.add(t.bookId);
  renderTabs();
  const active = saved.activeKey && tabs.some((t) => tabId(t) === saved.activeKey)
    ? saved.activeKey
    : tabs.length ? tabId(tabs[0]) : null;
  if (active) await activate(active);
}

/* ============================ Upload ====================================== */
function openUpload() { $("#upload").hidden = false; }
$("#btn-upload").addEventListener("click", openUpload);
$("#btn-upload2").addEventListener("click", openUpload);
const dropzone = $("#dropzone");
const fileInput = $("#file-input");
fileInput.addEventListener("change", () => { if (fileInput.files[0]) uploadFile(fileInput.files[0]); });
["dragover", "dragenter"].forEach((ev) => dropzone.addEventListener(ev, (e) => { e.preventDefault(); dropzone.classList.add("drag"); }));
["dragleave", "drop"].forEach((ev) => dropzone.addEventListener(ev, (e) => { e.preventDefault(); dropzone.classList.remove("drag"); }));
dropzone.addEventListener("drop", (e) => { const f = e.dataTransfer.files[0]; if (f) uploadFile(f); });

// Drives a book's chunked ingestion (see /api/books/:id/ingest-chunk) to
// completion — each call processes a bounded slice of chapters server-side,
// so a book with thousands of chapters can't blow a single request's CPU
// budget. onProgress(processed, total) fires after every chunk. The
// server-side CPU budget has proven inconsistent in practice, so a failed
// chunk is retried a few times (it's idempotent — it always resumes from
// however many chapters are already durably stored) before giving up.
async function ingestChapters(bookId, onProgress) {
  const MAX_RETRIES = 4;
  let retries = 0;
  for (;;) {
    const res = await api(`/api/books/${bookId}/ingest-chunk`, { method: "POST" });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      // 409: another request (e.g. a second tab) is ingesting this same book.
      if (retries++ < MAX_RETRIES) { await new Promise((r) => setTimeout(r, 400 * retries)); continue; }
      return { ok: false, error: data.error || `HTTP ${res.status}` };
    }
    retries = 0;
    if (onProgress) onProgress(data.processed || 0, data.total || 0);
    if (data.done) return { ok: true, total: data.total || 0 };
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// An .epub is a zip, and a zip's index sits at its END. A download that was cut
// short (the usual way an .epub turns out unreadable) has no such index, and
// would otherwise upload for minutes before failing with a cryptic server
// error. Look at the file's head and tail first. Returns a message, or null if
// the file looks complete.
async function zipProblem(file) {
  const EOCD = 0x06054b50; // "end of central directory" record signature
  if (file.size < 22) return "This file is too small to be an EPUB.";
  const head = new Uint8Array(await file.slice(0, 2).arrayBuffer());
  if (head[0] !== 0x50 || head[1] !== 0x4b) return "This doesn't look like an EPUB (it isn't a zip file).";
  const tailLen = Math.min(file.size, 65557); // record (22) + longest possible comment (65535)
  const tail = new DataView(await file.slice(file.size - tailLen).arrayBuffer());
  for (let i = tailLen - 22; i >= 0; i--) {
    if (tail.getUint32(i, true) !== EOCD) continue;
    const cdSize = tail.getUint32(i + 12, true);
    const cdOffset = tail.getUint32(i + 16, true);
    if (cdSize === 0xffffffff || cdOffset === 0xffffffff) return null; // zip64: the server checks it
    const eocdAt = file.size - tailLen + i;
    return cdOffset + cdSize <= eocdAt ? null : "This file is incomplete: its index points past the end of the file. It looks like a cut-off download — download it again.";
  }
  return "This file is incomplete: the end of the zip is missing. It looks like a cut-off download — download it again.";
}

// Sends `file` to the server in small parts (see /api/uploads) instead of one
// long request. A proxy in front of the server gives a single request only so
// long to deliver its body, and on a slow or flaky link a big file blows past
// that and arrives truncated. Small parts each finish in seconds, can be
// retried on their own, and give real progress. Returns {ok, book} | {ok:false, error}.
async function uploadInParts(file, { onProgress, onFinishing, dry = false }) {
  const CONCURRENCY = 3;
  const MAX_TRIES = 6;

  const start = await api("/api/uploads", { method: "POST", body: JSON.stringify({ size: file.size, name: file.name }) });
  const info = await start.json().catch(() => ({}));
  if (!start.ok) return { ok: false, error: info.error || `HTTP ${start.status}` };
  const { id, part_size: partSize, parts } = info;

  let confirmed = 0;
  async function sendPart(n) {
    const from = n * partSize;
    const blob = file.slice(from, Math.min(file.size, from + partSize));
    for (let attempt = 1; ; attempt++) {
      let status = 0;
      try {
        const res = await fetch(`/api/uploads/${id}/parts/${n}`, { method: "PUT", body: blob, credentials: "same-origin" });
        if (res.ok) { confirmed += blob.size; onProgress(confirmed); return; }
        status = res.status;
      } catch { /* network error: retry */ }
      // 401 = signed out, 404/413 = the upload is gone or refused: retrying can't help.
      if (status === 401 || status === 404 || status === 413) throw new Error(status === 401 ? "signed out — sign in again" : `upload rejected (HTTP ${status})`);
      if (attempt >= MAX_TRIES) throw new Error(`part ${n + 1}/${parts} failed after ${MAX_TRIES} tries — check the connection`);
      await sleep(Math.min(8000, 500 * 2 ** attempt));
    }
  }

  let next = 0;
  let failure = null;
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, parts) }, async () => {
    while (next < parts && !failure) {
      const n = next++;
      try { await sendPart(n); } catch (e) { failure = e; }
    }
  }));
  if (failure) return { ok: false, error: failure.message };

  onFinishing();
  for (let attempt = 1; attempt <= 4; attempt++) {
    const res = await api(`/api/uploads/${id}/complete${dry ? "?dry=1" : ""}`, { method: "POST" }).catch(() => null);
    if (res) {
      const data = await res.json().catch(() => ({}));
      if (res.ok) return dry ? { ok: true, preview: data.preview, uploadId: id } : { ok: true, book: data };
      if (res.status === 409 && Array.isArray(data.missing)) {
        try { for (const n of data.missing) await sendPart(n); } catch (e) { return { ok: false, error: e.message }; }
        continue;
      }
      if (res.status < 500 && res.status !== 429) return { ok: false, error: data.error || `HTTP ${res.status}` };
    }
    await sleep(1000 * attempt);
  }
  return { ok: false, error: "the upload was sent but could not be finished — check the connection and retry" };
}

// Text files: the server cuts them into chapters and reports what it found
// (a dry run); nothing is created until the reader confirms.
const RULE_LABELS = {
  vi: "chapter headings (Chương / Hồi …)", zh: "chapter headings (第…章)", en: "chapter headings (Chapter …)",
  numbered: "numbered headings", length: "cut by length", single: "one piece",
};
let pendingPreview = null;
new MutationObserver(() => { if ($("#upload").hidden && pendingPreview) pendingPreview(false); })
  .observe($("#upload"), { attributes: true, attributeFilter: ["hidden"] });
function showTextPreview(preview) {
  return new Promise((resolve) => {
    const box = $("#upload-preview");
    box.innerHTML = "";
    box.hidden = false;
    const done = (yes) => { pendingPreview = null; box.hidden = true; resolve(yes); };
    pendingPreview = done;
    box.appendChild(el("div", "up-title", `${preview.chapters} file${preview.chapters === 1 ? "" : "s"} found`));
    box.appendChild(el("div", "up-sub", `${preview.title} · ${preview.chars.toLocaleString()} characters · ${RULE_LABELS[preview.rule] || preview.rule}`));
    const list = el("div", "up-list");
    let prev = 0;
    for (const s of preview.samples) {
      if (prev && s.n > prev + 1) list.appendChild(el("div", "up-gap", "…"));
      const row = el("div", "up-row");
      row.appendChild(el("span", "up-n", String(s.n)));
      row.appendChild(el("span", "up-t", s.title || "(untitled)"));
      row.appendChild(el("span", "up-c", s.chars.toLocaleString()));
      list.appendChild(row);
      prev = s.n;
    }
    box.appendChild(list);
    for (const w of preview.warnings) box.appendChild(el("div", "up-warn", "! " + w));
    const btns = el("div", "up-btns");
    const yes = el("button", "xp-btn", "Import");
    const no = el("button", "xp-btn secondary", "Cancel");
    yes.type = no.type = "button";
    yes.addEventListener("click", () => done(true));
    no.addEventListener("click", () => done(false));
    btns.appendChild(yes);
    btns.appendChild(no);
    box.appendChild(btns);
  });
}
async function finishUpload(uploadId) {
  for (let attempt = 1; attempt <= 4; attempt++) {
    const res = await api(`/api/uploads/${uploadId}/complete`, { method: "POST" }).catch(() => null);
    if (res) {
      const data = await res.json().catch(() => ({}));
      if (res.ok) return { ok: true, book: data };
      if (res.status < 500 && res.status !== 429) return { ok: false, error: data.error || `HTTP ${res.status}` };
    }
    await sleep(1000 * attempt);
  }
  return { ok: false, error: "the import could not be finished — check the connection and retry" };
}

async function uploadFile(file) {
  const status = $("#upload-status");
  status.hidden = false;
  status.classList.remove("err");
  $("#upload-preview").hidden = true;
  const mb = (n) => (n / 1048576).toFixed(1);
  const isText = /\.(txt|text|html?|xhtml)$/i.test(file.name);

  const problem = isText ? null : await zipProblem(file);
  if (problem) {
    status.classList.add("err");
    status.textContent = `! ${problem} (${mb(file.size)} MB)`;
    return;
  }
  status.textContent = `> uploading ${file.name} … 0%`;

  const up = await uploadInParts(file, {
    onProgress: (done) => {
      status.textContent = `> uploading ${file.name} … ${Math.floor((done / file.size) * 100)}% (${mb(done)} / ${mb(file.size)} MB)`;
    },
    onFinishing: () => { status.textContent = `> parsing ${file.name} …`; },
    dry: isText,
  });
  if (!up.ok) {
    status.classList.add("err");
    status.textContent = `! ${up.error}`;
    return;
  }
  let data = up.book;
  if (isText) {
    status.textContent = `> ${file.name}: choose what to import`;
    if (!(await showTextPreview(up.preview))) {
      api(`/api/uploads/${up.uploadId}`, { method: "DELETE" }).catch(() => {});
      status.textContent = "> import cancelled";
      return;
    }
    status.textContent = `> importing ${file.name} …`;
    const fin = await finishUpload(up.uploadId);
    if (!fin.ok) {
      status.classList.add("err");
      status.textContent = `! ${fin.error}`;
      return;
    }
    data = fin.book;
  }

  const result = await ingestChapters(data.id, (processed, total) => {
    status.textContent = `> indexing "${data.code_name}" … ${processed}/${total}`;
  });
  if (!result.ok) {
    status.classList.add("err");
    status.textContent = `! ${result.error}`;
    return;
  }

  status.textContent = `> indexed as "${data.code_name}" · ${result.total} files`;
  const list = await api("/api/books").then((r) => r.json());
  state.books = list.books;
  renderTree();
  setTimeout(() => { $("#upload").hidden = true; status.hidden = true; }, 1200);
}

/* ============================ Settings ==================================== */
function openSettings() {
  $("#opt-blur").checked = state.settings.blurHide;
  $("#opt-camo").checked = state.settings.camo;
  $("#opt-serif").checked = state.settings.serif;
  $("#opt-focus").checked = state.settings.readFocus;
  $("#opt-panic-code").value = state.settings.panicCode;
  $("#font-val").textContent = state.settings.fontSize;
  $("#width-val").textContent = state.settings.readWidth;
  $("#settings").hidden = false;
}
$("#btn-settings").addEventListener("click", openSettings);
$("#btn-account").addEventListener("click", openSettings);
$("#opt-blur").addEventListener("change", (e) => { state.settings.blurHide = e.target.checked; saveSettings(); });
$("#opt-panic-code").addEventListener("change", (e) => {
  const v = e.target.value.trim().toLowerCase();
  state.settings.panicCode = v || DEFAULT_PANIC_CODE;
  e.target.value = state.settings.panicCode;
  saveSettings();
});
$("#opt-camo").addEventListener("change", (e) => { state.settings.camo = e.target.checked; saveSettings(); rerender(); });
$("#opt-serif").addEventListener("change", (e) => { state.settings.serif = e.target.checked; saveSettings(); rerender(); });
$("#opt-focus").addEventListener("change", (e) => {
  state.settings.readFocus = e.target.checked;
  saveSettings();
  paintFocus();
});
$("#font-inc").addEventListener("click", () => changeFont(1));
$("#font-dec").addEventListener("click", () => changeFont(-1));
$("#width-inc").addEventListener("click", () => changeWidth(4));
$("#width-dec").addEventListener("click", () => changeWidth(-4));
function changeFont(d) {
  state.settings.fontSize = Math.min(28, Math.max(10, state.settings.fontSize + d));
  $("#font-val").textContent = state.settings.fontSize;
  saveSettings(); applySettingsToDom();
  applyReaderOptions();
}
function changeWidth(d) {
  state.settings.readWidth = Math.min(140, Math.max(50, state.settings.readWidth + d));
  $("#width-val").textContent = state.settings.readWidth;
  saveSettings(); applySettingsToDom();
  applyReaderOptions();
}
function applySettingsToDom() {
  const r = document.documentElement.style;
  r.setProperty("--code-size", state.settings.fontSize + "px");
  r.setProperty("--read-width", state.settings.readWidth + "ch");
}
async function rerender() {
  const ch = state.current && chapterOf(state.current.bookId, state.current.idx);
  if (!ch) return;
  const top = view.top;
  await renderContent(ch);
  view.top = top;
}
$("#btn-logout").addEventListener("click", async () => { await api("/api/logout", { method: "POST" }); location.reload(); });
$("#btn-logout-all").addEventListener("click", async () => {
  if (!confirm("Sign out of every device, including this one?")) return;
  await api("/api/logout-all", { method: "POST" });
  location.reload();
});

document.querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", () => ($("#" + b.dataset.close).hidden = true)));
document.querySelectorAll(".modal-backdrop").forEach((bd) =>
  bd.addEventListener("click", (e) => { if (e.target === bd && bd.id !== "login") bd.hidden = true; }),
);

/* ============================ Reveal titles =============================== */
function toggleReveal() {
  state.revealTitles = !state.revealTitles;
  $("#st-reveal").hidden = !state.revealTitles;
  $("#btn-reveal").classList.toggle("on", state.revealTitles);
  renderTree(); renderTabs(); renderBreadcrumbs(); updateStatusFile();
  // An open extension page may show module names or links that depend on this.
  if (isExtKey(state.activeKey) && typeof refreshExtPage === "function") refreshExtPage(state.activeKey.slice(4));
}
$("#btn-reveal").addEventListener("click", toggleReveal);

/* ============================ Sidebar / panic ============================= */
function toggleSidebar() { $("#sidebar").classList.toggle("hidden"); }

let panicVisible = false;
let panicBuffer = "";
function setPanic(on) {
  panicVisible = on;
  panicBuffer = "";
  $("#panic").hidden = !on;
  if (on) renderPanic();
  extEvent("panic");
}
function anyModalOpen() { return ["upload", "settings", "login"].some((id) => !$("#" + id).hidden); }
function renderPanic() {
  $("#panic-code").innerHTML = PANIC_CODE;
  $("#panic-term").innerHTML = PANIC_TERM + '<span class="term-cursor">&nbsp;</span>';
}
window.addEventListener("blur", () => {
  if (state.settings.blurHide && $("#app").hidden === false && !anyModalOpen()) setPanic(true);
});

/* ============================ Keyboard ==================================== */
// True when a key is pressed with no modifiers and not while typing in a field.
function isBare(e) {
  if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return false;
  const t = e.target;
  // Monaco's own hidden input is not a field the user is typing into.
  if (t && t.classList && t.classList.contains("inputarea")) return true;
  if (t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return false;
  return true;
}
// Continuous WASD scroll: held keys drive a rAF loop instead of jumping
// per keydown, so movement feels fluid (and immune to OS key-repeat delay).
const moveKeys = { w: false, s: false };
let moveRAF = null;
function moveLoop() {
  let speed = 0;
  if (moveKeys.w) speed -= 16;
  if (moveKeys.s) speed += 16;
  if (speed) view.top += speed;
  if (moveKeys.w || moveKeys.s) moveRAF = requestAnimationFrame(moveLoop);
  else moveRAF = null;
}
function stopMoveKeys() {
  moveKeys.w = false;
  moveKeys.s = false;
}
document.addEventListener("keydown", (e) => {
  // Focus mode (boss key): "\" opens it. Once shown, no single key (not
  // even Esc) dismisses it — someone mashing or trying keys in sequence to
  // get past the cover screen shouldn't stumble onto the way out. Only
  // typing the configured unlock phrase (Settings) closes it.
  if (panicVisible) {
    e.preventDefault();
    e.stopPropagation();
    if (e.key.length === 1) {
      panicBuffer = (panicBuffer + e.key).toLowerCase().slice(-32);
      const code = state.settings.panicCode || DEFAULT_PANIC_CODE;
      if (panicBuffer.endsWith(code)) setPanic(false);
    }
    return;
  }
  if (e.key === "\\") {
    if (anyModalOpen()) return;
    e.preventDefault(); setPanic(true); return;
  }
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.altKey && e.key.toLowerCase() === "t") { e.preventDefault(); toggleReveal(); }
  else if (mod && e.altKey && e.key.toLowerCase() === "k") { e.preventDefault(); if (typeof addBookmarkAtReading === "function") addBookmarkAtReading(); }
  else if (mod && e.key.toLowerCase() === "b") { e.preventDefault(); toggleSidebar(); }
  else if (mod && e.shiftKey && e.key.toLowerCase() === "u") { e.preventDefault(); openUpload(); }
  else if (mod && (e.key === "=" || e.key === "+")) { e.preventDefault(); changeFont(1); }
  else if (mod && e.key === "-") { e.preventDefault(); changeFont(-1); }
  else if (mod && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "f" && reader.ed && state.current && !anyModalOpen()) {
    // Editor find widget (the browser's own find would miss text Monaco hasn't rendered).
    e.preventDefault(); reader.ed.focus(); reader.ed.getAction("actions.find").run();
  }
  else if (isBare(e) && e.key === "ArrowRight") { e.preventDefault(); e.stopPropagation(); navChapter(1); }
  else if (isBare(e) && e.key === "ArrowLeft") { e.preventDefault(); e.stopPropagation(); navChapter(-1); }
  else if (isBare(e) && e.key.toLowerCase() === "d") { e.preventDefault(); navChapter(1); }
  else if (isBare(e) && e.key.toLowerCase() === "a") { e.preventDefault(); navChapter(-1); }
  else if (isBare(e) && e.key.toLowerCase() === "w") {
    e.preventDefault();
    if (!moveKeys.w) { moveKeys.w = true; if (!moveRAF) moveRAF = requestAnimationFrame(moveLoop); }
  }
  else if (isBare(e) && e.key.toLowerCase() === "s") {
    e.preventDefault();
    if (!moveKeys.s) { moveKeys.s = true; if (!moveRAF) moveRAF = requestAnimationFrame(moveLoop); }
  }
  else if (e.altKey && /^[1-9]$/.test(e.key)) { e.preventDefault(); switchToTabIndex(Number(e.key) - 1); }
}, true);
document.addEventListener("keyup", (e) => {
  const k = e.key.toLowerCase();
  if (k === "w" || k === "s") moveKeys[k] = false;
});
window.addEventListener("blur", stopMoveKeys);

/* ============================ Panic content =============================== */
const PANIC_CODE = [
  '<span class="pl-cmt">// src/edge/session-gateway.ts</span>',
  '<span class="pl-key">import</span> { Router } <span class="pl-key">from</span> <span class="pl-str">"itty-router"</span>;',
  '<span class="pl-key">import</span> { verifyJWT, signSession } <span class="pl-key">from</span> <span class="pl-str">"../crypto/jwt"</span>;',
  "",
  '<span class="pl-key">export interface</span> Env {',
  "  SESSIONS: KVNamespace;",
  "  DB: D1Database;",
  '  JWT_SECRET: <span class="pl-key">string</span>;',
  "}",
  "",
  '<span class="pl-key">const</span> router = <span class="pl-fn">Router</span>();',
  "",
  'router.<span class="pl-fn">post</span>(<span class="pl-str">"/v1/auth/refresh"</span>, <span class="pl-key">async</span> (req, env: Env) => {',
  '  <span class="pl-key">const</span> token = req.headers.<span class="pl-fn">get</span>(<span class="pl-str">"authorization"</span>)?.<span class="pl-fn">slice</span>(<span class="pl-num">7</span>);',
  '  <span class="pl-key">if</span> (!token) <span class="pl-key">return</span> <span class="pl-fn">json</span>({ error: <span class="pl-str">"missing token"</span> }, <span class="pl-num">401</span>);',
  "",
  '  <span class="pl-key">const</span> claims = <span class="pl-key">await</span> <span class="pl-fn">verifyJWT</span>(token, env.JWT_SECRET);',
  '  <span class="pl-key">if</span> (!claims) <span class="pl-key">return</span> <span class="pl-fn">json</span>({ error: <span class="pl-str">"invalid token"</span> }, <span class="pl-num">401</span>);',
  "",
  '  <span class="pl-key">const</span> session = <span class="pl-key">await</span> <span class="pl-fn">signSession</span>(claims.sub, env.JWT_SECRET, <span class="pl-num">3600</span>);',
  '  <span class="pl-key">await</span> env.SESSIONS.<span class="pl-fn">put</span>(claims.sub, session, { expirationTtl: <span class="pl-num">3600</span> });',
  '  <span class="pl-key">return</span> <span class="pl-fn">json</span>({ session, expiresIn: <span class="pl-num">3600</span> });',
  "});",
  "",
  'router.<span class="pl-fn">get</span>(<span class="pl-str">"/v1/health"</span>, () => <span class="pl-fn">json</span>({ ok: <span class="pl-key">true</span> }));',
  "",
  '<span class="pl-key">export default</span> { fetch: router.handle };',
].join("\n");

const PANIC_TERM = [
  '<span class="pl-cmt">$ npm run deploy</span>',
  "",
  "> edge-session-gateway@1.4.2 deploy",
  "> wrangler deploy",
  "",
  " ⛅️ wrangler 4.4.0",
  "Total Upload: 48.21 KiB / gzip: 12.07 KiB",
  "Uploaded edge-session-gateway (3.11 sec)",
  "Deployed edge-session-gateway triggers (0.42 sec)",
  "  https://edge-session-gateway.workers.dev",
  "Current Version ID: 7a1c9f2e-3b44-48d1-9c02-5e8b1a0f6d3c",
  "",
  '<span class="pl-cmt">$ npm test -- --watch</span>',
  " PASS  test/session.spec.ts (2.4s)",
  " PASS  test/jwt.spec.ts (1.1s)",
  "Tests:       17 passed, 17 total",
  "",
  '<span class="pl-cmt">$ </span>',
].join("\n");

/* ============================ Go ========================================== */
const VSCODE_LOGO =
  '<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path fill-rule="evenodd" clip-rule="evenodd" d="M23.15 2.587L18.21.21a1.494 1.494 0 0 0-1.705.29l-9.46 8.63-4.12-3.128a.999.999 0 0 0-1.276.057L.327 7.261A1 1 0 0 0 .326 8.74L3.899 12 .326 15.26a1 1 0 0 0 .001 1.479L1.65 17.94a.999.999 0 0 0 1.276.057l4.12-3.128 9.46 8.63a1.492 1.492 0 0 0 1.704.29l4.942-2.377A1.5 1.5 0 0 0 24 20.06V3.939a1.5 1.5 0 0 0-.85-1.352zm-5.146 14.861L10.826 12l7.178-5.448v10.896z" fill="#0098FF"/></svg>';
injectIcons();
document.querySelectorAll(".vsclogo").forEach((e) => (e.innerHTML = VSCODE_LOGO));
boot();
