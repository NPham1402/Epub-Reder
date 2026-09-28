"use strict";

/* ============================ Command Palette & UI Extensions ============= */
// Implements:
// 1. VS Code Command Palette & Quick Open (Ctrl+P / Ctrl+Shift+P / Ctrl+G)
// 2. Interactive Titlebar Menu Dropdowns (File, Edit, Selection, View, Go, Terminal, Help)
// 3. Tab and Explorer Context Menus (Right-click)
// 4. Mobile Drawer Toggle and Touch Swipe Gestures for Chapter Navigation

const COMMANDS = [
  { id: "goto-chapter", name: "Go: Go to Chapter...", key: "Ctrl+G", icon: "chevron-right", run: () => openQuickPick(":") },
  { id: "toggle-docmode", name: "Reader: Toggle Technical Doc Preview / Code View", key: "Alt+M", icon: "book", run: () => toggleViewMode() },
  { id: "toggle-camo", name: "Disguise: Toggle Comment Camouflage (//)", icon: "comment", run: () => { state.settings.camo = !state.settings.camo; saveSettings(); rerender(); } },
  { id: "toggle-reveal", name: "Disguise: Reveal / Hide Real Book & Chapter Titles", key: "Ctrl+Alt+T", icon: "eye", run: () => toggleReveal() },
  { id: "boss-key", name: "Disguise: Boss Key / Focus Panic Cover", key: "\\", icon: "terminal", run: () => setPanic(true) },
  { id: "open-upload", name: "Module: Import EPUB or Text File...", key: "Ctrl+Shift+U", icon: "cloud-download", run: () => openUpload() },
  { id: "open-settings", name: "Preferences: Open Settings...", icon: "settings-gear", run: () => openSettings() },
  { id: "theme-picker", name: "Preferences: Select Color Theme...", icon: "symbol-color", run: () => openThemePicker() },
  { id: "toggle-sidebar", name: "View: Toggle Primary Side Bar", key: "Ctrl+B", icon: "layout-sidebar-left", run: () => toggleSidebar() },
  { id: "toggle-ai-chat", name: "View: Toggle GitHub Copilot Chat (Secondary Side Bar)", key: "Ctrl+L", icon: "comment-discussion", run: () => { if (window.aiChat) window.aiChat.toggle(); } },
  { id: "next-chapter", name: "Go: Next Chapter", key: "D / →", icon: "arrow-right", run: () => navChapter(1) },
  { id: "prev-chapter", name: "Go: Previous Chapter", key: "A / ←", icon: "arrow-left", run: () => navChapter(-1) },
  { id: "add-bookmark", name: "Bookmark: Add Bookmark at Current Position", key: "Ctrl+Alt+K", icon: "bookmark", run: () => { if (typeof addBookmarkAtReading === "function") addBookmarkAtReading(); } },
  { id: "font-inc", name: "Reader: Increase Font Size", key: "Ctrl+=", icon: "add", run: () => changeFont(1) },
  { id: "font-dec", name: "Reader: Decrease Font Size", key: "Ctrl+-", icon: "dash", run: () => changeFont(-1) },
  { id: "toggle-focus", name: "Reader: Toggle Dim Unfocused Paragraphs", icon: "eye", run: () => { state.settings.readFocus = !state.settings.readFocus; saveSettings(); paintFocus(); } },
  { id: "view-library", name: "Extension: Open Library", icon: "library", run: () => activateExt("library") },
  { id: "view-insights", name: "Extension: Open Activity Insights", icon: "graph", run: () => activateExt("insights") },
  { id: "view-search", name: "Extension: Open Global Search", icon: "search", run: () => activateExt("global-search") },
  { id: "view-sync", name: "Extension: Open Sync & Backup", icon: "cloud", run: () => activateExt("sync-backup") },
];

/* ---------------- Command Palette / Quick Pick ----------------------------- */
const qp = {
  isOpen: false,
  mode: "all", // "cmd" | "chapter" | "all" | "theme"
  items: [],
  selectedIndex: 0,
};

function openQuickPick(initialText = "") {
  const modal = $("#quick-pick");
  const input = $("#qp-input");
  if (!modal || !input) return;

  qp.isOpen = true;
  modal.hidden = false;
  input.value = initialText;
  updateQuickPickItems(initialText);
  input.focus();
  input.select();
}

function closeQuickPick() {
  const modal = $("#quick-pick");
  if (!modal) return;
  qp.isOpen = false;
  modal.hidden = true;
}

function updateQuickPickItems(rawQuery) {
  const q = rawQuery.trim();
  const listEl = $("#qp-list");
  if (!listEl) return;
  listEl.innerHTML = "";

  let matched = [];

  if (q.startsWith(">")) {
    // Command mode
    qp.mode = "cmd";
    const search = q.slice(1).trim().toLowerCase();
    matched = COMMANDS.filter((c) => !search || c.name.toLowerCase().includes(search)).map((c) => ({
      title: c.name,
      hint: c.key || "",
      icon: c.icon || "code",
      action: c.run,
    }));
  } else if (q.startsWith(":")) {
    // Chapter number jump mode
    qp.mode = "chapter";
    const targetNo = parseInt(q.slice(1).trim(), 10);
    const book = state.current && state.current.book;
    const chapters = book && book._chapters ? book._chapters : [];

    if (!isNaN(targetNo)) {
      matched = chapters.filter((c) => {
        const no = parseChapterNo(c.title);
        return no === targetNo || String(c.idx + 1) === String(targetNo);
      }).map((c) => ({
        title: displayName(c),
        desc: `Chapter ${c.idx + 1} of ${chapters.length}`,
        icon: "file-code",
        action: () => openTab(book.id, c.idx),
      }));
    } else {
      matched = chapters.slice(0, 50).map((c) => ({
        title: displayName(c),
        desc: `Chapter ${c.idx + 1} of ${chapters.length}`,
        icon: "file-code",
        action: () => openTab(book.id, c.idx),
      }));
    }
  } else if (qp.mode === "theme") {
    // Theme picker mode
    const search = q.toLowerCase();
    const themesList = typeof THEMES !== "undefined" ? THEMES : [];
    matched = themesList.filter((t) => !search || t.name.toLowerCase().includes(search)).map((t) => ({
      title: t.name,
      desc: t.kind === "dark" ? "Dark Theme" : "Light Theme",
      icon: "symbol-color",
      action: () => {
        state.settings.theme = t.id;
        saveSettings();
        if (typeof applyTheme === "function") applyTheme();
      },
    }));
  } else {
    // Default search: Search chapters in current book + popular commands + other books
    qp.mode = "all";
    const search = q.toLowerCase();
    const book = state.current && state.current.book;
    const chapters = book && book._chapters ? book._chapters : [];

    // Matched chapters
    if (chapters.length) {
      const chMatched = chapters.filter((c) => {
        if (!search) return false;
        return (c.title && c.title.toLowerCase().includes(search)) ||
               fileLabel(c).toLowerCase().includes(search);
      }).slice(0, 30).map((c) => ({
        title: displayName(c),
        desc: `${book.code_name} · Chapter ${c.idx + 1}`,
        icon: "file-code",
        action: () => openTab(book.id, c.idx),
      }));
      matched.push(...chMatched);
    }

    // Matched other books
    const bookMatched = state.books.filter((b) => {
      if (!search) return false;
      return (b.title && b.title.toLowerCase().includes(search)) ||
             b.code_name.toLowerCase().includes(search);
    }).map((b) => ({
      title: bookLabel(b),
      desc: "Workspace Module",
      icon: "folder",
      action: () => toggleBook(b.id),
    }));
    matched.push(...bookMatched);

    // If query matches commands or empty query, show frequent commands
    const cmdMatched = COMMANDS.filter((c) => !search || c.name.toLowerCase().includes(search)).slice(0, 15).map((c) => ({
      title: c.name,
      hint: c.key || "",
      icon: c.icon || "code",
      action: c.run,
    }));

    if (!search) {
      matched = cmdMatched;
    } else {
      matched.push(...cmdMatched);
    }
  }

  qp.items = matched;
  qp.selectedIndex = 0;

  if (!matched.length) {
    const emptyEl = document.createElement("div");
    emptyEl.className = "qp-empty";
    emptyEl.textContent = "No matching commands or chapters found.";
    listEl.appendChild(emptyEl);
    return;
  }

  matched.forEach((item, index) => {
    const row = document.createElement("div");
    row.className = "qp-item" + (index === 0 ? " selected" : "");
    row.dataset.index = String(index);

    const ico = document.createElement("span");
    ico.className = "qp-item-icon ico codicon codicon-" + (item.icon || "code");
    row.appendChild(ico);

    const textWrap = document.createElement("div");
    textWrap.className = "qp-item-text";

    const titleEl = document.createElement("div");
    titleEl.className = "qp-item-title";
    titleEl.textContent = item.title;
    textWrap.appendChild(titleEl);

    if (item.desc) {
      const descEl = document.createElement("div");
      descEl.className = "qp-item-desc";
      descEl.textContent = item.desc;
      textWrap.appendChild(descEl);
    }
    row.appendChild(textWrap);

    if (item.hint) {
      const hintEl = document.createElement("span");
      hintEl.className = "qp-item-hint";
      hintEl.textContent = item.hint;
      row.appendChild(hintEl);
    }

    row.addEventListener("click", () => {
      closeQuickPick();
      if (item.action) item.action();
    });

    row.addEventListener("mouseenter", () => {
      setQuickPickSelection(index);
    });

    listEl.appendChild(row);
  });
}

function setQuickPickSelection(index) {
  const listEl = $("#qp-list");
  if (!listEl) return;
  const rows = listEl.querySelectorAll(".qp-item");
  if (!rows.length) return;

  qp.selectedIndex = Math.max(0, Math.min(index, rows.length - 1));
  rows.forEach((r, i) => r.classList.toggle("selected", i === qp.selectedIndex));

  const selectedRow = rows[qp.selectedIndex];
  if (selectedRow) selectedRow.scrollIntoView({ block: "nearest" });
}

function openThemePicker() {
  qp.mode = "theme";
  openQuickPick("");
  const input = $("#qp-input");
  if (input) input.placeholder = "Select color theme...";
}

// Quick pick keyboard navigation
document.addEventListener("keydown", (e) => {
  const modal = $("#quick-pick");
  if (!modal || modal.hidden) return;

  if (e.key === "Escape") {
    e.preventDefault();
    closeQuickPick();
  } else if (e.key === "ArrowDown") {
    e.preventDefault();
    setQuickPickSelection(qp.selectedIndex + 1);
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    setQuickPickSelection(qp.selectedIndex - 1);
  } else if (e.key === "Enter") {
    e.preventDefault();
    const sel = qp.items[qp.selectedIndex];
    closeQuickPick();
    if (sel && sel.action) sel.action();
  }
});

/* ---------------- Titlebar Interactive Dropdown Menus ---------------------- */
const MENU_DATA = {
  file: [
    { label: "Import Module...", key: "Ctrl+Shift+U", action: () => openUpload() },
    { type: "sep" },
    { label: "Preferences: Settings", action: () => openSettings() },
    { label: "Preferences: Color Theme", action: () => openThemePicker() },
    { type: "sep" },
    { label: "Close Active Tab", key: "Ctrl+W", action: () => { if (state.activeKey) closeTab(state.activeKey); } },
    { label: "Close All Tabs", action: () => { state.tabs.slice().forEach(t => closeTab(tabId(t))); } },
    { type: "sep" },
    { label: "Sign Out", action: () => $("#btn-logout").click() },
  ],
  edit: [
    { label: "Find in Current Chapter", key: "Ctrl+F", action: () => {
      if (reader.ed && !isDocMode()) { reader.ed.focus(); reader.ed.getAction("actions.find").run(); }
    }},
    { label: "Find Across All Modules", action: () => activateExt("global-search") },
    { type: "sep" },
    { label: "Add Bookmark", key: "Ctrl+Alt+K", action: () => { if (typeof addBookmarkAtReading === "function") addBookmarkAtReading(); } },
  ],
  selection: [
    { label: "Focus Current Paragraph", action: () => { state.settings.readFocus = !state.settings.readFocus; saveSettings(); paintFocus(); } },
    { label: "Highlight Selected Text", action: () => showToast("Tip: Select text with mouse to highlight it directly.") },
  ],
  view: [
    { label: "Command Palette...", key: "Ctrl+P", action: () => openQuickPick(">") },
    { label: "Quick Open / Search Chapters...", key: "Ctrl+P", action: () => openQuickPick("") },
    { type: "sep" },
    { label: "Toggle Primary Side Bar", key: "Ctrl+B", action: () => toggleSidebar() },
    { label: "Toggle Reader Mode (Code / Doc Preview)", key: "Alt+M", action: () => toggleViewMode() },
    { label: "Toggle Comment Camouflage (//)", action: () => { state.settings.camo = !state.settings.camo; saveSettings(); rerender(); } },
    { label: "Reveal / Hide Real Titles", key: "Ctrl+Alt+T", action: () => toggleReveal() },
    { type: "sep" },
    { label: "Increase Font Size", key: "Ctrl+=", action: () => changeFont(1) },
    { label: "Decrease Font Size", key: "Ctrl+-", action: () => changeFont(-1) },
    { label: "Reset Font Size", action: () => { state.settings.fontSize = 15; saveSettings(); applySettingsToDom(); applyReaderOptions(); } },
  ],
  go: [
    { label: "Go to Chapter...", key: "Ctrl+G", action: () => openQuickPick(":") },
    { label: "Next Chapter", key: "D / →", action: () => navChapter(1) },
    { label: "Previous Chapter", key: "A / ←", action: () => navChapter(-1) },
    { type: "sep" },
    { label: "Jump to Furthest Read Position", action: () => {
      if (state.current && state.current.book && state.current.book._furthest) {
        const f = state.current.book._furthest;
        openTab(state.current.bookId, f.idx);
      }
    }},
  ],
  terminal: [
    { label: "Trigger Boss-Key (Cover Terminal)", key: "\\", action: () => setPanic(true) },
    { label: "Configure Unlock Phrase", action: () => openSettings() },
  ],
  help: [
    { label: "Keyboard Shortcuts Cheatsheet", action: () => openQuickPick(">") },
    { label: "Activity Insights", action: () => activateExt("insights") },
    { label: "Sync Status & Backup", action: () => activateExt("sync-backup") },
    { type: "sep" },
    { label: "About devdocs (EPUB Reader)", action: () => showToast("devdocs — EPUB reader disguised as VS Code code documentation.", [], 5000) },
  ],
};

let activeDropdownMenu = null;

function setupTitlebarMenus() {
  const menuBar = $("#tb-menu");
  const dropdown = $("#menu-dropdown");
  if (!menuBar || !dropdown) return;

  const spans = menuBar.querySelectorAll("span[data-menu]");
  spans.forEach((span) => {
    span.addEventListener("click", (e) => {
      e.stopPropagation();
      const menuKey = span.dataset.menu;
      if (activeDropdownMenu === menuKey) {
        closeDropdownMenu();
      } else {
        openDropdownMenu(menuKey, span);
      }
    });

    span.addEventListener("mouseenter", () => {
      if (activeDropdownMenu && activeDropdownMenu !== span.dataset.menu) {
        openDropdownMenu(span.dataset.menu, span);
      }
    });
  });

  document.addEventListener("click", (e) => {
    if (!e.target.closest("#menu-dropdown") && !e.target.closest("#tb-menu")) {
      closeDropdownMenu();
    }
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && activeDropdownMenu) {
      closeDropdownMenu();
    }
  });
}

function openDropdownMenu(menuKey, triggerEl) {
  const dropdown = $("#menu-dropdown");
  const items = MENU_DATA[menuKey];
  if (!dropdown || !items) return;

  activeDropdownMenu = menuKey;
  dropdown.innerHTML = "";
  dropdown.hidden = false;

  const rect = triggerEl.getBoundingClientRect();
  dropdown.style.left = `${rect.left}px`;
  dropdown.style.top = `${rect.bottom + 2}px`;

  items.forEach((item) => {
    if (item.type === "sep") {
      const sep = document.createElement("div");
      sep.className = "menu-sep";
      dropdown.appendChild(sep);
      return;
    }

    const row = document.createElement("button");
    row.type = "button";
    row.className = "menu-item";
    row.innerHTML = `
      <span class="menu-label">${esc(item.label)}</span>
      ${item.key ? `<span class="menu-key">${esc(item.key)}</span>` : ""}
    `;
    row.addEventListener("click", () => {
      closeDropdownMenu();
      if (item.action) item.action();
    });
    dropdown.appendChild(row);
  });
}

function closeDropdownMenu() {
  const dropdown = $("#menu-dropdown");
  if (!dropdown) return;
  activeDropdownMenu = null;
  dropdown.hidden = true;
}

/* ---------------- Context Menus (Tab and Tree) ----------------------------- */
function setupContextMenus() {
  const ctx = $("#context-menu");
  if (!ctx) return;

  // Tabs context menu
  const tabsContainer = $("#tabs");
  if (tabsContainer) {
    tabsContainer.addEventListener("contextmenu", (e) => {
      const tabEl = e.target.closest(".tab");
      if (!tabEl) return;
      e.preventDefault();

      const tabs = Array.from(tabsContainer.querySelectorAll(".tab"));
      const tabIndex = tabs.indexOf(tabEl);
      const clickedTab = state.tabs[tabIndex];
      const clickedKey = clickedTab ? tabId(clickedTab) : null;

      showContextMenu(e.clientX, e.clientY, [
        { label: "Close", key: "Ctrl+W", action: () => { if (clickedKey) closeTab(clickedKey); } },
        { label: "Close Others", action: () => {
          state.tabs.slice().forEach((t) => {
            const k = tabId(t);
            if (k !== clickedKey) closeTab(k);
          });
        }},
        { label: "Close Tabs to the Right", action: () => {
          state.tabs.slice(tabIndex + 1).forEach((t) => closeTab(tabId(t)));
        }},
        { label: "Close All Tabs", action: () => {
          state.tabs.slice().forEach((t) => closeTab(tabId(t)));
        }},
      ]);
    });
  }

  // Hide context menu on outside click or escape
  document.addEventListener("click", () => { if (ctx) ctx.hidden = true; });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && ctx) ctx.hidden = true; });
}

function showContextMenu(x, y, items) {
  const ctx = $("#context-menu");
  if (!ctx || !items.length) return;

  ctx.innerHTML = "";
  ctx.hidden = false;

  items.forEach((item) => {
    if (item.type === "sep") {
      const sep = document.createElement("div");
      sep.className = "menu-sep";
      ctx.appendChild(sep);
      return;
    }
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "menu-item";
    btn.innerHTML = `
      <span class="menu-label">${esc(item.label)}</span>
      ${item.key ? `<span class="menu-key">${esc(item.key)}</span>` : ""}
    `;
    btn.addEventListener("click", () => {
      ctx.hidden = true;
      if (item.action) item.action();
    });
    ctx.appendChild(btn);
  });

  // Keep inside screen viewport
  const rect = ctx.getBoundingClientRect();
  const maxX = window.innerWidth - rect.width - 8;
  const maxY = window.innerHeight - rect.height - 8;
  ctx.style.left = `${Math.min(x, maxX)}px`;
  ctx.style.top = `${Math.min(y, maxY)}px`;
}

/* ---------------- Mobile Drawer & Touch Gesture Navigation ------------------ */
function setupMobileGestures() {
  const mobileBtn = $("#btn-mobile-menu");
  const sidebar = $("#sidebar");
  const backdrop = $("#sidebar-backdrop");

  if (mobileBtn && sidebar && backdrop) {
    mobileBtn.addEventListener("click", () => {
      sidebar.classList.toggle("mobile-open");
      backdrop.hidden = !sidebar.classList.contains("mobile-open");
    });

    backdrop.addEventListener("click", () => {
      sidebar.classList.remove("mobile-open");
      backdrop.hidden = true;
    });

    // Close mobile drawer on tree file click
    $("#tree").addEventListener("click", (e) => {
      if (e.target.closest(".tree-file") && window.innerWidth <= 768) {
        sidebar.classList.remove("mobile-open");
        backdrop.hidden = true;
      }
    });
  }

  // Touch Swipe for Next / Previous Chapter
  let touchStartX = 0;
  let touchStartY = 0;
  const editorEl = $("#editor");

  if (editorEl) {
    editorEl.addEventListener("touchstart", (e) => {
      if (!state.current || e.touches.length !== 1) return;
      touchStartX = e.touches[0].clientX;
      touchStartY = e.touches[0].clientY;
    }, { passive: true });

    editorEl.addEventListener("touchend", (e) => {
      if (!state.current || e.changedTouches.length !== 1) return;
      const deltaX = e.changedTouches[0].clientX - touchStartX;
      const deltaY = e.changedTouches[0].clientY - touchStartY;

      // Ensure horizontal swipe is dominant and exceeds 80px threshold
      if (Math.abs(deltaX) > 80 && Math.abs(deltaX) > Math.abs(deltaY) * 1.6) {
        if (deltaX < 0) {
          // Swipe left -> Next chapter
          navChapter(1);
        } else {
          // Swipe right -> Previous chapter
          navChapter(-1);
        }
      }
    }, { passive: true });
  }
}

/* ---------------- Global Init ---------------------------------------------- */
function initPalette() {
  setupTitlebarMenus();
  setupContextMenus();
  setupMobileGestures();

  const titleBarCenter = $("#tb-title");
  if (titleBarCenter) {
    titleBarCenter.addEventListener("click", () => openQuickPick(""));
  }

  const toggleViewBtn = $("#btn-toggle-viewmode");
  if (toggleViewBtn) {
    toggleViewBtn.addEventListener("click", () => toggleViewMode());
  }

  const qpInput = $("#qp-input");
  if (qpInput) {
    qpInput.addEventListener("input", (e) => updateQuickPickItems(e.target.value));
  }

  const qpBackdrop = $("#quick-pick");
  if (qpBackdrop) {
    qpBackdrop.addEventListener("click", (e) => {
      if (e.target === qpBackdrop) closeQuickPick();
    });
  }
}

// Global hotkeys for Command Palette (Ctrl+P, Ctrl+Shift+P, Ctrl+G)
document.addEventListener("keydown", (e) => {
  if (typeof panicVisible !== "undefined" && panicVisible) return;
  const mod = e.ctrlKey || e.metaKey;

  if (mod && e.shiftKey && e.key.toLowerCase() === "p") {
    e.preventDefault();
    openQuickPick(">");
  } else if (mod && !e.shiftKey && e.key.toLowerCase() === "p") {
    e.preventDefault();
    openQuickPick("");
  } else if (mod && e.key.toLowerCase() === "g") {
    e.preventDefault();
    openQuickPick(":");
  } else if (e.altKey && e.key.toLowerCase() === "m") {
    e.preventDefault();
    toggleViewMode();
  }
});

// Boot when DOM is ready
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initPalette);
} else {
  initPalette();
}

window.openQuickPick = openQuickPick;
window.closeQuickPick = closeQuickPick;
window.openThemePicker = openThemePicker;
