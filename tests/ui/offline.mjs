// Offline reading: the app shell and any book/chapter that's been opened (or
// explicitly downloaded) must still work with the network truly cut — not
// just a failed fetch, Playwright's real `setOffline(true)`.
import { chromium } from "playwright";
import { writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeEpub, startServer, cleanup, paragraphText, PASSCODE } from "../helpers.ts";

const SHOTS = join(tmpdir(), "epub-ui-shots");
mkdirSync(SHOTS, { recursive: true });
const srv = await startServer();
const specs = Array.from({ length: 8 }, (_, i) => ({ title: `Chapter ${i}`, paragraphs: 3, paragraphChars: 200 }));
const epubPath = join(tmpdir(), "offline.epub");
writeFileSync(epubPath, makeEpub("Offline Book", specs));

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1366, height: 768 }, serviceWorkers: "allow" });
const page = await ctx.newPage();
const problems = [];
page.on("pageerror", (e) => problems.push("pageerror: " + e));
// Some fetches (settings/highlights/progress — deliberately not cached) are
// expected to fail loudly while the test is offline; that's not a problem.
page.on("console", (m) => {
  if (m.type() !== "error") return;
  if (/401|Failed to fetch|ERR_INTERNET_DISCONNECTED|net::ERR_FAILED/.test(m.text())) return;
  problems.push("console: " + m.text());
});
page.on("dialog", (d) => d.accept());
let failed = 0;
const check = (label, ok, extra = "") => { if (!ok) failed++; console.log(`${ok ? "PASS" : "FAIL"}  ${label}${extra !== "" ? "  -> " + extra : ""}`); };
const openChapter = async (n, bookId) => {
  if (!(await page.locator("#view-explorer").isVisible())) await page.click('.ab-icon[data-view="explorer"]');
  const book = page.locator(`.tree-book[data-book-id="${bookId}"]`);
  await book.locator("> .tree-row").waitFor();
  if (!(await book.locator(".tree-file").count())) await book.locator("> .tree-row").click();
  await book.locator(".tree-file").nth(n).waitFor();
  await book.locator(".tree-file").nth(n).click();
  await page.waitForSelector(".monaco-editor .view-line");
  await page.waitForTimeout(400);
};
const showExt = async (name) => {
  if (!(await page.locator("#view-extensions").isVisible())) await page.click('.ab-icon[data-view="extensions"]');
  await page.locator("#ext-list .ext-item", { hasText: name }).click();
};

try {
  await page.goto(srv.base);
  await page.fill("#login-pass", PASSCODE);
  await page.click("#login-form button[type=submit]");
  await page.waitForSelector("#app:not([hidden])");
  await page.click("#btn-upload");
  await page.setInputFiles("#file-input", epubPath);
  await page.waitForFunction(() => document.querySelector("#upload-status")?.textContent.includes("indexed as"), null, { timeout: 30000 });
  await page.waitForSelector("#upload", { state: "hidden" });
  const bookId = await page.evaluate(() => state.books[0].id);

  // A second book, uploaded but never opened or downloaded — stays the
  // control case: its listing is cached (that's expected), its chapters
  // are not.
  const untouchedPath = join(tmpdir(), "untouched.epub");
  writeFileSync(untouchedPath, makeEpub("Untouched Book", [{ title: "Only chapter", paragraphs: 2, paragraphChars: 100 }]));
  await page.click("#btn-upload");
  await page.setInputFiles("#file-input", untouchedPath);
  await page.waitForFunction(() => document.querySelector("#upload-status")?.textContent.includes("indexed as"), null, { timeout: 30000 });
  await page.waitForSelector("#upload", { state: "hidden" });
  const untouchedBookId = await page.evaluate((id) => state.books.find((b) => b.id !== id).id, bookId);

  // Read chapter 2 online (this is what should end up cached "as you go").
  await openChapter(2, bookId);
  const chapter2Text = await page.evaluate(() => window.monaco.editor.getEditors()[0].getModel().getValue());
  check("chapter 2 has real content before going offline", chapter2Text.includes(paragraphText(2, 0, 200)));

  // Wait for the service worker to actually control this page (a fresh
  // registration doesn't control the page that registered it until it's
  // finished installing/activating).
  await page.waitForFunction(() => navigator.serviceWorker && navigator.serviceWorker.controller, null, { timeout: 15000 });
  check("the service worker is registered and controls the page", true);
  // The very first load (page.goto, above) happened before the worker existed
  // to intercept anything — nothing from it was cached. Reload once, still
  // online, so the shell and chapter 2 are fetched under the worker's control
  // and actually land in the cache; only then does going offline mean anything.
  await page.reload();
  // Session restore reopens chapter 2 on its own; no need to click through
  // the Explorer again (and racing that with the restore is what a first
  // version of this test got wrong).
  await page.waitForSelector(".monaco-editor .view-line");
  await page.waitForTimeout(300);

  // Download chapter 5 for offline too, WITHOUT ever opening it — this is the
  // explicit "download for offline" path, not incidental browsing.
  await showExt("Library");
  await page.waitForSelector(".lib-row");
  const rowSel = `.lib-row[data-book-id="${bookId}"]`;
  const offSel = `${rowSel} .lib-offline`;
  const before5 = await page.evaluate((s) => document.querySelector(s).textContent, offSel);
  await page.click(offSel);
  await page.waitForFunction((s) => document.querySelector(s).classList.contains("on"), offSel, { timeout: 15000 });
  check("downloading for offline finishes and shows as available", (await page.evaluate((s) => document.querySelector(s).classList.contains("on"), offSel)), before5);
  await page.screenshot({ path: `${SHOTS}/G-1-offline-downloaded.png` });

  // Visiting Library made it the active tab; switch back to chapter 2 so
  // that's what session restore reopens after the reload below (matching
  // what a reader would actually be doing when they lose the connection).
  await page.locator("#tabs .tab").filter({ hasNotText: "Extension" }).first().click();
  await page.waitForSelector(".monaco-editor .view-line");

  // ---- now actually go offline ----
  await ctx.setOffline(true);

  await page.reload();
  await page.waitForSelector("#app:not([hidden])", { timeout: 15000 });
  check("the app shell itself loads with the network cut", true);
  check("offline is indicated in the status bar", await page.locator("#st-sync.codicon-debug-disconnect").isVisible());

  // Session restore reopens chapter 2 on its own (same as the online reload
  // above) — this is the "still reads what you were just reading" case.
  await page.waitForSelector(".monaco-editor .view-line", { timeout: 10000 });
  await page.waitForTimeout(300);
  const offlineChapter2 = await page.evaluate(() => window.monaco.editor.getEditors()[0].getModel().getValue());
  check("a previously-opened chapter still reads correctly offline", offlineChapter2.includes(paragraphText(2, 0, 200)), offlineChapter2.slice(0, 40));

  await openChapter(5, bookId);
  const offlineChapter5 = await page.evaluate(() => window.monaco.editor.getEditors()[0].getModel().getValue());
  check("a chapter downloaded (but never opened) also reads offline", offlineChapter5.includes(paragraphText(5, 0, 200)), offlineChapter5.slice(0, 40));

  // A chapter that was never opened nor downloaded — from a second book that
  // was never touched at all — is, correctly, unavailable.
  const res4 = await page.evaluate(async (id) => { try { const r = await fetch(`/api/books/${id}/chapters/0`); return r.status; } catch { return "network-error"; } }, untouchedBookId);
  check("a book that was never opened nor downloaded correctly fails offline instead of silently succeeding", res4 !== 200, String(res4));

  // Scrolling while offline still records progress — queued, not lost.
  await page.evaluate(() => window.monaco.editor.getEditors()[0].setScrollTop(50));
  await page.waitForTimeout(1000);
  const queued = await page.evaluate(() => JSON.parse(localStorage.getItem("devdocs.progressq") || "{}"));
  check("progress made offline is queued instead of silently dropped", Object.keys(queued).length > 0, JSON.stringify(queued));

  // ---- back online: the queued progress must reach the server ----
  await ctx.setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await page.waitForTimeout(600);
  const afterSync = await page.evaluate(() => JSON.parse(localStorage.getItem("devdocs.progressq") || "{}"));
  check("reconnecting flushes the queued progress", Object.keys(afterSync).length === 0);
  check("offline indicator clears once back online", !(await page.locator("#st-sync.codicon-debug-disconnect").isVisible()));

  // ---- signing out must not leave cached book text readable offline ----
  await page.click("#btn-settings");
  await page.waitForSelector("#settings:not([hidden])");
  await page.click("#btn-logout");
  await page.waitForSelector("#login-pass", { state: "visible", timeout: 10000 });
  await ctx.setOffline(true);
  // Book text (the private, session-gated content) must be gone. The app's
  // own code (shell cache) is fine to still be there or even get refetched by
  // the reload above — it's not user content, and the login screen needs it
  // to work offline too.
  const dataEntries = await page.evaluate(async () => (await (await caches.open("epub-reader-data-v1")).keys()).map((k) => new URL(k.url).pathname));
  check("signing out clears cached book content (no residual access while logged out)", dataEntries.length === 0, JSON.stringify(dataEntries));

  // Remove offline (re-login online first, since we just signed out).
  await ctx.setOffline(false);
  await page.reload();
  await page.fill("#login-pass", PASSCODE);
  await page.click("#login-form button[type=submit]");
  await page.waitForSelector("#app:not([hidden])");
  await openChapter(2, bookId);
  await showExt("Library");
  await page.waitForSelector(".lib-row");
  await page.click(offSel); // was cleared by logout, so this downloads fresh
  await page.waitForFunction((s) => document.querySelector(s).classList.contains("on"), offSel, { timeout: 15000 });
  await page.click(offSel); // now remove it
  await page.waitForFunction((s) => !document.querySelector(s).classList.contains("on"), offSel, { timeout: 5000 });
  const stillCached = await page.evaluate(async (id) => {
    const cache = await caches.open("epub-reader-data-v1");
    return (await cache.keys()).some((k) => new URL(k.url).pathname.startsWith(`/api/books/${id}/chapters/`));
  }, bookId);
  check("removing the offline copy actually clears its cached chapters", !stillCached);
} catch (e) {
  failed++;
  console.log("FAIL  exception: " + e);
  await page.screenshot({ path: `${SHOTS}/G-offline-error.png` }).catch(() => {});
} finally {
  await ctx.setOffline(false).catch(() => {});
}
console.log("\nconsole problems:", problems.length ? "\n  " + problems.slice(0, 10).join("\n  ") : "none");
await browser.close(); await srv.stop(); cleanup(srv.dataDir);
process.exit(failed ? 1 : 0);
