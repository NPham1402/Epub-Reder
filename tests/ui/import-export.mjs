import { chromium } from "playwright";
import { writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer, cleanup, paragraphText, PASSCODE } from "../helpers.ts";

const SHOTS = join(tmpdir(), "epub-ui-shots");
mkdirSync(SHOTS, { recursive: true });
const srv = await startServer();

const novel = Array.from({ length: 5 }, (_, i) => `Chương ${i + 1}: Tiêu đề ${i + 1}\n${paragraphText(i, 0, 300)}\n${paragraphText(i, 1, 300)}\n`).join("\n");
const txtPath = join(tmpdir(), "story.txt");
writeFileSync(txtPath, novel);
const thinPath = join(tmpdir(), "thin.txt");
writeFileSync(thinPath, ["Chapter 1", "tiny", "Chapter 2", "tiny", "Chapter 3", "tiny"].join("\n"));

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1366, height: 768 }, acceptDownloads: true });
const problems = [];
page.on("pageerror", (e) => problems.push("pageerror: " + e));
page.on("console", (m) => { if (m.type() === "error" && !m.text().includes("401")) problems.push("console: " + m.text()); });
page.on("dialog", (d) => d.accept());
let failed = 0;
const check = (label, ok, extra = "") => { if (!ok) failed++; console.log(`${ok ? "PASS" : "FAIL"}  ${label}${extra !== "" ? "  -> " + extra : ""}`); };
const bookCount = () => page.evaluate(async () => (await (await fetch("/api/books")).json()).books.length);

try {
  await page.goto(srv.base);
  await page.fill("#login-pass", PASSCODE);
  await page.click("#login-form button[type=submit]");
  await page.waitForSelector("#app:not([hidden])");

  // ---- a text file is previewed before anything is created ----
  await page.click("#btn-upload");
  await page.setInputFiles("#file-input", txtPath);
  await page.waitForSelector("#upload-preview:not([hidden])", { timeout: 20000 });
  check("the preview counts the chapters", (await page.textContent(".up-title")).startsWith("5 files found"), await page.textContent(".up-title"));
  check("and names the rule it used", (await page.textContent(".up-sub")).includes("Chương"));
  check("chapter titles are listed", (await page.locator(".up-row .up-t").allTextContents()).join("|") === [1, 2, 3, 4, 5].map((n) => `Chương ${n}: Tiêu đề ${n}`).join("|"));
  check("nothing exists yet", (await bookCount()) === 0);
  await page.screenshot({ path: `${SHOTS}/C-2-import-preview.png` });

  // cancel
  await page.click(".up-btns .xp-btn.secondary");
  await page.waitForTimeout(500);
  check("cancelling creates nothing", (await bookCount()) === 0 && (await page.textContent("#upload-status")).includes("cancelled"));

  // warnings for a suspicious split
  await page.setInputFiles("#file-input", thinPath);
  await page.waitForSelector("#upload-preview:not([hidden])");
  check("a suspicious split shows a warning", (await page.locator(".up-warn").count()) >= 1, await page.locator(".up-warn").first().textContent());
  await page.click(".up-btns .xp-btn.secondary");
  await page.waitForTimeout(400);

  // import for real
  await page.setInputFiles("#file-input", txtPath);
  await page.waitForSelector("#upload-preview:not([hidden])");
  await page.click(".up-btns .xp-btn:not(.secondary)");
  await page.waitForFunction(() => document.querySelector("#upload-status")?.textContent.includes("indexed as"), null, { timeout: 30000 });
  await page.waitForSelector("#upload", { state: "hidden" });
  check("confirming imports the book with every chapter", (await bookCount()) === 1 && (await page.evaluate(() => state.books[0].chapter_count)) === 5);
  await page.click(".tree-book .tree-row");
  await page.locator(".tree-file").nth(2).click();
  await page.waitForSelector(".monaco-editor .view-line");
  await page.waitForTimeout(500);
  const shown = await page.evaluate(() => window.monaco.editor.getEditors()[0].getModel().getValue());
  check("the imported text reads correctly", shown.includes(paragraphText(2, 0, 300)) && shown.includes(paragraphText(2, 1, 300)));

  // ---- export from the Library ----
  await page.click('.ab-icon[data-view="extensions"]');
  await page.locator("#ext-list .ext-item", { hasText: "Library" }).click();
  await page.waitForSelector(".lib-row");
  await page.locator(".lib-row").hover();
  const [txtDl] = await Promise.all([page.waitForEvent("download"), page.click(".lib-btn:has-text('TXT')")]);
  const txtFile = join(tmpdir(), "dl.txt");
  await txtDl.saveAs(txtFile);
  const exported = readFileSync(txtFile, "utf8");
  check("TXT export downloads with the disguise name", txtDl.suggestedFilename().endsWith(".txt") && !txtDl.suggestedFilename().includes("story"), txtDl.suggestedFilename());
  check("and contains the book text", exported.includes(paragraphText(4, 1, 300)) && exported.includes("Chương 3: Tiêu đề 3"));
  const [epubDl] = await Promise.all([page.waitForEvent("download"), page.click(".lib-btn:has-text('EPUB')")]);
  const epubFile = join(tmpdir(), "dl.epub");
  await epubDl.saveAs(epubFile);
  check("EPUB export downloads a zip", epubDl.suggestedFilename().endsWith(".epub") && readFileSync(epubFile).subarray(0, 2).toString() === "PK");

  await page.keyboard.press("Control+Alt+t"); // show real titles
  await page.locator(".lib-row").hover();
  const [realDl] = await Promise.all([page.waitForEvent("download"), page.click(".lib-btn:has-text('TXT')")]);
  check("with real titles shown, the file is named after the title", realDl.suggestedFilename() === "story.txt", realDl.suggestedFilename());
  await page.screenshot({ path: `${SHOTS}/C-3-library-export.png` });
} catch (e) {
  failed++;
  console.log("FAIL  exception: " + e);
  await page.screenshot({ path: `${SHOTS}/C-import-error.png` }).catch(() => {});
}
console.log("\nconsole problems:", problems.length ? "\n  " + problems.slice(0, 10).join("\n  ") : "none");
await browser.close(); await srv.stop(); cleanup(srv.dataDir);
process.exit(failed ? 1 : 0);
