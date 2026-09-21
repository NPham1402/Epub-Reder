import { chromium } from "playwright";
import { writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeEpub, startServer, cleanup, PASSCODE } from "../helpers.ts";

const SHOTS = join(tmpdir(), "epub-ui-shots");
mkdirSync(SHOTS, { recursive: true });
const srv = await startServer();
const epubPath = join(tmpdir(), "insights.epub");
writeFileSync(epubPath, makeEpub("Insights Book", Array.from({ length: 3 }, (_, i) => ({ title: `Chapter ${i}`, paragraphs: 30, paragraphChars: 300 }))));

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
const problems = [];
page.on("pageerror", (e) => problems.push("pageerror: " + e));
page.on("console", (m) => { if (m.type() === "error" && !m.text().includes("401")) problems.push("console: " + m.text()); });
page.on("dialog", (d) => d.accept());
let failed = 0;
const check = (label, ok, extra = "") => { if (!ok) failed++; console.log(`${ok ? "PASS" : "FAIL"}  ${label}${extra !== "" ? "  -> " + extra : ""}`); };
const pendingSeconds = () => page.evaluate(() => [...act.pending.values()].reduce((a, b) => a + b, 0));
const serverStats = () => page.evaluate(async () => (await (await fetch("/api/stats")).json()));

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
  await page.locator(".tree-file").nth(1).click();
  await page.waitForSelector(".monaco-editor .view-line");

  // Active reading is counted...
  for (let i = 0; i < 5; i++) { await page.mouse.move(400 + i * 10, 300); await page.waitForTimeout(1000); }
  const counted = await pendingSeconds();
  check("time is counted while the window is in use", counted >= 3 && counted <= 6, counted + " s");

  // ...idle time and the cover screen are not.
  await page.keyboard.press("\\");
  await page.waitForSelector("#panic:not([hidden])");
  const beforePanic = await pendingSeconds();
  for (let i = 0; i < 3; i++) { await page.mouse.move(500 + i, 320); await page.waitForTimeout(1000); }
  check("nothing is counted behind the cover screen", (await pendingSeconds()) === beforePanic, `${beforePanic} -> ${await pendingSeconds()}`);
  await page.keyboard.type("unlock");
  await page.waitForSelector("#panic", { state: "hidden" });

  // Flush and read back
  await page.evaluate(() => actFlush());
  await page.waitForTimeout(400);
  const s = await serverStats();
  const total = s.daily.reduce((a, d) => a + d.seconds, 0);
  check("the batch reaches the server as durations only", total >= 3 && s.per_book.length === 1 && Object.keys(s.daily[0]).sort().join() === "day,seconds", `${total} s`);
  check("and nothing waits to be sent afterwards", (await pendingSeconds()) === 0);

  // Four earlier days of real activity (a day counts toward a streak from one minute on).
  await page.evaluate(async () => {
    const bookId = state.books[0].id;
    const pings = [1, 2, 3, 4].map((n) => { const d = new Date(); d.setDate(d.getDate() - n); return { book_id: bookId, day: localDay(d), hour: 21, seconds: 900 }; });
    await fetch("/api/stats/ping", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pings }) });
  });

  // The page
  await page.click('.ab-icon[data-view="extensions"]');
  await page.locator("#ext-list .ext-item", { hasText: "Activity Insights" }).click();
  await page.waitForSelector(".hm-grid .hm-cell");
  check("the heat map has 53 weeks x 7 days", (await page.locator(".hm-grid .hm-cell").count()) === 371);
  check("today's cell is lit", (await page.locator(".hm-grid .hm-1, .hm-grid .hm-2, .hm-grid .hm-3, .hm-grid .hm-4").count()) >= 1);
  check("summary reads the total", /of focused time in the last year/.test(await page.textContent(".in-total")), await page.textContent(".in-total"));
  const cards = await page.locator(".in-card .in-val").allTextContents();
  check("streak: today is short of a minute, so the run ends yesterday (4 days)", cards[0] === "<1 min" && cards[3] === "4 days" && cards[4] === "4 days", cards.join(" | "));
  check("the busiest hour is named", (await page.textContent(".in-sub")).includes("Most active around"));
  await page.screenshot({ path: `${SHOTS}/C-1-insights.png` });

  // Disabling stops the recording.
  await page.click(".xp-btn:has-text('Disable')");
  const after = await pendingSeconds();
  await page.locator("#tabs .tab").filter({ hasNotText: "Extension" }).first().click();
  for (let i = 0; i < 3; i++) { await page.mouse.move(600 + i, 340); await page.waitForTimeout(1000); }
  check("disabled: nothing is recorded any more", (await pendingSeconds()) === after && after === 0, `${after}`);
} catch (e) {
  failed++;
  console.log("FAIL  exception: " + e);
  await page.screenshot({ path: `${SHOTS}/C-insights-error.png` }).catch(() => {});
}
console.log("\nconsole problems:", problems.length ? "\n  " + problems.slice(0, 10).join("\n  ") : "none");
await browser.close(); await srv.stop(); cleanup(srv.dataDir);
process.exit(failed ? 1 : 0);
