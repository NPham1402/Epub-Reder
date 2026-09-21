"use strict";

/* ============================ Extensions =================================== */
// Every feature beyond reading is an internal "extension": it shows up in the
// Extensions view, opens as an "Extension: <name>" tab (like VS Code's
// extension page), and can be disabled. Explorer, tabs, editor and status bar
// stay exactly as they were unless an enabled extension adds something there.
//
// Loaded after app.js, so it can use app.js's globals (state, $, el, api, ...).

const EXTENSIONS = [];
const EXT_BY_ID = {};
function registerExtension(def) { EXTENSIONS.push(def); EXT_BY_ID[def.id] = def; }

function extEnabled(id) {
  const v = state.settings.extensions[id];
  return typeof v === "boolean" ? v : !!(EXT_BY_ID[id] && EXT_BY_ID[id].defaultEnabled);
}
function setExtEnabled(id, on) {
  const d = EXT_BY_ID[id];
  if (!d) return;
  state.settings.extensions[id] = on;
  saveSettings();
  if (on) { if (d.onEnable) d.onEnable(); } else if (d.onDisable) d.onDisable();
  renderExtList();
  refreshExtPage(id);
}

/* ---- Toasts (VS Code notification style, bottom right) --------------------- */
function showToast(message, actions = [], ttl = 20000) {
  const box = $("#toasts");
  box.hidden = typeof panicVisible !== "undefined" && panicVisible;
  const t = el("div", "toast");
  t.appendChild(el("span", "toast-ico " + codiCls("info")));
  const body = el("div", "toast-body");
  body.appendChild(el("div", "toast-msg", message));
  if (actions.length) {
    const row = el("div", "toast-actions");
    for (const a of actions) {
      const b = el("button", "toast-btn", a.label);
      b.type = "button";
      b.addEventListener("click", () => { t.remove(); if (a.run) a.run(); });
      row.appendChild(b);
    }
    body.appendChild(row);
  }
  t.appendChild(body);
  const x = el("span", "toast-x " + codiCls("close"));
  x.addEventListener("click", () => t.remove());
  t.appendChild(x);
  box.appendChild(t);
  if (ttl) setTimeout(() => t.remove(), ttl);
}
function clearToasts() { $("#toasts").innerHTML = ""; }

/* ---- Events from app.js ---------------------------------------------------- */
function onExtEvent(name) {
  if (name === "panic") $("#toasts").hidden = panicVisible;
  if ((name === "chapter" || name === "scroll") && extEnabled("focus-timer")) updateTimerStatus();
}

/* ---- Side bar views ---------------------------------------------------------- */
function setSideView(v) {
  for (const id of ["explorer", "search", "scm", "run", "extensions"]) $("#view-" + id).hidden = id !== v;
  document.querySelectorAll(".activitybar .ab-icon[data-view]").forEach((i) => i.classList.toggle("active", i.dataset.view === v));
  if (v === "extensions") renderExtList();
}
document.querySelectorAll(".activitybar .ab-icon[data-view]").forEach((icon) => {
  icon.addEventListener("click", () => {
    const sidebar = $("#sidebar");
    // Like VS Code: clicking the icon of the open view collapses the side bar.
    if (icon.classList.contains("active") && !sidebar.classList.contains("hidden")) { sidebar.classList.add("hidden"); return; }
    sidebar.classList.remove("hidden");
    setSideView(icon.dataset.view);
  });
});
$("#sv-search").addEventListener("keydown", (e) => {
  if (e.key === "Enter") $("#sv-search-msg").textContent = "No results found. Review your settings for configured exclusions.";
});
$("#ext-filter").addEventListener("input", renderExtList);

/* ---- Extensions view -------------------------------------------------------- */
function renderExtList() {
  const q = $("#ext-filter").value.trim().toLowerCase();
  const list = $("#ext-list");
  list.innerHTML = "";
  const items = EXTENSIONS.filter((d) => !q || (d.name + " " + d.description).toLowerCase().includes(q));
  const head = el("div", "ext-group");
  head.appendChild(el("span", codiCls("chevron-down")));
  head.appendChild(el("span", "ext-group-name", "Installed"));
  head.appendChild(el("span", "ext-count", String(items.length)));
  list.appendChild(head);
  for (const d of items) list.appendChild(extItem(d));
  if (!items.length) list.appendChild(el("div", "sv-msg", "No extensions found."));
}
function extItem(d) {
  const on = extEnabled(d.id);
  const item = el("div", "ext-item" + (on ? "" : " off") + (state.activeKey === extKey(d.id) ? " active" : ""));
  item.appendChild(el("span", "ext-ico " + codiCls(d.icon)));
  const main = el("div", "ext-main");
  main.appendChild(el("div", "ext-name", d.name));
  main.appendChild(el("div", "ext-desc", d.description));
  const foot = el("div", "ext-foot");
  foot.appendChild(el("span", "ext-pub", "devdocs"));
  const gear = el("button", "ext-gear " + codiCls("settings-gear"));
  gear.type = "button";
  gear.title = "Manage";
  gear.addEventListener("click", (e) => { e.stopPropagation(); extMenu(d, gear); });
  foot.appendChild(gear);
  main.appendChild(foot);
  item.appendChild(main);
  item.addEventListener("click", () => openExtension(d.id));
  return item;
}
function extMenu(d, anchor) {
  document.querySelectorAll(".ext-menu").forEach((m) => m.remove());
  const on = extEnabled(d.id);
  const menu = el("div", "ext-menu");
  const add = (label, run) => {
    const b = el("button", "ext-menu-item", label);
    b.type = "button";
    b.addEventListener("click", () => { menu.remove(); run(); });
    menu.appendChild(b);
  };
  add(on ? "Disable" : "Enable", () => setExtEnabled(d.id, !on));
  add("Open", () => openExtension(d.id));
  const r = anchor.getBoundingClientRect();
  menu.style.left = Math.max(8, Math.min(r.left, window.innerWidth - 150)) + "px";
  menu.style.top = r.bottom + 2 + "px";
  document.body.appendChild(menu);
  setTimeout(() => document.addEventListener("click", () => menu.remove(), { once: true }), 0);
}

/* ---- Extension tab ------------------------------------------------------------ */
function openExtension(id) {
  if (!EXT_BY_ID[id]) return;
  if (!state.tabs.some((t) => t.ext === id)) state.tabs.push({ ext: id });
  activate(extKey(id));
}
async function activateExt(id) {
  const d = EXT_BY_ID[id];
  if (!d) return;
  captureScroll();
  state.activeKey = extKey(id);
  state.current = null;
  $("#monaco-host").hidden = true;
  $("#welcome").hidden = true;
  const page = $("#ext-page");
  page.hidden = false;
  renderExtPage(d, page);
  renderTabs();
  renderTree();
  const bc = $("#breadcrumbs");
  bc.innerHTML = "";
  const crumb = el("span", "crumb");
  crumb.appendChild(el("span", codiCls("extensions")));
  crumb.appendChild(el("span", null, "Extension: " + d.name));
  bc.appendChild(crumb);
  $("#st-pos").textContent = "";
  document.title = `Extension: ${d.name} — devdocs`;
  if (!$("#view-extensions").hidden) renderExtList();
  saveSession();
}
function refreshExtPage(id) {
  if (state.activeKey === extKey(id)) renderExtPage(EXT_BY_ID[id], $("#ext-page"));
}
function renderExtPage(d, page) {
  page.innerHTML = "";
  const on = extEnabled(d.id);
  const head = el("div", "xp-head");
  head.appendChild(el("span", "xp-ico " + codiCls(d.icon)));
  const info = el("div", "xp-info");
  info.appendChild(el("div", "xp-title", d.name));
  info.appendChild(el("div", "xp-sub", `devdocs  |  v${d.version}`));
  info.appendChild(el("div", "xp-desc", d.description));
  const btns = el("div", "xp-btns");
  const toggle = el("button", "xp-btn" + (on ? " secondary" : ""), on ? "Disable" : "Enable");
  toggle.type = "button";
  toggle.addEventListener("click", () => setExtEnabled(d.id, !on));
  btns.appendChild(toggle);
  info.appendChild(btns);
  head.appendChild(info);
  page.appendChild(head);
  const body = el("div", "xp-body");
  page.appendChild(body);
  if (on) d.render(body);
  else body.appendChild(el("p", "xp-off", "This extension is disabled. Enable it to use it."));
}

/* ============================ Library ======================================= */
function bookPercent(b) {
  const p = b._progress || (b.progress_idx != null ? { chapter_idx: b.progress_idx, scroll_ratio: b.progress_ratio || 0 } : null);
  if (!p || !b.chapter_count) return 0;
  return Math.min(1, ((p.chapter_idx || 0) + (p.scroll_ratio || 0)) / b.chapter_count);
}
function ago(ms) {
  if (!ms) return "never";
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 90) return "just now";
  if (s < 5400) return Math.round(s / 60) + " min ago";
  if (s < 129600) return Math.round(s / 3600) + " h ago";
  return Math.round(s / 86400) + " d ago";
}
async function openBookFromLibrary(b) {
  if (!(await loadBookIndex(b))) return;
  state.expanded.add(b.id);
  renderTree();
  openTab(b.id, b._progress ? b._progress.chapter_idx || 0 : 0);
}
registerExtension({
  id: "library",
  name: "Library",
  version: "1.0.0",
  icon: "library",
  description: "Sort your modules and see how far along each one is.",
  defaultEnabled: true,
  render(body) {
    const bar = el("div", "lib-bar");
    bar.appendChild(el("span", null, "Sort by"));
    const sel = el("select", "lib-sort");
    for (const [v, label] of [["recent", "Recently opened"], ["added", "Recently added"], ["name", "Name"], ["progress", "Progress"]]) {
      const o = el("option", null, label);
      o.value = v;
      sel.appendChild(o);
    }
    sel.value = state.settings.librarySort || "recent";
    bar.appendChild(sel);
    body.appendChild(bar);
    const list = el("div", "lib-list");
    body.appendChild(list);
    const draw = () => {
      const by = sel.value;
      const books = [...state.books].sort((a, b) => {
        if (by === "name") return bookLabel(a).localeCompare(bookLabel(b));
        if (by === "added") return (b.created_at || 0) - (a.created_at || 0);
        if (by === "progress") return bookPercent(b) - bookPercent(a);
        return (b.last_read_at || 0) - (a.last_read_at || 0) || (b.created_at || 0) - (a.created_at || 0);
      });
      list.innerHTML = "";
      if (!books.length) list.appendChild(el("p", "xp-off", "No modules yet. Import an .epub to get started."));
      for (const b of books) {
        const pct = Math.round(bookPercent(b) * 100);
        const row = el("div", "lib-row");
        row.appendChild(el("span", "lib-ico " + codiCls("folder")));
        const info = el("div", "lib-info");
        info.appendChild(el("div", "lib-name", bookLabel(b)));
        info.appendChild(el("div", "lib-meta", `${b.chapter_count} files  ·  last opened ${ago(b.last_read_at)}`));
        const track = el("div", "lib-track");
        const fill = el("div", "lib-fill");
        fill.style.width = pct + "%";
        track.appendChild(fill);
        info.appendChild(track);
        row.appendChild(info);
        row.appendChild(el("span", "lib-pct", pct + "%"));
        row.addEventListener("click", () => openBookFromLibrary(b));
        list.appendChild(row);
      }
    };
    sel.addEventListener("change", () => { state.settings.librarySort = sel.value; saveSettings(); draw(); });
    draw();
  },
});

/* ============================ Focus Timer =================================== */
// Status-bar "time left in this chapter" and a break reminder. Both are only
// added to the window while the extension is enabled (it is off by default).
const timer = { lastActive: 0, sessionMs: 0, lastTick: 0, id: 0 };
["keydown", "mousemove", "wheel", "pointerdown", "touchstart"].forEach((ev) =>
  document.addEventListener(ev, () => { timer.lastActive = Date.now(); }, { passive: true, capture: true }));

function updateTimerStatus() {
  const s = $("#st-timer");
  if (!s) return;
  const model = reader.ed && reader.ed.getModel();
  if (!state.current || !model) { s.hidden = true; return; }
  const speed = Math.max(200, state.settings.readSpeed || 900);
  const mins = (model.getValueLength() * (1 - view.ratio)) / speed;
  s.hidden = false;
  s.textContent = "";
  s.appendChild(el("span", "ico " + codiCls("clock")));
  s.appendChild(document.createTextNode(mins < 1 ? " <1 min left" : ` ${Math.round(mins)} min left`));
}
function timerTick() {
  const now = Date.now();
  const dt = now - timer.lastTick;
  timer.lastTick = now;
  const reading = !document.hidden && !panicVisible && state.current && now - timer.lastActive < 60000;
  if (!reading) {
    if (now - timer.lastActive > 5 * 60000) timer.sessionMs = 0; // a real break
    return;
  }
  timer.sessionMs += Math.min(dt, 2000);
  const every = (state.settings.remindMin || 0) * 60000;
  if (every > 0 && timer.sessionMs >= every) {
    timer.sessionMs = 0;
    showToast(`You have been working for ${Math.round(every / 60000)} minutes. Take a short break to rest your eyes.`, [
      { label: "OK" },
      { label: "Don't Show Again", run: () => { state.settings.remindMin = 0; saveSettings(); } },
    ]);
  }
}
function timerStart() {
  if (timer.id) return;
  if (!$("#st-timer")) {
    const s = el("span", "st-item");
    s.id = "st-timer";
    s.hidden = true;
    s.title = "Estimated time left in this file";
    $(".st-right").insertBefore(s, $("#st-pos"));
  }
  timer.lastTick = Date.now();
  timer.id = setInterval(timerTick, 1000);
  updateTimerStatus();
}
function timerStop() {
  clearInterval(timer.id);
  timer.id = 0;
  timer.sessionMs = 0;
  const s = $("#st-timer");
  if (s) s.remove();
  clearToasts();
}
registerExtension({
  id: "focus-timer",
  name: "Focus Timer",
  version: "1.0.0",
  icon: "clock",
  description: "Shows the time left in the open file and reminds you to take a break.",
  defaultEnabled: false,
  onEnable: timerStart,
  onDisable: timerStop,
  render(body) {
    const row = (label, control, hint) => {
      const r = el("label", "ft-row");
      const t = el("div", "ft-label");
      t.appendChild(el("div", null, label));
      if (hint) t.appendChild(el("small", null, hint));
      r.appendChild(t);
      r.appendChild(control);
      body.appendChild(r);
    };
    const speed = el("input", "ft-input");
    speed.type = "number";
    speed.min = "200";
    speed.max = "3000";
    speed.step = "50";
    speed.value = String(state.settings.readSpeed || 900);
    speed.addEventListener("change", () => {
      state.settings.readSpeed = Math.min(3000, Math.max(200, Number(speed.value) || 900));
      speed.value = String(state.settings.readSpeed);
      saveSettings();
      updateTimerStatus();
    });
    row("Reading speed", speed, "Characters per minute, used for the time left in the file.");
    const remind = el("select", "lib-sort");
    for (const [v, label] of [[0, "Off"], [30, "Every 30 minutes"], [60, "Every 60 minutes"], [90, "Every 90 minutes"]]) {
      const o = el("option", null, label);
      o.value = String(v);
      remind.appendChild(o);
    }
    remind.value = String(state.settings.remindMin);
    remind.addEventListener("change", () => { state.settings.remindMin = Number(remind.value); saveSettings(); });
    row("Break reminder", remind, "Counts only time you are actively working with the window in front.");
    const test = el("button", "xp-btn secondary", "Show a sample reminder");
    test.type = "button";
    test.addEventListener("click", () => showToast("You have been working for 60 minutes. Take a short break to rest your eyes.", [{ label: "OK" }]));
    body.appendChild(test);
  },
});

/* ============================ Color Themes ================================== */
const THEMES = [
  { id: "dark", name: "Dark+ (default dark)", kind: "dark", swatch: ["#1e1e1e", "#252526", "#007acc", "#d4d4d4"] },
  { id: "light", name: "Light+ (default light)", kind: "light", swatch: ["#ffffff", "#f3f3f3", "#007acc", "#333333"] },
  { id: "monokai", name: "Monokai", kind: "dark", swatch: ["#272822", "#1e1f1c", "#75715e", "#f8f8f2"] },
  { id: "amoled", name: "Black (AMOLED)", kind: "dark", swatch: ["#000000", "#000000", "#005a9e", "#bbbbbb"] },
];
function effectiveTheme() {
  const id = extEnabled("themes") ? state.settings.theme : "dark";
  return THEMES.find((t) => t.id === id) || THEMES[0];
}
function applyTheme() {
  const t = effectiveTheme();
  const root = document.documentElement;
  if (t.id === "dark") delete root.dataset.theme;
  else root.dataset.theme = t.id;
  root.style.colorScheme = t.kind;
  // The editor keeps its own theme object: rebuild it from the new colors.
  if (window.monaco && typeof defineReaderTheme === "function") {
    defineReaderTheme(window.monaco);
    window.monaco.editor.setTheme("devdocs");
  }
}
registerExtension({
  id: "themes",
  name: "Color Themes",
  version: "1.0.0",
  icon: "symbol-color",
  description: "Choose the color theme: Dark+, Light+, Monokai or AMOLED black.",
  defaultEnabled: true,
  onEnable: applyTheme,
  onDisable: applyTheme,
  render(body) {
    body.appendChild(el("p", "xp-note", "Applies to the whole window, including the cover screen."));
    const list = el("div", "theme-list");
    for (const t of THEMES) {
      const row = el("button", "theme-row" + (effectiveTheme().id === t.id ? " on" : ""));
      row.type = "button";
      const sw = el("span", "theme-swatch");
      for (const c of t.swatch) { const s = el("span"); s.style.background = c; sw.appendChild(s); }
      row.appendChild(sw);
      row.appendChild(el("span", "theme-name", t.name));
      row.appendChild(el("span", "theme-check " + codiCls("check")));
      row.addEventListener("click", () => {
        state.settings.theme = t.id;
        saveSettings();
        applyTheme();
        list.querySelectorAll(".theme-row").forEach((r) => r.classList.toggle("on", r === row));
      });
      list.appendChild(row);
    }
    body.appendChild(list);
  },
});

/* ============================ Start ========================================= */
applyTheme();
if (extEnabled("focus-timer")) timerStart();
