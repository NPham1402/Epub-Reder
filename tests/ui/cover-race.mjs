// The boss-key cover going up while a chapter is still loading (the window
// opens in the background, or focus is lost right at launch): the chapter
// finishes under the cover, and unlocking must still bring back a working
// editor, with nothing real leaking into the fake sidebar/tabs meanwhile.
import { chromium } from "playwright";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeEpub, startServer, cleanup, PASSCODE } from "../helpers.ts";

const srv = await startServer();
const epubPath = join(tmpdir(), "cover-race.epub");
writeFileSync(epubPath, makeEpub("Cover Race", Array.from({ length: 4 }, (_, i) => ({ title: `Chapter ${i}`, paragraphs: 30, paragraphChars: 300 }))));

const browser = await chromium.launch({ headless: true });
// No service worker, so page.route can delay the chapter request.
const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 }, serviceWorkers: "block" });
const page = await ctx.newPage();
const problems = [];
page.on("pageerror", (e) => problems.push("pageerror: " + e));
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
  await page.click(".tree-book > .tree-row");
  await page.locator(".tree-file").nth(1).click();
  await page.waitForSelector(".monaco-editor .view-line", { timeout: 20000 });
  await page.click("#btn-settings");
  await page.check("#opt-blur");
  await page.click('[data-close="settings"]');
  const realTab = (await page.locator("#tabs .tab-name").first().textContent()).trim();

  // Reload with the chapter request held back, and lose focus right away.
  await page.route("**/api/books/*/chapters/*", async (route) => { await new Promise((r) => setTimeout(r, 1500)); route.continue(); });
  await page.reload();
  await page.waitForSelector("#app:not([hidden])");
  await page.evaluate(() => window.dispatchEvent(new Event("blur")));
  await page.waitForSelector("#panic-editor:not([hidden])");
  await page.waitForTimeout(2500); // the chapter has now loaded, under the cover

  check("the real chapter finished loading behind the cover", await page.evaluate(() => !!state.current));
  const under = await page.evaluate(() => ({
    tabs: document.querySelector("#tabs").textContent,
    tree: document.querySelector("#tree").textContent,
    crumbs: document.querySelector("#breadcrumbs").textContent,
    lang: document.querySelector("#st-lang").textContent,
    title: document.title,
  }));
  check("the tabs stay fake while covered", under.tabs.includes("Program.cs") && !under.tabs.includes(realTab), under.tabs.replace(/\s+/g, " ").trim());
  check("the sidebar stays fake while covered", under.tree.includes("eBOSS.Standard"), under.tree.replace(/\s+/g, " ").trim());
  check("the breadcrumb stays fake while covered", under.crumbs.includes("Program.cs"), under.crumbs.replace(/\s+/g, " ").trim());
  check("status language and tab title stay fake while covered", under.lang === "C#" && under.title.includes("Program.cs"), `${under.lang} | ${under.title}`);

  await page.keyboard.type("unlock");
  await page.waitForSelector("#panic-editor", { state: "hidden" });
  await page.waitForSelector(".monaco-editor .view-line", { state: "visible", timeout: 5000 });
  check("unlocking shows the editor with the chapter in it", await page.locator("#monaco-host").isVisible());
  check("and the welcome page is not left on top", !(await page.locator("#welcome").isVisible()));
  const after = await page.evaluate(() => ({ tabs: document.querySelector("#tabs").textContent, title: document.title, lang: document.querySelector("#st-lang").textContent }));
  check("real tabs come back", after.tabs.includes(realTab) && !after.tabs.includes("Program.cs"), after.tabs.replace(/\s+/g, " ").trim());
  check("real tab title and language come back", !after.title.includes("eBOSS") && after.lang !== "C#", `${after.title} | ${after.lang}`);
  await page.locator("#tabs .tab").first().click();
  check("tabs are clickable again", true);
} catch (e) {
  failed++;
  console.log("FAIL  exception: " + e);
}
console.log("\nconsole problems:", problems.length ? "\n  " + problems.slice(0, 10).join("\n  ") : "none");
await browser.close(); await srv.stop(); cleanup(srv.dataDir);
process.exit(failed ? 1 : 0);
