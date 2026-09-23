import { chromium } from "playwright";
import { writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer, cleanup, PASSCODE } from "../helpers.ts";
import { buildEpub } from "../../src/epubwrite.ts";

const SHOTS = join(tmpdir(), "epub-ui-shots");
mkdirSync(SHOTS, { recursive: true });
const srv = await startServer({ env: { CHUNK_SIZE: "3" } });

const filler = (n, tag) => Array.from({ length: n }, (_, i) => `${tag} đoạn số ${i} nói về chuyện thường ngày trong thôn, chẳng có gì đáng chú ý cả.`);
const book = (title, marker) => buildEpub({
  title, language: "vi",
  chapters: [
    { title: "Mở đầu", blocks: filler(6, "a").map((text) => ({ type: "p", text })) },
    { title: "Chương giữa", blocks: [...filler(45, "b"), `Ở đây ${marker} đã xuất hiện trước mặt mọi người.`, ...filler(10, "c")].map((text) => ({ type: "p", text })) },
    { title: "Kết", blocks: filler(4, "d").map((text) => ({ type: "p", text })) },
  ],
});
const pathA = join(tmpdir(), "search-a.epub");
const pathB = join(tmpdir(), "search-b.epub");
writeFileSync(pathA, book("Sách A", "Trạch Nhật Phi Thăng, đạo chủ của vùng này"));
writeFileSync(pathB, book("Sách B", "Trạch Nhật cũng có mặt"));

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
const problems = [];
page.on("pageerror", (e) => problems.push("pageerror: " + e));
page.on("console", (m) => { if (m.type() === "error" && !m.text().includes("401")) problems.push("console: " + m.text()); });
page.on("dialog", (d) => d.accept());
let failed = 0;
const check = (label, ok, extra = "") => { if (!ok) failed++; console.log(`${ok ? "PASS" : "FAIL"}  ${label}${extra !== "" ? "  -> " + extra : ""}`); };
const status = () => page.evaluate(async () => (await (await fetch("/api/search/status")).json()));
const showExt = async (name) => {
  if (!(await page.locator("#view-extensions").isVisible())) await page.click('.ab-icon[data-view="extensions"]');
  await page.locator("#ext-list .ext-item", { hasText: name }).click();
};
const importFile = async (path) => {
  await page.click("#btn-upload");
  await page.setInputFiles("#file-input", path);
  await page.waitForFunction(() => document.querySelector("#upload-status")?.textContent.includes("indexed as"), null, { timeout: 30000 });
  await page.waitForSelector("#upload", { state: "hidden" });
};

try {
  await page.goto(srv.base);
  await page.fill("#login-pass", PASSCODE);
  await page.click("#login-form button[type=submit]");
  await page.waitForSelector("#app:not([hidden])");

  // A new upload is indexed in the background.
  await importFile(pathA);
  await page.waitForFunction(async () => { const s = await (await fetch("/api/search/status")).json(); return s.books.length === 1 && s.books[0].indexed === s.books[0].total; }, null, { timeout: 15000, polling: 500 });
  check("a new upload is indexed without being asked", true);

  await showExt("Global Search");
  await page.waitForSelector(".gs-input");
  // The status starts as "Checking the index…" until its own async fetch
  // resolves; wait for that to settle instead of racing it.
  await page.waitForFunction(() => !document.querySelector(".gs-status").textContent.includes("Checking"), null, { timeout: 5000 });
  check("the page says everything is indexed", (await page.textContent(".gs-status")).includes("1 module indexed"), await page.textContent(".gs-status"));

  // Accent-insensitive search, đ included
  for (const q of ["dao chu", "đạo chủ", "TRACH NHAT"]) {
    await page.fill(".gs-input", q);
    await page.keyboard.press("Enter");
    await page.waitForSelector(".gs-row", { timeout: 8000 });
    check(`"${q}" finds it`, (await page.locator(".gs-row").count()) === 1);
  }
  const marked = await page.textContent(".gs-mark");
  check("the match is shown with its accents", marked === "Trạch" || marked === "đạo", marked);
  const where = await page.textContent(".gs-where");
  check("results name the file like the explorer does, not the story chapter", /\d{4}_/.test(where) && !where.includes("Chương giữa"), where);
  await page.screenshot({ path: `${SHOTS}/D-1-search.png` });

  // Clicking jumps to the paragraph
  await page.fill(".gs-input", "đạo chủ");
  await page.keyboard.press("Enter");
  await page.waitForSelector(".gs-row");
  await page.locator(".gs-row").click();
  await page.waitForSelector(".monaco-editor .view-line");
  await page.waitForTimeout(1200);
  const jumped = await page.evaluate(() => {
    const ed = window.monaco.editor.getEditors()[0];
    const model = ed.getModel();
    const line = model.getValue().split("\n").findIndex((l) => l.includes("đạo chủ")) + 1;
    const r = ed.getVisibleRanges()[0];
    return { line, from: r.startLineNumber, to: r.endLineNumber, top: ed.getScrollTop() };
  });
  check("clicking a result opens the chapter with the paragraph in view", jumped.line > 0 && jumped.top > 300 && jumped.line >= jumped.from && jumped.line <= jumped.to, JSON.stringify(jumped));
  await page.screenshot({ path: `${SHOTS}/D-2-search-jump.png` });

  // Second book, not indexed while the extension is off
  await showExt("Global Search");
  await page.click(".xp-btn:has-text('Disable')");
  await importFile(pathB);
  await page.waitForTimeout(1500);
  const s = await status();
  check("with the extension off, new uploads are not indexed", s.books.length === 2 && s.books.some((b) => b.indexed === 0), JSON.stringify(s.books.map((b) => b.indexed + "/" + b.total)));
  await page.click(".xp-btn:has-text('Enable')");
  await page.waitForSelector(".gs-status .xp-btn");
  check("the page offers to index what is missing", (await page.textContent(".gs-status")).includes("1 of 2 modules indexed"), await page.textContent(".gs-status"));
  await page.fill(".gs-input", "trach nhat");
  await page.keyboard.press("Enter");
  await page.waitForSelector(".gs-row");
  check("only the indexed module is searched so far", (await page.locator(".gs-row").count()) === 1);
  await page.click(".gs-status .xp-btn");
  await page.waitForFunction(() => document.querySelector(".gs-status")?.textContent.includes("2 modules indexed"), null, { timeout: 15000 });
  await page.fill(".gs-input", "trach nhat");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.querySelectorAll(".gs-row").length === 2, null, { timeout: 8000 });
  check("after Index now, both modules are found", true);
  await page.selectOption(".gs-bar select", { index: 2 });
  await page.waitForTimeout(800);
  check("the scope selector limits results to one module", (await page.locator(".gs-row").count()) === 1);
} catch (e) {
  failed++;
  console.log("FAIL  exception: " + e);
  await page.screenshot({ path: `${SHOTS}/D-search-error.png` }).catch(() => {});
}
console.log("\nconsole problems:", problems.length ? "\n  " + problems.slice(0, 10).join("\n  ") : "none");
await browser.close(); await srv.stop(); cleanup(srv.dataDir);
process.exit(failed ? 1 : 0);
