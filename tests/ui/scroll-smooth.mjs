// While scrolling, recomputing the "currently reading" paragraph (a decoration
// set + CSS repaint) used to run on every scroll frame — wasted work, and the
// dim/bright boundary flickering distractingly while the page moves. It should
// now wait until scrolling settles, and still land on the right paragraph.
import { chromium } from "playwright";
import { writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeEpub, startServer, cleanup, PASSCODE } from "../helpers.ts";

const SHOTS = join(tmpdir(), "epub-ui-shots");
mkdirSync(SHOTS, { recursive: true });
const srv = await startServer();
const epubPath = join(tmpdir(), "scroll-smooth.epub");
writeFileSync(epubPath, makeEpub("Scroll Smooth Book", [{ title: "Long chapter", paragraphs: 260, paragraphChars: 260 }]));

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
const problems = [];
page.on("pageerror", (e) => problems.push("pageerror: " + e));
page.on("console", (m) => { if (m.type() === "error" && !m.text().includes("401")) problems.push("console: " + m.text()); });
page.on("dialog", (d) => d.accept());
let failed = 0;
const check = (label, ok, extra = "") => { if (!ok) failed++; console.log(`${ok ? "PASS" : "FAIL"}  ${label}${extra !== "" ? "  -> " + extra : ""}`); };

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
  await page.locator(".tree-file").nth(0).click();
  await page.waitForSelector(".monaco-editor .view-line");
  await page.waitForTimeout(500);

  await page.evaluate(() => {
    window.__calls = 0;
    window.__orig = paintFocus;
    paintFocus = function () { window.__calls++; return window.__orig.apply(this, arguments); }; // eslint-disable-line no-global-assign
  });

  // Hold S (continuous scroll) for ~1.5s — many scroll ticks, ideally very few paintFocus calls.
  await page.keyboard.down("s");
  await page.waitForTimeout(1500);
  const duringHold = await page.evaluate(() => window.__calls);
  const scrollTopWhileHeld = await page.evaluate(() => window.monaco.editor.getEditors()[0].getScrollTop());
  await page.keyboard.up("s");
  check("recompute runs rarely while actively scrolling (debounced, not per-frame)", duringHold <= 2, `${duringHold} call(s) while scrolling ~1.5s, scrollTop reached ${scrollTopWhileHeld}`);

  // After release, it settles once and lands on the right paragraph.
  await page.waitForTimeout(400);
  const settled = await page.evaluate(() => {
    const ed = window.monaco.editor.getEditors()[0];
    const expectedLine = activeParagraphLine();
    const deco = ed.getModel().getAllDecorations().find((d) => d.options.inlineClassName === "reading-text");
    return { calls: window.__calls, expectedLine, decoLine: deco ? deco.range.startLineNumber : null };
  });
  check("settles to exactly one more recompute after release", settled.calls === duringHold + 1, `calls now ${settled.calls}`);
  check("and highlights the paragraph that matches the settled scroll position", settled.decoLine === settled.expectedLine, `deco=${settled.decoLine} expected=${settled.expectedLine}`);
  await page.screenshot({ path: `${SHOTS}/scroll-smooth.png` });

  // Sanity: turning the feature off skips the work entirely, and scrolling
  // itself is unaffected either way (the reader still moves while held).
  await page.click("#btn-settings");
  await page.uncheck("#opt-focus");
  await page.click('[data-close="settings"]');
  await page.evaluate(() => { window.__calls = 0; });
  const before = await page.evaluate(() => window.monaco.editor.getEditors()[0].getScrollTop());
  await page.keyboard.down("s");
  await page.waitForTimeout(800);
  await page.keyboard.up("s");
  await page.waitForTimeout(300);
  const after = await page.evaluate(() => window.monaco.editor.getEditors()[0].getScrollTop());
  check("scrolling still works with focus reading turned off", after > before, `${before} -> ${after}`);
} catch (e) {
  failed++;
  console.log("FAIL  exception: " + e);
  await page.screenshot({ path: `${SHOTS}/scroll-smooth-error.png` }).catch(() => {});
}
console.log("\nconsole problems:", problems.length ? "\n  " + problems.slice(0, 10).join("\n  ") : "none");
await browser.close(); await srv.stop(); cleanup(srv.dataDir);
process.exit(failed ? 1 : 0);
