// Export a book as text/EPUB, and import a plain-text file through the normal
// part-by-part upload (with a dry-run preview first).

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, cleanup, login, api, upload, ingestAll, makeEpub, paragraphText, type TestServer } from "./helpers.ts";
import { startUpload, putPart } from "./upload-helpers.ts";
import { parseEpubMeta } from "../src/epub.ts";

const SPECS = Array.from({ length: 4 }, (_, i) => ({ title: `Chapter ${i}`, paragraphs: 3, paragraphChars: 80 }));

describe("export and text import", () => {
  let srv: TestServer;
  let cookie: string;
  let bookId: string;

  before(async () => {
    srv = await startServer();
    cookie = await login(srv.base);
    const { body } = await upload(srv.base, cookie, makeEpub("Export Book", SPECS));
    bookId = body.id!;
    await ingestAll(srv.base, cookie, bookId);
  });
  after(async () => { await srv.stop(); cleanup(srv.dataDir); });

  test("txt: every paragraph in order, named after the disguise unless the real title is asked for", async () => {
    const res = await api(srv.base, cookie, `/api/books/${bookId}/export?format=txt`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type")!, /^text\/plain/);
    const text = await res.text();
    let last = -1;
    for (let ch = 0; ch < SPECS.length; ch++) {
      for (let p = 0; p < SPECS[ch].paragraphs; p++) {
        const at = text.indexOf(paragraphText(ch, p, SPECS[ch].paragraphChars));
        assert.ok(at > last, `chapter ${ch} paragraph ${p} is present and after the previous one`);
        last = at;
      }
    }
    const disposition = res.headers.get("content-disposition")!;
    assert.ok(!disposition.includes("Export Book"), "the real title is not in the file name by default");
    const real = await api(srv.base, cookie, `/api/books/${bookId}/export?format=txt&real=1`);
    assert.ok(decodeURIComponent(real.headers.get("content-disposition")!).includes("Export Book.txt"));
  });

  test("epub: a valid book with every chapter; a range gives just those chapters", async () => {
    const res = await api(srv.base, cookie, `/api/books/${bookId}/export?format=epub`);
    assert.equal(res.headers.get("content-type"), "application/epub+zip");
    const meta = parseEpubMeta(new Uint8Array(await res.arrayBuffer()));
    assert.equal(meta.title, "Export Book");
    assert.equal(meta.spine.length, SPECS.length);

    const part = await api(srv.base, cookie, `/api/books/${bookId}/export?format=epub&from=1&to=2`);
    assert.equal(parseEpubMeta(new Uint8Array(await part.arrayBuffer())).spine.length, 2);
  });

  test("an exported EPUB can be imported again as a new book with the same text", async () => {
    const epub = new Uint8Array(await (await api(srv.base, cookie, `/api/books/${bookId}/export?format=epub`)).arrayBuffer());
    const { res, body } = await upload(srv.base, cookie, epub);
    assert.equal(res.status, 200);
    await ingestAll(srv.base, cookie, body.id!);
    const chapter = await (await api(srv.base, cookie, `/api/books/${body.id}/chapters/2`)).json() as { blocks: { text: string }[] };
    assert.ok(chapter.blocks.some((b) => b.text === paragraphText(2, 1, 80)));
  });

  test("export: bad format, unknown book, no session", async () => {
    assert.equal((await api(srv.base, cookie, `/api/books/${bookId}/export?format=pdf`)).status, 400);
    assert.equal((await api(srv.base, cookie, "/api/books/00000000-0000-0000-0000-000000000000/export?format=txt")).status, 404);
    assert.equal((await api(srv.base, cookie, `/api/books/${bookId}/export?format=txt&from=99`)).status, 200, "a range past the end is clamped to the last chapter");
    assert.equal((await fetch(`${srv.base}/api/books/${bookId}/export?format=txt`)).status, 401);
  });

  // ---- text import ------------------------------------------------------------
  const novel = () => {
    const chapters = Array.from({ length: 5 }, (_, i) => `Chương ${i + 1}: Tiêu đề ${i + 1}\n${paragraphText(i, 0, 400)}\n${paragraphText(i, 1, 400)}\n`);
    return new TextEncoder().encode(chapters.join("\n"));
  };
  async function sendText(name: string, bytes: Uint8Array) {
    const { body } = await startUpload(srv.base, cookie, bytes.length, name);
    const size = body.part_size!;
    for (let n = 0; n * size < bytes.length; n++) await putPart(srv.base, cookie, body.id!, n, bytes.slice(n * size, (n + 1) * size));
    return body.id!;
  }
  const complete = (id: string, dry = false) => api(srv.base, cookie, `/api/uploads/${id}/complete${dry ? "?dry=1" : ""}`, { method: "POST" });

  test("a .txt file: the dry run previews the chapters and changes nothing; the real run makes the book", async () => {
    const before = ((await (await api(srv.base, cookie, "/api/books")).json()) as { books: unknown[] }).books.length;
    const id = await sendText("Truyện thử.txt", novel());

    const dry = await complete(id, true);
    assert.equal(dry.status, 200);
    const { preview } = await dry.json() as { preview: { title: string; rule: string; chapters: number; samples: { title: string }[]; warnings: string[] } };
    assert.equal(preview.title, "Truyện thử");
    assert.equal(preview.rule, "vi");
    assert.equal(preview.chapters, 5);
    assert.equal(preview.samples[0].title, "Chương 1: Tiêu đề 1");
    assert.equal(((await (await api(srv.base, cookie, "/api/books")).json()) as { books: unknown[] }).books.length, before, "a dry run creates nothing");

    const done = await complete(id);
    assert.equal(done.status, 200);
    const book = await done.json() as { id: string; total: number; title: string };
    assert.equal(book.total, 5);
    assert.equal(book.title, "Truyện thử");
    await ingestAll(srv.base, cookie, book.id);
    const index = await (await api(srv.base, cookie, `/api/books/${book.id}/index`)).json() as { chapters: { title: string }[] };
    assert.deepEqual(index.chapters.map((c) => c.title), [1, 2, 3, 4, 5].map((n) => `Chương ${n}: Tiêu đề ${n}`));
    const ch = await (await api(srv.base, cookie, `/api/books/${book.id}/chapters/3`)).json() as { blocks: { text: string }[] };
    assert.ok(ch.blocks.some((b) => b.text === paragraphText(3, 1, 400)), "the text arrives intact");
    assert.equal((await complete(id)).status, 200, "completing again returns the same book instead of a duplicate");
  });

  test("an upload can be discarded after previewing; an empty text file is refused; HTML works too", async () => {
    const id = await sendText("nope.txt", novel());
    assert.equal((await complete(id, true)).status, 200);
    assert.equal((await api(srv.base, cookie, `/api/uploads/${id}`, { method: "DELETE" })).status, 200);
    assert.equal((await complete(id)).status, 404, "discarded: nothing left to import");

    const empty = await sendText("empty.txt", new TextEncoder().encode("   \n\n  \n"));
    assert.equal((await complete(empty)).status, 422);

    const html = new TextEncoder().encode("<html><body>" + [1, 2, 3].map((n) => `<h2>Chapter ${n}</h2><p>${paragraphText(n, 0, 300)}</p><p>${paragraphText(n, 1, 300)}</p>`).join("") + "</body></html>");
    const hid = await sendText("page.html", html);
    const { preview } = await (await complete(hid, true)).json() as { preview: { rule: string; chapters: number } };
    assert.deepEqual([preview.rule, preview.chapters], ["en", 3]);
  });

  test("names that are not text files still go through the EPUB parser (and are refused as before)", async () => {
    const id = await sendText("book.epub", new TextEncoder().encode("this is not a zip file"));
    const res = await complete(id);
    assert.equal(res.status, 422);
    assert.match(((await res.json()) as { error: string }).error, /could not parse EPUB/);
  });
});
