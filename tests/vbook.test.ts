// vBook backup import (EPR-19): a synthetic backup with the same layout as a
// real one (§13.2) — tar of books/<id>/{book.json,toc_links.json,contents/...},
// zstd-compressed — goes through the real part-by-part upload and the job API.

import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { zstdCompressSync } from "node:zlib";
import { api, cleanup, ingestAll, login, makeEpub, startServer, upload, type TestServer } from "./helpers.ts";
import { putPart, startUpload } from "./upload-helpers.ts";
import { chapterParagraphs, findParagraph, readVbookBackup, sessionBuckets, tarEntries } from "../src/vbook.ts";

// ---- a tiny ustar writer -------------------------------------------------------
function tar(files: [string, string | Uint8Array][]): Uint8Array {
  const blocks: Uint8Array[] = [];
  const enc = new TextEncoder();
  for (const [name, content] of files) {
    const data = typeof content === "string" ? enc.encode(content) : content;
    const h = new Uint8Array(512);
    const put = (s: string, at: number, len: number) => h.set(enc.encode(s).subarray(0, len), at);
    let path = name, prefix = "";
    if (enc.encode(path).length > 100) { const cut = path.lastIndexOf("/", 154); prefix = path.slice(0, cut); path = path.slice(cut + 1); }
    put(path, 0, 100);
    put("0000644\0", 100, 8); put("0000000\0", 108, 8); put("0000000\0", 116, 8);
    put(data.length.toString(8).padStart(11, "0") + "\0", 124, 12);
    put("00000000000\0", 136, 12);
    put("        ", 148, 8);
    put("0", 156, 1);
    put("ustar\0" + "00", 257, 8);
    put(prefix, 345, 155);
    const sum = h.reduce((a, b) => a + b, 0);
    put(sum.toString(8).padStart(6, "0") + "\0 ", 148, 8);
    blocks.push(h, data, new Uint8Array((512 - (data.length % 512)) % 512));
  }
  blocks.push(new Uint8Array(1024));
  const out = new Uint8Array(blocks.reduce((n, b) => n + b.length, 0));
  let o = 0;
  for (const b of blocks) { out.set(b, o); o += b.length; }
  return out;
}

const chapterHtml = (title: string, paras: string[]) =>
  `<body>\n ${title.replace(" - ", ": ")}\n <br>\n <br>\n ${paras.join("\n <br>\n <br>\n ")}\n</body>`;

interface FakeBook { id: string; name: string; author: string; toc: string[]; have: number[]; read?: [number, number, number, string?]; marks?: Record<string, unknown>[] }
function fakeBook(b: FakeBook): [string, string][] {
  const read = b.read ?? [0, 0, 0];
  const files: [string, string][] = [
    [`books/${b.id}/book.json`, JSON.stringify({
      id: b.id, name: { raw: b.name }, author: { raw: b.author }, language: "vi_VN", source: "Test Source",
      description: { raw: "long text that must not be stored" },
      last_read_chapter_index: read[0], last_read_chapter_percent: read[1], last_read: read[2],
      last_read_chapter_name: read[3] ?? b.toc[read[0]], total_chapter: b.toc.length,
    })],
    [`books/${b.id}/toc_links.json`, JSON.stringify(b.toc.map((t, i) => ({ id: `${b.id}_${i}`, title: { raw: t }, position: i })))],
    [`books/${b.id}/bookmarks.json`, JSON.stringify(b.marks ?? [])],
  ];
  for (const pos of b.have) {
    files.push([`books/${b.id}/contents/${b.id}_${pos}/raw.txt`, chapterHtml(b.toc[pos], [`${b.id}-p${pos}-a &amp; <i>nghiêng</i>`, `${b.id}-p${pos}-b`])]);
  }
  return files;
}

const T = 1_789_000_000_000;
const FULL: FakeBook = { id: "aaa111", name: "Trạch Nhật Phi Thăng", author: "Trạch Trư", toc: ["Chương 1 - Mở đầu", "Chương 2 - Nộ phạm", "Chương 3 - Kết"], have: [0, 1, 2], read: [1, 0.5, T] };
const PARTIAL: FakeBook = { id: "bbb222", name: "Đại Chúa Tể", author: "Thiên Tàm Thổ Đậu", toc: ["C1", "C2", "C3", "C4"], have: [0, 2], read: [2, 0.25, T] };
const NONE: FakeBook = { id: "ccc333", name: "Văn Phòng Ẩn Hôn", author: "Khinh Ảm", toc: ["Chương 1"], have: [] };
const OWNED: FakeBook = { id: "ddd444", name: "Owned Book", author: "Test Author", toc: ["Intro", "Chapter 1", "Chapter 2", "Chapter 3"], have: [], read: [2, 0.4, T, "Chapter 2"] };

function backup(books: FakeBook[], pad = 0, histories: { id: string; read_time: number; create_at: number }[] = []): Uint8Array {
  const files: [string, string | Uint8Array][] = [["manifest.json", JSON.stringify({ device_name: "test phone", backup_version: 1, create_at: T })]];
  if (histories.length) files.push(["read_histories.json", JSON.stringify(histories.map((h) => ({ ...h, listen_time: 0 })))]);
  for (const b of books) files.push(...fakeBook(b));
  // Incompressible filler outside books/ so the upload spans several parts.
  if (pad) files.push(["pad.bin", new Uint8Array(randomBytes(pad))]);
  return zstdCompressSync(tar(files));
}

async function sendBackup(base: string, cookie: string, bytes: Uint8Array, name = "vbook_20260921_083231.tar.zst"): Promise<string> {
  const { res, body } = await startUpload(base, cookie, bytes.length, name);
  assert.equal(res.status, 200, JSON.stringify(body));
  for (let n = 0; n < body.parts!; n++) {
    const r = await putPart(base, cookie, body.id!, n, bytes.slice(n * body.part_size!, (n + 1) * body.part_size!));
    assert.equal(r.status, 200);
  }
  return body.id!;
}

interface Job { state: string; error: string | null; device: string | null; items: { vbook_id: string; action: string; options: string[]; outcome?: string; match: { id: string; by: string } | null; downloaded: number; chapters: number }[]; ingest: { id: string; total: number }[] }
async function runJob(base: string, cookie: string, uploadId: string, mode: string, actions: Record<string, string> = {}): Promise<Job> {
  const res = await api(base, cookie, `/api/uploads/${uploadId}/vbook`, {
    method: "POST", body: JSON.stringify({ mode, actions }), headers: { "content-type": "application/json" },
  });
  const { job, error } = await res.json() as { job?: string; error?: string };
  assert.equal(res.status, 200, error ?? "");
  for (let i = 0; i < 200; i++) {
    const j = await (await api(base, cookie, `/api/vbook-jobs/${job}`)).json() as Job;
    if (j.state !== "running") return j;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("job did not finish");
}
const item = (j: Job, id: string) => j.items.find((i) => i.vbook_id === id)!;
const progressOf = async (base: string, cookie: string, id: string) =>
  ((await (await api(base, cookie, `/api/books/${id}/index`)).json()) as { progress: { chapter_idx: number; scroll_ratio: number; furthest_idx: number } }).progress;

describe("vBook backup reading (unit)", () => {
  test("tar stream: entries come back whole across arbitrary chunk boundaries, long names included", async () => {
    const longName = `books/${"x".repeat(60)}/contents/${"y".repeat(60)}_7/raw.txt`;
    const bytes = tar([["a.txt", "hello"], [longName, "x".repeat(1500)]]);
    async function* chunks() { for (let i = 0; i < bytes.length; i += 333) yield bytes.subarray(i, i + 333); }
    const got: [string, number][] = [];
    for await (const e of tarEntries(chunks())) got.push([e.name, e.data.length]);
    assert.deepEqual(got, [["a.txt", 5], [longName, 1500]]);
  });

  test("chapter HTML becomes paragraphs; the repeated title line is dropped; entities decoded", () => {
    const paras = chapterParagraphs(chapterHtml("Chương 2 - Nộ phạm", ["a &amp; b <i>c</i>", "d"]), "Chương 2 - Nộ phạm");
    assert.deepEqual(paras, ["a & b c", "d"]);
  });

  test("a reading session is spread over the local clock hours it covers", () => {
    // 2026-10-17 01:50 UTC = 08:50 in UTC+7; 25 minutes -> 10 min in hour 8, 15 in hour 9.
    const start = Date.UTC(2026, 9, 17, 1, 50, 0);
    assert.deepEqual(sessionBuckets(start, 25 * 60, -420), [
      { day: "2026-10-17", hour: 8, seconds: 600 },
      { day: "2026-10-17", hour: 9, seconds: 900 },
    ]);
    // Crossing local midnight changes the day.
    assert.deepEqual(sessionBuckets(Date.UTC(2026, 9, 17, 16, 59, 0), 120, -420).map((b) => [b.day, b.hour, b.seconds]),
      [["2026-10-17", 23, 60], ["2026-10-18", 0, 60]]);
  });

  test("preview pass counts chapters without keeping their text", async () => {
    async function* one() { yield tar(fakeBook(PARTIAL)); }
    const seen: { downloaded: number; toc: number; kept: number }[] = [];
    await readVbookBackup(one(), async (b) => { seen.push({ downloaded: b.downloaded, toc: b.toc.length, kept: b.contents.size }); }, { withContent: false });
    assert.deepEqual(seen, [{ downloaded: 2, toc: 4, kept: 0 }]);
  });
});

describe("vBook backup import (server)", () => {
  let srv: TestServer;
  let cookie: string;
  let ownedId: string;

  before(async () => {
    srv = await startServer();
    cookie = await login(srv.base);
    // A copy of OWNED that came from somewhere else (not vBook): matched by title.
    const r = await upload(srv.base, cookie, makeEpub("Owned Book", OWNED.toc.map((t) => ({ title: t, paragraphs: 3, paragraphChars: 50 }))));
    ownedId = r.body.id!;
    await ingestAll(srv.base, cookie, ownedId);
  });
  after(async () => { await srv.stop(); cleanup(srv.dataDir); });

  test("a backup is not mistaken for an EPUB", async () => {
    const id = await sendBackup(srv.base, cookie, backup([NONE]));
    const res = await api(srv.base, cookie, `/api/uploads/${id}/complete`, { method: "POST" });
    assert.equal(res.status, 400);
  });

  test("preview: one row per book with the right default action, nothing created yet", async () => {
    const id = await sendBackup(srv.base, cookie, backup([FULL, PARTIAL, NONE, OWNED], 600_000));
    const j = await runJob(srv.base, cookie, id, "preview");
    assert.equal(j.state, "done", j.error ?? "");
    assert.equal(j.device, "test phone");
    assert.equal(item(j, FULL.id).action, "create");
    assert.equal(item(j, PARTIAL.id).action, "create");
    assert.deepEqual([item(j, PARTIAL.id).downloaded, item(j, PARTIAL.id).chapters], [2, 4]);
    assert.equal(item(j, NONE.id).action, "skip", "no downloaded text: cannot become a readable book");
    assert.deepEqual(item(j, NONE.id).options, ["skip"]);
    assert.equal(item(j, OWNED.id).action, "progress");
    assert.equal(item(j, OWNED.id).match?.by, "title");
    const books = (await (await api(srv.base, cookie, "/api/books")).json()) as { books: unknown[] };
    assert.equal(books.books.length, 1, "preview creates nothing");

    // Import with the defaults, from the same upload (no second upload).
    const imp = await runJob(srv.base, cookie, id, "import");
    assert.equal(imp.state, "done", imp.error ?? "");
    assert.equal(imp.ingest.length, 2);
    for (const b of imp.ingest) await ingestAll(srv.base, cookie, b.id);

    const full = item(imp, FULL.id).match!.id;
    const partial = item(imp, PARTIAL.id).match!.id;
    const idx = (await (await api(srv.base, cookie, `/api/books/${partial}/index`)).json()) as { chapters: { idx: number }[] };
    assert.equal(idx.chapters.length, 4, "every chapter of vBook's list, so chapter numbers line up");
    const ch = async (book: string, n: number) =>
      ((await (await api(srv.base, cookie, `/api/books/${book}/chapters/${n}`)).json()) as { blocks: { text: string }[] }).blocks.map((b) => b.text);
    assert.ok((await ch(partial, 2)).includes(`${PARTIAL.id}-p2-a & nghiêng`), "downloaded chapter has its text");
    assert.ok((await ch(partial, 1)).some((t) => /not been downloaded/.test(t)), "missing chapter is a placeholder");
    assert.equal((await ch(full, 1)).filter((t) => /Nộ phạm/.test(t)).length, 1, "the title appears once (as the heading), not again as a paragraph");

    assert.deepEqual(await progressOf(srv.base, cookie, full).then((p) => [p.chapter_idx, p.scroll_ratio]), [1, 0.5]);
    assert.equal((await progressOf(srv.base, cookie, partial)).chapter_idx, 2);
    assert.equal((await progressOf(srv.base, cookie, ownedId)).chapter_idx, 2, "mapped by chapter title, not raw number");
    assert.match(item(imp, NONE.id).outcome ?? "", /skipped/);

    const after = await api(srv.base, cookie, `/api/uploads/${id}/vbook`, { method: "POST", body: "{}", headers: { "content-type": "application/json" } });
    assert.equal(after.status, 404, "the upload is cleaned up after an import");
  });

  test("importing a newer backup again: no duplicates, progress moves forward but never back", async () => {
    const newer: FakeBook = { ...FULL, read: [2, 0.1, T + 1000] };
    const id = await sendBackup(srv.base, cookie, backup([newer, PARTIAL]));
    const j = await runJob(srv.base, cookie, id, "import");
    assert.equal(j.state, "done", j.error ?? "");
    assert.equal(item(j, FULL.id).match?.by, "vbook");
    assert.equal(item(j, FULL.id).action, "progress");
    assert.ok(!item(j, FULL.id).options.includes("create"), "a book already imported from vBook is never duplicated");
    const books = (await (await api(srv.base, cookie, "/api/books")).json()) as { books: unknown[] };
    assert.equal(books.books.length, 3);
    const fullId = item(j, FULL.id).match!.id;
    assert.equal((await progressOf(srv.base, cookie, fullId)).chapter_idx, 2);

    // An older backup must not drag "furthest read" backwards.
    const older: FakeBook = { ...FULL, read: [0, 0, T - 5000] };
    const id2 = await sendBackup(srv.base, cookie, backup([older]));
    await runJob(srv.base, cookie, id2, "import");
    const p = await progressOf(srv.base, cookie, fullId);
    assert.equal(p.furthest_idx, 2);
    assert.equal(p.chapter_idx, 2, "the newer position (by vBook's own clock) wins");
  });

  test("downloaded more in vBook (and the novel grew): content refreshed in place, nothing else lost", async () => {
    const list = (await (await api(srv.base, cookie, "/api/books")).json()) as { books: { id: string; title: string }[] };
    const partialId = list.books.find((b) => b.title === PARTIAL.name)!.id;
    await api(srv.base, cookie, `/api/books/${partialId}/bookmarks`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ chapter_idx: 0, p: 0, snippet: "x" }),
    });
    const grown: FakeBook = { ...PARTIAL, toc: [...PARTIAL.toc, "C5"], have: [0, 1, 2, 3, 4], read: [4, 0.3, T + 5000] };
    const id = await sendBackup(srv.base, cookie, backup([grown]));
    const pre = await runJob(srv.base, cookie, id, "preview");
    assert.equal(item(pre, PARTIAL.id).action, "update");
    assert.deepEqual(item(pre, PARTIAL.id).options, ["update", "progress", "skip"]);
    const imp = await runJob(srv.base, cookie, id, "import");
    assert.equal(imp.ingest.length, 1);
    assert.equal(imp.ingest[0].id, partialId, "same book, not a new one");
    await ingestAll(srv.base, cookie, partialId);
    const idx = (await (await api(srv.base, cookie, `/api/books/${partialId}/index`)).json()) as { chapters: unknown[]; progress: { chapter_idx: number } };
    assert.equal(idx.chapters.length, 5);
    assert.equal(idx.progress.chapter_idx, 4);
    const ch1 = ((await (await api(srv.base, cookie, `/api/books/${partialId}/chapters/1`)).json()) as { blocks: { text: string }[] }).blocks.map((b) => b.text);
    assert.ok(ch1.includes(`${PARTIAL.id}-p1-b`), "a chapter that was a placeholder now has its text");
    const bms = (await (await api(srv.base, cookie, "/api/bookmarks")).json()) as { bookmarks: { book_id: string }[] };
    assert.equal(bms.bookmarks.filter((b) => b.book_id === partialId).length, 1, "bookmarks survive");

    // Same backup again: nothing new, so only the position is touched.
    const id2 = await sendBackup(srv.base, cookie, backup([grown]));
    assert.equal(item(await runJob(srv.base, cookie, id2, "preview"), PARTIAL.id).action, "progress");
    await api(srv.base, cookie, `/api/uploads/${id2}`, { method: "DELETE" });
  });

  test("the reader's choice overrides the default", async () => {
    const other: FakeBook = { ...FULL, id: "eee555", name: "Another Book" };
    const id = await sendBackup(srv.base, cookie, backup([other]));
    const j = await runJob(srv.base, cookie, id, "import", { [other.id]: "skip" });
    assert.equal(item(j, other.id).action, "skip");
    assert.equal(j.ingest.length, 0);
  });
});

// ---- EPR-20: read-only WebDAV for vBook; EPR-21: positions back to vBook --------
import { zstdDecompressSync } from "node:zlib";
import { parseEpubMeta } from "../src/epub.ts";

describe("WebDAV for vBook + positions back to vBook", () => {
  let srv: TestServer;
  let cookie: string;
  const DAV = "dav-secret-pw";
  const basic = (pw: string) => ({ authorization: "Basic " + Buffer.from(`vbook:${pw}`).toString("base64") });
  const dav = (path: string, init: RequestInit = {}) => fetch(srv.base + path, init);
  const propfind = (path: string, depth = "1", pw = DAV) => dav(path, { method: "PROPFIND", headers: { depth, ...basic(pw) } });
  let bookId: string;

  before(async () => {
    srv = await startServer({ env: { DAV_PASSWORD: DAV } });
    cookie = await login(srv.base);
    const id = await sendBackup(srv.base, cookie, backup([FULL]));
    const j = await runJob(srv.base, cookie, id, "import");
    bookId = j.ingest[0].id;
    await ingestAll(srv.base, cookie, bookId);
  });
  after(async () => { await srv.stop(); cleanup(srv.dataDir); });

  test("no password / wrong password: 401 with a Basic challenge; nothing listed", async () => {
    const none = await dav("/dav/", { method: "PROPFIND", headers: { depth: "1" } });
    assert.equal(none.status, 401);
    assert.match(none.headers.get("www-authenticate") ?? "", /^Basic/);
    assert.equal((await propfind("/dav/", "1", "wrong")).status, 401);
    // The reader passcode is not the WebDAV password.
    assert.equal((await propfind("/dav/", "1", "correct horse battery staple")).status, 401);
  });

  test("lists every finished book as an .epub, plus the positions backup", async () => {
    const res = await propfind("/dav/");
    assert.equal(res.status, 207);
    const xml = await res.text();
    assert.match(xml, /<d:href>\/dav\/<\/d:href>/);
    assert.match(xml, new RegExp(`<d:href>/dav/${encodeURIComponent("Trạch Nhật Phi Thăng.epub")}</d:href>`));
    assert.ok(!/vbook_\d{8}_\d{6}\.tar\.zst/.test(xml), "right after an import vBook already has this position: nothing to send back");
    await api(srv.base, cookie, `/api/books/${bookId}/progress`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ chapter_idx: 2, scroll_ratio: 0.1, client_ts: T + 50_000 }),
    });
    const backupName = (await (await propfind("/dav/")).text()).match(/vbook_\d{8}_\d{6}\.tar\.zst/)?.[0];
    assert.ok(backupName, "read further here: the positions backup is listed");
    const again = await (await propfind("/dav/")).text();
    assert.ok(again.includes(backupName!), "same name on the next listing (vBook lists, then downloads)");
    const depth0 = await (await propfind("/dav/", "0")).text();
    assert.ok(!depth0.includes(".epub"), "Depth: 0 is the folder only");
  });

  test("GET returns a real EPUB of the book; afterwards its size is listed", async () => {
    const path = `/dav/${encodeURIComponent("Trạch Nhật Phi Thăng.epub")}`;
    const res = await dav(path, { headers: basic(DAV) });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "application/epub+zip");
    assert.match(res.headers.get("cache-control") ?? "", /no-store/);
    const meta = parseEpubMeta(new Uint8Array(await res.arrayBuffer()));
    assert.equal(meta.title, "Trạch Nhật Phi Thăng");
    assert.equal(meta.spine.length, FULL.toc.length);
    const xml = await (await propfind("/dav/")).text();
    assert.match(xml, /<d:getcontentlength>\d+<\/d:getcontentlength>/);
    assert.equal((await dav(path, { method: "HEAD", headers: basic(DAV) })).status, 200);
  });

  test("read-only: writes are refused", async () => {
    for (const method of ["PUT", "DELETE", "MKCOL", "MOVE", "PROPPATCH"]) {
      const r = await dav("/dav/x.epub", { method, headers: basic(DAV), body: method === "PUT" ? "x" : undefined });
      assert.equal(r.status, 405, method);
    }
  });

  test("vBook sync backup: the vbook_backup folder is writable, nothing else is", async () => {
    const B = "/dav/vbook_backup";
    const h = basic(DAV);
    // the exact opening sequence vBook sent (from the request log): HEAD, MKCOL, PROPFIND
    assert.equal((await dav(B, { method: "HEAD", headers: h })).status, 200);
    assert.equal((await dav(B + "/", { method: "MKCOL", headers: h })).status, 201);
    assert.equal((await dav(B + "/", { method: "MKCOL", headers: h })).status, 201, "idempotent");
    const empty = await dav(B + "/", { method: "PROPFIND", headers: { depth: "1", ...h } });
    assert.equal(empty.status, 207);
    const body = Buffer.from("not really zstd but opaque bytes ".repeat(50));
    const put = (name: string, extra: Record<string, string> = {}, data: Buffer | string = body) =>
      dav(`${B}/${name}`, { method: "PUT", headers: { ...h, ...extra }, body: data });
    assert.equal((await put("backup.tar.zst")).status, 201);
    assert.equal((await put("backup.tar.zst")).status, 204, "overwrite");
    assert.equal((await put("backup.tar.zst", { "if-none-match": "*" })).status, 412);
    const xml = await (await dav(B + "/", { method: "PROPFIND", headers: { depth: "1", ...h } })).text();
    assert.match(xml, /<d:href>\/dav\/vbook_backup\/backup\.tar\.zst<\/d:href>/);
    assert.equal((xml.match(/backup\.tar\.zst<\/d:href>/g) ?? []).length, 1, "overwrite leaves one file");
    assert.match(xml, new RegExp(`<d:getcontentlength>${body.length}</d:getcontentlength>`));
    const got = await dav(`${B}/backup.tar.zst`, { headers: h });
    assert.equal(got.status, 200);
    assert.deepEqual(Buffer.from(await got.arrayBuffer()), body);
    assert.equal((await dav(`${B}/backup.tar.zst`, { method: "HEAD", headers: h })).status, 200);
    // only backup-shaped names, one folder deep, never without the password
    assert.equal((await put("evil.html")).status, 404);
    assert.equal((await put("..%2Fx.tar.zst")).status, 404);
    assert.equal((await dav(`${B}/sub/a.tar.zst`, { method: "PUT", headers: h, body: "x" })).status, 404);
    assert.equal((await put("empty.tar.zst", {}, "")).status, 400);
    assert.equal((await dav(`${B}/anon.tar.zst`, { method: "PUT", body: "x" })).status, 401);
    assert.equal((await dav(`${B}/backup.tar.zst`, { method: "MOVE", headers: h })).status, 405);
    // the books root is still read-only
    assert.equal((await dav("/dav/new.tar.zst", { method: "PUT", headers: h, body: "x" })).status, 405);
    // only the newest few are kept
    for (let i = 0; i < 12; i++) assert.equal((await put(`vbook_20260101_0000${String(i).padStart(2, "0")}.tar.zst`)).status, 201);
    const listed = await (await dav(B + "/", { method: "PROPFIND", headers: { depth: "1", ...h } })).text();
    assert.ok((listed.match(/<d:href>\/dav\/vbook_backup\/[^<]+<\/d:href>/g) ?? []).length <= 8 + 1, "pruned");
    assert.match(listed, /vbook_20260101_000011\.tar\.zst/);
    assert.doesNotMatch(listed, /vbook_20260101_000000\.tar\.zst/);
    // delete
    assert.equal((await dav(`${B}/vbook_20260101_000011.tar.zst`, { method: "DELETE", headers: h })).status, 204);
    assert.equal((await dav(`${B}/vbook_20260101_000011.tar.zst`, { method: "DELETE", headers: h })).status, 404);
  });

  test("the web app can list and download what's on the share, without the WebDAV password", async () => {
    const h = basic(DAV);
    const body = Buffer.from("backup bytes ".repeat(40));
    assert.equal((await dav("/dav/vbook_backup/dl_test.tar.zst", { method: "PUT", headers: h, body })).status, 201);
    assert.equal((await fetch(srv.base + "/api/dav/files")).status, 401, "needs a session");
    const { files } = (await (await api(srv.base, cookie, "/api/dav/files")).json()) as { files: { path: string; label: string; kind: string }[] };
    assert.ok(files.some((f) => f.kind === "book" && /\.epub$/.test(f.path)), "a book is listed");
    assert.ok(!files.some((f) => f.kind === "book" && f.label.includes("Trạch")), "books are labelled by code name");
    const bk = files.find((f) => f.path === "vbook_backup/dl_test.tar.zst");
    assert.ok(bk, "the uploaded backup is listed");
    const got = await api(srv.base, cookie, "/api/dav/download?path=" + encodeURIComponent(bk!.path));
    assert.equal(got.status, 200);
    assert.match(got.headers.get("content-disposition") ?? "", /attachment; filename="dl_test\.tar\.zst"/);
    assert.deepEqual(Buffer.from(await got.arrayBuffer()), body);
    const book = files.find((f) => f.kind === "book")!;
    const epub = await api(srv.base, cookie, "/api/dav/download?path=" + encodeURIComponent(book.path));
    assert.equal(epub.status, 200);
    assert.equal(Buffer.from(await epub.arrayBuffer()).subarray(0, 2).toString(), "PK");
    assert.equal((await api(srv.base, cookie, "/api/dav/download?path=" + encodeURIComponent("../etc/passwd"))).status, 404);
    assert.equal((await api(srv.base, cookie, "/api/dav/download?path=" + encodeURIComponent("vbook_backup/nope.tar.zst"))).status, 404);
    await dav("/dav/vbook_backup/dl_test.tar.zst", { method: "DELETE", headers: h });
  });

  test("positions backup carries this app's position in vBook's own book record", async () => {
    await api(srv.base, cookie, `/api/books/${bookId}/progress`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ chapter_idx: 2, scroll_ratio: 0.75, client_ts: T + 99_000 }),
    });
    const res = await api(srv.base, cookie, "/api/vbook/progress-backup");
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-disposition") ?? "", /vbook_\d{8}_\d{6}\.tar\.zst/);
    const files = new Map<string, string>();
    async function* one() { yield new Uint8Array(zstdDecompressSync(new Uint8Array(await res.arrayBuffer()))); }
    for await (const e of tarEntries(one())) files.set(e.name, new TextDecoder().decode(e.data));
    assert.deepEqual([...files.keys()].sort(), ["books/aaa111/book.json", "manifest.json"]);
    const rec = JSON.parse(files.get("books/aaa111/book.json")!);
    assert.equal(rec.id, FULL.id);
    assert.equal(rec.last_read_chapter_index, 2);
    assert.equal(rec.last_read_chapter_id, "aaa111_2");
    assert.equal(rec.last_read_chapter_percent, 0.75);
    assert.equal(rec.last_read, T + 99_000);
    assert.equal(rec.last_read_chapter_name, FULL.toc[2]);
    assert.equal(rec.name.raw, FULL.name, "vBook's other fields are kept as they were");
    assert.equal(rec.description, undefined);
    assert.equal(JSON.parse(files.get("manifest.json")!).backup_version, 1);
  });

  test("talks the way vBook's own WebDAV client does (webdav-jvm: DEPTH header, allprop body, namespaced XML)", async () => {
    // Requests shaped like vBook's PropFindCommand; replies read with a
    // namespace-aware XML parse, the way its MultiStatusReader (ksoup) does.
    const ALLPROP = `<d:propfind xmlns:d="DAV:">\n  <d:allprop/>\n</d:propfind>`;
    const auth = { authorization: "Basic " + Buffer.from(`phone-user:${DAV}`).toString("base64") };
    const propfind = (url: string, depth: string) =>
      fetch(url, { method: "PROPFIND", headers: { DEPTH: depth, "Content-Type": "application/xml; charset=UTF-8", ...auth }, body: ALLPROP });
    type Res = { href: string; props: Record<string, string>; collection: boolean; status: string };
    const parse = (xml: string): Res[] => {
      // Resolve prefixes from xmlns declarations instead of assuming "d:".
      const ns = new Map<string, string>();
      for (const m of xml.matchAll(/xmlns:(\w+)="([^"]+)"/g)) ns.set(m[1], m[2]);
      const dav = [...ns].find(([, uri]) => uri === "DAV:")?.[0];
      assert.ok(dav, "DAV: namespace declared");
      const tag = (t: string) => new RegExp(`<${dav}:${t}>([\\s\\S]*?)</${dav}:${t}>`, "g");
      return [...xml.matchAll(tag("response"))].map(([, r]) => {
        const props: Record<string, string> = {};
        for (const p of ["displayname", "getcontentlength", "getcontenttype", "getlastmodified", "getetag"]) {
          const m = r.match(new RegExp(`<${dav}:${p}>([^<]*)</${dav}:${p}>`));
          if (m) props[p] = m[1];
        }
        return {
          href: r.match(new RegExp(`<${dav}:href>([^<]*)</${dav}:href>`))![1],
          props,
          collection: new RegExp(`<${dav}:collection/>`).test(r),
          status: r.match(new RegExp(`<${dav}:status>([^<]*)</${dav}:status>`))![1],
        };
      });
    };

    // vBook asks for the folder the user typed — with or without the slash.
    for (const base of [`${srv.base}/dav/`, `${srv.base}/dav`]) {
      const res = await propfind(base, "1");
      assert.equal(res.status, 207, base);
      const items = parse(await res.text());
      assert.ok(items.every((i) => /^HTTP\/1\.1 200/.test(i.status)));
      const folder = items.find((i) => i.collection)!;
      assert.equal(folder.href, "/dav/");
      const book = items.find((i) => i.props.getcontenttype === "application/epub+zip")!;
      assert.ok(book, "a book is listed");
      assert.equal(book.props.displayname, "Trạch Nhật Phi Thăng.epub");
      assert.ok(!Number.isNaN(Date.parse(book.props.getlastmodified)));

      // It then downloads from the href it was given, resolved against the server.
      const url = new URL(book.href, base).toString();
      const one = parse(await (await propfind(url, "0")).text());
      assert.equal(one.length, 1, "a resource's PROPFIND yields exactly one href (vBook rejects more)");
      const get = await fetch(url, { headers: auth });
      assert.equal(get.status, 200);
      const bytes = new Uint8Array(await get.arrayBuffer());
      assert.equal(String(bytes.length), one[0].props.getcontentlength, "listed length matches the download");
      assert.equal(parseEpubMeta(bytes).title, "Trạch Nhật Phi Thăng");
    }
    // DEPTH: infinity on a flat folder is just the listing.
    assert.equal((await propfind(`${srv.base}/dav/`, "infinity")).status, 207);
  });

  test("a book read further on the phone since is never sent back (merge would drag vBook backwards)", async () => {
    // vBook's newest backup: read on the phone after our position.
    const phoneAhead: FakeBook = { ...FULL, read: [2, 0.9, T + 500_000] };
    const id = await sendBackup(srv.base, cookie, backup([phoneAhead]));
    const j = await runJob(srv.base, cookie, id, "import");
    assert.equal(item(j, FULL.id).action, "progress");
    assert.equal((await api(srv.base, cookie, "/api/vbook/progress-backup")).status, 404);
    const st = (await (await api(srv.base, cookie, "/api/vbook/status")).json()) as { positions: number };
    assert.equal(st.positions, 0);
    // Reading on here again puts it back in.
    await api(srv.base, cookie, `/api/books/${bookId}/progress`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ chapter_idx: 2, scroll_ratio: 0.95, client_ts: T + 600_000 }),
    });
    assert.equal((await api(srv.base, cookie, "/api/vbook/progress-backup")).status, 200);
  });

  test("deleting a book removes its cached .epub", async () => {
    await api(srv.base, cookie, `/api/books/${bookId}`, { method: "DELETE" });
    const xml = await (await propfind("/dav/")).text();
    assert.ok(!xml.includes(".epub"));
    assert.equal((await dav(`/dav/${encodeURIComponent("Trạch Nhật Phi Thăng.epub")}`, { headers: basic(DAV) })).status, 404);
  });

  test("repeated wrong passwords are throttled", async () => {
    let last = 0;
    for (let i = 0; i < 12; i++) last = (await propfind("/dav/", "1", "nope" + i)).status;
    assert.equal(last, 429);
  });
});

describe("WebDAV is off without DAV_PASSWORD", () => {
  test("404", async () => {
    const srv = await startServer();
    try { assert.equal((await fetch(srv.base + "/dav/", { method: "PROPFIND" })).status, 404); }
    finally { await srv.stop(); cleanup(srv.dataDir); }
  });
});

describe("vBook reading time -> Activity Insights", () => {
  let srv: TestServer;
  let cookie: string;
  const day = Date.UTC(2026, 9, 10, 2, 0, 0); // 09:00 in UTC+7
  const H = [
    { id: "s1", read_time: 30 * 60_000, create_at: day },
    { id: "s2", read_time: 10 * 60_000, create_at: day + 2 * 3_600_000 },
  ];
  const stats = async () => (await (await api(srv.base, cookie, "/api/stats?days=732")).json()) as { daily: { day: string; seconds: number }[]; per_book: { book_id: string; seconds: number }[] };
  interface HJob { state: string; history: { sessions: number; fresh: number; fresh_seconds: number; added: number } }
  const job = async (mode: string, extra: Record<string, unknown>, hist = H): Promise<HJob> => {
    const id = await sendBackup(srv.base, cookie, backup([NONE], 0, hist));
    const res = await api(srv.base, cookie, `/api/uploads/${id}/vbook`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode, ...extra }) });
    const { job: jid } = (await res.json()) as { job: string };
    for (;;) {
      const j = (await (await api(srv.base, cookie, `/api/vbook-jobs/${jid}`)).json()) as HJob;
      if (j.state !== "running") {
        if (mode === "preview") await api(srv.base, cookie, `/api/uploads/${id}`, { method: "DELETE" });
        return j;
      }
      await new Promise((r) => setTimeout(r, 40));
    }
  };

  before(async () => { srv = await startServer(); cookie = await login(srv.base); });
  after(async () => { await srv.stop(); cleanup(srv.dataDir); });

  test("preview counts the sessions not added yet", async () => {
    const j = await job("preview", {});
    assert.deepEqual(j.history, { sessions: 2, fresh: 2, fresh_seconds: 2400, added: 0 });
  });

  test("unticked: nothing is added", async () => {
    await job("import", { history: false, tz_offset: -420 });
    assert.equal((await stats()).daily.length, 0);
  });

  test("import adds them on the reader's local day, under vBook", async () => {
    const j = await job("import", { history: true, tz_offset: -420 });
    assert.equal(j.history.added, 2);
    const s = await stats();
    assert.deepEqual(s.daily, [{ day: "2026-10-10", seconds: 2400 }]);
    assert.deepEqual(s.per_book, [{ book_id: "vbook", seconds: 2400 }]);
  });

  test("a newer backup with the same sessions plus one more adds only the new one", async () => {
    const more = [...H, { id: "s3", read_time: 5 * 60_000, create_at: day + 26 * 3_600_000 }];
    assert.equal((await job("preview", {}, more)).history.fresh, 1);
    await job("import", { history: true, tz_offset: -420 }, more);
    const s = await stats();
    assert.equal(s.daily.reduce((a, d) => a + d.seconds, 0), 2700);
    assert.equal(s.daily.length, 2);
  });
});

describe("vBook bookmarks", () => {
  let srv: TestServer;
  let cookie: string;
  let ownedId: string;
  // New format (vBook's SyncBookmark serial names) on a book imported from vBook.
  const MARKED: FakeBook = {
    id: "fff666", name: "Marked Book", author: "X", toc: ["Chương 1 - A", "Chương 2 - B"], have: [0, 1], read: [1, 0, T],
    marks: [
      { id: "m1", type: 0, chapter_index: 1, chapter_name: "Chương 2 - B", color: "#ffeb3b", content: "fff666-p1-b", description: "hay", start_position: 40, end_position: 51, create_at: T - 1000 },
      { id: "m2", type: 0, chapter_index: 0, chapter_name: "Chương 1 - A", content: "text that is nowhere", description: "", start_position: 0, end_position: 5, create_at: T - 500 },
    ],
  };
  // Older backups: chap_index / title / timestamp, on a copy that came from elsewhere.
  const OLDFMT: FakeBook = {
    id: "ggg777", name: "Owned Book", author: "Test Author", toc: ["Intro", "Chapter 1", "Chapter 2", "Chapter 3"], have: [],
    marks: [{ id: 5, chap_index: 2, title: "Chapter 2", content: "c2p1 c2p1", position: 0.3, timestamp: T }],
  };
  const list = async () => ((await (await api(srv.base, cookie, "/api/bookmarks")).json()) as { bookmarks: { book_id: string; chapter_idx: number; p: number; snippet: string; note: string }[] }).bookmarks;

  before(async () => {
    srv = await startServer();
    cookie = await login(srv.base);
    const r = await upload(srv.base, cookie, makeEpub("Owned Book", OLDFMT.toc.map((t) => ({ title: t, paragraphs: 3, paragraphChars: 50 }))));
    ownedId = r.body.id!;
    await ingestAll(srv.base, cookie, ownedId);
  });
  after(async () => { await srv.stop(); cleanup(srv.dataDir); });

  test("findParagraph locates a bookmark by its text", () => {
    assert.equal(findParagraph(["first one", "the  Second\nparagraph here", "third"], "second paragraph"), 1);
    assert.equal(findParagraph(["a", "b"], "missing"), -1);
  });

  test("bookmarks come in with the book, on the right chapter and paragraph, with the note", async () => {
    const id = await sendBackup(srv.base, cookie, backup([MARKED, OLDFMT]));
    const pre = await runJob(srv.base, cookie, id, "preview");
    assert.equal((item(pre, MARKED.id) as unknown as { bookmarks: number }).bookmarks, 2);
    const imp = await runJob(srv.base, cookie, id, "import");
    for (const b of imp.ingest) await ingestAll(srv.base, cookie, b.id);
    const markedId = item(imp, MARKED.id).match!.id;
    const marks = await list();
    const mine = marks.filter((m) => m.book_id === markedId).sort((a, b) => a.chapter_idx - b.chapter_idx);
    assert.deepEqual(mine.map((m) => [m.chapter_idx, m.p, m.note]), [[0, 0, ""], [1, 2, "hay"]],
      "text found -> its paragraph (after the heading); text not found -> top of the chapter");
    // The paragraph it points at really is the bookmarked one.
    const blocks = ((await (await api(srv.base, cookie, `/api/books/${markedId}/chapters/1`)).json()) as { blocks: { text: string }[] }).blocks;
    assert.equal(blocks[mine[1].p].text, "fff666-p1-b");

    const owned = marks.filter((m) => m.book_id === ownedId);
    assert.equal(owned.length, 1, "old-format bookmark lands on the copy from elsewhere, by chapter title");
    assert.equal(owned[0].chapter_idx, 2);
    const ob = ((await (await api(srv.base, cookie, `/api/books/${ownedId}/chapters/2`)).json()) as { blocks: { text: string }[] }).blocks;
    assert.ok(ob[owned[0].p].text.startsWith("c2p1"), ob[owned[0].p].text.slice(0, 20));
    assert.match(item(imp, OLDFMT.id).outcome ?? "", /1 bookmark/);
  });

  test("importing the same backup again does not duplicate bookmarks", async () => {
    const before = (await list()).length;
    const id = await sendBackup(srv.base, cookie, backup([MARKED, OLDFMT]));
    await runJob(srv.base, cookie, id, "import");
    assert.equal((await list()).length, before);
  });
});

describe("WebDAV password set from the app", () => {
  let srv: TestServer;
  let cookie: string;
  const put = (pw: string, ck = cookie) => api(srv.base, ck, "/api/vbook/dav-password", { method: "PUT", body: JSON.stringify({ password: pw }), headers: { "content-type": "application/json" } });
  const dav = (pw: string) => fetch(srv.base + "/dav/", { method: "PROPFIND", headers: { depth: "0", authorization: "Basic " + Buffer.from(`u:${pw}`).toString("base64") } });

  before(async () => { srv = await startServer(); cookie = await login(srv.base); });
  after(async () => { await srv.stop(); cleanup(srv.dataDir); });

  test("off by default; setting it needs a signed-in session", async () => {
    assert.equal((await fetch(srv.base + "/dav/", { method: "PROPFIND" })).status, 404);
    const anon = await fetch(srv.base + "/api/vbook/dav-password", { method: "PUT", body: JSON.stringify({ password: "long-enough-pw" }), headers: { "content-type": "application/json" } });
    assert.equal(anon.status, 401);
    const st = (await (await api(srv.base, cookie, "/api/vbook/status")).json()) as { dav: string | null };
    assert.equal(st.dav, null);
  });

  test("short passwords and the reader passcode are refused", async () => {
    assert.equal((await put("short")).status, 400);
    assert.equal((await put("x".repeat(201))).status, 400);
    const same = await put("correct horse battery staple");
    assert.equal(same.status, 400);
    assert.match(((await same.json()) as { error: string }).error, /different/);
  });

  test("a set password turns WebDAV on; only that password works; change and remove", async () => {
    assert.equal((await put("first-password-1")).status, 200);
    assert.equal(((await (await api(srv.base, cookie, "/api/vbook/status")).json()) as { dav: string }).dav, "app");
    assert.equal((await dav("first-password-1")).status, 207);
    assert.equal((await dav("wrong-password")).status, 401);
    assert.equal((await put("second-password-2")).status, 200);
    assert.equal((await dav("first-password-1")).status, 401, "the old one stops working");
    assert.equal((await dav("second-password-2")).status, 207);
    await api(srv.base, cookie, "/api/vbook/dav-password", { method: "DELETE" });
    assert.equal((await dav("second-password-2")).status, 404);
  });

  test("the password itself is not stored: only a keyed hash is in the database", async () => {
    await put("plaintext-check-9");
    const { readdirSync, readFileSync, statSync } = await import("node:fs");
    const { join } = await import("node:path");
    const hits: string[] = [];
    const walk = (d: string) => { for (const e of readdirSync(d)) { const p = join(d, e); if (statSync(p).isDirectory()) walk(p); else if (readFileSync(p).includes("plaintext-check-9")) hits.push(p); } };
    walk(srv.dataDir);
    assert.deepEqual(hits, []);
  });
});

describe("DAV_PASSWORD from the cluster wins over the app's", () => {
  test("the server's password works, the app can't override it", async () => {
    const srv = await startServer({ env: { DAV_PASSWORD: "cluster-secret-1" } });
    try {
      const cookie = await login(srv.base);
      const r = await api(srv.base, cookie, "/api/vbook/dav-password", { method: "PUT", body: JSON.stringify({ password: "app-password-22" }), headers: { "content-type": "application/json" } });
      assert.equal(r.status, 409);
      const ok = (pw: string) => fetch(srv.base + "/dav/", { method: "PROPFIND", headers: { depth: "0", authorization: "Basic " + Buffer.from(`u:${pw}`).toString("base64") } });
      assert.equal((await ok("cluster-secret-1")).status, 207);
      assert.equal((await ok("app-password-22")).status, 401);
      assert.equal(((await (await api(srv.base, cookie, "/api/vbook/status")).json()) as { dav: string }).dav, "cluster");
    } finally { await srv.stop(); cleanup(srv.dataDir); }
  });
});

describe("WebDAV listing carries real sizes without anyone downloading first", () => {
  test("books are built ahead (indexing done / password set); listed length == downloaded bytes", async () => {
    const srv = await startServer();
    try {
      const cookie = await login(srv.base);
      const id = await sendBackup(srv.base, cookie, backup([FULL, PARTIAL]));
      const j = await runJob(srv.base, cookie, id, "import");
      for (const b of j.ingest) await ingestAll(srv.base, cookie, b.id);
      // Nothing is built yet: WebDAV is off, so there is no reason to.
      const pw = "ahead-of-time-pw";
      const put = await api(srv.base, cookie, "/api/vbook/dav-password", { method: "PUT", body: JSON.stringify({ password: pw }), headers: { "content-type": "application/json" } });
      assert.equal(put.status, 200);
      const auth = { authorization: "Basic " + Buffer.from(`u:${pw}`).toString("base64") };
      const lengths = async () => {
        const xml = await (await fetch(srv.base + "/dav/", { method: "PROPFIND", headers: { depth: "1", ...auth } })).text();
        return [...xml.matchAll(/<d:response>([\s\S]*?)<\/d:response>/g)].flatMap(([, r]) => {
          const name = r.match(/<d:href>\/dav\/([^<]*\.epub)<\/d:href>/)?.[1];
          return name ? [[decodeURIComponent(name), Number(r.match(/<d:getcontentlength>(\d+)</)?.[1] ?? 0)] as const] : [];
        });
      };
      let list: (readonly [string, number])[] = [];
      for (let i = 0; i < 100; i++) { // a few seconds at most
        list = await lengths();
        if (list.length === 2 && list.every(([, n]) => n > 0)) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      assert.equal(list.length, 2);
      assert.ok(list.every(([, n]) => n > 0), JSON.stringify(list));
      for (const [name, n] of list) {
        const get = await fetch(`${srv.base}/dav/${encodeURIComponent(name)}`, { headers: auth });
        assert.equal((await get.arrayBuffer()).byteLength, n, name);
      }
    } finally { await srv.stop(); cleanup(srv.dataDir); }
  });
});

describe("WebDAV request log (for diagnosing the phone app)", () => {
  test("records what a client sent and got back, never the password; needs a session; tolerates //", async () => {
    const srv = await startServer();
    try {
      const cookie = await login(srv.base);
      await api(srv.base, cookie, "/api/vbook/dav-password", { method: "PUT", body: JSON.stringify({ password: "log-test-password" }), headers: { "content-type": "application/json" } });
      const good = { authorization: "Basic " + Buffer.from("anyone:log-test-password").toString("base64"), "user-agent": "ktor-client", depth: "1" };
      await fetch(srv.base + "/dav/", { method: "PROPFIND", headers: { "user-agent": "ktor-client", depth: "1" } });                    // no credentials: 401
      assert.equal((await fetch(srv.base + "/dav/", { method: "PROPFIND", headers: good })).status, 207);
      assert.equal((await fetch(srv.base + "/dav//", { method: "PROPFIND", headers: good })).status, 207, "a doubled slash is the same folder");
      const anon = await fetch(srv.base + "/api/vbook/dav-log");
      assert.equal(anon.status, 401);
      const { log } = (await (await api(srv.base, cookie, "/api/vbook/dav-log")).json()) as { log: { method: string; path: string; status: number; auth: boolean; agent: string; depth: string | null }[] };
      assert.deepEqual(log.map((e) => [e.method, e.path, e.status, e.auth]), [
        ["PROPFIND", "/dav//", 207, true],
        ["PROPFIND", "/dav/", 207, true],
        ["PROPFIND", "/dav/", 401, false],
      ]);
      assert.equal(log[0].agent, "ktor-client");
      assert.equal(log[0].depth, "1");
      assert.ok(!JSON.stringify(log).includes("log-test-password") && !JSON.stringify(log).includes(good.authorization.slice(6)));
    } finally { await srv.stop(); cleanup(srv.dataDir); }
  });

  test("an upload that drops half-way is logged with how far it got, and leaves no file", async () => {
    const srv = await startServer();
    try {
      const cookie = await login(srv.base);
      await api(srv.base, cookie, "/api/vbook/dav-password", { method: "PUT", body: JSON.stringify({ password: "log-test-password" }), headers: { "content-type": "application/json" } });
      const auth = "Basic " + Buffer.from("anyone:log-test-password").toString("base64");
      const { connect } = await import("node:net");
      const sock = connect({ host: "127.0.0.1", port: Number(new URL(srv.base).port) });
      await new Promise<void>((r) => sock.once("connect", r));
      sock.write(`PUT /dav/vbook_backup/vbook_x_20261018_155321.tar.zst HTTP/1.1\r\nHost: x\r\nAuthorization: ${auth}\r\nUser-Agent: ktor-client\r\nContent-Length: 100000\r\n\r\n${"z".repeat(2000)}`);
      await new Promise((r) => setTimeout(r, 200));
      sock.destroy();
      let note: string | undefined;
      for (let i = 0; i < 30 && !note; i++) {
        await new Promise((r) => setTimeout(r, 100));
        const { log } = (await (await api(srv.base, cookie, "/api/vbook/dav-log")).json()) as { log: { method: string; note?: string }[] };
        note = log.find((e) => e.method === "PUT")?.note;
      }
      assert.match(note ?? "", /upload interrupted after \d+ of 100000 bytes/);
      const listing = await fetch(srv.base + "/dav/vbook_backup/", { method: "PROPFIND", headers: { authorization: auth, depth: "1" } });
      assert.doesNotMatch(await listing.text(), /vbook_x_/);
    } finally { await srv.stop(); cleanup(srv.dataDir); }
  });
});
