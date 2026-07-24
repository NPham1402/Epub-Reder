"use strict";

// ============================ State =========================================
const state = {
  books: [],
  expanded: new Set(), // book ids whose chapter list is open
  current: null, // { bookId, code_name, idx, fileName, chapters:[...] }
  saveTimer: null,
  restoreRatio: 0,
  settings: loadSettings(),
};

const $ = (sel) => document.querySelector(sel);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};
const esc = (s) =>
  String(s).replace(/[&<>"']/g, (m) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]),
  );

function loadSettings() {
  let s = {};
  try {
    s = JSON.parse(localStorage.getItem("devdocs.settings") || "{}");
  } catch {}
  return {
    blurHide: s.blurHide !== false, // default ON
    camo: !!s.camo,
    fontSize: s.fontSize || 15,
  };
}
function saveSettings() {
  localStorage.setItem("devdocs.settings", JSON.stringify(state.settings));
}

// ============================ API ===========================================
async function api(path, opts = {}) {
  const res = await fetch(path, {
    credentials: "same-origin",
    headers: opts.body && !(opts.body instanceof FormData)
      ? { "content-type": "application/json" }
      : undefined,
    ...opts,
  });
  return res;
}

// ============================ Auth ==========================================
async function boot() {
  const res = await api("/api/books");
  if (res.status === 401) {
    showLogin();
    return;
  }
  const data = await res.json();
  state.books = data.books || [];
  $("#app").hidden = false;
  applySettingsToDom();
  renderTree();
}

function showLogin() {
  $("#login").hidden = false;
  setTimeout(() => $("#login-pass").focus(), 50);
}

$("#login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const passcode = $("#login-pass").value;
  const res = await api("/api/auth", { method: "POST", body: JSON.stringify({ passcode }) });
  if (res.ok) {
    $("#login").hidden = true;
    $("#login-pass").value = "";
    boot();
  } else {
    $("#login-error").hidden = false;
    $("#login-pass").select();
  }
});

// ============================ Tree ==========================================
function extOf(name) {
  const m = name.match(/\.([a-z0-9]+)$/i);
  return m ? m[1].toLowerCase() : "";
}
function extClass(name) {
  const e = extOf(name);
  return ["ts", "tsx", "md", "py", "go", "rs", "sql"].includes(e) ? `tree-ext-${e === "tsx" ? "ts" : e}` : "tree-ext-default";
}
function langOf(name) {
  const map = { ts: "TypeScript", tsx: "TypeScript JSX", md: "Markdown", py: "Python", go: "Go", rs: "Rust", sql: "SQL", java: "Java", yaml: "YAML", kt: "Kotlin" };
  return map[extOf(name)] || "Markdown";
}

function renderTree() {
  const tree = $("#tree");
  tree.innerHTML = "";
  for (const book of state.books) {
    const bookNode = el("div", "tree-book");
    const row = el("div", "tree-row");
    row.dataset.bookId = book.id;
    const open = state.expanded.has(book.id);
    row.appendChild(el("span", "tree-caret", open ? "▾" : "▸"));
    row.appendChild(el("span", "tree-ico", "📁"));
    row.appendChild(el("span", "tree-label", book.code_name));
    const del = el("span", "tree-del", "🗑");
    del.title = "Remove module";
    del.addEventListener("click", (e) => {
      e.stopPropagation();
      removeBook(book);
    });
    row.appendChild(del);
    row.addEventListener("click", () => toggleBook(book.id));
    bookNode.appendChild(row);

    const children = el("div", "tree-children" + (open ? "" : " collapsed"));
    children.dataset.for = book.id;
    if (open && book._chapters) {
      for (const ch of book._chapters) {
        const f = el("div", "tree-row tree-file");
        f.dataset.bookId = book.id;
        f.dataset.idx = ch.idx;
        if (state.current && state.current.bookId === book.id && state.current.idx === ch.idx) {
          f.classList.add("active");
        }
        f.appendChild(el("span", "tree-ico " + extClass(ch.file_name), "❮❯"));
        f.appendChild(el("span", "tree-label", ch.file_name));
        f.addEventListener("click", () => openChapter(book.id, ch.idx));
        children.appendChild(f);
      }
    }
    bookNode.appendChild(children);
    tree.appendChild(bookNode);
  }
  $("#sb-footer").textContent = `${state.books.length} module${state.books.length === 1 ? "" : "s"}`;
}

// Fetch the whole book once (chapters + blocks) and cache it on the book object.
async function loadBookContent(book) {
  if (book._chapters) return true;
  const res = await api(`/api/books/${book.id}/content`);
  if (!res.ok) return false;
  const data = await res.json();
  book._chapters = data.chapters || [];
  book._progress = data.progress || null;
  if (data.code_name) book.code_name = data.code_name;
  return true;
}

async function toggleBook(bookId) {
  const book = state.books.find((b) => b.id === bookId);
  if (!book) return;
  if (state.expanded.has(bookId)) {
    state.expanded.delete(bookId);
    renderTree();
    return;
  }
  if (!(await loadBookContent(book))) return;
  state.expanded.add(bookId);
  renderTree();
  // Resume where the reader left off, first time a book is opened.
  if (book._progress && (!state.current || state.current.bookId !== bookId)) {
    state.restoreRatio = book._progress.scroll_ratio || 0;
    openChapter(bookId, book._progress.chapter_idx || 0);
  }
}

async function removeBook(book) {
  if (!confirm(`Remove module "${book.code_name}"? This deletes it permanently.`)) return;
  const res = await api(`/api/books/${book.id}`, { method: "DELETE" });
  if (!res.ok) return;
  state.books = state.books.filter((b) => b.id !== book.id);
  state.expanded.delete(book.id);
  if (state.current && state.current.bookId === book.id) closeEditor();
  renderTree();
}

// ============================ Chapter rendering =============================
async function openChapter(bookId, idx) {
  const book = state.books.find((b) => b.id === bookId);
  if (!book) return;
  if (!(await loadBookContent(book))) return;
  const chapters = book._chapters;
  if (idx < 0 || idx >= chapters.length) return;
  const ch = chapters[idx];
  state.expanded.add(bookId);

  state.current = {
    bookId,
    code_name: book.code_name,
    idx,
    fileName: ch.file_name,
    title: ch.title,
    chapters,
  };
  renderContent({ file_name: ch.file_name, title: ch.title, blocks: ch.blocks });
  renderTree();
  renderTabs();
  renderBreadcrumbs();
  updateStatusFile();
}

function renderContent(data) {
  const code = $("#code");
  const camo = state.settings.camo;
  $("#welcome").hidden = true;
  code.hidden = false;
  code.innerHTML = "";

  let n = 0;
  const frag = document.createDocumentFragment();
  const line = (cls, html) => {
    n++;
    const row = el("div", "row " + cls);
    const ln = el("span", "ln", String(n));
    const lc = el("span", "lc");
    lc.innerHTML = html;
    row.appendChild(ln);
    row.appendChild(lc);
    frag.appendChild(row);
    return row;
  };
  const blank = () => line("rb", "&nbsp;");

  // Header banner styled as a documentation heading.
  const heading = data.title || data.file_name;
  line("rh", `<span class="tok-cmt"># </span><span class="tok-h">${esc(heading)}</span>`);
  blank();
  line("rc", `<span class="tok-cmt">&gt; module: ${esc(state.current.code_name)} · generated documentation</span>`);
  blank();

  for (const b of data.blocks) {
    if (b.type === "h1" || b.type === "h2" || b.type === "h3") {
      const hashes = b.type === "h1" ? "#" : b.type === "h2" ? "##" : "###";
      blank();
      line("rh", `<span class="tok-cmt">${hashes} </span><span class="tok-h">${esc(b.text)}</span>`);
      blank();
    } else if (camo) {
      line("rc", `<span class="tok-cmt">// </span>${esc(b.text)}`);
      blank();
    } else {
      line("rp", esc(b.text));
      blank();
    }
  }

  // Navigation footer (prev / next) disguised as trailing comments.
  const chapters = state.current.chapters;
  const cur = state.current.idx;
  blank();
  line("rc", `<span class="tok-cmt">// ─────────────────────────────</span>`);
  if (cur > 0) {
    const prev = chapters.find((c) => c.idx === cur - 1);
    const row = line("rc navline", `<span class="tok-cmt">// ◄ import ./${esc(prev ? prev.file_name : "prev")}</span>`);
    row.addEventListener("click", () => openChapter(state.current.bookId, cur - 1));
  }
  const next = chapters.find((c) => c.idx === cur + 1);
  if (next) {
    const row = line("rc navline", `<span class="tok-cmt">// ► import ./${esc(next.file_name)}</span>`);
    row.addEventListener("click", () => openChapter(state.current.bookId, cur + 1));
  }

  code.appendChild(frag);

  // Restore scroll position (once), else scroll to top.
  const editor = $("#editor");
  requestAnimationFrame(() => {
    if (state.restoreRatio > 0) {
      editor.scrollTop = state.restoreRatio * (editor.scrollHeight - editor.clientHeight);
      state.restoreRatio = 0;
    } else {
      editor.scrollTop = 0;
    }
  });
}

function closeEditor() {
  state.current = null;
  $("#code").hidden = true;
  $("#welcome").hidden = false;
  $("#tabs").innerHTML = "";
  $("#breadcrumbs").innerHTML = "";
}

// ============================ Tabs & breadcrumbs ============================
function renderTabs() {
  const tabs = $("#tabs");
  tabs.innerHTML = "";
  if (!state.current) return;
  const tab = el("div", "tab active");
  tab.appendChild(el("span", "tab-dot"));
  tab.appendChild(el("span", "tab-name", state.current.fileName));
  const close = el("span", "tab-close", "✕");
  close.addEventListener("click", closeEditor);
  tab.appendChild(close);
  tabs.appendChild(tab);
  document.title = `${state.current.fileName} — devdocs`;
}

function renderBreadcrumbs() {
  const bc = $("#breadcrumbs");
  bc.innerHTML = "";
  if (!state.current) return;
  ["src", state.current.code_name, state.current.fileName].forEach((c) => {
    bc.appendChild(el("span", "crumb", c));
  });
}

function updateStatusFile() {
  $("#st-lang").textContent = state.current ? langOf(state.current.fileName) : "Markdown";
}

// ============================ Progress ======================================
$("#editor").addEventListener("scroll", () => {
  if (!state.current) return;
  const editor = $("#editor");
  const denom = editor.scrollHeight - editor.clientHeight;
  const ratio = denom > 0 ? editor.scrollTop / denom : 0;
  const pct = Math.round(ratio * 100);
  $("#st-pos").textContent = `Ln ${Math.max(1, Math.round(ratio * 400))}, Col 1  (${pct}%)`;
  clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(() => saveProgress(ratio), 800);
});

async function saveProgress(ratio) {
  if (!state.current) return;
  api(`/api/books/${state.current.bookId}/progress`, {
    method: "POST",
    body: JSON.stringify({ chapter_idx: state.current.idx, scroll_ratio: ratio }),
  }).catch(() => {});
}

// ============================ Upload ========================================
function openUpload() {
  $("#upload").hidden = false;
}
$("#btn-upload").addEventListener("click", openUpload);
$("#btn-upload2").addEventListener("click", openUpload);

const dropzone = $("#dropzone");
const fileInput = $("#file-input");
fileInput.addEventListener("change", () => {
  if (fileInput.files[0]) uploadFile(fileInput.files[0]);
});
["dragover", "dragenter"].forEach((ev) =>
  dropzone.addEventListener(ev, (e) => {
    e.preventDefault();
    dropzone.classList.add("drag");
  }),
);
["dragleave", "drop"].forEach((ev) =>
  dropzone.addEventListener(ev, (e) => {
    e.preventDefault();
    dropzone.classList.remove("drag");
  }),
);
dropzone.addEventListener("drop", (e) => {
  const f = e.dataTransfer.files[0];
  if (f) uploadFile(f);
});

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
    setTimeout(() => {
      $("#upload").hidden = true;
      status.hidden = true;
    }, 1200);
  } else {
    status.classList.add("err");
    status.textContent = `! ${data.error || "upload failed (HTTP " + res.status + ")"}`;
  }
}

// ============================ Settings ======================================
function openSettings() {
  $("#opt-blur").checked = state.settings.blurHide;
  $("#opt-camo").checked = state.settings.camo;
  $("#font-val").textContent = state.settings.fontSize;
  $("#settings").hidden = false;
}
$("#btn-settings").addEventListener("click", openSettings);
$("#btn-account").addEventListener("click", openSettings);
$("#opt-blur").addEventListener("change", (e) => {
  state.settings.blurHide = e.target.checked;
  saveSettings();
});
$("#opt-camo").addEventListener("change", (e) => {
  state.settings.camo = e.target.checked;
  saveSettings();
  if (state.current) openChapter(state.current.bookId, state.current.idx);
});
$("#font-inc").addEventListener("click", () => changeFont(1));
$("#font-dec").addEventListener("click", () => changeFont(-1));
function changeFont(d) {
  state.settings.fontSize = Math.min(28, Math.max(10, state.settings.fontSize + d));
  $("#font-val").textContent = state.settings.fontSize;
  saveSettings();
  applySettingsToDom();
}
function applySettingsToDom() {
  document.documentElement.style.setProperty("--code-size", state.settings.fontSize + "px");
}
$("#btn-logout").addEventListener("click", async () => {
  await api("/api/logout", { method: "POST" });
  location.reload();
});

// Close buttons / backdrop clicks.
document.querySelectorAll("[data-close]").forEach((b) =>
  b.addEventListener("click", () => ($("#" + b.dataset.close).hidden = true)),
);
document.querySelectorAll(".modal-backdrop").forEach((bd) =>
  bd.addEventListener("click", (e) => {
    if (e.target === bd && bd.id !== "login") bd.hidden = true;
  }),
);

// ============================ Sidebar toggle ================================
function toggleSidebar() {
  $("#sidebar").classList.toggle("hidden");
}

// ============================ Panic / focus overlay =========================
let panicVisible = false;
function setPanic(on) {
  panicVisible = on;
  $("#panic").hidden = !on;
  if (on) renderPanic();
}
function anyModalOpen() {
  return ["upload", "settings", "login"].some((id) => !$("#" + id).hidden);
}

function renderPanic() {
  const code = $("#panic-code");
  code.innerHTML = PANIC_CODE;
  const term = $("#panic-term");
  term.innerHTML = PANIC_TERM + '<span class="term-cursor">&nbsp;</span>';
}

window.addEventListener("blur", () => {
  if (state.settings.blurHide && $("#app").hidden === false && !anyModalOpen()) {
    setPanic(true);
  }
});

// ============================ Keyboard ======================================
document.addEventListener("keydown", (e) => {
  // Boss key / focus mode.
  if (e.key === "Escape") {
    if (anyModalOpen()) return;
    e.preventDefault();
    setPanic(!panicVisible);
    return;
  }
  if (panicVisible) {
    // Any key returns from panic (like dismissing a screensaver).
    if (e.key.length === 1 || e.key === "Enter" || e.key === " ") setPanic(false);
    return;
  }
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key.toLowerCase() === "b") {
    e.preventDefault();
    toggleSidebar();
  } else if (mod && e.shiftKey && e.key.toLowerCase() === "u") {
    e.preventDefault();
    openUpload();
  } else if (mod && (e.key === "=" || e.key === "+")) {
    e.preventDefault();
    changeFont(1);
  } else if (mod && e.key === "-") {
    e.preventDefault();
    changeFont(-1);
  } else if (e.altKey && e.key === "ArrowRight") {
    if (state.current) openChapter(state.current.bookId, state.current.idx + 1);
  } else if (e.altKey && e.key === "ArrowLeft") {
    if (state.current && state.current.idx > 0) openChapter(state.current.bookId, state.current.idx - 1);
  }
});

// ============================ Panic content ================================
const PANIC_CODE = [
  '<span class="pl-cmt">// src/edge/session-gateway.ts</span>',
  '<span class="pl-key">import</span> { Router } <span class="pl-key">from</span> <span class="pl-str">"itty-router"</span>;',
  '<span class="pl-key">import</span> { verifyJWT, signSession } <span class="pl-key">from</span> <span class="pl-str">"../crypto/jwt"</span>;',
  "",
  '<span class="pl-key">export interface</span> Env {',
  "  SESSIONS: KVNamespace;",
  "  DB: D1Database;",
  "  JWT_SECRET: <span class=\"pl-key\">string</span>;",
  "}",
  "",
  '<span class="pl-key">const</span> router = Router();',
  "",
  'router.<span class="pl-fn">post</span>(<span class="pl-str">"/v1/auth/refresh"</span>, <span class="pl-key">async</span> (req, env: Env) => {',
  '  <span class="pl-key">const</span> token = req.headers.<span class="pl-fn">get</span>(<span class="pl-str">"authorization"</span>)?.<span class="pl-fn">slice</span>(7);',
  '  <span class="pl-key">if</span> (!token) <span class="pl-key">return</span> <span class="pl-fn">json</span>({ error: <span class="pl-str">"missing token"</span> }, 401);',
  "",
  '  <span class="pl-key">const</span> claims = <span class="pl-key">await</span> <span class="pl-fn">verifyJWT</span>(token, env.JWT_SECRET);',
  '  <span class="pl-key">if</span> (!claims) <span class="pl-key">return</span> <span class="pl-fn">json</span>({ error: <span class="pl-str">"invalid token"</span> }, 401);',
  "",
  '  <span class="pl-key">const</span> session = <span class="pl-key">await</span> <span class="pl-fn">signSession</span>(claims.sub, env.JWT_SECRET, 3600);',
  '  <span class="pl-key">await</span> env.SESSIONS.<span class="pl-fn">put</span>(claims.sub, session, { expirationTtl: 3600 });',
  '  <span class="pl-key">return</span> <span class="pl-fn">json</span>({ session, expiresIn: 3600 });',
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
  "-------------------",
  "Total Upload: 48.21 KiB / gzip: 12.07 KiB",
  "Your Worker has access to the following bindings:",
  "  - D1 Databases: DB",
  "  - KV Namespaces: SESSIONS",
  "Uploaded edge-session-gateway (3.11 sec)",
  "Deployed edge-session-gateway triggers (0.42 sec)",
  "  https://edge-session-gateway.workers.dev",
  "Current Version ID: 7a1c9f2e-3b44-48d1-9c02-5e8b1a0f6d3c",
  "",
  '<span class="pl-cmt">$ npm test -- --watch</span>',
  " PASS  test/session.spec.ts (2.4s)",
  " PASS  test/jwt.spec.ts (1.1s)",
  "Test Suites: 2 passed, 2 total",
  "Tests:       17 passed, 17 total",
  "",
  '<span class="pl-cmt">$ </span>',
].join("\n");

// ============================ Go ============================================
boot();
