// A plain (non-trackpad) mouse sends one big, discrete delta per wheel notch.
// Without Monaco's smoothScrolling option, that notch snaps the page straight
// to its target in a single frame — reads as jumpy/laggy next to how a normal
// web page scrolls. It should now animate the jump, and W/S hold-scroll (its
// own frame-by-frame loop, unrelated to wheel input) must stop instantly with
// no drift once released — the animation must not add its own lag there.
import { chromium } from "playwright";
import { writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeEpub, startServer, cleanup, PASSCODE } from "../helpers.ts";

const SHOTS = join(tmpdir(), "epub-ui-shots");
mkdirSync(SHOTS, { recursive: true });
const srv = await startServer();
const epubPath = join(tmpdir(), "wheel-smooth.epub");
writeFileSync(epubPath, makeEpub("Wheel Smooth Book", [{ title: "Long chapter", paragraphs: 260, paragraphChars: 260 }]));

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
const problems = [];
page.on("pageerror", (e) => problems.push("pageerror: " + e));
page.on("console", (m) => { if (m.type() === "error" && !m.text().includes("401")) problems.push("console: " + m.text()); });
page.on("dialog", (d) => d.accept());
let failed = 0;
const check = (label, ok, extra = "") => { if (!ok) failed++; console.log(`${ok ? "PASS" : "FAIL"}  ${label}${extra !== "" ? "  -> " + extra : ""}`); };
const scrollTop = () => page.evaluate(() => window.monaco.editor.getEditors()[0].getScrollTop());

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

  check("smoothScrolling is turned on", await page.evaluate(() => window.monaco.editor.getEditors()[0].getOption(window.monaco.editor.EditorOption.smoothScrolling)));

  // One wheel notch should ramp toward its target across several frames, not
  // land there on the very first one.
  const box = await page.locator(".monaco-editor .view-lines").boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + 100);
  await page.mouse.wheel(0, 100);
  const samples = [];
  for (let i = 0; i < 8; i++) { samples.push(await scrollTop()); await page.waitForTimeout(16); }
  const final = samples[samples.length - 1];
  check("a single wheel notch animates toward its target instead of jumping there", samples[1] !== final && new Set(samples).size > 2, samples.join(","));
  check("and still ends up at the right place", final > 0);
  await page.screenshot({ path: `${SHOTS}/F-wheel-ramp.png` });

  // W/S hold-scroll must stop the instant the key is released — no coasting.
  await page.evaluate(() => window.monaco.editor.getEditors()[0].setScrollTop(0));
  await page.waitForTimeout(200);
  await page.keyboard.down("s");
  await page.waitForTimeout(600);
  const atRelease = await scrollTop();
  await page.keyboard.up("s");
  await page.waitForTimeout(300);
  const afterRelease = await scrollTop();
  check("W/S hold-scroll still moves", atRelease > 0);
  check("and stops immediately on release, without drifting further", afterRelease === atRelease, `${atRelease} -> ${afterRelease}`);
} catch (e) {
  failed++;
  console.log("FAIL  exception: " + e);
  await page.screenshot({ path: `${SHOTS}/F-wheel-error.png` }).catch(() => {});
}
console.log("\nconsole problems:", problems.length ? "\n  " + problems.slice(0, 10).join("\n  ") : "none");
await browser.close(); await srv.stop(); cleanup(srv.dataDir);
process.exit(failed ? 1 : 0);
