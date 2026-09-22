// "Auto reveal": VS Code scrolls the Explorer to show and highlight whichever
// file is the active tab. A long book (hundreds of chapters) makes this easy to
// notice when it's missing — the highlighted row can be scrolled off-screen.
import { chromium } from "playwright";
import { writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeEpub, startServer, cleanup, PASSCODE } from "../helpers.ts";

const SHOTS = join(tmpdir(), "epub-ui-shots");
mkdirSync(SHOTS, { recursive: true });
const srv = await startServer();
const epubPath = join(tmpdir(), "reveal-book.epub");
writeFileSync(epubPath, makeEpub("Reveal Book", Array.from({ length: 220 }, (_, i) => ({ title: `Chương ${i + 1}`, paragraphs: 2, paragraphChars: 40 }))));

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
const problems = [];
page.on("pageerror", (e) => problems.push("pageerror: " + e));
page.on("console", (m) => { if (m.type() === "error" && !m.text().includes("401")) problems.push("console: " + m.text()); });
page.on("dialog", (d) => d.accept());
let failed = 0;
const check = (label, ok, extra = "") => { if (!ok) failed++; console.log(`${ok ? "PASS" : "FAIL"}  ${label}${extra !== "" ? "  -> " + extra : ""}`); };
const activeRowVisible = () => page.evaluate(() => {
  const row = document.querySelector(".tree-row.active");
  const pane = document.querySelector("#view-explorer .sb-section");
  if (!row || !pane) return false;
  const r = row.getBoundingClientRect(), p = pane.getBoundingClientRect();
  return r.top >= p.top && r.bottom <= p.bottom;
});
const activeRowText = () => page.evaluate(() => document.querySelector(".tree-row.active .tree-label")?.textContent ?? null);
const scrollTopOf = () => page.evaluate(() => document.querySelector("#view-explorer .sb-section").scrollTop);

try {
  await page.goto(srv.base);
  await page.fill("#login-pass", PASSCODE);
  await page.click("#login-form button[type=submit]");
  await page.waitForSelector("#app:not([hidden])");
  await page.click("#btn-upload");
  await page.setInputFiles("#file-input", epubPath);
  await page.waitForFunction(() => document.querySelector("#upload-status")?.textContent.includes("indexed as"), null, { timeout: 60000 });
  await page.waitForSelector("#upload", { state: "hidden" });
  await page.click(".tree-book .tree-row");
  await page.waitForSelector(".tree-file");

  // Open a chapter near the top, then one far down the list — the tree scrolls with it.
  await page.locator(".tree-file").nth(0).click();
  await page.waitForSelector(".monaco-editor .view-line");
  await page.locator(".tree-file").nth(190).click();
  await page.waitForSelector(".monaco-editor .view-line");
  await page.waitForTimeout(300);
  check("opening a chapter from the tree keeps it revealed", await activeRowVisible(), await activeRowText());

  // Switch back to the earlier tab by clicking it, the way a reader normally does.
  await page.locator("#tabs .tab").first().click();
  await page.waitForSelector(".monaco-editor .view-line");
  await page.waitForTimeout(300);
  check("switching tabs scrolls the Explorer to the newly active chapter", await activeRowVisible() && (await activeRowText()) === "0001_db_pipeline.kt", await activeRowText());

  // D/A (next/previous chapter) must also keep the tree in sync. Focus the
  // editor directly (not by clicking its content: these fixture chapters are
  // short enough that a click can land on the visible "next chapter" nav line
  // and navigate on its own, which is correct behavior but would confuse this
  // check).
  await page.evaluate(() => window.monaco.editor.getEditors()[0].focus());
  await page.keyboard.press("d");
  await page.waitForTimeout(400);
  check("navigating to the next chapter (D) reveals it too", await activeRowVisible() && /^0002_/.test(await activeRowText()), await activeRowText());

  // Manually scrolling the tree to browse must NOT be fought — no forced re-reveal
  // happens just from rendering (e.g. toggling "reveal real titles").
  const manualTop = 1200;
  await page.evaluate((top) => { document.querySelector("#view-explorer .sb-section").scrollTop = top; }, manualTop);
  await page.keyboard.press("Control+Alt+t"); // reveal real titles: re-renders the tree
  await page.waitForTimeout(200);
  check("re-rendering the tree for an unrelated reason does not reset a manual scroll", Math.abs((await scrollTopOf()) - manualTop) < 5, await scrollTopOf());
  await page.keyboard.press("Control+Alt+t");

  // Collapsing the whole sidebar (Ctrl+B) then reopening it must catch up too.
  await page.keyboard.press("Control+b");
  await page.locator("#tabs .tab").first().click();
  await page.waitForTimeout(300);
  await page.keyboard.press("Control+b");
  await page.waitForTimeout(300);
  check("reopening the collapsed sidebar reveals whatever is active now", await activeRowVisible(), await activeRowText());

  // Leaving the Explorer view (Extensions) and coming back must also catch up.
  await page.locator(".tree-file").nth(190).click();
  await page.waitForSelector(".monaco-editor .view-line");
  await page.click('.ab-icon[data-view="extensions"]');
  await page.waitForTimeout(200);
  await page.click('.ab-icon[data-view="explorer"]');
  await page.waitForTimeout(300);
  check("returning to the Explorer view reveals the active chapter", await activeRowVisible(), await activeRowText());
  await page.screenshot({ path: `${SHOTS}/E-explorer-reveal.png` });
} catch (e) {
  failed++;
  console.log("FAIL  exception: " + e);
  await page.screenshot({ path: `${SHOTS}/E-explorer-reveal-error.png` }).catch(() => {});
}
console.log("\nconsole problems:", problems.length ? "\n  " + problems.slice(0, 10).join("\n  ") : "none");
await browser.close(); await srv.stop(); cleanup(srv.dataDir);
process.exit(failed ? 1 : 0);
