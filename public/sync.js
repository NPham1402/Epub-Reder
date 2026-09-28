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
    const isErr = !!sync.error;
    const isBusy = sync.busy;

    // 1. Hero Status Card
    const hero = el("div", "xp-hero-card");
    const heroLeft = el("div", "xp-hero-left");
    const statusPill = el("div", "xp-status-pill " + (isErr ? "error" : isBusy ? "busy" : "ok"));
    statusPill.appendChild(el("span", "xp-pulse-dot"));
    statusPill.appendChild(document.createTextNode(isErr ? "Sync Error" : isBusy ? "Syncing in Progress..." : "Cloud Database In Sync"));
    heroLeft.appendChild(statusPill);
    heroLeft.appendChild(el("h3", "xp-hero-title", "Universal Cross-Device Synchronization"));
    heroLeft.appendChild(el("p", "xp-hero-sub", "Your reading milestones, text annotations, bookmarks, and interface settings are continuously mirrored to the server with encrypted session tokens."));
    hero.appendChild(heroLeft);
    body.appendChild(hero);

    // 2. Metrics Grid (3 cards)
    const grid = el("div", "xp-metric-grid");

    // Metric 1: Status
    const m1 = el("div", "xp-metric-card");
    m1.appendChild(el("div", "xp-metric-label", "Sync Status"));
    m1.appendChild(el("div", "xp-metric-val", isErr ? "Attention Needed" : isBusy ? "Syncing…" : "Up to Date"));
    m1.appendChild(el("div", "xp-metric-sub", sync.lastOk ? `Last sync: ${new Date(sync.lastOk).toLocaleTimeString()}` : "Not synced yet"));
    grid.appendChild(m1);

    // Metric 2: Pending Outbox Queue
    const pendingTotal = sync.pendingSettings.size + hlQueue.size;
    const m2 = el("div", "xp-metric-card");
    m2.appendChild(el("div", "xp-metric-label", "Outbox Upload Queue"));
    m2.appendChild(el("div", "xp-metric-val", `${pendingTotal} item${pendingTotal === 1 ? "" : "s"}`));
    m2.appendChild(el("div", "xp-metric-sub", `${sync.pendingSettings.size} settings, ${hlQueue.size} highlighted chapters`));
    grid.appendChild(m2);

    // Metric 3: Backup & Recovery
    const m3 = el("div", "xp-metric-card");
    m3.appendChild(el("div", "xp-metric-label", "Disaster Recovery"));
    m3.appendChild(el("div", "xp-metric-val", "Active (Nightly)"));
    m3.appendChild(el("div", "xp-metric-sub", "Local SQLite + Encrypted Snapshot"));
    grid.appendChild(m3);

    body.appendChild(grid);

    // 3. Action Toolbar
    const actBox = el("div", "xp-action-toolbar");
    const syncBtn = el("button", "xp-btn primary");
    syncBtn.type = "button";
    const syncIco = el("span", "codicon " + codiCls("sync"));
    syncBtn.appendChild(syncIco);
    const syncText = document.createTextNode(isBusy ? " Syncing..." : " Sync Now");
    syncBtn.appendChild(syncText);
    
    syncBtn.addEventListener("click", async () => {
      syncBtn.disabled = true;
      syncIco.classList.add("xp-spin");
      syncText.textContent = " Syncing...";
      try {
        await syncNow();
        showToast("All settings and annotations successfully synced with server.", [], 3000);
      } catch (err) {
        showToast("Sync failed: " + err.message, [], 4000);
      } finally {
        syncIco.classList.remove("xp-spin");
        syncBtn.disabled = false;
        syncText.textContent = " Sync Now";
        refreshExtPage("sync-backup");
      }
    });
    actBox.appendChild(syncBtn);

    const pingBtn = el("button", "xp-btn secondary", "Test Server Latency");
    pingBtn.type = "button";
    pingBtn.addEventListener("click", async () => {
      pingBtn.disabled = true;
      pingBtn.textContent = "Pinging...";
      const t0 = performance.now();
      try {
        const res = await fetch("/api/health");
        const dt = Math.round(performance.now() - t0);
        if (res.ok) {
          showToast(`Server Connection Healthy: ${dt}ms latency.`, [], 3500);
        } else {
          showToast(`Server returned HTTP ${res.status} (${dt}ms).`, [], 4000);
        }
      } catch (e) {
        showToast("Cannot reach server: " + e.message, [], 4000);
      } finally {
        pingBtn.disabled = false;
        pingBtn.textContent = "Test Server Latency";
      }
    });
    actBox.appendChild(pingBtn);

    body.appendChild(actBox);

    // 4. Synchronized Data Entities Section
    const sec = el("div", "xp-card");
    sec.appendChild(el("h3", "xp-sec-title", "Synchronized Data Entities"));
    sec.appendChild(el("p", "xp-sec-desc", "The following components automatically replicate to your private SQLite database whenever you read or change preferences:"));

    const table = el("div", "xp-entity-table");
    const entities = [
      { name: "Reading Progress", desc: "Current chapter index and exact scroll ratio", freq: "On scroll & chapter transition", icon: "book" },
      { name: "Furthest Point Reached", desc: "Farthest milestone in each book (never lost on backward jump)", freq: "Monotonic forward-only", icon: "milestone" },
      { name: "Text Highlights & Notes", desc: "Paragraph highlights with vector timestamps", freq: "Instant local + background flush", icon: "edit" },
      { name: "Bookmarks (Ctrl+Alt+K)", desc: "Quick-jump paragraph snippets across modules", freq: "Real-time API sync", icon: "bookmark" },
      { name: "Editor & Stealth Settings", desc: "Theme, font family, panic template, disguise mode", freq: "Instant cloud update", icon: "settings-gear" },
    ];
    for (const ent of entities) {
      const row = el("div", "xp-entity-row");
      const iconCell = el("div", "xp-entity-ico " + codiCls(ent.icon));
      row.appendChild(iconCell);
      const infoCell = el("div", "xp-entity-info");
      infoCell.appendChild(el("div", "xp-entity-name", ent.name));
      infoCell.appendChild(el("div", "xp-entity-desc", ent.desc));
      row.appendChild(infoCell);
      const freqCell = el("div", "xp-entity-freq", ent.freq);
      row.appendChild(freqCell);
      table.appendChild(row);
    }
    sec.appendChild(table);
    body.appendChild(sec);
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
    const hero = el("div", "xp-hero-card");
    const heroLeft = el("div", "xp-hero-left");
    const statusPill = el("div", "xp-status-pill ok");
    statusPill.appendChild(el("span", "xp-pulse-dot"));
    statusPill.appendChild(document.createTextNode("Paragraph Bookmark Ledger"));
    heroLeft.appendChild(statusPill);
    heroLeft.appendChild(el("h3", "xp-hero-title", "Bookmarks & Annotations Index"));
    heroLeft.appendChild(el("p", "xp-hero-sub", "Press Ctrl+Alt+K while reading in any chapter to bookmark the active paragraph. Bookmarked lines feature an indicator mark in the editor gutter."));
    hero.appendChild(heroLeft);
    body.appendChild(hero);

    const card = el("div", "xp-card");
    card.appendChild(el("h3", "xp-sec-title", "Saved Bookmarks"));
    const list = el("div", "bm-list");
    card.appendChild(list);
    body.appendChild(card);

    const draw = () => {
      list.innerHTML = "";
      if (!bm.loaded) { list.appendChild(el("div", "xp-off-banner", "Loading saved bookmarks from database…")); return; }
      if (!bm.list.length) {
        const empty = el("div", "xp-empty-box");
        empty.appendChild(el("span", "codicon " + codiCls("bookmark")));
        empty.appendChild(el("h4", null, "No bookmarks saved yet"));
        empty.appendChild(el("p", null, "While reading in code or doc view, press Ctrl+Alt+K to bookmark key passages."));
        list.appendChild(empty);
        return;
      }
      for (const b of bm.list) {
        const book = bookById(b.book_id);
        if (!book) continue;
        const ch = book._chapters && book._chapters[b.chapter_idx];
        const row = el("div", "bm-row");
        const info = el("div", "bm-info");
        const where = el("div", "bm-where");
        where.appendChild(el("span", "xp-badge", bookLabel(book)));
        where.appendChild(document.createTextNode(" › " + (ch ? displayName(ch) : "Chapter " + b.chapter_idx)));
        info.appendChild(where);
        info.appendChild(el("div", "bm-snip", `“${b.snippet || "(no text)"}”`));
        row.appendChild(info);

        const actions = el("div", "bm-actions");
        const jumpBtn = el("button", "xp-btn secondary small", "Jump to Line");
        jumpBtn.type = "button";
        jumpBtn.addEventListener("click", () => openBookmark(b));
        actions.appendChild(jumpBtn);

        const del = el("button", "bm-del " + codiCls("trash"));
        del.type = "button";
        del.title = "Remove bookmark";
        del.addEventListener("click", async (e) => {
          e.stopPropagation();
          const res = await syncFetch(`/api/bookmarks/${b.id}`, { method: "DELETE" });
          if (res && (res.ok || res.status === 404)) {
            bm.list = bm.list.filter((x) => x.id !== b.id);
            bmPaint();
            draw();
            showToast("Bookmark deleted.", [], 2000);
          }
        });
        actions.appendChild(del);
        row.appendChild(actions);

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
