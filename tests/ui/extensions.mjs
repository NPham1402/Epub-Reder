import { chromium } from "playwright";
import { writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeEpub, startServer, cleanup, PASSCODE } from "../helpers.ts";

const SHOTS = join(tmpdir(), "epub-ui-shots");
mkdirSync(SHOTS, { recursive: true });
const srv = await startServer();
const epubPath = join(tmpdir(), "phaseA.epub");
writeFileSync(epubPath, makeEpub("Phase A Book", Array.from({ length: 6 }, (_, i) => ({ title: `Chapter ${i}`, paragraphs: 40, paragraphChars: 400 }))));

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
const problems = [];
page.on("pageerror", (e) => problems.push("pageerror: " + e));
page.on("console", (m) => { if (m.type() === "error" && !m.text().includes("401")) problems.push("console: " + m.text()); });
page.on("dialog", (d) => d.accept());

let failed = 0;
const check = (label, ok, extra = "") => { if (!ok) failed++; console.log(`${ok ? "PASS" : "FAIL"}  ${label}${extra !== "" ? "  -> " + extra : ""}`); };
const vis = (sel) => page.locator(sel).isVisible();
const tabs = () => page.locator("#tabs .tab .tab-name").allTextContents();
const activeTab = () => page.locator("#tabs .tab.active .tab-name").textContent();
const showExtView = async () => { if (!(await vis("#view-extensions"))) await page.click('.ab-icon[data-view="extensions"]'); };
const cssBg = (sel) => page.evaluate((s) => getComputedStyle(document.querySelector(s)).backgroundColor, sel);

try {
  await page.goto(srv.base);
  await page.fill("#login-pass", PASSCODE);
  await page.click("#login-form button[type=submit]");
  await page.waitForSelector("#app:not([hidden])");
  await page.click("#btn-upload");
  await page.setInputFiles("#file-input", epubPath);
  await page.waitForFunction(() => document.querySelector("#upload-status")?.textContent.includes("indexed as"), null, { timeout: 30000 });
  await page.waitForSelector("#upload", { state: "hidden" });
  await page.click(".tree-book .tree-row");
  await page.locator(".tree-file").nth(2).click();
  await page.waitForSelector(".monaco-editor .view-line");
  await page.waitForTimeout(500);

  // ---- Side bar views ----
  check("default state: Explorer shown, no timer item in the status bar", (await vis("#view-explorer")) && !(await page.locator("#st-timer").count()));
  await showExtView();
  check("Extensions icon opens the Extensions view", (await vis("#view-extensions")) && !(await vis("#view-explorer")));
  const names = await page.locator("#ext-list .ext-name").allTextContents();
  check("the installed extensions are listed", names.length === 5 && ["Library","Focus Timer","Color Themes","Sync & Backup","Bookmarks"].every((n) => names.includes(n)), names.join(", "));
  await page.fill("#ext-filter", "timer");
  check("the filter narrows the list", (await page.locator("#ext-list .ext-item").count()) === 1);
  await page.fill("#ext-filter", "");
  await page.screenshot({ path: `${SHOTS}/A-1-extensions-view.png` });

  await page.click('.ab-icon[data-view="search"]');
  await page.fill("#sv-search", "anything"); await page.keyboard.press("Enter");
  check("Search view answers like VS Code", (await page.textContent("#sv-search-msg")).includes("No results"));
  await page.click('.ab-icon[data-view="scm"]');
  check("Source Control view shows its empty state", (await page.textContent("#view-scm")).includes("doesn't have a git repository"));
  await page.click('.ab-icon[data-view="run"]');
  check("Run view shows its empty state", (await page.textContent("#view-run")).includes("launch.json"));
  await page.click('.ab-icon[data-view="explorer"]');
  check("Explorer icon returns to the Explorer", await vis("#view-explorer"));
  await page.click('.ab-icon[data-view="explorer"]');
  check("clicking the open view's icon collapses the side bar", !(await vis("#sidebar")));
  await page.click('.ab-icon[data-view="explorer"]');
  check("and clicking again reopens it", await vis("#sidebar"));

  // ---- Library ----
  await page.waitForTimeout(1500); // let progress save for chapter 2
  await page.evaluate(() => window.monaco.editor.getEditors()[0].setScrollTop(600));
  await page.waitForTimeout(1200);
  await showExtView();
  await page.locator("#ext-list .ext-item", { hasText: "Library" }).click();
  await page.waitForSelector("#ext-page:not([hidden]) .lib-row");
  check("an extension opens as its own tab", (await activeTab()) === "Extension: Library", (await tabs()).join(" | "));
  check("the editor is replaced by the extension page", (await vis("#ext-page")) && !(await vis("#monaco-host")));
  check("breadcrumb names the extension", (await page.textContent("#breadcrumbs")).includes("Extension: Library"));
  const pct = await page.locator(".lib-pct").first().textContent();
  check("Library shows reading progress from the server", /^\d+%$/.test(pct) && pct !== "0%", pct);
  await page.screenshot({ path: `${SHOTS}/A-2-library.png` });
  await page.selectOption(".lib-sort", "name");
  check("sort choice is remembered", (await page.evaluate(() => JSON.parse(localStorage.getItem("devdocs.settings")).librarySort)) === "name");
  await page.locator(".lib-row").first().click();
  await page.waitForSelector(".monaco-editor .view-line");
  check("clicking a book opens it where you left off", (await activeTab()).match(/^\d{4}_/) && (await vis("#monaco-host")), await activeTab());

  // keyboard on an extension page must be harmless
  await page.locator("#tabs .tab", { hasText: "Extension: Library" }).click();
  await page.keyboard.press("d"); await page.keyboard.press("ArrowRight");
  check("chapter keys do nothing on an extension page", (await activeTab()) === "Extension: Library");

  // ---- Focus Timer ----
  await showExtView();
  await page.locator("#ext-list .ext-item", { hasText: "Focus Timer" }).click();
  await page.waitForSelector(".xp-off");
  check("Focus Timer is off by default and says so", (await page.textContent(".xp-off")).includes("disabled"));
  await page.click(".xp-btn:has-text('Enable')");
  await page.waitForSelector(".ft-row");
  await page.locator("#tabs .tab").filter({ hasNotText: "Extension" }).first().click();
  await page.waitForSelector(".monaco-editor .view-line");
  await page.waitForSelector("#st-timer:not([hidden])", { timeout: 5000 });
  const left = await page.textContent("#st-timer");
  check("enabled: the status bar shows time left", /min left/.test(left), left.trim());
  await page.screenshot({ path: `${SHOTS}/A-3-timer.png` });
  await page.locator("#tabs .tab", { hasText: "Focus Timer" }).click();
  await page.click("text=Show a sample reminder");
  check("a sample reminder appears as a notification", (await page.locator(".toast").count()) === 1);
  await page.keyboard.press("\\");
  await page.waitForSelector("#panic:not([hidden])");
  check("the boss key hides notifications", !(await vis("#toasts")));
  await page.keyboard.type("unlock");
  await page.waitForSelector("#panic", { state: "hidden" });
  check("and they come back after unlocking", await vis("#toasts"));
  await page.click(".toast .toast-btn");
  await page.click(".xp-btn:has-text('Disable')");
  check("disabling removes every trace from the status bar", (await page.locator("#st-timer").count()) === 0);

  // ---- Color Themes ----
  await showExtView();
  await page.locator("#ext-list .ext-item", { hasText: "Color Themes" }).click();
  await page.waitForSelector(".theme-row");
  await page.locator(".theme-row", { hasText: "Light+" }).click();
  check("Light+ sets the theme attribute", (await page.evaluate(() => document.documentElement.dataset.theme)) === "light");
  check("and the window really turns light", (await cssBg("body")) === "rgb(255, 255, 255)", await cssBg("body"));
  await page.screenshot({ path: `${SHOTS}/A-4-light-theme-page.png` });
  await page.locator("#tabs .tab").filter({ hasNotText: "Extension" }).first().click();
  await page.waitForSelector(".monaco-editor .view-line");
  await page.waitForTimeout(500);
  const editorBg = await page.evaluate(() => getComputedStyle(document.querySelector(".monaco-editor-background")).backgroundColor);
  check("the reading editor follows the theme", editorBg === "rgb(255, 255, 255)", editorBg);
  await page.screenshot({ path: `${SHOTS}/A-5-light-reading.png` });
  await page.keyboard.press("\\");
  await page.waitForSelector("#panic:not([hidden])");
  const panicBg = await cssBg("#panic");
  check("the cover screen follows the theme too", panicBg === "rgb(255, 255, 255)", panicBg);
  await page.screenshot({ path: `${SHOTS}/A-6-light-panic.png` });
  await page.keyboard.type("unlock");
  await page.waitForSelector("#panic", { state: "hidden" });
  for (const [name, bg] of [["Monokai", "rgb(39, 40, 34)"], ["AMOLED", "rgb(0, 0, 0)"]]) {
    await showExtView();
    await page.locator("#ext-list .ext-item", { hasText: "Color Themes" }).click();
    await page.locator(".theme-row", { hasText: name }).click();
    check(`${name} theme applies`, (await cssBg("body")) === bg, await cssBg("body"));
  }
  await page.screenshot({ path: `${SHOTS}/A-7-amoled.png` });
  await page.locator(".theme-row", { hasText: "Dark+" }).click();
  check("Dark+ removes the theme attribute (the original look)", (await page.evaluate(() => document.documentElement.dataset.theme)) === undefined);
  await page.locator(".theme-row", { hasText: "Light+" }).click();
  await page.click(".xp-btn:has-text('Disable')");
  check("disabling Color Themes puts the original look back", (await page.evaluate(() => document.documentElement.dataset.theme)) === undefined);
  await page.click(".xp-btn:has-text('Enable')");
  await page.locator(".theme-row", { hasText: "Dark+" }).click();

  // ---- Tabs survive a reload ----
  await page.locator("#tabs .tab", { hasText: "Extension: Library" }).click();
  await page.waitForTimeout(300);
  await page.reload();
  await page.waitForSelector("#ext-page:not([hidden])", { timeout: 10000 });
  check("extension tabs are restored after a reload", (await activeTab()) === "Extension: Library" && (await vis("#ext-page")), (await tabs()).join(" | "));
  await page.locator("#tabs .tab.active .tab-close").click();
  await page.waitForTimeout(700);
  check("closing an extension tab falls back to another tab", !(await activeTab()).startsWith("Extension: Library"), await activeTab());
  await page.keyboard.press("Alt+1");
  await page.waitForTimeout(300);
} catch (e) {
  failed++;
  console.log("FAIL  exception: " + e);
  await page.screenshot({ path: `${SHOTS}/A-error.png` }).catch(() => {});
}
console.log("\nconsole problems:", problems.length ? "\n  " + problems.slice(0, 10).join("\n  ") : "none");
await browser.close(); await srv.stop(); cleanup(srv.dataDir);
process.exit(failed ? 1 : 0);
