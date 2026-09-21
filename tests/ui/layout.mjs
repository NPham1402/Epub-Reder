// Usage: node layout.mjs capture|compare
// Measures the boxes of the shell regions (and a few children) at three window
// sizes in the default state (Explorer view, one chapter open), so a change can
// prove it did not move the VS Code layout.
import { chromium } from "playwright";
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeEpub, startServer, cleanup, PASSCODE } from "../helpers.ts";

const mode = process.argv[2] || "compare";
const FILE = join(tmpdir(), "epub-ui-layout-baseline.json");
const SIZES = [[1920, 1080], [1366, 768], [1024, 700]];
const SELECTORS = {
  titlebar: "header.titlebar", activitybar: ".activitybar", sidebar: "#sidebar", editorgroup: ".editorgroup", statusbar: ".statusbar",
  sbHeader: "#sidebar .sb-header", sbSectionTitle: "#sidebar .sb-section-title", treeRow: "#tree .tree-row", sbFooter: "#sb-footer",
  tabs: "#tabs", tab: "#tabs .tab", breadcrumbs: "#breadcrumbs", editorWrap: ".editor-wrap", monaco: "#monaco-host .monaco-editor",
  stPos: "#st-pos", firstIcon: ".activitybar .ab-icon",
};

const srv = await startServer();
const epubPath = join(tmpdir(), "layout-check.epub");
writeFileSync(epubPath, makeEpub("Layout Check", Array.from({ length: 4 }, (_, i) => ({ title: `Chapter ${i}`, paragraphs: 20, paragraphChars: 300 }))));
const browser = await chromium.launch({ headless: true });
const out = {};
try {
  for (const [w, h] of SIZES) {
    const ctx = await browser.newContext({ viewport: { width: w, height: h } });
    const page = await ctx.newPage();
    page.on("dialog", (d) => d.accept());
    await page.goto(srv.base);
    await page.fill("#login-pass", PASSCODE);
    await page.click("#login-form button[type=submit]");
    await page.waitForSelector("#app:not([hidden])");
    if (w === SIZES[0][0]) {
      await page.click("#btn-upload");
      await page.setInputFiles("#file-input", epubPath);
      await page.waitForFunction(() => document.querySelector("#upload-status")?.textContent.includes("indexed as"), null, { timeout: 30000 });
      await page.waitForSelector("#upload", { state: "hidden" });
    }
    await page.click(".tree-book .tree-row");
    await page.locator(".tree-file").nth(1).click();
    await page.waitForSelector(".monaco-editor .view-line");
    await page.waitForTimeout(900);
    out[`${w}x${h}`] = await page.evaluate((sels) => Object.fromEntries(Object.entries(sels).map(([k, s]) => {
      const e = document.querySelector(s);
      if (!e) return [k, null];
      const r = e.getBoundingClientRect();
      return [k, [Math.round(r.x * 10) / 10, Math.round(r.y * 10) / 10, Math.round(r.width * 10) / 10, Math.round(r.height * 10) / 10]];
    })), SELECTORS);
    await ctx.close();
  }
} finally {
  await browser.close(); await srv.stop(); cleanup(srv.dataDir);
}

if (mode === "capture" || !existsSync(FILE)) {
  writeFileSync(FILE, JSON.stringify(out, null, 1));
  console.log("baseline written:", Object.keys(out).join(", "));
} else {
  const base = JSON.parse(readFileSync(FILE, "utf8"));
  let diffs = 0;
  for (const size of Object.keys(base)) for (const k of Object.keys(base[size])) {
    const a = JSON.stringify(base[size][k]), b = JSON.stringify(out[size]?.[k]);
    if (a !== b) { diffs++; console.log(`DIFF ${size} ${k}: before ${a}  after ${b}`); }
  }
  console.log(diffs ? `${diffs} differences` : "PASS  no layout differences at any size (" + Object.keys(base).join(", ") + ")");
  process.exit(diffs ? 1 : 0);
}
