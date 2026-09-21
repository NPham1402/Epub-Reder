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
node --disable-warning=ExperimentalWarning tests/ui/layout.mjs capture   # once, on a known-good build
node --disable-warning=ExperimentalWarning tests/ui/layout.mjs compare   # after a UI change: the shell must not move
```

Each prints `PASS`/`FAIL` per check and exits non-zero on any failure. Screenshots
go to `$TMP/epub-ui-shots`. `layout.mjs` measures the boxes of the shell regions
(title bar, activity bar, side bar, editor group, status bar and a few children)
at 1920×1080, 1366×768 and 1024×700 in the default state; a UI change is not
allowed to move any of them.
