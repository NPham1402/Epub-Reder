// The Claude Code chat panel never saved anything: new messages vanished on
// reload, and the "Recent Sessions" history button did nothing at all.
import { chromium } from "playwright";
import { startServer, cleanup, PASSCODE } from "../helpers.ts";

const srv = await startServer();
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
let failed = 0;
const check = (label, ok, extra = "") => { if (!ok) failed++; console.log(`${ok ? "PASS" : "FAIL"}  ${label}${extra !== "" ? "  -> " + extra : ""}`); };

try {
  await page.goto(srv.base);
  await page.fill("#login-pass", PASSCODE);
  await page.click("#login-form button[type=submit]");
  await page.waitForSelector("#app:not([hidden])");
  await page.click("#btn-split-claude");
  await page.waitForSelector(".editorgroup-claude:not([hidden])");

  const marker = "kiểm tra lưu lịch sử " + Date.now();
  await page.fill("#ai-prompt-input", marker);
  await page.click("#ai-send-btn");
  await page.waitForSelector(".claude-user-bubble", { hasText: marker });
  // Let the streamed assistant reply finish so it gets persisted too.
  await page.waitForFunction(() => !window.aiChat.isGenerating, null, { timeout: 15000 });
  await page.waitForTimeout(200);

  await page.reload();
  await page.waitForSelector("#app:not([hidden])");
  // Closed by default after a reload is intentional (see the earlier
  // narrow-window fix) — the history itself must still be there once reopened.
  check("chat pane is closed by default after reload (unchanged behavior)", !(await page.locator(".editorgroup-claude").isVisible()));
  await page.click("#btn-split-claude");
  await page.waitForSelector(".editorgroup-claude:not([hidden])");
  check("the message survives a reload", await page.locator(".claude-user-bubble", { hasText: marker }).count() === 1);
  const proseCount = await page.locator(".claude-final-prose").count();
  check("the assistant's answer text (not just the thought step) is restored", proseCount > 0, "prose blocks: " + proseCount);

  // Recent Sessions: was a dead button before.
  await page.click("#ai-history-btn");
  await page.waitForSelector("#ai-history-menu");
  const items = await page.locator(".claude-history-item").count();
  check("Recent Sessions lists the known sessions", items >= 3, `${items} items`);
  await page.locator(".claude-history-item", { hasText: "Phân trình ký dự án" }).click();
  check("picking a session from history switches to it", (await page.textContent("#ai-ws-pill")).includes("Phân trình ký dự án"));

  // Closing a tab must not erase its history — reopen it from Recent Sessions.
  await page.click('.claude-tab[data-session="workflow"] .tab-close');
  check("closing the tab removes it from the tab bar", await page.locator('.claude-tab[data-session="workflow"]').count() === 0);
  await page.click("#ai-history-btn");
  await page.waitForSelector("#ai-history-menu");
  check("...but it's still listed in Recent Sessions (not deleted)", await page.locator('.claude-history-item[data-session="workflow"]').count() === 1);
  await page.locator('.claude-history-item[data-session="workflow"]').click();
  check("reopening it from history brings the tab back", await page.locator('.claude-tab[data-session="workflow"]').count() === 1);
} catch (e) {
  failed++;
  console.log("FAIL  exception: " + e);
}
console.log("\ndone");
await browser.close(); await srv.stop(); cleanup(srv.dataDir);
process.exit(failed ? 1 : 0);
