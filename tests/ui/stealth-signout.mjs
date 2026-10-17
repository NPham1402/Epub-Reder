// Both stealth readers (/read in the Claude Code pane, Ctrl+Alt+S + Alt+[ ]
// in the status bar) silently did nothing: they read state.current.chapter,
// which was never set. And once /read works, book text lands in the saved
// chat history — so Sign out must wipe localStorage, not just Cache Storage.
import { chromium } from "playwright";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeEpub, startServer, cleanup, PASSCODE } from "../helpers.ts";

const srv = await startServer();
const epubPath = join(tmpdir(), "stealth.epub");
writeFileSync(epubPath, makeEpub("Stealth Book", Array.from({ length: 3 }, (_, i) => ({ title: `Chapter ${i}`, paragraphs: 6, paragraphChars: 120 }))));

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
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
  await page.waitForFunction(() => !!state.current && !!state.current.chapter, null, { timeout: 20000 });

  // Status-bar reader.
  await page.keyboard.press("Control+Alt+s");
  await page.waitForSelector("#st-thief:not([hidden])");
  const first = await page.textContent("#st-thief-text");
  check("status-bar reader shows real chapter text", /^\[1\/\d+\] c1p0/.test(first), first.slice(0, 30));
  await page.keyboard.press("Alt+]");
  const second = await page.textContent("#st-thief-text");
  check("Alt+] moves to the next paragraph", /^\[2\/\d+\] c1p1/.test(second), second.slice(0, 30));

  // /read in the Claude Code pane.
  await page.click("#btn-split-claude");
  await page.waitForSelector(".editorgroup-claude:not([hidden])");
  await page.fill("#ai-prompt-input", "/read");
  await page.click("#ai-send-btn");
  await page.waitForFunction(() => !aiChat.isGenerating, null, { timeout: 15000 });
  const reply = await page.locator(".claude-final-prose").last().textContent();
  check("/read streams the real paragraph text, not the placeholder", reply.includes("Heading 1") && !reply.includes("Dữ liệu cấu hình phân hệ"), reply.slice(0, 80));

  // Book text in a reply is rendered as text, never as markup.
  await page.fill("#ai-prompt-input", "/next");
  await page.click("#ai-send-btn");
  await page.waitForFunction(() => !aiChat.isGenerating, null, { timeout: 15000 });
  const nextReply = await page.locator(".claude-final-prose").last().textContent();
  check("/next moves on to the first paragraph", nextReply.includes("c1p0"), nextReply.slice(0, 80));

  const injected = await page.evaluate(() => { const d = document.createElement("div"); d.innerHTML = aiChat.renderMarkdown('<img src=x onerror="window.__pwned=1">'); return !!d.querySelector("img"); });
  check("chat text that looks like HTML is escaped, not injected", !injected);

  const before = await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith("devdocs.")));
  check("history with book text is in localStorage before sign-out", before.includes("devdocs.aiChatHistory"), before.join(","));

  // Sign out.
  await page.click("#btn-settings");
  await page.click("#btn-logout");
  await page.waitForSelector("#login:not([hidden])", { timeout: 10000 });
  const after = await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith("devdocs.")));
  check("sign-out leaves no devdocs.* keys behind (chat history, tabs, queues)", after.length === 0, after.join(",") || "none");
} catch (e) {
  failed++;
  console.log("FAIL  exception: " + e);
}
console.log("\nconsole problems:", problems.length ? "\n  " + problems.join("\n  ") : "none");
await browser.close(); await srv.stop(); cleanup(srv.dataDir);
process.exit(failed ? 1 : 0);
