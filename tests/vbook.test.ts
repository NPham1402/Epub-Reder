// vBook backup import (EPR-19): a synthetic backup with the same layout as a
// real one (§13.2) — tar of books/<id>/{book.json,toc_links.json,contents/...},
// zstd-compressed — goes through the real part-by-part upload and the job API.

import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { zstdCompressSync } from "node:zlib";
import { api, cleanup, ingestAll, login, makeEpub, startServer, upload, type TestServer } from "./helpers.ts";
import { putPart, startUpload } from "./upload-helpers.ts";
import { chapterParagraphs, readVbookBackup, tarEntries } from "../src/vbook.ts";

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

interface FakeBook { id: string; name: string; author: string; toc: string[]; have: number[]; read?: [number, number, number, string?] }
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
    [`books/${b.id}/bookmarks.json`, "[]"],
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

function backup(books: FakeBook[], pad = 0): Uint8Array {
  const files: [string, string | Uint8Array][] = [["manifest.json", JSON.stringify({ device_name: "test phone", backup_version: 1, create_at: T })]];
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
    const backupName = xml.match(/vbook_\d{8}_\d{6}\.tar\.zst/)?.[0];
    assert.ok(backupName, "positions backup is listed");
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
