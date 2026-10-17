// vBook backup import from the upload modal: preview with a choice per book,
// import, index, and the reader opens the book where vBook left off.
import { chromium } from "playwright";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zstdCompressSync } from "node:zlib";
import { startServer, cleanup, PASSCODE } from "../helpers.ts";

function tar(files) {
  const enc = new TextEncoder(), blocks = [];
  for (const [name, content] of files) {
    const data = enc.encode(content), h = new Uint8Array(512);
    const put = (s, at, len) => h.set(enc.encode(s).subarray(0, len), at);
    put(name, 0, 100); put("0000644\0", 100, 8); put("0000000\0", 108, 8); put("0000000\0", 116, 8);
    put(data.length.toString(8).padStart(11, "0") + "\0", 124, 12); put("00000000000\0", 136, 12);
    put("        ", 148, 8); put("0", 156, 1); put("ustar\0" + "00", 257, 8);
    put(h.reduce((a, b) => a + b, 0).toString(8).padStart(6, "0") + "\0 ", 148, 8);
    blocks.push(h, data, new Uint8Array((512 - (data.length % 512)) % 512));
  }
  blocks.push(new Uint8Array(1024));
  const out = new Uint8Array(blocks.reduce((n, b) => n + b.length, 0));
  let o = 0; for (const b of blocks) { out.set(b, o); o += b.length; }
  return out;
}
function book(id, name, toc, have, read) {
  const f = [
    [`books/${id}/book.json`, JSON.stringify({ id, name: { raw: name }, author: { raw: "A" }, source: "S", last_read_chapter_index: read[0], last_read_chapter_percent: read[1], last_read: 1789000000000, last_read_chapter_name: toc[read[0]] })],
    [`books/${id}/toc_links.json`, JSON.stringify(toc.map((t, i) => ({ title: { raw: t }, position: i })))],
  ];
  for (const p of have) f.push([`books/${id}/contents/${id}_${p}/raw.txt`, `<body>\n ${toc[p]}\n <br>\n <br>\n ${id} para ${p} one\n <br>\n <br>\n ${id} para ${p} two\n</body>`]);
  return f;
}
const toc = Array.from({ length: 30 }, (_, i) => `Chương ${i + 1} - Tên ${i + 1}`);
const backup = zstdCompressSync(tar([
  ["manifest.json", JSON.stringify({ device_name: "phone", backup_version: 1, create_at: 1789000000000 })],
  ...book("keep1", "Kept Book", toc, toc.map((_, i) => i), [12, 0.5]),
  ...book("skip2", "Skipped Book", toc, [0, 1], [0, 0]),
  ...book("none3", "Nothing Downloaded", toc, [], [3, 0]),
]));
const file = join(tmpdir(), "vbook_20261017_120000.tar.zst");
writeFileSync(file, backup);

const srv = await startServer();
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1400, height: 850 } });
const problems = [];
page.on("pageerror", (e) => problems.push("pageerror: " + e));
let failed = 0;
const check = (label, ok, extra = "") => { if (!ok) failed++; console.log(`${ok ? "PASS" : "FAIL"}  ${label}${extra !== "" ? "  -> " + extra : ""}`); };

try {
  await page.goto(srv.base);
  await page.fill("#login-pass", PASSCODE);
  await page.click("#login-form button[type=submit]");
  await page.waitForSelector("#app:not([hidden])");
  await page.click("#btn-upload");
  await page.setInputFiles("#file-input", file);
  await page.waitForSelector(".vb-row", { timeout: 30000 });
  const rows = await page.locator(".vb-row").count();
  check("preview lists every book in the backup", rows === 3, `${rows} rows`);
  const defaults = await page.$$eval(".vb-action", (s) => s.map((x) => x.value));
  check("defaults: import books with text, skip the one with none", JSON.stringify(defaults) === JSON.stringify(["create", "create", "skip"]), defaults.join(","));
  check("a book with nothing downloaded can't be imported", await page.locator(".vb-action").nth(2).isDisabled());
  check("a partly downloaded book is called out", /partly downloaded/.test(await page.textContent("#upload-preview")));
  await page.locator(".vb-action").nth(1).selectOption("skip");
  await page.click("#upload-preview .xp-btn:not(.secondary)");
  await page.waitForFunction(() => /vBook import done/.test(document.querySelector("#upload-status").textContent), null, { timeout: 60000 });
  const summary = await page.textContent("#upload-status");
  check("summary reports what happened", /1 imported/.test(summary) && /2 skipped/.test(summary), summary.trim());
  const books = await page.evaluate(() => state.books.map((b) => ({ t: b.title, n: b.chapter_count, p: b.progress_idx })));
  check("only the chosen book was created, with vBook's full section list", books.length === 1 && books[0].n === 30, JSON.stringify(books));
  check("and vBook's reading position", books[0] && books[0].p === 12);

  // Opening it resumes at vBook's chapter 13 (index 12).
  await page.click('[data-close="upload"]');
  await page.click(".tree-book > .tree-row");
  await page.waitForFunction(() => state.current && state.current.idx === 12, null, { timeout: 20000 });
  check("opening the book resumes where vBook left off", (await page.evaluate(() => state.current.idx)) === 12);
  await page.waitForSelector(".monaco-editor .view-line", { timeout: 20000 });
  const text = await page.evaluate(() => monaco.editor.getEditors()[0].getModel().getValue());
  check("the chapter text is vBook's", text.includes("keep1 para 12 one"));

  // Sync & Backup: the vBook card.
  await page.click('.ab-icon[data-view="extensions"]');
  await page.locator("#ext-list .ext-item", { hasText: "Sync & Backup" }).click();
  await page.waitForSelector("#vbook-positions", { timeout: 10000 });
  const card = await page.textContent("#vbook-card");
  check("Sync & Backup shows how many modules came from vBook", /1 module came from a vBook backup/.test(card), card.slice(0, 70));
  check("WebDAV is reported off when no password is set", /WebDAV for vBook is off/.test(card));
  check("positions download is offered once a vBook module has a position", (await page.getAttribute("#vbook-positions", "href")) === "/api/vbook/progress-backup");
  const dl = await page.request.get(srv.base + "/api/vbook/progress-backup");
  check("and downloads a vbook_*.tar.zst", dl.status() === 200 && /vbook_\d{8}_\d{6}\.tar\.zst/.test(dl.headers()["content-disposition"] || ""), dl.headers()["content-disposition"]);
} catch (e) {
  failed++;
  console.log("FAIL  exception: " + e);
}
console.log("\nconsole problems:", problems.length ? "\n  " + problems.join("\n  ") : "none");
await browser.close(); await srv.stop(); cleanup(srv.dataDir);
process.exit(failed ? 1 : 0);
