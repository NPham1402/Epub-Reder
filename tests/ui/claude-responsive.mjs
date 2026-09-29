// The Claude Code split pane must never be able to take over a narrow
// window and erase every trace of the VS Code disguise (no sidebar, no
// primary editor, nothing but a chat window). Covers: closed by default,
// forced hidden below 900px even if manually opened, and even maximized.
import { chromium } from "playwright";
import { startServer, cleanup, PASSCODE } from "../helpers.ts";

const srv = await startServer();
const browser = await chromium.launch({ headless: true });
let failed = 0;
const check = (label, ok, extra = "") => { if (!ok) failed++; console.log(`${ok ? "PASS" : "FAIL"}  ${label}${extra !== "" ? "  -> " + extra : ""}`); };
const state = async (page) => page.evaluate(() => ({
  display: getComputedStyle(document.querySelector(".editorgroup-claude")).display,
  primaryVisible: document.querySelector(".editorgroup-primary").getBoundingClientRect().width > 0,
}));

try {
  // Fresh, wide window: closed by default.
  let page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  await page.goto(srv.base);
  await page.fill("#login-pass", PASSCODE);
  await page.click("#login-form button[type=submit]");
  await page.waitForSelector("#app:not([hidden])");
  check("wide window, fresh load: chat pane is closed by default", (await state(page)).display === "none");

  // Manually opened, still wide: fine for it to show.
  await page.evaluate(() => aiChat.toggle(true));
  check("wide window, opened: chat pane shows", (await state(page)).display !== "none");
  await page.close();

  // Narrow window, opened: forced hidden regardless.
  page = await browser.newPage({ viewport: { width: 343, height: 700 } });
  await page.goto(srv.base);
  await page.fill("#login-pass", PASSCODE);
  await page.click("#login-form button[type=submit]");
  await page.waitForSelector("#app:not([hidden])");
  await page.evaluate(() => aiChat.toggle(true));
  let s = await state(page);
  check("narrow window, manually opened: chat pane is still hidden", s.display === "none", s.display);
  check("...and the primary editor is still the thing on screen", s.primaryVisible);

  // Narrow window, opened AND maximized (the actual reported case): still hidden.
  await page.evaluate(() => aiChat.toggleMaximize());
  s = await state(page);
  check("narrow window, opened and maximized: chat pane is still hidden", s.display === "none", s.display);
  check("...and the primary editor is still the thing on screen", s.primaryVisible);

  // Resize back up: reappears without needing to reopen it.
  await page.setViewportSize({ width: 1600, height: 900 });
  await page.waitForTimeout(100);
  s = await state(page);
  check("resizing back up: the pane (still open+maximized) shows again", s.display !== "none");
  await page.close();
} catch (e) {
  failed++;
  console.log("FAIL  exception: " + e);
}
console.log("\ndone");
await browser.close(); await srv.stop(); cleanup(srv.dataDir);
process.exit(failed ? 1 : 0);
