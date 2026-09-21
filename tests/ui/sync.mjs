import { chromium } from "playwright";
import { writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeEpub, startServer, cleanup, PASSCODE } from "../helpers.ts";

const SHOTS = join(tmpdir(), "epub-ui-shots");
mkdirSync(SHOTS, { recursive: true });
const srv = await startServer();
const epubPath = join(tmpdir(), "phaseB.epub");
writeFileSync(epubPath, makeEpub("Phase B Book", Array.from({ length: 6 }, (_, i) => ({ title: `Chapter ${i}`, paragraphs: 40, paragraphChars: 400 }))));

const browser = await chromium.launch({ headless: true });
const problems = [];
let failed = 0;
const check = (label, ok, extra = "") => { if (!ok) failed++; console.log(`${ok ? "PASS" : "FAIL"}  ${label}${extra !== "" ? "  -> " + extra : ""}`); };

async function device(name, init) {
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 768 } });
  if (init) await ctx.addInitScript(init);
  const page = await ctx.newPage();
  page.on("pageerror", (e) => problems.push(`${name} pageerror: ${e}`));
  page.on("console", (m) => { if (m.type() === "error" && !m.text().includes("401")) problems.push(`${name} console: ${m.text()}`); });
  page.on("dialog", (d) => d.accept());
  await page.goto(srv.base);
  await page.fill("#login-pass", PASSCODE);
  await page.click("#login-form button[type=submit]");
  await page.waitForSelector("#app:not([hidden])");
  return page;
}
const openChapter = async (page, n) => {
  if (!(await page.locator("#view-explorer").isVisible())) await page.click('.ab-icon[data-view="explorer"]');
  if (!(await page.locator(".tree-file").count())) await page.click(".tree-book .tree-row");
  await page.waitForSelector(".tree-file");
  await page.locator(".tree-file").nth(n).click();
  await page.waitForSelector(".monaco-editor .view-line");
  await page.waitForTimeout(700);
};
const showExt = async (page, name) => {
  if (!(await page.locator("#view-extensions").isVisible())) await page.click('.ab-icon[data-view="extensions"]');
  await page.locator("#ext-list .ext-item", { hasText: name }).click();
};
const apiGet = (page, path) => page.evaluate(async (p) => (await fetch(p)).json(), path);

try {
  // ------------- device A: create things -------------
  const A = await device("A");
  await A.click("#btn-upload");
  await A.setInputFiles("#file-input", epubPath);
  await A.waitForFunction(() => document.querySelector("#upload-status")?.textContent.includes("indexed as"), null, { timeout: 30000 });
  await A.waitForSelector("#upload", { state: "hidden" });
  const bookId = await A.evaluate(() => state.books[0].id);

  await openChapter(A, 2);
  await A.evaluate(() => window.monaco.editor.getEditors()[0].setScrollTop(0));
  await A.waitForTimeout(300);
  const box = await A.locator(".monaco-editor .view-line", { hasText: "c2p" }).first().boundingBox();
  await A.mouse.dblclick(box.x + 60, box.y + box.height / 2);
  await A.waitForTimeout(400);
  check("A: highlight created", (await A.locator(".monaco-editor .hl").count()) > 0);
  await A.waitForTimeout(2500);
  const remoteHl = await apiGet(A, `/api/books/${bookId}/highlights`);
  check("highlight reached the server", remoteHl.chapters["2"] && remoteHl.chapters["2"].items.length === 1, JSON.stringify(remoteHl.chapters["2"]?.items));

  // settings: font size + theme
  await A.keyboard.press("Control+="); await A.keyboard.press("Control+=");
  await showExt(A, "Color Themes");
  await A.locator(".theme-row", { hasText: "Monokai" }).click();
  await A.waitForTimeout(2500);
  const remoteSettings = (await apiGet(A, "/api/settings")).settings;
  check("settings reached the server", remoteSettings.theme?.value === "monokai" && remoteSettings.fontSize?.value === 17, `${remoteSettings.theme?.value}, ${remoteSettings.fontSize?.value}`);

  // ------------- device B: a fresh browser sees them -------------
  const B = await device("B");
  await B.waitForTimeout(1500);
  check("B: theme arrived from the server", (await B.evaluate(() => document.documentElement.dataset.theme)) === "monokai");
  check("B: font size arrived", (await B.evaluate(() => state.settings.fontSize)) === 17);
  await openChapter(B, 2);
  await B.waitForFunction(() => document.querySelectorAll(".monaco-editor .hl").length > 0, null, { timeout: 8000 }).catch(() => {});
  check("B: the highlight made on A shows on B", (await B.locator(".monaco-editor .hl").count()) > 0);
  await B.screenshot({ path: `${SHOTS}/B-1-second-device.png` });

  // a change on B reaches A
  await showExt(B, "Color Themes");
  await B.locator(".theme-row", { hasText: "Light+" }).click();
  await B.waitForTimeout(2500);
  await A.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await A.waitForTimeout(1500);
  check("A: picks up B's theme when it comes back to the tab", (await A.evaluate(() => document.documentElement.dataset.theme)) === "light");

  // ------------- legacy highlights are merged, not lost -------------
  const C = await device("C", `
    if (!localStorage.getItem("seeded")) {
      localStorage.setItem("seeded", "1");
      localStorage.setItem("devdocs.hl:${bookId}:3", JSON.stringify([{ p: 1, start: 0, end: 6 }]));
      localStorage.setItem("devdocs.hl:${bookId}:2", JSON.stringify([{ p: 5, start: 2, end: 9 }]));
    }`);
  await openChapter(C, 2);
  await C.waitForTimeout(3500);
  const merged = await apiGet(C, `/api/books/${bookId}/highlights`);
  check("legacy highlights on a never-synced device are pushed (chapter 3)", merged.chapters["3"]?.items.length === 1);
  check("and merged with what the server had, not replacing it (chapter 2)", merged.chapters["2"]?.items.length === 2, JSON.stringify(merged.chapters["2"]?.items));

  // ------------- progress: "% read" never goes backwards -------------
  await openChapter(B, 4);
  await B.evaluate(() => window.monaco.editor.getEditors()[0].setScrollTop(500));
  await B.waitForTimeout(1500);
  await openChapter(B, 1);
  await B.waitForTimeout(1500);
  const prog = (await apiGet(B, `/api/books/${bookId}/index`)).progress;
  check("server: resume point is the latest chapter, furthest stays ahead", prog.chapter_idx === 1 && prog.furthest_idx === 4, JSON.stringify(prog));
  await A.reload();
  await A.waitForSelector("#app:not([hidden])");
  await showExt(A, "Library");
  await A.waitForSelector(".lib-row");
  const pct = Number((await A.locator(".lib-pct").first().textContent()).replace("%", ""));
  check("Library % follows the furthest point, not the latest", pct >= 60, pct + "%");

  // ------------- bookmarks -------------
  await showExt(A, "Bookmarks");
  await A.waitForSelector(".xp-off");
  check("Bookmarks is off by default", (await A.textContent(".xp-off")).includes("disabled"));
  await A.click(".xp-btn:has-text('Enable')");
  await A.waitForSelector(".bm-list");
  await A.locator("#tabs .tab").filter({ hasNotText: "Extension" }).first().click().catch(() => {});
  await openChapter(A, 2);
  await A.evaluate(() => window.monaco.editor.getEditors()[0].setScrollTop(700));
  await A.waitForTimeout(500);
  await A.keyboard.press("Control+Alt+k");
  await A.waitForSelector(".toast");
  check("Ctrl+Alt+K adds a bookmark", (await A.textContent(".toast")).includes("Bookmark added"));
  await A.waitForTimeout(600);
  check("the bookmarked paragraph gets a marker in the gutter", (await A.locator(".monaco-editor .bm-mark").count()) > 0);
  await A.screenshot({ path: `${SHOTS}/B-2-bookmark.png` });
  const marks = (await apiGet(A, "/api/bookmarks")).bookmarks;
  check("the bookmark is stored on the server", marks.length === 1 && marks[0].chapter_idx === 2 && marks[0].snippet.length > 10, marks[0]?.snippet?.slice(0, 20));
  await A.keyboard.press("Control+Alt+k");
  await A.waitForTimeout(600);
  check("adding it twice does not duplicate", (await apiGet(A, "/api/bookmarks")).bookmarks.length === 1);

  // B: enable the extension, see the bookmark, jump to it
  await showExt(B, "Bookmarks");
  await B.click(".xp-btn:has-text('Enable')");
  await B.waitForSelector(".bm-row");
  check("B sees A's bookmark", (await B.locator(".bm-row").count()) === 1);
  await B.screenshot({ path: `${SHOTS}/B-3-bookmarks-page.png` });
  await B.locator(".bm-row").click();
  await B.waitForSelector(".monaco-editor .view-line");
  await B.waitForTimeout(1200);
  const scrolled = await B.evaluate(() => window.monaco.editor.getEditors()[0].getScrollTop());
  check("clicking it opens that chapter, scrolled to the paragraph", scrolled > 300, "scrollTop=" + scrolled);

  // remove
  await showExt(B, "Bookmarks");
  await B.locator(".bm-row").hover();
  await B.locator(".bm-del").click();
  await B.waitForTimeout(500);
  check("removing a bookmark deletes it on the server", (await apiGet(B, "/api/bookmarks")).bookmarks.length === 0);

  // ------------- Sync & Backup page -------------
  await showExt(A, "Sync & Backup");
  await A.click("text=Sync now");
  await A.waitForTimeout(800);
  check("Sync & Backup page reports up to date", (await A.textContent(".xp-body")).includes("Up to date"));
} catch (e) {
  failed++;
  console.log("FAIL  exception: " + e);
}
console.log("\nconsole problems:", problems.length ? "\n  " + problems.slice(0, 10).join("\n  ") : "none");
await browser.close(); await srv.stop(); cleanup(srv.dataDir);
process.exit(failed ? 1 : 0);
