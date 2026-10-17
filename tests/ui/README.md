# Browser checks

Real-browser checks of the UI against the real built server (strict CSP, real
Monaco). They are **not** part of `npm test` because they need Playwright and a
browser, which are not project dependencies:

```bash
npm run build:monaco && npm run build:server
npm i --no-save playwright && npx playwright install chromium
node --disable-warning=ExperimentalWarning tests/ui/reader.mjs       # Monaco reading pane: find, highlight, keys, progress, boss key
node --disable-warning=ExperimentalWarning tests/ui/extensions.mjs   # Extensions view/tabs, Library, Focus Timer, Color Themes
node --disable-warning=ExperimentalWarning tests/ui/sync.mjs         # two devices: settings, highlights, progress, bookmarks
node --disable-warning=ExperimentalWarning tests/ui/insights.mjs     # Activity Insights: what is counted, streaks, heat map
node --disable-warning=ExperimentalWarning tests/ui/import-export.mjs # .txt import with preview, Library export
node --disable-warning=ExperimentalWarning tests/ui/search.mjs        # Global Search: indexing, accents, jump to the paragraph
node --disable-warning=ExperimentalWarning tests/ui/explorer-reveal.mjs # Explorer auto-scrolls to the active chapter, like VS Code
node --disable-warning=ExperimentalWarning tests/ui/scroll-smooth.mjs # reading-focus dim only recomputes once scrolling settles
node --disable-warning=ExperimentalWarning tests/ui/wheel-smooth.mjs  # a mouse-wheel notch animates instead of jumping
node --disable-warning=ExperimentalWarning tests/ui/pwa-install.mjs   # manifest + icons for "Install app", one shared title bar (window-controls-overlay)
node --disable-warning=ExperimentalWarning tests/ui/offline.mjs       # true network-cut offline reading, download-for-offline, logout clears it
node --disable-warning=ExperimentalWarning tests/ui/cover-race.mjs    # boss-key cover raised mid-load: nothing real leaks, unlock restores the editor
node --disable-warning=ExperimentalWarning tests/ui/claude-theme.mjs      # Claude Code pane follows the color theme
node --disable-warning=ExperimentalWarning tests/ui/claude-responsive.mjs # the pane can never take over a narrow window (even maximized)
node --disable-warning=ExperimentalWarning tests/ui/claude-history.mjs    # chat history survives a reload; Recent Sessions; closing a tab keeps history
node --disable-warning=ExperimentalWarning tests/ui/stealth-signout.mjs   # /read and the status-bar reader show real text; sign-out wipes localStorage
node --disable-warning=ExperimentalWarning tests/ui/palette-docview.mjs   # Ctrl+G / Ctrl+Shift+P palette, Alt+M doc view, boss key over it
node --disable-warning=ExperimentalWarning tests/ui/layout.mjs capture   # once, on a known-good build
node --disable-warning=ExperimentalWarning tests/ui/layout.mjs compare   # after a UI change: the shell must not move
```

Each prints `PASS`/`FAIL` per check and exits non-zero on any failure. CI runs all of them except `layout.mjs` (job `ui` in `build-ghcr.yml`) and a red run stops the image, so nothing reaches the cluster. `layout.mjs` keeps its baseline in `tests/ui/layout-baseline.json`; its boxes depend on the OS fonts, so capture and compare on the same OS. Screenshots
go to `$TMP/epub-ui-shots`. `layout.mjs` measures the boxes of the shell regions
(title bar, activity bar, side bar, editor group, status bar and a few children)
at 1920×1080, 1366×768 and 1024×700 in the default state; a UI change is not
allowed to move any of them.
