// Command palette (Ctrl+P / Ctrl+Shift+P / Ctrl+G) and the Technical Doc view
// (Alt+M) had no tests at all.
import { chromium } from "playwright";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeEpub, startServer, cleanup, PASSCODE } from "../helpers.ts";

const srv = await startServer();
const epubPath = join(tmpdir(), "palette.epub");
writeFileSync(epubPath, makeEpub("Palette Book", Array.from({ length: 5 }, (_, i) => ({ title: `Chapter ${i + 1}`, paragraphs: 8, paragraphChars: 200 }))));

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1400, height: 850 } });
const problems = [];
page.on("pageerror", (e) => problems.push("pageerror: " + e));
page.on("dialog", (d) => d.accept());
let failed = 0;
const check = (label, ok, extra = "") => { if (!ok) failed++; console.log(`${ok ? "PASS" : "FAIL"}  ${label}${extra !== "" ? "  -> " + extra : ""}`); };
const curIdx = () => page.evaluate(() => state.current && state.current.idx);

try {
  await page.goto(srv.base);
  await page.fill("#login-pass", PASSCODE);
  await page.click("#login-form button[type=submit]");
  await page.waitForSelector("#app:not([hidden])");
  await page.click("#btn-upload");
  await page.setInputFiles("#file-input", epubPath);
  await page.waitForFunction(() => document.querySelector("#upload-status")?.textContent.includes("indexed as"), null, { timeout: 30000 });
  await page.waitForSelector("#upload", { state: "hidden" });
  await page.click(".tree-book > .tree-row");
  await page.locator(".tree-file").first().click();
  await page.waitForSelector(".monaco-editor .view-line", { timeout: 20000 });
  await page.waitForTimeout(400);

  // Ctrl+G: go to chapter by number.
  await page.keyboard.press("Control+g");
  await page.waitForSelector("#quick-pick:not([hidden])");
  await page.keyboard.type("3");
  await page.waitForSelector(".qp-item");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => state.current && state.current.idx === 2, null, { timeout: 10000 });
  check("Ctrl+G, 3, Enter opens the third chapter", (await curIdx()) === 2);
  check("and closes the palette", await page.locator("#quick-pick").isHidden());

  // Ctrl+Shift+P: commands.
  await page.keyboard.press("Control+Shift+p");
  await page.waitForSelector("#quick-pick:not([hidden])");
  const cmds = await page.locator(".qp-item").count();
  check("Ctrl+Shift+P lists commands", cmds > 3, `${cmds} commands`);
  await page.keyboard.press("Escape");
  await page.waitForSelector("#quick-pick", { state: "hidden" });
  check("Escape closes the palette", true);

  // Alt+M: Technical Doc view and back.
  await page.keyboard.press("Alt+m");
  await page.waitForSelector("#doc-host:not([hidden])", { timeout: 5000 });
  const prose = await page.textContent("#doc-host");
  check("Alt+M shows the chapter in the doc view", prose.includes("c2p0"), prose.replace(/\s+/g, " ").slice(0, 60));
  check("and hides the code editor", await page.locator("#monaco-host").isHidden());

  // The boss key must cover the doc view too, and give it back on unlock.
  await page.keyboard.press("\\");
  await page.waitForSelector("#panic-editor:not([hidden])");
  check("boss key hides the doc view", await page.locator("#doc-host").isHidden());
  await page.keyboard.type("unlock");
  await page.waitForSelector("#panic-editor", { state: "hidden" });
  check("unlock brings the doc view back (not the code editor)", (await page.locator("#doc-host").isVisible()) && (await page.locator("#monaco-host").isHidden()));

  await page.keyboard.press("Alt+m");
  await page.waitForSelector("#monaco-host:not([hidden])", { timeout: 5000 });
  check("Alt+M again returns to the code editor", await page.locator("#doc-host").isHidden());
} catch (e) {
  failed++;
  console.log("FAIL  exception: " + e);
}
console.log("\nconsole problems:", problems.length ? "\n  " + problems.join("\n  ") : "none");
await browser.close(); await srv.stop(); cleanup(srv.dataDir);
process.exit(failed ? 1 : 0);
