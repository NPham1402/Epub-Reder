import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  api, cleanup, ingestAll, login, makeEpub, startServer, verifyBook, type ChapterSpec, type TestServer,
} from "./helpers.ts";
import { completeUpload, padEpub, putPart, startUpload } from "./upload-helpers.ts";

const SPECS: ChapterSpec[] = Array.from({ length: 12 }, (_, i) => ({ title: `Part ${i}`, paragraphs: 20, paragraphChars: 500 }));
const EPUB = padEpub(makeEpub("Chunked Book", SPECS), 700_000); // ~700 KB: at least three 256 KB parts
const PART = 256 * 1024;
const partsOf = (bytes: Uint8Array) =>
  Array.from({ length: Math.ceil(bytes.length / PART) }, (_, i) => bytes.slice(i * PART, (i + 1) * PART));

function allFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? allFiles(join(dir, e.name)) : [join(dir, e.name)]);
}

describe("upload in parts", () => {
  let srv: TestServer;
  let cookie: string;

  before(async () => {
    srv = await startServer();
    cookie = await login(srv.base);
  });
  after(async () => {
    await srv.stop();
    cleanup(srv.dataDir);
  });

  test("parts may arrive in any order and repeat; completing twice yields the same book", async () => {
    const parts = partsOf(EPUB);
    assert.ok(parts.length >= 3);
    const { res, body } = await startUpload(srv.base, cookie, EPUB.length);
    assert.equal(res.status, 200);
    assert.equal(body.part_size, PART);
    assert.equal(body.parts, parts.length);
    const id = body.id!;

    for (const n of [...parts.keys()].reverse()) assert.equal((await putPart(srv.base, cookie, id, n, parts[n])).status, 200);
    assert.equal((await putPart(srv.base, cookie, id, 0, parts[0])).status, 200, "re-sending a part (a retry) is harmless");

    const first = await completeUpload(srv.base, cookie, id);
    assert.equal(first.res.status, 200);
    assert.equal(first.body.total, 12);
    const again = await completeUpload(srv.base, cookie, id);
    assert.equal(again.res.status, 200, "a retried complete (lost response) must not fail");
    assert.equal(again.body.id, first.body.id, "and must not create a duplicate book");
    assert.equal((await putPart(srv.base, cookie, id, 0, parts[0])).status, 404, "a finished upload takes no more parts");

    assert.deepEqual(allFiles(join(srv.dataDir, "objects", "uploads")), [], "the parts were cleaned up");
    await ingestAll(srv.base, cookie, first.body.id!);
    assert.deepEqual((await verifyBook(srv.base, cookie, first.body.id!, SPECS)).mismatched, []);
    const listed = await (await api(srv.base, cookie, "/api/books")).json() as { books: unknown[] };
    assert.equal(listed.books.length, 1, "exactly one book, not two");
  });

  test("cut-off or wrong-sized parts are refused with a clear message", async () => {
    const parts = partsOf(EPUB);
    const { body } = await startUpload(srv.base, cookie, EPUB.length);
    const id = body.id!;
    const cut = await putPart(srv.base, cookie, id, 0, parts[0].slice(0, 1000));
    assert.equal(cut.status, 400);
    assert.match((await cut.json() as { error: string }).error, /cut off/);
    assert.equal((await putPart(srv.base, cookie, id, 99, parts[0])).status, 400, "no such part");
    assert.equal((await putPart(srv.base, cookie, id, -1, parts[0])).status, 400);
    assert.equal((await putPart(srv.base, cookie, "00000000-0000-0000-0000-000000000000", 0, parts[0])).status, 404);
  });

  test("completing with parts missing lists exactly which; sending them then succeeds", async () => {
    const parts = partsOf(EPUB);
    const { body } = await startUpload(srv.base, cookie, EPUB.length);
    const id = body.id!;
    await putPart(srv.base, cookie, id, 0, parts[0]);
    const early = await completeUpload(srv.base, cookie, id);
    assert.equal(early.res.status, 409);
    assert.deepEqual(early.body.missing, [...parts.keys()].slice(1));
    for (let n = 1; n < parts.length; n++) await putPart(srv.base, cookie, id, n, parts[n]);
    assert.equal((await completeUpload(srv.base, cookie, id)).res.status, 200);
  });

  test("bad input: oversize, zero size, not an EPUB, signed out", async () => {
    assert.equal((await startUpload(srv.base, cookie, 81 * 1024 * 1024)).res.status, 413);
    assert.equal((await startUpload(srv.base, cookie, 0)).res.status, 400);

    const junk = new Uint8Array(300_000).fill(65);
    const { body } = await startUpload(srv.base, cookie, junk.length);
    const id = body.id!;
    for (const [n, p] of partsOf(junk).entries()) await putPart(srv.base, cookie, id, n, p);
    const done = await completeUpload(srv.base, cookie, id);
    assert.equal(done.res.status, 422);
    assert.match(done.body.error!, /could not parse EPUB/);
    assert.equal((await completeUpload(srv.base, cookie, id)).res.status, 404, "a refused upload is discarded");
    assert.deepEqual(allFiles(join(srv.dataDir, "objects", "uploads")), [], "and so are its parts");

    for (const [method, path] of [
      ["POST", "/api/uploads"], ["PUT", `/api/uploads/${id}/parts/0`], ["POST", `/api/uploads/${id}/complete`],
    ] as const) {
      assert.equal((await fetch(`${srv.base}${path}`, { method })).status, 401, `${method} ${path} without a session`);
    }
  });

  test("an EPUB whose tail is missing is refused with a plain 'cut off' message", async () => {
    const cut = EPUB.slice(0, Math.floor(EPUB.length * 0.94));
    const { body } = await startUpload(srv.base, cookie, cut.length);
    const id = body.id!;
    for (const [n, p] of partsOf(cut).entries()) await putPart(srv.base, cookie, id, n, p);
    const done = await completeUpload(srv.base, cookie, id);
    assert.equal(done.res.status, 422);
    assert.match(done.body.error!, /could not parse EPUB: the zip data is missing or cut off/);
    assert.doesNotMatch(done.body.error!, /invalid zip data/);
  });

  test("one-request upload: a declared size that does not match is reported as cut off", async () => {
    const fd = new FormData();
    fd.append("size", String(EPUB.length + 12345));
    fd.append("file", new File([EPUB as Uint8Array<ArrayBuffer>], "book.epub"));
    const res = await api(srv.base, cookie, "/api/books", { method: "POST", body: fd });
    assert.equal(res.status, 400);
    assert.match((await res.json() as { error: string }).error, /cut off: received \d+ of \d+ bytes/);
  });
});

describe("upload sessions cleanup", () => {
  test("an abandoned upload's parts are swept and it can no longer be completed", async () => {
    let srv = await startServer();
    try {
      let cookie = await login(srv.base);
      const { body } = await startUpload(srv.base, cookie, EPUB.length);
      await putPart(srv.base, cookie, body.id!, 0, partsOf(EPUB)[0]);
      assert.equal(allFiles(join(srv.dataDir, "objects", "uploads")).length, 1);

      await srv.stop();
      srv = await startServer({ dataDir: srv.dataDir, env: { STALE_INGEST_HOURS: "0", MAINTENANCE_FIRST_RUN_MS: "200" } });
      cookie = await login(srv.base);
      const deadline = Date.now() + 10_000;
      while (allFiles(join(srv.dataDir, "objects", "uploads")).length > 0) {
        assert.ok(Date.now() < deadline, `parts were not swept\n${srv.logs()}`);
        await new Promise((r) => setTimeout(r, 100));
      }
      assert.equal((await completeUpload(srv.base, cookie, body.id!)).res.status, 404);
    } finally {
      await srv.stop();
      cleanup(srv.dataDir);
    }
  });
});
