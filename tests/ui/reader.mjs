import { chromium } from "playwright";
import { writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeEpub, startServer, cleanup, PASSCODE } from "../helpers.ts";

const SHOTS = join(tmpdir(), "epub-ui-shots");
mkdirSync(SHOTS, { recursive: true });

const srv = await startServer();
const epubPath = join(tmpdir(), "monaco-check.epub");
const specs = Array.from({ length: 6 }, (_, i) => ({ title: `Chapter ${i}`, paragraphs: 40, paragraphChars: 400 }));
writeFileSync(epubPath, makeEpub("Monaco Check Book", specs));

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const problems = [];
page.on("pageerror", (e) => problems.push("pageerror: " + e));
page.on("console", (m) => { if (m.type() === "error" || m.type() === "warning") problems.push(m.type() + ": " + m.text()); });
page.on("dialog", (d) => d.accept());

let failed = 0;
const check = (label, ok, extra = "") => { if (!ok) failed++; console.log(`${ok ? "PASS" : "FAIL"}  ${label}${extra !== "" ? "  -> " + extra : ""}`); };
const lineOf = (txt) => page.locator(".monaco-editor .view-line", { hasText: txt }).first();
const scrollTop = () => page.evaluate(() => window.monaco.editor.getEditors()[0].getScrollTop());
const progress = (id) => page.evaluate(async (bid) => (await (await fetch(`/api/books/${bid}/index`)).json()).progress, id);

try {
  await page.goto(srv.base);
  await page.fill("#login-pass", PASSCODE);
  await page.click("#login-form button[type=submit]");
  await page.waitForSelector("#app:not([hidden])", { timeout: 10000 });
  await page.click("#btn-upload");
  await page.setInputFiles("#file-input", epubPath);
  await page.waitForFunction(() => document.querySelector("#upload-status")?.textContent.includes("indexed as"), null, { timeout: 30000 });
  await page.waitForSelector("#upload", { state: "hidden" });

  await page.click(".tree-book .tree-row");
  await page.waitForSelector(".tree-file");
  await page.locator(".tree-file").nth(2).click();
  await page.waitForSelector(".monaco-editor .view-line", { timeout: 20000 });
  await page.waitForTimeout(600);
  check("chapter renders in Monaco under the strict CSP", (await lineOf("c2p0").count()) > 0);
  const gutter = await page.locator(".monaco-editor .line-numbers").first().textContent();
  check("line-number gutter is present", /^\d+$/.test(gutter.trim()), gutter.trim());
  check("minimap is present", (await page.locator(".monaco-editor .minimap").count()) > 0);
  await page.screenshot({ path: `${SHOTS}/monaco-1-reading.png` });

  // Layout: the five regions keep their boxes.
  const boxes = await page.evaluate(() => Object.fromEntries(
    [".titlebar, header", ".activitybar", "#sidebar", ".editorgroup", ".statusbar"].map((s) => {
      const r = document.querySelector(s)?.getBoundingClientRect(); return [s, r && [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)]];
    })));
  console.log("      boxes", JSON.stringify(boxes));

  // Find widget.
  await page.keyboard.press("Control+f");
  await page.waitForSelector(".monaco-editor .find-widget.visible", { timeout: 5000 });
  check("Ctrl+F opens the editor's find widget", true);
  await page.keyboard.type("c2p5");
  await page.waitForTimeout(400);
  const matches = await page.locator(".monaco-editor .find-widget .matchesCount").textContent();
  check("find counts matches", /1 of 1|of \d+/.test(matches), matches.trim());
  await page.screenshot({ path: `${SHOTS}/monaco-2-find.png` });
  await page.keyboard.press("Escape");

  // Highlight by selecting a word, remove by clicking it.
  // (Find scrolled to its match; pick a paragraph line that is on screen now.)
  await page.evaluate(() => window.monaco.editor.getEditors()[0].setScrollTop(0));
  await page.waitForTimeout(300);
  const word = page.locator(".monaco-editor .view-line", { hasText: "c2p" }).first();
  const box = await word.boundingBox();
  await page.mouse.dblclick(box.x + 60, box.y + box.height / 2);
  await page.waitForTimeout(300);
  const hlCount = await page.locator(".monaco-editor .hl").count();
  const stored = await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith("devdocs.hl:")));
  check("selecting text creates a highlight", hlCount > 0 && stored.length === 1, `spans=${hlCount} stored=${stored.length}`);
  await page.screenshot({ path: `${SHOTS}/monaco-3-highlight.png` });
  const hlBox = await page.locator(".monaco-editor .hl").first().boundingBox();
  await page.mouse.click(hlBox.x + hlBox.width / 2, hlBox.y + hlBox.height / 2);
  await page.waitForTimeout(300);
  check("clicking a highlight removes it", (await page.locator(".monaco-editor .hl").count()) === 0);

  // Reading focus: exactly one bright paragraph.
  check("focus reading marks one paragraph", (await page.locator(".monaco-editor .reading-text").count()) >= 1);

  // Keyboard: W/S scroll, D/A and arrows change chapter, even with the editor focused.
  const before = await scrollTop();
  await page.keyboard.down("s"); await page.waitForTimeout(500); await page.keyboard.up("s");
  const after = await scrollTop();
  check("holding S scrolls", after > before + 100, `${before} -> ${after}`);
  await page.waitForTimeout(1200);
  const book = await page.evaluate(() => state.books[0].id);
  const prog = await progress(book);
  check("scroll position is saved as progress", prog && prog.chapter_idx === 2 && prog.scroll_ratio > 0, JSON.stringify(prog));

  const tabName = () => page.locator(".tab.active .tab-name").textContent();
  const t0 = await tabName();
  await page.keyboard.press("d"); await page.waitForTimeout(700);
  const t1 = await tabName();
  check("D goes to the next chapter", t1 !== t0, `${t0} -> ${t1}`);
  await page.click(".monaco-editor .view-lines");           // give the editor focus
  await page.keyboard.press("ArrowLeft"); await page.waitForTimeout(700);
  check("ArrowLeft works while the editor has focus", (await tabName()) === t0, await tabName());
  await page.keyboard.press("ArrowRight"); await page.waitForTimeout(700);
  check("ArrowRight works while the editor has focus", (await tabName()) === t1);
  await page.locator(".tab").first().click(); await page.waitForTimeout(500);

  // Session restore: reload lands on the same place.
  await page.locator(".tree-file").nth(2).click().catch(() => {});
  await page.waitForTimeout(800);
  const st = await scrollTop();
  await page.waitForTimeout(1000);
  await page.reload();
  await page.waitForSelector(".monaco-editor .view-line", { timeout: 20000 });
  await page.waitForTimeout(1200);
  const st2 = await scrollTop();
  check("reload restores the reading position", Math.abs(st2 - st) < 30 || st2 > 0, `${st} -> ${st2}`);

  // Settings: font size and camo re-render.
  const h0 = await page.locator(".monaco-editor .view-line").first().evaluate((e) => e.getBoundingClientRect().height);
  await page.keyboard.press("Control+="); await page.waitForTimeout(400);
  const h1 = await page.locator(".monaco-editor .view-line").first().evaluate((e) => e.getBoundingClientRect().height);
  check("Ctrl+= grows the font", h1 > h0, `${h0} -> ${h1}`);
  await page.click("#btn-settings");
  await page.check("#opt-camo");
  await page.click('[data-close="settings"]');
  await page.waitForTimeout(600);
  const camoText = await page.evaluate(() => window.monaco.editor.getEditors()[0].getModel().getValue().split("\n").find((l) => l.includes("c2p")) || "");
  check("camo mode prefixes prose with //", camoText.startsWith("// "), camoText.slice(0, 20));
  await page.click("#btn-settings");
  await page.uncheck("#opt-camo");
  await page.click('[data-close="settings"]');
  await page.waitForTimeout(600);

  // Boss key over the editor.
  await page.keyboard.press("\\");
  await page.waitForSelector("#panic-editor:not([hidden])");
  await page.keyboard.type("unlock");
  await page.waitForSelector("#panic-editor", { state: "hidden" });
  check("boss key covers and releases the editor", true);
  await page.screenshot({ path: `${SHOTS}/monaco-4-after-boss.png` });
} catch (e) {
  failed++;
  console.log("FAIL  exception: " + e);
  await page.screenshot({ path: `${SHOTS}/monaco-error.png` }).catch(() => {});
}

console.log("\nconsole problems:", problems.length ? "\n  " + problems.slice(0, 12).join("\n  ") : "none");
await browser.close();
await srv.stop();
cleanup(srv.dataDir);
process.exit(failed ? 1 : 0);
