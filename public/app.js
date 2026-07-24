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

function loadSettings() {
  let s = {};
  try { s = JSON.parse(localStorage.getItem("devdocs.settings") || "{}"); } catch {}
  return {
    blurHide: !!s.blurHide,
    camo: !!s.camo,
    serif: !!s.serif,
    fontSize: s.fontSize || 15,
    readWidth: s.readWidth || 82,
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
  if ((!data.chapters || !data.chapters.length) && data.chapter_count > 0) {
    // Old-format book (content stored as one blob) — re-index from its .epub.
    await api(`/api/books/${book.id}/reindex`, { method: "POST" }).catch(() => {});
    res = await api(`/api/books/${book.id}/index`);
    if (!res.ok) return false;
    data = await res.json();
  }
  book._chapters = data.chapters || [];
  computeLabels(book._chapters);
  book._progress = data.progress || null;
  if (data.code_name) book.code_name = data.code_name;
  if (data.title) book.title = data.title;
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
  ch._blocks = data.blocks || [];
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
  code.innerHTML = "";

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

  for (const b of blocks) {
    if (b.type === "h1" || b.type === "h2" || b.type === "h3") {
      heading(b.text, b.type === "h1" ? 1 : b.type === "h2" ? 2 : 3);
    } else if (camo) {
      line("rc", `<span class="tok-comment">// </span>${esc(b.text)}`, b.text.length, "c");
      blank();
    } else {
      line("rp", esc(b.text), b.text.length, "p");
      blank();
    }
  }

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
  requestAnimationFrame(drawMinimap);
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
  if (!state.mmRAF) state.mmRAF = requestAnimationFrame(() => { state.mmRAF = 0; drawMinimap(); });
  updatePos();
  if (!state.current) return;
  const editor = $("#editor");
  const denom = editor.scrollHeight - editor.clientHeight;
  const ratio = denom > 0 ? editor.scrollTop / denom : 0;
  clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(() => saveProgress(ratio), 700);
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

async function uploadFile(file) {
  const status = $("#upload-status");
  status.hidden = false;
  status.classList.remove("err");
  status.textContent = `> parsing ${file.name} …`;
  const fd = new FormData();
  fd.append("file", file);
  const res = await api("/api/books", { method: "POST", body: fd });
  const data = await res.json().catch(() => ({}));
  if (res.ok) {
    status.textContent = `> indexed as "${data.code_name}" · ${data.chapters} files`;
    const list = await api("/api/books").then((r) => r.json());
    state.books = list.books;
    renderTree();
    setTimeout(() => { $("#upload").hidden = true; status.hidden = true; }, 1200);
  } else {
    status.classList.add("err");
    status.textContent = `! ${data.error || "upload failed (HTTP " + res.status + ")"}`;
  }
}

/* ============================ Settings ==================================== */
function openSettings() {
  $("#opt-blur").checked = state.settings.blurHide;
  $("#opt-camo").checked = state.settings.camo;
  $("#opt-serif").checked = state.settings.serif;
  $("#font-val").textContent = state.settings.fontSize;
  $("#width-val").textContent = state.settings.readWidth;
  $("#settings").hidden = false;
}
$("#btn-settings").addEventListener("click", openSettings);
$("#btn-account").addEventListener("click", openSettings);
$("#opt-blur").addEventListener("change", (e) => { state.settings.blurHide = e.target.checked; saveSettings(); });
$("#opt-camo").addEventListener("change", (e) => { state.settings.camo = e.target.checked; saveSettings(); rerender(); });
$("#opt-serif").addEventListener("change", (e) => { state.settings.serif = e.target.checked; saveSettings(); rerender(); });
$("#font-inc").addEventListener("click", () => changeFont(1));
$("#font-dec").addEventListener("click", () => changeFont(-1));
$("#width-inc").addEventListener("click", () => changeWidth(4));
$("#width-dec").addEventListener("click", () => changeWidth(-4));
function changeFont(d) {
  state.settings.fontSize = Math.min(28, Math.max(10, state.settings.fontSize + d));
  $("#font-val").textContent = state.settings.fontSize;
  saveSettings(); applySettingsToDom(); requestAnimationFrame(drawMinimap);
}
function changeWidth(d) {
  state.settings.readWidth = Math.min(140, Math.max(50, state.settings.readWidth + d));
  $("#width-val").textContent = state.settings.readWidth;
  saveSettings(); applySettingsToDom();
}
function applySettingsToDom() {
  const r = document.documentElement.style;
  r.setProperty("--code-size", state.settings.fontSize + "px");
  r.setProperty("--read-width", state.settings.readWidth + "ch");
}
function rerender() { const ch = state.current && chapterOf(state.current.bookId, state.current.idx); if (ch) renderContent(ch); }
$("#btn-logout").addEventListener("click", async () => { await api("/api/logout", { method: "POST" }); location.reload(); });

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
function setPanic(on) { panicVisible = on; $("#panic").hidden = !on; if (on) renderPanic(); }
function anyModalOpen() { return ["upload", "settings", "login"].some((id) => !$("#" + id).hidden); }
function renderPanic() {
  $("#panic-code").innerHTML = PANIC_CODE;
  $("#panic-term").innerHTML = PANIC_TERM + '<span class="term-cursor">&nbsp;</span>';
}
window.addEventListener("blur", () => {
  if (state.settings.blurHide && $("#app").hidden === false && !anyModalOpen()) setPanic(true);
});

/* ============================ Keyboard ==================================== */
document.addEventListener("keydown", (e) => {
  // Focus mode (boss key): "\" opens it, Esc closes it.
  if (panicVisible) {
    if (e.key === "Escape") setPanic(false);
    e.preventDefault();
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
  else if (e.altKey && e.key === "ArrowRight") { e.preventDefault(); navChapter(1); }
  else if (e.altKey && e.key === "ArrowLeft") { e.preventDefault(); navChapter(-1); }
  else if (e.altKey && /^[1-9]$/.test(e.key)) { e.preventDefault(); switchToTabIndex(Number(e.key) - 1); }
});
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
