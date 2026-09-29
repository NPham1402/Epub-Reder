// The Claude Code split-tab pane used a fixed dark palette (hardcoded hex),
// so switching the app's color theme did nothing to it. Verify the pane's
// key surfaces now follow the active theme's CSS variables.
import { chromium } from "playwright";
import { startServer, cleanup, PASSCODE } from "../helpers.ts";

const srv = await startServer();
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
let failed = 0;
const check = (label, ok, extra = "") => { if (!ok) failed++; console.log(`${ok ? "PASS" : "FAIL"}  ${label}${extra !== "" ? "  -> " + extra : ""}`); };

const rgb = async (sel, prop) => page.evaluate(([s, p]) => getComputedStyle(document.querySelector(s))[p], [sel, prop]);

try {
  await page.goto(srv.base);
  await page.fill("#login-pass", PASSCODE);
  await page.click("#login-form button[type=submit]");
  await page.waitForSelector("#app:not([hidden])");
  await page.click("#btn-split-claude"); // closed by default now; open it to check its theming
  await page.waitForSelector(".editorgroup-claude:not([hidden])");

  const dark = {
    panel: await rgb(".editorgroup-claude", "backgroundColor"),
    tabs: await rgb(".claude-tabs-header", "backgroundColor"),
    text: await rgb(".claude-sub-title", "color"),
  };
  const editorBgDark = await rgb(".editorgroup-primary", "backgroundColor");
  check("Dark+ (default): chat panel matches the sidebar surface, not a fixed hex", dark.panel === await rgb("#sidebar", "backgroundColor"), dark.panel);

  await page.click('.ab-icon[data-view="extensions"]');
  await page.locator("#ext-list .ext-item", { hasText: "Color Themes" }).click();
  await page.waitForSelector(".xp-theme-card");
  await page.locator(".xp-theme-card", { hasText: "Light+" }).click();
  await page.waitForTimeout(200);

  const light = {
    panel: await rgb(".editorgroup-claude", "backgroundColor"),
    tabs: await rgb(".claude-tabs-header", "backgroundColor"),
    text: await rgb(".claude-sub-title", "color"),
  };
  check("Light+: chat panel background actually changed", light.panel !== dark.panel, `${dark.panel} -> ${light.panel}`);
  check("Light+: chat panel matches the (now light) sidebar surface", light.panel === await rgb("#sidebar", "backgroundColor"), light.panel);
  check("Light+: chat tabs header matches the (now light) tabs surface", light.tabs === await rgb(".tabs", "backgroundColor"), light.tabs);
  check("Light+: chat text switched to a dark-on-light color, not still near-white", light.text !== dark.text && light.text !== "rgb(255, 255, 255)", light.text);

  await page.locator(".xp-theme-card", { hasText: "Monokai" }).click();
  await page.waitForTimeout(200);
  const monokai = { panel: await rgb(".editorgroup-claude", "backgroundColor") };
  check("Monokai: chat panel changed again (not stuck on Light+ or the old fixed hex)", monokai.panel !== light.panel && monokai.panel !== dark.panel, monokai.panel);

  // Brand accent (Claude terracotta) should stay constant across themes by design.
  await page.locator(".xp-theme-card", { hasText: "Dark+" }).click();
  await page.waitForTimeout(200);
  const accent = await rgb(".claude-act-star", "color");
  check("Claude's own brand accent color stays put across themes (by design)", accent === "rgb(217, 119, 87)", accent);
} catch (e) {
  failed++;
  console.log("FAIL  exception: " + e);
}
console.log("\ndone");
await browser.close(); await srv.stop(); cleanup(srv.dataDir);
process.exit(failed ? 1 : 0);
