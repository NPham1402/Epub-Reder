"use strict";

/* ============================ Synced state ================================== */
// Settings, highlights and reading position live on the server so they follow
// the reader across devices and are backed up. The browser keeps a cache (so
// the page works at once and offline) and pushes changes in the background.
//
// Conflicts: for settings and highlights the newest device timestamp wins (a
// device that has never synced counts as oldest, and its highlights are merged
// rather than replaced). Progress has its own rule on the server: the "furthest"
// point never goes backwards.
//
// Loaded after extensions.js (it registers two extensions).

const sync = { lastOk: 0, error: "", busy: 0, pendingSettings: new Set(), timers: {} };

const DEFAULT_SETTINGS = {
  blurHide: false, camo: false, serif: false, readFocus: true, fontSize: 15, readWidth: 82,
  panicCode: DEFAULT_PANIC_CODE, extensions: {}, theme: "dark", readSpeed: 900, remindMin: 60, librarySort: "recent",
};

async function syncFetch(path, opts = {}) {
  sync.busy++;
  const icon = $("#st-sync");
  if (icon) icon.classList.add("codicon-modifier-spin");
  try {
    const res = await api(path, opts);
    if (res.ok) { sync.lastOk = Date.now(); sync.error = ""; }
    else if (res.status !== 401) sync.error = `server answered ${res.status}`;
    return res;
  } catch (err) {
    sync.error = "offline";
    return null;
  } finally {
    if (--sync.busy === 0 && icon) icon.classList.remove("codicon-modifier-spin");
    if (icon) icon.title = sync.error ? `Sync: ${sync.error}` : sync.lastOk ? "Synced " + new Date(sync.lastOk).toLocaleTimeString() : "Sync";
    if (typeof refreshExtPage === "function" && state.activeKey === extKey("sync-backup")) refreshExtPage("sync-backup");
  }
}

/* ---- Settings --------------------------------------------------------------- */
const SETTINGS_TS_KEY = "devdocs.settings.ts";
let settingsTs = (() => { try { return JSON.parse(localStorage.getItem(SETTINGS_TS_KEY) || "{}"); } catch { return {}; } })();
const snap = () => Object.fromEntries(Object.entries(state.settings).map(([k, v]) => [k, JSON.stringify(v)]));
let settingsSnapshot = snap();

function sanitizeSetting(key, v) {
  const num = (lo, hi) => (typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v))) : undefined);
  switch (key) {
    case "blurHide": case "camo": case "serif": case "readFocus": return typeof v === "boolean" ? v : undefined;
    case "fontSize": return num(10, 28);
    case "readWidth": return num(50, 140);
    case "readSpeed": return num(200, 3000);
    case "remindMin": return [0, 30, 60, 90].includes(v) ? v : undefined;
    case "panicCode": return typeof v === "string" && v.trim() ? v.trim().toLowerCase().slice(0, 32) : undefined;
    case "theme": return THEMES.some((t) => t.id === v) ? v : undefined;
    case "librarySort": return ["recent", "added", "name", "progress"].includes(v) ? v : undefined;
    case "extensions":
      return v && typeof v === "object" && !Array.isArray(v)
        ? Object.fromEntries(Object.entries(v).filter(([, x]) => typeof x === "boolean")) : undefined;
  }
  return undefined;
}

// Called by saveSettings(): note which keys changed, and push them shortly.
function syncSettingsSoon() {
  const now = Date.now();
  for (const [k, v] of Object.entries(state.settings)) {
    const j = JSON.stringify(v);
    if (settingsSnapshot[k] !== j) { settingsSnapshot[k] = j; settingsTs[k] = now; sync.pendingSettings.add(k); }
  }
  localStorage.setItem(SETTINGS_TS_KEY, JSON.stringify(settingsTs));
  clearTimeout(sync.timers.settings);
  sync.timers.settings = setTimeout(pushSettings, 1500);
}
async function pushSettings() {
  if (!sync.pendingSettings.size) return;
  const sent = {};
  const changes = {};
  for (const k of sync.pendingSettings) { sent[k] = settingsTs[k]; changes[k] = { value: state.settings[k], updated_at: settingsTs[k] }; }
  const res = await syncFetch("/api/settings", { method: "PUT", body: JSON.stringify({ changes }) });
  if (res && res.ok) for (const k of Object.keys(sent)) if (settingsTs[k] === sent[k]) sync.pendingSettings.delete(k);
}

async function pullSettings() {
  const res = await syncFetch("/api/settings");
  if (!res || !res.ok) return;
  const remote = (await res.json()).settings || {};
  const before = { ...state.settings, extensions: { ...state.settings.extensions } };
  const changedKeys = [];
  for (const [k, e] of Object.entries(remote)) {
    if (!(k in DEFAULT_SETTINGS)) continue; // a newer UI's setting: not ours to interpret
    if (e.updated_at > (settingsTs[k] || 0)) {
      const v = sanitizeSetting(k, e.value);
      if (v !== undefined && JSON.stringify(v) !== JSON.stringify(state.settings[k])) { state.settings[k] = v; changedKeys.push(k); }
      settingsTs[k] = e.updated_at;
      settingsSnapshot[k] = JSON.stringify(state.settings[k]);
    }
  }
  // Values only this device has (a first sync, or edits made offline) go up.
  // At a first sync only values the reader actually changed are sent, so a
  // fresh device's defaults never override another device's choices.
  for (const k of Object.keys(DEFAULT_SETTINGS)) {
    const e = remote[k];
    const local = JSON.stringify(state.settings[k]);
    if (e && (settingsTs[k] || 0) <= e.updated_at) continue;
    if (!e && local === JSON.stringify(DEFAULT_SETTINGS[k])) continue;
    if (!settingsTs[k]) settingsTs[k] = Date.now();
    sync.pendingSettings.add(k);
  }
  localStorage.setItem(SETTINGS_TS_KEY, JSON.stringify(settingsTs));
  if (changedKeys.length) {
    localStorage.setItem("devdocs.settings", JSON.stringify(state.settings));
    applyLoadedSettings(before, changedKeys);
  }
  if (sync.pendingSettings.size) pushSettings();
}

// Make the running UI reflect settings that just arrived from another device.
function applyLoadedSettings(before, changedKeys) {
  applySettingsToDom();
  applyTheme();
  applyReaderOptions();
  for (const d of EXTENSIONS) {
    const was = typeof before.extensions[d.id] === "boolean" ? before.extensions[d.id] : !!d.defaultEnabled;
    const now = extEnabled(d.id);
    if (was !== now) { if (now) { if (d.onEnable) d.onEnable(); } else if (d.onDisable) d.onDisable(); }
  }
  renderExtList();
  if (isExtKey(state.activeKey)) refreshExtPage(state.activeKey.slice(4));
  if (changedKeys.some((k) => k === "camo" || k === "serif" || k === "readFocus")) rerender();
}

/* ---- Highlights ---------------------------------------------------------------- */
const hlTsKey = (b, i) => `devdocs.hlts:${b}:${i}`;
const hlGet = (b, i) => { try { return JSON.parse(localStorage.getItem(hlKey(b, i)) || "null"); } catch { return null; } };
const hlTs = (b, i) => Number(localStorage.getItem(hlTsKey(b, i))) || 0;
const HLQ_KEY = "devdocs.hlq";
const hlQueue = new Set((() => { try { return JSON.parse(localStorage.getItem(HLQ_KEY) || "[]"); } catch { return []; } })());
const persistQueue = () => localStorage.setItem(HLQ_KEY, JSON.stringify([...hlQueue]));

// Called by saveHighlights(): stamp the change and push it shortly.
function syncHighlightsSoon(bookId, idx) {
  localStorage.setItem(hlTsKey(bookId, idx), String(Date.now()));
  hlQueue.add(`${bookId}:${idx}`);
  persistQueue();
  clearTimeout(sync.timers.hl);
  sync.timers.hl = setTimeout(flushHighlights, 1200);
}
async function flushHighlights() {
  for (const key of [...hlQueue]) {
    const cut = key.lastIndexOf(":");
    const b = key.slice(0, cut);
    const i = Number(key.slice(cut + 1));
    const items = hlGet(b, i) || [];
    const res = await syncFetch(`/api/books/${b}/chapters/${i}/highlights`, {
      method: "PUT", body: JSON.stringify({ items, updated_at: hlTs(b, i) || Date.now() }),
    });
    if (res && (res.ok || res.status === 404 || res.status === 400)) hlQueue.delete(key); // 4xx: the book is gone or the data is unusable; retrying can't help
    else break; // offline or server trouble: keep the rest for later
  }
  persistQueue();
}
const hlUnion = (a, b) => {
  const seen = new Set();
  return [...a, ...b].filter((h) => { const k = `${h.p}:${h.start}:${h.end}`; if (seen.has(k)) return false; seen.add(k); return true; });
};

// Runs when a book's index is loaded: reconcile this device's cache with the server.
async function syncBookHighlights(bookId) {
  const res = await syncFetch(`/api/books/${bookId}/highlights`);
  if (!res || !res.ok) return;
  const remote = (await res.json()).chapters || {};
  const local = new Set();
  const prefix = `devdocs.hl:${bookId}:`;
  for (let n = 0; n < localStorage.length; n++) { const k = localStorage.key(n); if (k && k.startsWith(prefix)) local.add(Number(k.slice(prefix.length))); }
  let touchedCurrent = false;
  const adopt = (idx, items, ts) => {
    localStorage.setItem(hlKey(bookId, idx), JSON.stringify(items));
    localStorage.setItem(hlTsKey(bookId, idx), String(ts));
    if (state.current && state.current.bookId === bookId && state.current.idx === idx) touchedCurrent = true;
  };
  const push = (idx) => hlQueue.add(`${bookId}:${idx}`);
  for (const idx of new Set([...Object.keys(remote).map(Number), ...local])) {
    const re = remote[idx];
    const items = hlGet(bookId, idx);
    const ts = hlTs(bookId, idx);
    if (!re) { if (items && items.length) { if (!ts) localStorage.setItem(hlTsKey(bookId, idx), String(Date.now())); push(idx); } continue; }
    if (!items) adopt(idx, re.items, re.updated_at);
    else if (!ts) { adopt(idx, hlUnion(items, re.items), Date.now()); push(idx); } // never synced: merge, don't replace
    else if (re.updated_at > ts) adopt(idx, re.items, re.updated_at);
    else if (ts > re.updated_at) push(idx);
  }
  persistQueue();
  if (hlQueue.size) flushHighlights();
  if (touchedCurrent) { state.hl = loadHighlights(state.current.bookId, state.current.idx); paintHighlights(); }
}

/* ---- Boot / refocus ---------------------------------------------------------------- */
async function syncNow() {
  await pullSettings();
  await flushHighlights();
  await pushSettings();
  if (typeof bmRefresh === "function" && extEnabled("bookmarks")) bmRefresh();
}
function syncBoot() {
  pullSettings().then(flushHighlights);
}
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && !$("#app").hidden) syncNow(); });
window.addEventListener("online", () => { flushHighlights(); pushSettings(); });

/* ============================ Sync & Backup (extension) ====================== */
registerExtension({
  id: "sync-backup",
  name: "Sync & Backup",
  version: "1.0.0",
  icon: "cloud",
  description: "Keeps settings, highlights and reading position in sync across devices.",
  defaultEnabled: true,
  render(body) {
    const row = (label, value) => {
      const r = el("div", "ft-row");
      r.appendChild(el("div", "ft-label", label));
      r.appendChild(el("div", null, value));
      body.appendChild(r);
    };
    body.appendChild(el("p", "xp-note", "Your settings, highlights, bookmarks and reading position are stored on the server and shared by every device you sign in on. The server itself is backed up every night."));
    row("Status", sync.error ? `Problem: ${sync.error}` : sync.busy ? "Syncing…" : sync.lastOk ? "Up to date" : "Not synced yet");
    row("Last sync", sync.lastOk ? new Date(sync.lastOk).toLocaleString() : "never");
    row("Waiting to upload", `${sync.pendingSettings.size} setting(s), ${hlQueue.size} highlighted chapter(s)`);
    const btn = el("button", "xp-btn", "Sync now");
    btn.type = "button";
    btn.addEventListener("click", () => syncNow());
    body.appendChild(btn);
  },
});

/* ============================ Bookmarks (extension) ========================== */
const bm = { list: [], loaded: false, coll: null };
// redraw=false when the caller (the Bookmarks page) redraws itself, else the page
// would refresh itself in a loop.
async function bmRefresh(redraw = true) {
  const res = await syncFetch("/api/bookmarks");
  if (!res || !res.ok) return;
  bm.list = (await res.json()).bookmarks || [];
  bm.loaded = true;
  bmPaint();
  if (redraw && state.activeKey === extKey("bookmarks")) refreshExtPage("bookmarks");
}
function bmPaint() {
  const ed = reader.ed;
  if (bm.coll) { bm.coll.clear(); bm.coll = null; }
  if (!extEnabled("bookmarks") || !ed || !state.current || !ed.getModel()) return;
  const cur = state.current;
  bm.coll = ed.createDecorationsCollection(
    bm.list.filter((b) => b.book_id === cur.bookId && b.chapter_idx === cur.idx && reader.paraLine[b.p])
      .map((b) => ({ range: new window.monaco.Range(reader.paraLine[b.p], 1, reader.paraLine[b.p], 1), options: { isWholeLine: true, linesDecorationsClassName: "bm-mark" } })));
}
async function addBookmarkAtReading() {
  if (!extEnabled("bookmarks") || !state.current || !reader.ed || panicVisible) return;
  const line = activeParagraphLine();
  const meta = line && reader.meta[line - 1];
  if (!meta || meta.kind !== "p") { showToast("Move to a paragraph first, then add the bookmark.", [], 2500); return; }
  const snippet = reader.ed.getModel().getLineContent(line).slice(0, 80);
  const res = await syncFetch(`/api/books/${state.current.bookId}/bookmarks`, {
    method: "POST", body: JSON.stringify({ chapter_idx: state.current.idx, p: meta.p, snippet }),
  });
  if (!res || !res.ok) { showToast("Could not add the bookmark right now.", [], 3000); return; }
  await bmRefresh();
  showToast(`Bookmark added at line ${line}.`, [], 2500);
}
async function openBookmark(b) {
  const book = bookById(b.book_id);
  if (!book || !(await loadBookIndex(book))) return;
  state.expanded.add(book.id);
  state.reveal = { key: tabKey(book.id, b.chapter_idx), p: b.p };
  renderTree();
  openTab(book.id, b.chapter_idx);
}
registerExtension({
  id: "bookmarks",
  name: "Bookmarks",
  version: "1.0.0",
  icon: "bookmark",
  description: "Bookmark a paragraph with Ctrl+Alt+K and jump back to it later.",
  defaultEnabled: false,
  onEnable: () => bmRefresh(),
  onDisable: () => bmPaint(),
  render(body) {
    body.appendChild(el("p", "xp-note", "Press Ctrl+Alt+K while reading to bookmark the paragraph you are on. Bookmarked paragraphs show a bar next to their line number."));
    const list = el("div", "bm-list");
    body.appendChild(list);
    const draw = () => {
      list.innerHTML = "";
      if (!bm.loaded) { list.appendChild(el("p", "xp-off", "Loading…")); return; }
      if (!bm.list.length) { list.appendChild(el("p", "xp-off", "No bookmarks yet.")); return; }
      for (const b of bm.list) {
        const book = bookById(b.book_id);
        if (!book) continue;
        const ch = book._chapters && book._chapters[b.chapter_idx];
        const row = el("div", "bm-row");
        const info = el("div", "bm-info");
        info.appendChild(el("div", "bm-where", `${bookLabel(book)}  ›  ${ch ? displayName(ch) : "file " + b.chapter_idx}`));
        info.appendChild(el("div", "bm-snip", b.snippet || "(no text)"));
        row.appendChild(info);
        const del = el("button", "bm-del " + codiCls("trash"));
        del.type = "button";
        del.title = "Remove bookmark";
        del.addEventListener("click", async (e) => {
          e.stopPropagation();
          const res = await syncFetch(`/api/bookmarks/${b.id}`, { method: "DELETE" });
          if (res && (res.ok || res.status === 404)) { bm.list = bm.list.filter((x) => x.id !== b.id); bmPaint(); draw(); }
        });
        row.appendChild(del);
        row.addEventListener("click", () => openBookmark(b));
        list.appendChild(row);
      }
    };
    draw();
    bmRefresh(false).then(draw);
  },
});
// Called by onExtEvent (extensions.js) whenever a chapter is shown.
function bmOnChapter() {
  if (!extEnabled("bookmarks")) return;
  if (bm.loaded) bmPaint(); else bmRefresh();
}
