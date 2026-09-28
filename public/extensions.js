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
  if (name === "chapter" && typeof bmOnChapter === "function") bmOnChapter();
}

/* ---- Side bar views ---------------------------------------------------------- */
function setSideView(v) {
  for (const id of ["explorer", "search", "scm", "run", "extensions"]) $("#view-" + id).hidden = id !== v;
  document.querySelectorAll(".activitybar .ab-icon[data-view]").forEach((i) => i.classList.toggle("active", i.dataset.view === v));
  if (v === "extensions") renderExtList();
  // The reveal in activate() is a no-op while this view was hidden (nothing to
  // measure); catch up now that it has real layout again.
  if (v === "explorer" && typeof revealActiveInTree === "function") revealActiveInTree();
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

const EXT_METADATA = {
  "library": {
    gradient: "linear-gradient(135deg, #f59e0b, #d97706)",
    category: "Library & Module Management",
    rating: "4.9",
    ratingCount: "1,420",
    installs: "42.8k",
    features: {
      commands: [
        { id: "devdocs.library.open", title: "Library: Open Module" },
        { id: "devdocs.library.exportEpub", title: "Library: Export to EPUB" },
        { id: "devdocs.library.exportTxt", title: "Library: Export to Plain Text" },
        { id: "devdocs.library.cacheOffline", title: "Library: Download for Offline" },
      ],
      keybindings: [
        { key: "Ctrl+P", command: "Quick Open File" },
      ],
      settings: [
        { key: "devdocs.librarySort", type: "string", default: "recent", description: "Default order for library module list" },
      ]
    },
    changelog: [
      { version: "1.0.0", date: "2026-09-20", changes: ["Added full EPUB and TXT multi-chapter import", "Offline cache storage with Service Worker", "Dynamic reading progress bars"] }
    ]
  },
  "focus-timer": {
    gradient: "linear-gradient(135deg, #10b981, #059669)",
    category: "Productivity & Health",
    rating: "4.8",
    ratingCount: "860",
    installs: "18.2k",
    features: {
      commands: [
        { id: "devdocs.timer.start", title: "Focus: Start Reading Pace Tracker" },
        { id: "devdocs.timer.testNotification", title: "Focus: Send Test Break Reminder" },
      ],
      keybindings: [],
      settings: [
        { key: "devdocs.readSpeed", type: "number", default: 900, description: "Reading speed in characters per minute" },
        { key: "devdocs.remindMin", type: "number", default: 0, description: "Eye rest break reminder interval in minutes" },
      ]
    },
    changelog: [
      { version: "1.0.0", date: "2026-09-20", changes: ["Reading pace calculator in status bar", "Smart eye rest break notification toasts"] }
    ]
  },
  "themes": {
    gradient: "linear-gradient(135deg, #8b5cf6, #6366f1)",
    category: "Themes & Customization",
    rating: "5.0",
    ratingCount: "2,980",
    installs: "56.1k",
    features: {
      commands: [
        { id: "devdocs.theme.change", title: "Preferences: Color Theme" },
      ],
      keybindings: [
        { key: "Ctrl+K Ctrl+T", command: "devdocs.theme.change" },
      ],
      settings: [
        { key: "devdocs.theme", type: "string", default: "dark", description: "Color theme for the editor and workbench" },
      ]
    },
    changelog: [
      { version: "1.1.0", date: "2026-09-28", changes: ["Added Tokyo Night, Catppuccin Mocha, Dracula, and GitHub Dark themes", "Interactive theme preview cards"] },
      { version: "1.0.0", date: "2026-09-20", changes: ["Initial Dark+, Light+, Monokai, and AMOLED themes"] }
    ]
  },
  "sync-backup": {
    gradient: "linear-gradient(135deg, #0ea5e9, #0284c7)",
    category: "Synchronization & Storage",
    rating: "4.9",
    ratingCount: "1,240",
    installs: "35.4k",
    features: {
      commands: [
        { id: "devdocs.sync.now", title: "Sync: Synchronize Now" },
        { id: "devdocs.sync.force", title: "Sync: Force Push State" },
        { id: "devdocs.sync.status", title: "Sync: Check Server Connection" },
      ],
      keybindings: [],
      settings: [
        { key: "devdocs.sync.auto", type: "boolean", default: true, description: "Synchronize automatically on window focus and network reconnect" },
      ]
    },
    changelog: [
      { version: "1.0.0", date: "2026-09-20", changes: ["Real-time state replication across devices", "Nightly automated SQLite snapshots", "Vector clock conflict resolution"] }
    ]
  },
  "bookmarks": {
    gradient: "linear-gradient(135deg, #f43f5e, #e11d48)",
    category: "Bookmarks & Annotations",
    rating: "4.9",
    ratingCount: "920",
    installs: "21.6k",
    features: {
      commands: [
        { id: "devdocs.bookmark.add", title: "Bookmarks: Toggle Bookmark at Line" },
      ],
      keybindings: [
        { key: "Ctrl+Alt+K", command: "devdocs.bookmark.add" },
      ],
      settings: []
    },
    changelog: [
      { version: "1.0.0", date: "2026-09-20", changes: ["One-click paragraph bookmarking", "Sync bookmarks with database"] }
    ]
  },
  "insights": {
    gradient: "linear-gradient(135deg, #6366f1, #06b6d4)",
    category: "Analytics & Statistics",
    rating: "4.8",
    ratingCount: "740",
    installs: "14.9k",
    features: {
      commands: [
        { id: "devdocs.insights.open", title: "Insights: Show Activity Insights" },
      ],
      keybindings: [],
      settings: []
    },
    changelog: [
      { version: "1.0.0", date: "2026-09-20", changes: ["GitHub-style contribution graph heatmap", "Reading duration breakdowns by chapter"] }
    ]
  },
  "global-search": {
    gradient: "linear-gradient(135deg, #3b82f6, #1d4ed8)",
    category: "Search & Navigation",
    rating: "4.9",
    ratingCount: "1,650",
    installs: "38.7k",
    features: {
      commands: [
        { id: "devdocs.search.find", title: "Search: Find in Modules" },
      ],
      keybindings: [
        { key: "Ctrl+Shift+F", command: "devdocs.search.find" },
      ],
      settings: []
    },
    changelog: [
      { version: "1.0.0", date: "2026-09-20", changes: ["Full-text SQLite search with FTS5", "Accent-insensitive Vietnamese folding"] }
    ]
  }
};

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
  const meta = EXT_METADATA[d.id] || { gradient: "var(--accent)", category: "Extension", rating: "4.9", installs: "10k" };
  const item = el("div", "ext-item" + (on ? "" : " off") + (state.activeKey === extKey(d.id) ? " active" : ""));
  
  const icon = el("div", "ext-ico");
  if (on && meta.gradient) icon.style.background = meta.gradient;
  icon.appendChild(el("span", codiCls(d.icon)));
  item.appendChild(icon);

  const main = el("div", "ext-main");
  const top = el("div", "ext-name-row");
  top.appendChild(el("span", "ext-name", d.name));
  main.appendChild(top);
  main.appendChild(el("div", "ext-desc", d.description));
  
  const foot = el("div", "ext-foot");
  const pub = el("span", "ext-pub");
  pub.appendChild(document.createTextNode("devdocs "));
  pub.appendChild(el("span", "ext-verified " + codiCls("verified")));
  foot.appendChild(pub);
  
  const tags = el("span", "ext-badges");
  const starPill = el("span", "ext-pill");
  starPill.appendChild(el("span", "codicon " + codiCls("star")));
  starPill.appendChild(document.createTextNode(" " + (meta.rating || "4.9")));
  tags.appendChild(starPill);
  const gear = el("button", "ext-gear " + codiCls("settings-gear"));
  gear.type = "button";
  gear.title = "Manage";
  gear.addEventListener("click", (e) => { e.stopPropagation(); extMenu(d, gear); });
  tags.appendChild(gear);
  foot.appendChild(tags);
  
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
  if ($("#doc-host")) $("#doc-host").hidden = true;
  const page = $("#ext-page");
  page.hidden = false;
  renderExtPage(d, page);
  renderTabs();
  renderTree();
  renderBreadcrumbs();
  $("#st-pos").textContent = "";
  document.title = `Extension: ${d.name} — devdocs`;
  if (!$("#view-extensions").hidden) renderExtList();
  saveSession();
}

// Breadcrumb for an extension tab (called from renderBreadcrumbs in app.js).
function extCrumb(bc, id) {
  const d = EXT_BY_ID[id];
  if (!d) return;
  const crumb = el("span", "crumb");
  crumb.appendChild(el("span", codiCls("extensions")));
  crumb.appendChild(el("span", null, "Extension: " + d.name));
  bc.appendChild(crumb);
}

function refreshExtPage(id) {
  if (state.activeKey === extKey(id)) renderExtPage(EXT_BY_ID[id], $("#ext-page"));
}

function renderExtPage(d, page) {
  page.innerHTML = "";
  const on = extEnabled(d.id);
  const meta = EXT_METADATA[d.id] || {
    gradient: "linear-gradient(135deg, #0284c7, #06b6d4)",
    category: "Utility",
    rating: "4.9",
    ratingCount: "1,000",
    installs: "25k",
    features: { commands: [], keybindings: [], settings: [] },
    changelog: [{ version: d.version, date: "Today", changes: ["Stable release"] }]
  };

  // Header Card
  const head = el("div", "xp-header-card");
  const ico = el("div", "xp-icon-box");
  if (meta.gradient) ico.style.background = meta.gradient;
  ico.appendChild(el("span", "codicon " + codiCls(d.icon)));
  head.appendChild(ico);

  const info = el("div", "xp-header-details");
  const titleRow = el("div", "xp-title-row");
  titleRow.appendChild(el("h1", "xp-title", d.name));
  const vBadge = el("span", "xp-verified-badge");
  vBadge.appendChild(el("span", "codicon " + codiCls("verified")));
  vBadge.appendChild(document.createTextNode(" Verified"));
  titleRow.appendChild(vBadge);
  info.appendChild(titleRow);

  const metaRow = el("div", "xp-meta-row");
  metaRow.appendChild(el("span", "xp-publisher", "devdocs"));
  metaRow.appendChild(el("span", "xp-dot", "•"));
  metaRow.appendChild(el("span", "xp-version", `v${d.version}`));
  metaRow.appendChild(el("span", "xp-dot", "•"));
  const starRow = el("span", "xp-rating");
  starRow.appendChild(el("span", "codicon " + codiCls("star")));
  starRow.appendChild(document.createTextNode(` ${meta.rating} (${meta.ratingCount})`));
  metaRow.appendChild(starRow);
  metaRow.appendChild(el("span", "xp-dot", "•"));
  const instRow = el("span", "xp-installs");
  instRow.appendChild(el("span", "codicon " + codiCls("cloud-download")));
  instRow.appendChild(document.createTextNode(` ${meta.installs}`));
  metaRow.appendChild(instRow);
  info.appendChild(metaRow);

  info.appendChild(el("div", "xp-desc", d.description));

  const actionRow = el("div", "xp-action-bar");
  const toggle = el("button", "xp-btn-toggle" + (on ? " secondary" : " primary"), on ? "Disable" : "Enable");
  toggle.type = "button";
  toggle.addEventListener("click", () => setExtEnabled(d.id, !on));
  actionRow.appendChild(toggle);

  const uninstall = el("button", "xp-btn-secondary", "Uninstall");
  uninstall.type = "button";
  uninstall.disabled = true;
  uninstall.title = "Built-in extension cannot be uninstalled";
  actionRow.appendChild(uninstall);

  const gear = el("button", "xp-btn-icon " + codiCls("settings-gear"));
  gear.type = "button";
  gear.title = "Manage Extension";
  gear.addEventListener("click", (e) => extMenu(d, gear));
  actionRow.appendChild(gear);

  info.appendChild(actionRow);
  head.appendChild(info);
  page.appendChild(head);

  // Tab Navigation Bar (Details, Feature Contributions, Changelog)
  const navTabs = el("div", "xp-nav-tabs");
  let activeTab = "details";
  const tabs = [
    { id: "details", label: "Details" },
    { id: "features", label: "Feature Contributions" },
    { id: "changelog", label: "Changelog" }
  ];
  const tabBtns = {};
  for (const t of tabs) {
    const btn = el("button", "xp-tab-btn" + (t.id === activeTab ? " active" : ""), t.label);
    btn.type = "button";
    tabBtns[t.id] = btn;
    btn.addEventListener("click", () => switchTab(t.id));
    navTabs.appendChild(btn);
  }
  page.appendChild(navTabs);

  // Two-column Layout
  const layout = el("div", "xp-layout");

  // Left Column (Main content)
  const mainCol = el("div", "xp-main-col");

  // Panel 1: Details
  const detailsPanel = el("div", "xp-tab-panel");
  if (on) d.render(detailsPanel);
  else detailsPanel.appendChild(el("div", "xp-off-banner", "This extension is currently disabled. Click Enable above to activate its features."));
  mainCol.appendChild(detailsPanel);

  // Panel 2: Feature Contributions
  const featuresPanel = el("div", "xp-tab-panel");
  featuresPanel.hidden = true;
  renderFeaturesTab(d, meta, featuresPanel);
  mainCol.appendChild(featuresPanel);

  // Panel 3: Changelog
  const changelogPanel = el("div", "xp-tab-panel");
  changelogPanel.hidden = true;
  renderChangelogTab(d, meta, changelogPanel);
  mainCol.appendChild(changelogPanel);

  layout.appendChild(mainCol);

  // Right Column (Metadata Sidebar)
  const sideCol = el("div", "xp-side-col");
  renderSideMetadata(d, meta, sideCol);
  layout.appendChild(sideCol);

  page.appendChild(layout);

  function switchTab(target) {
    activeTab = target;
    for (const id of Object.keys(tabBtns)) {
      tabBtns[id].classList.toggle("active", id === target);
    }
    detailsPanel.hidden = target !== "details";
    featuresPanel.hidden = target !== "features";
    changelogPanel.hidden = target !== "changelog";
  }
}

function renderFeaturesTab(d, meta, container) {
  const f = meta.features || {};
  if (f.commands && f.commands.length) {
    container.appendChild(el("h3", "xp-sec-title", "Commands"));
    const tbl = el("table", "xp-tbl");
    tbl.innerHTML = "<thead><tr><th>Command</th><th>Title</th></tr></thead><tbody></tbody>";
    const tbody = tbl.querySelector("tbody");
    for (const c of f.commands) {
      const tr = el("tr");
      tr.appendChild(el("td", "xp-tbl-code", c.id));
      tr.appendChild(el("td", null, c.title));
      tbody.appendChild(tr);
    }
    container.appendChild(tbl);
  }
  if (f.keybindings && f.keybindings.length) {
    container.appendChild(el("h3", "xp-sec-title", "Keyboard Shortcuts"));
    const tbl = el("table", "xp-tbl");
    tbl.innerHTML = "<thead><tr><th>Key</th><th>Command</th></tr></thead><tbody></tbody>";
    const tbody = tbl.querySelector("tbody");
    for (const k of f.keybindings) {
      const tr = el("tr");
      tr.appendChild(el("td", "xp-tbl-kbd", k.key));
      tr.appendChild(el("td", "xp-tbl-code", k.command));
      tbody.appendChild(tr);
    }
    container.appendChild(tbl);
  }
  if (f.settings && f.settings.length) {
    container.appendChild(el("h3", "xp-sec-title", "Settings"));
    const tbl = el("table", "xp-tbl");
    tbl.innerHTML = "<thead><tr><th>Setting</th><th>Type</th><th>Description</th></tr></thead><tbody></tbody>";
    const tbody = tbl.querySelector("tbody");
    for (const s of f.settings) {
      const tr = el("tr");
      tr.appendChild(el("td", "xp-tbl-code", s.key));
      tr.appendChild(el("td", null, s.type || "string"));
      tr.appendChild(el("td", null, s.description));
      tbody.appendChild(tr);
    }
    container.appendChild(tbl);
  }
}

function renderChangelogTab(d, meta, container) {
  const list = meta.changelog || [{ version: d.version, date: "Today", changes: ["Stable release"] }];
  container.appendChild(el("h3", "xp-sec-title", "Release History"));
  for (const release of list) {
    const item = el("div", "xp-changelog-card");
    const h = el("div", "xp-cl-header");
    h.appendChild(el("span", "xp-cl-ver", `v${release.version}`));
    h.appendChild(el("span", "xp-cl-date", release.date));
    item.appendChild(h);
    const ul = el("ul", "xp-cl-list");
    for (const change of release.changes) {
      ul.appendChild(el("li", null, change));
    }
    item.appendChild(ul);
    container.appendChild(item);
  }
}

function renderSideMetadata(d, meta, container) {
  // Categories
  const catSec = el("div", "xp-side-sec");
  catSec.appendChild(el("h4", "xp-side-title", "Categories"));
  const tags = el("div", "xp-tags");
  tags.appendChild(el("span", "xp-tag", meta.category || "Utility"));
  tags.appendChild(el("span", "xp-tag", "Built-in"));
  catSec.appendChild(tags);
  container.appendChild(catSec);

  // Resources
  const resSec = el("div", "xp-side-sec");
  resSec.appendChild(el("h4", "xp-side-title", "Resources"));
  const ul = el("ul", "xp-side-links");
  const links = [
    { label: "Documentation", ico: "book" },
    { label: "Storage Engine: SQLite D1", ico: "database" },
    { label: "Session Security: AES Token", ico: "shield" },
    { label: "Repository: DevDocs", ico: "github" },
  ];
  for (const l of links) {
    const li = el("li");
    li.appendChild(el("span", "codicon " + codiCls(l.ico)));
    li.appendChild(document.createTextNode(" " + l.label));
    ul.appendChild(li);
  }
  resSec.appendChild(ul);
  container.appendChild(resSec);

  // More Info
  const infoSec = el("div", "xp-side-sec");
  infoSec.appendChild(el("h4", "xp-side-title", "More Info"));
  const dl = el("dl", "xp-side-dl");
  const items = [
    ["Published", "2026-09-15"],
    ["Last Released", "Today"],
    ["Identifier", `devdocs.${d.id}`],
    ["License", "MIT"],
  ];
  for (const [k, v] of items) {
    dl.appendChild(el("dt", null, k));
    dl.appendChild(el("dd", null, v));
  }
  infoSec.appendChild(dl);
  container.appendChild(infoSec);
}

/* ============================ Library ======================================= */
function bookPercent(b) {
  // The furthest point reached, which never goes backwards; the resume position can.
  const f = b._furthest || (b.furthest_idx != null ? { idx: b.furthest_idx, ratio: b.furthest_ratio || 0 } : null);
  const p = f ? { chapter_idx: f.idx, scroll_ratio: f.ratio }
    : b._progress || (b.progress_idx != null ? { chapter_idx: b.progress_idx, scroll_ratio: b.progress_ratio || 0 } : null);
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

/* ---- Offline copies --------------------------------------------------------- */
// Reading already caches whatever chapter you open (see sw.js); this instead
// fetches every chapter of a module up front, so it is fully available before
// you lose the connection on purpose (e.g. before a flight). Writes straight
// into the same cache the service worker reads from, so it works even in the
// brief window right after the very first visit, before the worker has taken
// over the page.
async function offlineCounts(books) {
  const map = new Map();
  if (!("caches" in window)) return map;
  const cache = await caches.open(OFFLINE_DATA_CACHE).catch(() => null);
  if (!cache) return map;
  const paths = (await cache.keys()).map((k) => new URL(k.url).pathname);
  for (const b of books) map.set(b.id, paths.filter((p) => p.startsWith(`/api/books/${b.id}/chapters/`)).length);
  return map;
}
async function downloadForOffline(book, onProgress) {
  if (!("caches" in window) || !(await loadBookIndex(book))) return false;
  const cache = await caches.open(OFFLINE_DATA_CACHE);
  const total = book._chapters.length;
  let done = 0, failed = false, next = 0;
  await Promise.all(Array.from({ length: Math.min(3, total) }, async () => {
    while (next < total && !failed) {
      const url = `/api/books/${book.id}/chapters/${next++}`;
      try {
        const res = await fetch(url, { credentials: "same-origin" });
        if (!res.ok) throw new Error("http " + res.status);
        await cache.put(url, res.clone());
      } catch { failed = true; }
      onProgress(++done, total);
    }
  }));
  const idxUrl = `/api/books/${book.id}/index`;
  const idxRes = await fetch(idxUrl, { credentials: "same-origin" }).catch(() => null);
  if (idxRes && idxRes.ok) await cache.put(idxUrl, idxRes.clone());
  return !failed;
}
async function removeOffline(book) {
  if (!("caches" in window)) return;
  const cache = await caches.open(OFFLINE_DATA_CACHE);
  const prefix = `/api/books/${book.id}/`;
  await Promise.all((await cache.keys()).filter((k) => new URL(k.url).pathname.startsWith(prefix)).map((k) => cache.delete(k)));
}
registerExtension({
  id: "library",
  name: "Library",
  version: "1.0.0",
  icon: "library",
  description: "Sort your modules, see how far along each one is, and export them.",
  defaultEnabled: true,
  render(body) {
    const hero = el("div", "xp-hero-card");
    const heroLeft = el("div", "xp-hero-left");
    const statusPill = el("div", "xp-status-pill ok");
    statusPill.appendChild(el("span", "xp-pulse-dot"));
    statusPill.appendChild(document.createTextNode("Module & Document Repository"));
    heroLeft.appendChild(statusPill);
    heroLeft.appendChild(el("h3", "xp-hero-title", "Local Library & Reading Progress"));
    heroLeft.appendChild(el("p", "xp-hero-sub", "Track your overall progress across modules, store offline copies in browser cache, and export books back to EPUB or TXT."));
    hero.appendChild(heroLeft);
    body.appendChild(hero);

    const card = el("div", "xp-card");
    const bar = el("div", "lib-bar");
    bar.appendChild(el("span", null, "Sort modules:"));
    const sel = el("select", "lib-sort");
    for (const [v, label] of [["recent", "Recently opened"], ["added", "Recently added"], ["name", "Name"], ["progress", "Progress"]]) {
      const o = el("option", null, label);
      o.value = v;
      sel.appendChild(o);
    }
    sel.value = state.settings.librarySort || "recent";
    bar.appendChild(sel);
    const countBadge = el("span", "xp-badge", `${state.books.length} module${state.books.length === 1 ? "" : "s"}`);
    bar.appendChild(countBadge);
    card.appendChild(bar);

    const list = el("div", "lib-list");
    card.appendChild(list);
    body.appendChild(card);
    const draw = async () => {
      const by = sel.value;
      const books = [...state.books].sort((a, b) => {
        if (by === "name") return bookLabel(a).localeCompare(bookLabel(b));
        if (by === "added") return (b.created_at || 0) - (a.created_at || 0);
        if (by === "progress") return bookPercent(b) - bookPercent(a);
        return (b.last_read_at || 0) - (a.last_read_at || 0) || (b.created_at || 0) - (a.created_at || 0);
      });
      const offline = await offlineCounts(books);
      list.innerHTML = "";
      if (!books.length) list.appendChild(el("p", "xp-off", "No modules yet. Import an .epub to get started."));
      for (const b of books) {
        const pct = Math.round(bookPercent(b) * 100);
        const row = el("div", "lib-row");
        row.dataset.bookId = b.id;
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
        const acts = el("span", "lib-acts");
        for (const [fmt, label] of [["txt", "TXT"], ["epub", "EPUB"]]) {
          // A plain link: the session cookie authorises the download, and the
          // server names the file after the module unless real titles are shown.
          const a = el("a", "lib-btn", label);
          a.href = `/api/books/${b.id}/export?format=${fmt}${state.revealTitles ? "&real=1" : ""}`;
          a.download = "";
          a.title = `Export as .${fmt}`;
          a.addEventListener("click", (e) => e.stopPropagation());
          acts.appendChild(a);
        }
        if ("caches" in window) {
          const have = offline.get(b.id) || 0;
          const full = b.chapter_count > 0 && have >= b.chapter_count;
          const off = el("button", "lib-btn lib-offline" + (full ? " on" : ""));
          off.type = "button";
          off.appendChild(el("span", "ico " + codiCls(full ? "cloud" : "cloud-download")));
          off.appendChild(document.createTextNode(full ? " Offline" : have > 0 ? ` ${Math.round((have / b.chapter_count) * 100)}%` : " Offline"));
          off.title = full ? "Available offline — click to remove the offline copy" : "Download every file for offline reading";
          off.addEventListener("click", async (e) => {
            e.stopPropagation();
            if (full) { await removeOffline(b); draw(); return; }
            off.disabled = true;
            const label = off.lastChild;
            await downloadForOffline(b, (done, total) => { label.textContent = ` ${Math.round((done / total) * 100)}%`; });
            draw();
          });
          acts.appendChild(off);
        }
        row.appendChild(acts);
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
    const hero = el("div", "xp-hero-card");
    const heroLeft = el("div", "xp-hero-left");
    const statusPill = el("div", "xp-status-pill ok");
    statusPill.appendChild(el("span", "xp-pulse-dot"));
    statusPill.appendChild(document.createTextNode("Reading Pace & Eye Health Monitor"));
    heroLeft.appendChild(statusPill);
    heroLeft.appendChild(el("h3", "xp-hero-title", "Adaptive Reading Pace Tracker"));
    heroLeft.appendChild(el("p", "xp-hero-sub", "Calculates remaining reading duration in the active file and reminds you to take ergonomic eye rest breaks while disguised."));
    hero.appendChild(heroLeft);
    body.appendChild(hero);

    // Pace Card
    const paceCard = el("div", "xp-card");
    paceCard.appendChild(el("h3", "xp-sec-title", "Reading Pace Calibration"));
    paceCard.appendChild(el("p", "xp-sec-desc", "Adjust your reading speed to calibrate the estimated time left displayed in the status bar:"));

    const curSpeed = state.settings.readSpeed || 900;
    const speedBox = el("div", "xp-slider-box");
    const speedHead = el("div", "xp-slider-head");
    const speedVal = el("span", "xp-slider-val", `${curSpeed} chars / min (~${Math.round(curSpeed / 5)} wpm)`);
    const speedBadge = el("span", "xp-badge", curSpeed < 700 ? "Relaxed Pace" : curSpeed > 1400 ? "Fast Reader" : "Standard Pace");
    speedHead.appendChild(speedVal);
    speedHead.appendChild(speedBadge);
    speedBox.appendChild(speedHead);

    const slider = el("input", "xp-slider");
    slider.type = "range";
    slider.min = "200";
    slider.max = "3000";
    slider.step = "50";
    slider.value = String(curSpeed);

    const calcBox = el("div", "xp-calc-hint");
    const updateCalc = (v) => {
      const mins = (5000 / v).toFixed(1);
      calcBox.textContent = `At ${v} cpm, an average chapter (5,000 chars) takes approximately ${mins} minutes to read.`;
    };
    updateCalc(curSpeed);

    slider.addEventListener("input", () => {
      const v = Number(slider.value);
      speedVal.textContent = `${v} chars / min (~${Math.round(v / 5)} wpm)`;
      speedBadge.textContent = v < 700 ? "Relaxed Pace" : v > 1400 ? "Fast Reader" : "Standard Pace";
      updateCalc(v);
    });
    slider.addEventListener("change", () => {
      state.settings.readSpeed = Number(slider.value);
      saveSettings();
      updateTimerStatus();
    });
    speedBox.appendChild(slider);
    speedBox.appendChild(calcBox);
    paceCard.appendChild(speedBox);
    body.appendChild(paceCard);

    // Break Reminder Card
    const breakCard = el("div", "xp-card");
    breakCard.appendChild(el("h3", "xp-sec-title", "Eye Health & Rest Reminders"));
    breakCard.appendChild(el("p", "xp-sec-desc", "Periodic notification toasts remind you to look 20 feet away to reduce eye strain. Only active reading time counts:"));

    const chipRow = el("div", "xp-chips-row");
    const intervals = [
      { val: 0, label: "Disabled" },
      { val: 30, label: "Every 30 mins" },
      { val: 45, label: "Every 45 mins" },
      { val: 60, label: "Every 60 mins" },
      { val: 90, label: "Every 90 mins" },
    ];
    for (const item of intervals) {
      const chip = el("button", "xp-chip" + (state.settings.remindMin === item.val ? " active" : ""), item.label);
      chip.type = "button";
      chip.addEventListener("click", () => {
        state.settings.remindMin = item.val;
        saveSettings();
        chipRow.querySelectorAll(".xp-chip").forEach((c) => c.classList.toggle("active", c === chip));
        showToast(item.val ? `Eye rest reminder set for every ${item.val} minutes.` : "Eye rest reminders disabled.", [], 2500);
      });
      chipRow.appendChild(chip);
    }
    breakCard.appendChild(chipRow);

    const testBtn = el("button", "xp-btn secondary", "Preview Notification Toast");
    testBtn.type = "button";
    testBtn.style.marginTop = "14px";
    testBtn.addEventListener("click", () => {
      showToast("You have been reading for 45 minutes. Take a 20-second break to rest your eyes.", [{ label: "Acknowledge" }, { label: "Snooze 10m" }]);
    });
    breakCard.appendChild(testBtn);
    body.appendChild(breakCard);
  },
});

/* ============================ Color Themes ================================== */
const THEMES = [
  { id: "dark", name: "Dark+ (default dark)", kind: "dark", swatch: ["#1e1e1e", "#252526", "#007acc", "#d4d4d4"] },
  { id: "tokyo-night", name: "Tokyo Night", kind: "dark", swatch: ["#1a1b26", "#16161e", "#7aa2f7", "#c0caf5"] },
  { id: "catppuccin", name: "Catppuccin Mocha", kind: "dark", swatch: ["#1e1e2e", "#181825", "#89b4fa", "#cdd6f4"] },
  { id: "dracula", name: "Dracula", kind: "dark", swatch: ["#282a36", "#21222c", "#bd93f9", "#f8f8f2"] },
  { id: "github-dark", name: "GitHub Dark", kind: "dark", swatch: ["#0d1117", "#161b22", "#1f6feb", "#c9d1d9"] },
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
  // Installed-app title bar (Windows Window Controls Overlay) and, on other
  // platforms that read it, the OS chrome around the page.
  const meta = $("#meta-theme-color");
  if (meta) meta.content = getComputedStyle(root).getPropertyValue("--titlebar-bg").trim() || "#3c3c3c";
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
    const hero = el("div", "xp-hero-card");
    const heroLeft = el("div", "xp-hero-left");
    const statusPill = el("div", "xp-status-pill ok");
    statusPill.appendChild(el("span", "xp-pulse-dot"));
    statusPill.appendChild(document.createTextNode("Curated VS Code Theme Engine"));
    heroLeft.appendChild(statusPill);
    heroLeft.appendChild(el("h3", "xp-hero-title", "Theme Gallery & Syntax Previews"));
    heroLeft.appendChild(el("p", "xp-hero-sub", "Select an authentic theme for both reading and boss-key disguise screens. Each theme re-tints the editor, explorer, tabs, and status bar."));
    hero.appendChild(heroLeft);
    body.appendChild(hero);

    const filterRow = el("div", "xp-theme-filter-row");
    let currentFilter = "all";
    const filterBtns = {};
    for (const f of [{ id: "all", label: "All Themes (8)" }, { id: "dark", label: "Dark (7)" }, { id: "light", label: "Light (1)" }]) {
      const b = el("button", "xp-chip" + (f.id === currentFilter ? " active" : ""), f.label);
      b.type = "button";
      filterBtns[f.id] = b;
      b.addEventListener("click", () => {
        currentFilter = f.id;
        for (const k of Object.keys(filterBtns)) filterBtns[k].classList.toggle("active", k === f.id);
        drawCards();
      });
      filterRow.appendChild(b);
    }
    body.appendChild(filterRow);

    const grid = el("div", "xp-theme-grid");
    body.appendChild(grid);

    function drawCards() {
      grid.innerHTML = "";
      const filtered = THEMES.filter((t) => currentFilter === "all" || t.kind === currentFilter);
      for (const t of filtered) {
        const isCurrent = effectiveTheme().id === t.id;
        const card = el("div", "xp-theme-card" + (isCurrent ? " active" : ""));
        
        // Card Header
        const cardHead = el("div", "xp-tc-head");
        const cardTitle = el("span", "xp-tc-name", t.name);
        const cardKind = el("span", "xp-badge", t.kind);
        cardHead.appendChild(cardTitle);
        cardHead.appendChild(cardKind);
        card.appendChild(cardHead);

        // Mini Code Syntax Window
        const mini = el("div", "xp-mini-code");
        mini.style.background = t.swatch[0];
        mini.style.color = t.swatch[3];
        mini.style.borderColor = t.swatch[1];

        const line1 = el("div", "xp-mc-line");
        line1.innerHTML = `<span style="color:${t.swatch[2]}">import</span> { Reader } <span style="color:${t.swatch[2]}">from</span> <span style="color:${t.swatch[3]}">"devdocs"</span>;`;
        const line2 = el("div", "xp-mc-line");
        line2.innerHTML = `<span style="opacity:0.6">// chapter stream</span>`;
        const line3 = el("div", "xp-mc-line");
        line3.innerHTML = `<span style="color:${t.swatch[2]}">const</span> doc = <span style="color:${t.swatch[2]}">await</span> Reader.<span style="color:${t.swatch[2]}">load</span>();`;
        
        mini.appendChild(line1);
        mini.appendChild(line2);
        mini.appendChild(line3);
        card.appendChild(mini);

        // Card Footer / Swatches
        const cardFoot = el("div", "xp-tc-foot");
        const sw = el("span", "theme-swatch");
        for (const c of t.swatch) {
          const s = el("span");
          s.style.background = c;
          sw.appendChild(s);
        }
        cardFoot.appendChild(sw);

        const check = el("span", "xp-tc-check" + (isCurrent ? " on" : ""));
        check.appendChild(el("span", "codicon " + codiCls("check")));
        check.appendChild(document.createTextNode(isCurrent ? " Active" : " Apply"));
        cardFoot.appendChild(check);

        card.appendChild(cardFoot);

        card.addEventListener("click", () => {
          state.settings.theme = t.id;
          saveSettings();
          applyTheme();
          drawCards();
          showToast(`Switched theme to "${t.name}".`, [], 2500);
        });

        grid.appendChild(card);
      }
    }
    drawCards();
  },
});

/* ============================ Start ========================================= */
applyTheme();
if (extEnabled("focus-timer")) timerStart();
