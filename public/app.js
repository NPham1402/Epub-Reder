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
  mmLines: [],
  mmRAF: 0,
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

// Dialogue quotes to colour as "strings".
const QUOTE_RE = /"[^"]*"|“[^”]*”|«[^»]*»/g;

// Render a paragraph: escape text, colour quoted dialogue, apply saved
// highlight ranges. Splits at every interval boundary so dialogue and
// highlights can overlap cleanly.
function renderParagraph(text, hls) {
  const n = text.length;
  const q = [];
  QUOTE_RE.lastIndex = 0;
  let m;
  while ((m = QUOTE_RE.exec(text)) !== null) q.push([m.index, m.index + m[0].length]);
  const H = (hls || []).map((h) => [Math.max(0, h.start), Math.min(n, h.end)]).filter((h) => h[1] > h[0]);
  const pts = new Set([0, n]);
  for (const [a, b] of q) { pts.add(a); pts.add(b); }
  for (const [a, b] of H) { pts.add(a); pts.add(b); }
  const bs = [...pts].filter((p) => p >= 0 && p <= n).sort((a, b) => a - b);
  const covers = (pos, arr) => arr.some(([a, b]) => pos >= a && pos < b);
  let out = "";
  for (let i = 0; i < bs.length - 1; i++) {
    const s = bs[i], e = bs[i + 1];
    if (e <= s) continue;
    const seg = esc(text.slice(s, e));
    const cls = (covers(s, q) ? "tok-string" : "") + (covers(s, H) ? (covers(s, q) ? " hl" : "hl") : "");
    out += cls ? `<span class="${cls}">${seg}</span>` : seg;
  }
  return out;
}

// ---- Manual highlighter (marker) -------------------------------------------
const hlKey = (bookId, idx) => `devdocs.hl:${bookId}:${idx}`;
function loadHighlights(bookId, idx) {
  try { return JSON.parse(localStorage.getItem(hlKey(bookId, idx)) || "[]"); } catch { return []; }
}
function saveHighlights() {
  if (!state.current) return;
  localStorage.setItem(hlKey(state.current.bookId, state.current.idx), JSON.stringify(state.hl));
}
function textOffset(container, node, offset) {
  const r = document.createRange();
  r.selectNodeContents(container);
  try { r.setEnd(node, offset); } catch { return 0; }
  return r.toString().length;
}
function closestRp(node) {
  const el = node && node.nodeType === 3 ? node.parentElement : node;
  return el && el.closest ? el.closest(".row.rp") : null;
}
function rerenderParagraph(p) {
  const row = $("#code").querySelector(`.row.rp[data-p="${p}"]`);
  if (!row || !state.current) return;
  const ch = chapterOf(state.current.bookId, state.current.idx);
  const b = ((ch && (ch._blocks || ch.blocks)) || [])[p];
  if (!b) return;
  row.querySelector(".lc").innerHTML = renderParagraph(b.text, state.hl.filter((h) => h.p === p));
}
function addHighlight(p, start, end) {
  state.hl.push({ p, start, end });
  saveHighlights();
  rerenderParagraph(p);
}
function removeHighlightAt(p, pos) {
  const before = state.hl.length;
  state.hl = state.hl.filter((h) => !(h.p === p && pos >= h.start && pos < h.end));
  if (state.hl.length !== before) { saveHighlights(); rerenderParagraph(p); }
}

// ---- Focus current paragraph ------------------------------------------------
function cacheProseRows() {
  state.proseRows = [...$("#code").querySelectorAll(".row.rp")].map((el) => ({ el, top: el.offsetTop }));
}
function updateReadingFocus() {
  if (!state.settings.readFocus) return;
  const rows = state.proseRows;
  if (!rows || !rows.length) return;
  const editor = $("#editor");
  const center = editor.scrollTop + editor.clientHeight * 0.42;
  let active = rows[0].el;
  for (const r of rows) { if (r.top <= center) active = r.el; else break; }
  if (state.readingEl === active) return;
  if (state.readingEl) state.readingEl.classList.remove("reading");
  active.classList.add("reading");
  state.readingEl = active;
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
  };
}
function saveSettings() { localStorage.setItem("devdocs.settings", JSON.stringify(state.settings)); }
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
    if (state.tabs.length) activate(tabKey(state.tabs[0].bookId, state.tabs[0].idx));
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
  renderContent(ch);
  renderTabs();
  renderTree();
  renderBreadcrumbs();
  updateStatusFile();
  restoreScroll(key, book, idx);
  saveSession();
  prefetchAround(book, idx);
}

function navChapter(delta) {
  if (!state.activeKey) return;
  const [b, iStr] = state.activeKey.split(":");
  const idx = Number(iStr) + delta;
  const book = bookById(b);
  if (!book || !book._chapters || idx < 0 || idx >= book._chapters.length) return;
  const ti = state.tabs.findIndex((t) => tabKey(t.bookId, t.idx) === state.activeKey);
  if (ti >= 0) state.tabs[ti] = { bookId: b, idx };
  activate(tabKey(b, idx));
}

function switchToTabIndex(i) {
  if (i < 0 || i >= state.tabs.length) return;
  activate(tabKey(state.tabs[i].bookId, state.tabs[i].idx));
}

function closeTab(key) {
  const i = state.tabs.findIndex((t) => tabKey(t.bookId, t.idx) === key);
  if (i < 0) return;
  state.tabs.splice(i, 1);
  delete state.scroll[key];
  if (state.activeKey === key) {
    if (state.tabs.length) {
      const n = Math.min(i, state.tabs.length - 1);
      activate(tabKey(state.tabs[n].bookId, state.tabs[n].idx));
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
    const ch = chapterOf(t.bookId, t.idx);
    const key = tabKey(t.bookId, t.idx);
    const tab = el("div", "tab" + (key === state.activeKey ? " active" : ""));
    const ico = el("span", "tab-ico " + codiCls("file", ch ? extClass(fileLabel(ch)) : "ext-default"));
    tab.appendChild(ico);
    tab.appendChild(el("span", "tab-name", ch ? displayName(ch) : "…"));
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
  $("#code").hidden = true;
  $("#welcome").hidden = false;
  $("#breadcrumbs").innerHTML = "";
  state.mmLines = [];
  drawMinimap();
  document.title = "workspace — devdocs";
}

/* ============================ Content rendering ============================ */
function renderContent(ch) {
  const code = $("#code");
  const camo = state.settings.camo;
  $("#welcome").hidden = true;
  code.hidden = false;
  code.classList.toggle("serif", state.settings.serif);
  code.classList.toggle("focusread", !!state.settings.readFocus);
  code.innerHTML = "";
  state.hl = loadHighlights(state.current.bookId, ch.idx);

  const mm = [];
  let n = 0;
  const frag = document.createDocumentFragment();
  const line = (cls, html, ink, kind) => {
    n++;
    const row = el("div", "row " + cls);
    const ln = el("span", "ln", String(n));
    const lc = el("span", "lc");
    lc.innerHTML = html;
    row.appendChild(ln);
    row.appendChild(lc);
    frag.appendChild(row);
    mm.push({ ink: ink || 0, kind: kind || "p" });
    return row;
  };
  const blank = () => line("rb", "&nbsp;", 0, "blank");
  const heading = (text, level) => {
    const hashes = "#".repeat(level);
    blank();
    line("rh", `<span class="tok-comment">${hashes} </span><span class="tok-heading">${esc(text)}</span>`, text.length + 2, "h");
    blank();
  };

  // File path header comment (disguise, no title duplication).
  line("rc", `<span class="tok-comment">// src/${esc(state.current.code_name)}/${esc(fileLabel(ch))}</span>`, 30, "c");
  blank();

  const blocks = ch._blocks || ch.blocks || [];
  const firstIsHeading = blocks.length && blocks[0].type !== "p";
  if (!firstIsHeading && ch.title) heading(ch.title, 1);

  blocks.forEach((b, bi) => {
    if (b.type === "h1" || b.type === "h2" || b.type === "h3") {
      heading(b.text, b.type === "h1" ? 1 : b.type === "h2" ? 2 : 3);
    } else if (camo) {
      line("rc", `<span class="tok-comment">// </span>${esc(b.text)}`, b.text.length, "c");
      blank();
    } else {
      const row = line("rp", renderParagraph(b.text, state.hl.filter((h) => h.p === bi)), b.text.length, "p");
      row.dataset.p = String(bi);
      blank();
    }
  });

  // Prev / next chapter, disguised as import comments.
  const chapters = state.current.book._chapters;
  const cur = ch.idx;
  blank();
  line("rc", `<span class="tok-comment">// ─────────────────────────────</span>`, 20, "c");
  if (cur > 0) {
    const prev = chapters[cur - 1];
    const row = line("rc navline", `<span class="tok-comment">// ◄ import ./${esc(fileLabel(prev))}</span>`, 24, "c");
    row.addEventListener("click", () => navChapter(-1));
  }
  if (cur < chapters.length - 1) {
    const next = chapters[cur + 1];
    const row = line("rc navline", `<span class="tok-comment">// ► import ./${esc(fileLabel(next))}</span>`, 24, "c");
    row.addEventListener("click", () => navChapter(1));
  }

  code.appendChild(frag);
  state.mmLines = mm;
  state.readingEl = null;
  requestAnimationFrame(() => { drawMinimap(); cacheProseRows(); updateReadingFocus(); });
}

/* ============================ Minimap ====================================== */
function drawMinimap() {
  const canvas = $("#minimap");
  const wrap = canvas.parentElement;
  if (!wrap) return;
  const dpr = window.devicePixelRatio || 1;
  const W = 70;
  const H = wrap.clientHeight || 300;
  if (canvas.width !== W * dpr || canvas.height !== H * dpr) {
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    canvas.style.width = W + "px";
    canvas.style.height = H + "px";
  }
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);

  const lines = state.mmLines;
  const nLines = lines.length;
  if (!nLines) return;

  const rowH = Math.max(1, Math.min(3, (H - 8) / nLines));
  const colors = { h: "#4ec9b0", c: "#5a7a4a", p: "#6b6b6b", blank: null };
  for (let i = 0; i < nLines; i++) {
    const L = lines[i];
    if (L.kind === "blank" || L.ink === 0) continue;
    const y = 4 + i * rowH;
    const w = Math.max(2, Math.min(1, L.ink / 70) * (W - 10));
    ctx.fillStyle = colors[L.kind] || "#6b6b6b";
    ctx.globalAlpha = L.kind === "h" ? 0.9 : 0.55;
    ctx.fillRect(6, y, w, Math.max(1, rowH - 0.6));
  }
  ctx.globalAlpha = 1;

  // Viewport slider.
  const editor = $("#editor");
  const total = editor.scrollHeight || 1;
  const contentH = Math.min(H, 4 + nLines * rowH);
  const boxY = (editor.scrollTop / total) * contentH;
  const boxH = Math.max(18, (editor.clientHeight / total) * contentH);
  ctx.fillStyle = "rgba(255,255,255,0.08)";
  ctx.fillRect(0, boxY, W, boxH);
  ctx.strokeStyle = "rgba(255,255,255,0.12)";
  ctx.lineWidth = 1;
  ctx.strokeRect(0.5, boxY + 0.5, W - 1, boxH - 1);
}
$("#minimap").addEventListener("click", (e) => {
  const editor = $("#editor");
  const rect = e.currentTarget.getBoundingClientRect();
  const ratio = (e.clientY - rect.top) / rect.height;
  editor.scrollTop = ratio * editor.scrollHeight - editor.clientHeight / 2;
});

/* ============================ Scroll / progress =========================== */
function captureScroll() { if (state.activeKey) state.scroll[state.activeKey] = $("#editor").scrollTop; }
function restoreScroll(key, book, idx) {
  const editor = $("#editor");
  requestAnimationFrame(() => {
    let top = 0;
    if (key in state.scroll) top = state.scroll[key];
    else if (book._progress && book._progress.chapter_idx === idx) {
      top = (book._progress.scroll_ratio || 0) * (editor.scrollHeight - editor.clientHeight);
    }
    editor.scrollTop = top;
    drawMinimap();
    updatePos();
    updateReadingFocus();
  });
}
function updatePos() {
  const editor = $("#editor");
  const denom = editor.scrollHeight - editor.clientHeight;
  const ratio = denom > 0 ? editor.scrollTop / denom : 0;
  const ln = Math.max(1, Math.round(ratio * state.mmLines.length));
  $("#st-pos").textContent = `Ln ${ln}, Col 1  ${Math.round(ratio * 100)}%`;
}

$("#editor").addEventListener("scroll", () => {
  if (!state.mmRAF) state.mmRAF = requestAnimationFrame(() => { state.mmRAF = 0; drawMinimap(); updateReadingFocus(); });
  updatePos();
  if (!state.current) return;
  const editor = $("#editor");
  const denom = editor.scrollHeight - editor.clientHeight;
  const ratio = denom > 0 ? editor.scrollTop / denom : 0;
  clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(() => saveProgress(ratio), 700);
});

// Manual highlighter: select prose to mark it; click a mark to remove it.
$("#code").addEventListener("mouseup", () => {
  if (state.settings.camo || !state.current) return;
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount) return;
  const range = sel.getRangeAt(0);
  const row = closestRp(range.startContainer);
  if (!row || row !== closestRp(range.endContainer)) return;
  const lc = row.querySelector(".lc");
  const p = Number(row.dataset.p);
  let start = textOffset(lc, range.startContainer, range.startOffset);
  let end = textOffset(lc, range.endContainer, range.endOffset);
  if (end < start) { const t = start; start = end; end = t; }
  if (end - start < 1) return;
  addHighlight(p, start, end);
  sel.removeAllRanges();
});
$("#code").addEventListener("click", (e) => {
  const mark = e.target.closest && e.target.closest(".hl");
  if (!mark) return;
  const row = e.target.closest(".row.rp");
  if (!row) return;
  const lc = row.querySelector(".lc");
  const p = Number(row.dataset.p);
  let pos = -1;
  if (document.caretRangeFromPoint) {
    const r = document.caretRangeFromPoint(e.clientX, e.clientY);
    if (r) pos = textOffset(lc, r.startContainer, r.startOffset);
  } else if (document.caretPositionFromPoint) {
    const cp = document.caretPositionFromPoint(e.clientX, e.clientY);
    if (cp) pos = textOffset(lc, cp.offsetNode, cp.offset);
  }
  if (pos >= 0) removeHighlightAt(p, pos);
});

async function saveProgress(ratio) {
  if (!state.current) return;
  const book = state.current.book;
  if (book) book._progress = { chapter_idx: state.current.idx, scroll_ratio: ratio };
  api(`/api/books/${state.current.bookId}/progress`, {
    method: "POST",
    body: JSON.stringify({ chapter_idx: state.current.idx, scroll_ratio: ratio }),
  }).catch(() => {});
}
function beaconProgress() {
  if (!state.current) return;
  const editor = $("#editor");
  const denom = editor.scrollHeight - editor.clientHeight;
  const ratio = denom > 0 ? editor.scrollTop / denom : 0;
  const body = JSON.stringify({ chapter_idx: state.current.idx, scroll_ratio: ratio });
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
  const tabs = (saved.tabs || []).filter((t) => bookById(t.bookId));
  state.tabs = tabs;
  for (const t of tabs) state.expanded.add(t.bookId);
  renderTabs();
  const active = saved.activeKey && tabs.some((t) => tabKey(t.bookId, t.idx) === saved.activeKey)
    ? saved.activeKey
    : tabs.length ? tabKey(tabs[0].bookId, tabs[0].idx) : null;
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

// Sends `file` to the server in small parts (see /api/uploads) instead of one
// long request. A proxy in front of the server gives a single request only so
// long to deliver its body, and on a slow or flaky link a big file blows past
// that and arrives truncated. Small parts each finish in seconds, can be
// retried on their own, and give real progress. Returns {ok, book} | {ok:false, error}.
async function uploadInParts(file, { onProgress, onFinishing }) {
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
    const res = await api(`/api/uploads/${id}/complete`, { method: "POST" }).catch(() => null);
    if (res) {
      const data = await res.json().catch(() => ({}));
      if (res.ok) return { ok: true, book: data };
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

async function uploadFile(file) {
  const status = $("#upload-status");
  status.hidden = false;
  status.classList.remove("err");
  const mb = (n) => (n / 1048576).toFixed(1);
  status.textContent = `> uploading ${file.name} … 0%`;

  const up = await uploadInParts(file, {
    onProgress: (done) => {
      status.textContent = `> uploading ${file.name} … ${Math.floor((done / file.size) * 100)}% (${mb(done)} / ${mb(file.size)} MB)`;
    },
    onFinishing: () => { status.textContent = `> parsing ${file.name} …`; },
  });
  if (!up.ok) {
    status.classList.add("err");
    status.textContent = `! ${up.error}`;
    return;
  }
  const data = up.book;

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
  $("#code").classList.toggle("focusread", e.target.checked);
  if (e.target.checked) updateReadingFocus();
  else if (state.readingEl) { state.readingEl.classList.remove("reading"); state.readingEl = null; }
});
$("#font-inc").addEventListener("click", () => changeFont(1));
$("#font-dec").addEventListener("click", () => changeFont(-1));
$("#width-inc").addEventListener("click", () => changeWidth(4));
$("#width-dec").addEventListener("click", () => changeWidth(-4));
function changeFont(d) {
  state.settings.fontSize = Math.min(28, Math.max(10, state.settings.fontSize + d));
  $("#font-val").textContent = state.settings.fontSize;
  saveSettings(); applySettingsToDom();
  requestAnimationFrame(() => { drawMinimap(); cacheProseRows(); updateReadingFocus(); });
}
function changeWidth(d) {
  state.settings.readWidth = Math.min(140, Math.max(50, state.settings.readWidth + d));
  $("#width-val").textContent = state.settings.readWidth;
  saveSettings(); applySettingsToDom();
  requestAnimationFrame(() => { drawMinimap(); cacheProseRows(); updateReadingFocus(); });
}
function applySettingsToDom() {
  const r = document.documentElement.style;
  r.setProperty("--code-size", state.settings.fontSize + "px");
  r.setProperty("--read-width", state.settings.readWidth + "ch");
}
function rerender() { const ch = state.current && chapterOf(state.current.bookId, state.current.idx); if (ch) renderContent(ch); }
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
}
$("#btn-reveal").addEventListener("click", toggleReveal);

/* ============================ Sidebar / panic ============================= */
function toggleSidebar() { $("#sidebar").classList.toggle("hidden"); requestAnimationFrame(drawMinimap); }

let panicVisible = false;
let panicBuffer = "";
function setPanic(on) {
  panicVisible = on;
  panicBuffer = "";
  $("#panic").hidden = !on;
  if (on) renderPanic();
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
  if (t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return false;
  return true;
}
// Continuous WASD scroll: held keys drive a rAF loop instead of jumping
// per keydown, so movement feels fluid (and immune to OS key-repeat delay).
const moveKeys = { w: false, s: false };
let moveRAF = null;
function moveLoop() {
  const editor = $("#editor");
  let speed = 0;
  if (moveKeys.w) speed -= 16;
  if (moveKeys.s) speed += 16;
  if (speed) editor.scrollTop += speed;
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
  else if (mod && e.key.toLowerCase() === "b") { e.preventDefault(); toggleSidebar(); }
  else if (mod && e.shiftKey && e.key.toLowerCase() === "u") { e.preventDefault(); openUpload(); }
  else if (mod && (e.key === "=" || e.key === "+")) { e.preventDefault(); changeFont(1); }
  else if (mod && e.key === "-") { e.preventDefault(); changeFont(-1); }
  else if (isBare(e) && e.key === "ArrowRight") { e.preventDefault(); navChapter(1); }
  else if (isBare(e) && e.key === "ArrowLeft") { e.preventDefault(); navChapter(-1); }
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
});
document.addEventListener("keyup", (e) => {
  const k = e.key.toLowerCase();
  if (k === "w" || k === "s") moveKeys[k] = false;
});
window.addEventListener("blur", stopMoveKeys);
window.addEventListener("resize", () => requestAnimationFrame(drawMinimap));

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
