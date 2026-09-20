import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  PASSCODE, api, cleanup, ingestAll, ingestChunk, login, makeBombEpub, makeEpub, startServer, upload, verifyBook,
  type ChapterSpec, type TestServer,
} from "./helpers.ts";

// 60 chapters x ~255 KB = ~15 MB of parsed text: crosses the ~5 MB multipart
// part size twice, so real part consolidation happens during ingest.
const BIG: ChapterSpec[] = Array.from({ length: 60 }, (_, i) => ({ title: `Chapter ${i}`, paragraphs: 250, paragraphChars: 1000 }));
const SMALL: ChapterSpec[] = Array.from({ length: 12 }, (_, i) => ({ title: `Small ${i}`, paragraphs: 20, paragraphChars: 500 }));
const bigEpub = makeEpub("Big Book", BIG);
const smallEpub = makeEpub("Small Book", SMALL);

function allFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? allFiles(join(dir, e.name)) : [join(dir, e.name)]);
}

describe("server", () => {
  let srv: TestServer;
  let cookie: string;
  let bigId: string;

  before(async () => {
    srv = await startServer();
    cookie = await login(srv.base);
  });
  after(async () => {
    await srv.stop();
    cleanup(srv.dataDir);
  });

  test("public surface: static UI, security headers, health, no-store on the API", async () => {
    const home = await fetch(`${srv.base}/`);
    assert.equal(home.status, 200);
    assert.match(home.headers.get("content-type")!, /text\/html/);
    const csp = home.headers.get("content-security-policy")!;
    assert.match(csp, /default-src 'self'/);
    assert.match(csp, /script-src 'self'(;|$)/, "no inline/eval scripts allowed");
    assert.match(csp, /frame-ancestors 'none'/);
    assert.equal(home.headers.get("x-frame-options"), "DENY");
    assert.equal(home.headers.get("x-content-type-options"), "nosniff");
    assert.equal(home.headers.get("referrer-policy"), "no-referrer");

    const spa = await fetch(`${srv.base}/some/deep/link`);
    assert.equal(spa.status, 200);
    assert.match(spa.headers.get("content-type")!, /text\/html/);

    const health = await (await fetch(`${srv.base}/healthz`)).json() as { ok: boolean; disk: { free_mb: number } };
    assert.equal(health.ok, true);
    assert.equal(typeof health.disk.free_mb, "number");

    const unauth = await fetch(`${srv.base}/api/books`);
    assert.equal(unauth.status, 401);
    assert.equal(unauth.headers.get("cache-control"), "no-store");
  });

  test("session cookie: HttpOnly; Secure only when the request is HTTPS", async () => {
    const plain = await fetch(`${srv.base}/api/auth`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ passcode: PASSCODE }),
    });
    const plainCookie = plain.headers.get("set-cookie")!;
    assert.match(plainCookie, /HttpOnly/i);
    assert.match(plainCookie, /SameSite=Lax/i);
    assert.doesNotMatch(plainCookie, /Secure/i, "a Secure cookie over http would be dropped by browsers");

    const proxied = await fetch(`${srv.base}/api/auth`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-proto": "https" },
      body: JSON.stringify({ passcode: PASSCODE }),
    });
    assert.match(proxied.headers.get("set-cookie")!, /Secure/i, "behind a TLS proxy it must be Secure");
  });

  test("upload validation", async () => {
    const noFile = await api(srv.base, cookie, "/api/books", { method: "POST", body: new FormData() });
    assert.equal(noFile.status, 400);
    const junk = await upload(srv.base, cookie, new TextEncoder().encode("definitely not an epub"));
    assert.equal(junk.res.status, 422);
    const chapterless = await upload(srv.base, cookie, makeEpub("Empty", []));
    assert.equal(chapterless.res.status, 422);
  });

  test("a large book ingests in chunks, across multipart boundaries, byte-exact", async () => {
    const { res, body } = await upload(srv.base, cookie, bigEpub);
    assert.equal(res.status, 200);
    assert.equal(body.total, 60);
    bigId = body.id!;

    const listed = await (await api(srv.base, cookie, "/api/books")).json() as { books: unknown[] };
    assert.equal(listed.books.length, 0, "a book that hasn't finished ingesting is not in the library");

    const calls = await ingestAll(srv.base, cookie, bigId);
    assert.equal(calls, 9, "60 chapters at 7 per request");

    const { mismatched, index } = await verifyBook(srv.base, cookie, bigId, BIG);
    assert.deepEqual(mismatched, []);
    assert.equal(index.ingest_done, 1);
    assert.equal(allFiles(join(srv.dataDir, "multipart")).length, 0, "no leftover multipart parts");
    assert.equal(allFiles(join(srv.dataDir, "objects")).filter((f) => f.includes("_staged")).length, 0, "no leftover staged data");

    const listedAfter = await (await api(srv.base, cookie, "/api/books")).json() as { books: { id: string }[] };
    assert.deepEqual(listedAfter.books.map((b) => b.id), [bigId]);

    const again = await ingestChunk(srv.base, cookie, bigId);
    assert.deepEqual(again.body, { done: true, processed: 60, total: 60 }, "ingest after completion is a harmless no-op");
  });

  test("overlapping ingest requests for one book are refused, and nothing is corrupted", async () => {
    const { body } = await upload(srv.base, cookie, bigEpub);
    const id = body.id!;
    const burst = await Promise.all(Array.from({ length: 4 }, () => ingestChunk(srv.base, cookie, id)));
    const statuses = burst.map((r) => r.status).sort();
    assert.ok(statuses.includes(409), `expected a 409 among ${statuses}`);
    assert.ok(statuses.includes(200), `expected at least one success among ${statuses}`);
    await ingestAll(srv.base, cookie, id);
    assert.deepEqual((await verifyBook(srv.base, cookie, id, BIG)).mismatched, []);
    await api(srv.base, cookie, `/api/books/${id}`, { method: "DELETE" });
  });

  test("reindex: the book stays listed, refuses to serve half-built chapters, then heals", async () => {
    assert.equal((await api(srv.base, cookie, `/api/books/${bigId}/reindex`, { method: "POST" })).status, 200);
    await ingestChunk(srv.base, cookie, bigId);

    const listed = await (await api(srv.base, cookie, "/api/books")).json() as { books: { id: string }[] };
    assert.ok(listed.books.some((b) => b.id === bigId), "a finished book being re-indexed stays visible");
    const mid = await api(srv.base, cookie, `/api/books/${bigId}/chapters/0`);
    assert.equal(mid.status, 409, "chapter offsets point into a file that's being rewritten");

    await ingestAll(srv.base, cookie, bigId);
    assert.deepEqual((await verifyBook(srv.base, cookie, bigId, BIG)).mismatched, []);
  });

  test("reading progress: rejected for unknown books, stored for real ones", async () => {
    const body = JSON.stringify({ chapter_idx: 3, scroll_ratio: 0.5 });
    const ghost = await api(srv.base, cookie, "/api/books/00000000-0000-0000-0000-000000000000/progress", {
      method: "POST", body, headers: { "content-type": "application/json" },
    });
    assert.equal(ghost.status, 404);
    const real = await api(srv.base, cookie, `/api/books/${bigId}/progress`, {
      method: "POST", body, headers: { "content-type": "application/json" },
    });
    assert.equal(real.status, 200);
    const idx = await (await api(srv.base, cookie, `/api/books/${bigId}/index`)).json() as { progress: { chapter_idx: number } };
    assert.equal(idx.progress.chapter_idx, 3);
  });

  test("'sign out everywhere' revokes every session; signing in again works", async () => {
    const a = await login(srv.base);
    const b = await login(srv.base);
    assert.equal((await api(srv.base, a, "/api/books")).status, 200);
    assert.equal((await api(srv.base, b, "/api/books")).status, 200);
    assert.equal((await api(srv.base, a, "/api/logout-all", { method: "POST" })).status, 200);
    assert.equal((await api(srv.base, a, "/api/books")).status, 401);
    assert.equal((await api(srv.base, b, "/api/books")).status, 401, "the other device is signed out too");
    assert.equal((await api(srv.base, cookie, "/api/books")).status, 401);
    cookie = await login(srv.base);
    assert.equal((await api(srv.base, cookie, "/api/books")).status, 200);
  });

  test("ids and paths cannot reach outside the data directory", async () => {
    const sentinel = join(srv.dataDir, "..", `sentinel-${Date.now()}.txt`);
    writeFileSync(sentinel, "keep me");
    try {
      const pkg = await fetch(`${srv.base}/..%2f..%2fpackage.json`);
      assert.match(pkg.headers.get("content-type")!, /text\/html/, "served the SPA shell, not package.json");
      assert.doesNotMatch(await pkg.text(), /"name":\s*"epub-reader-it"/);
      const evil = encodeURIComponent(`../../../${sentinel.split(/[\\/]/).pop()}`);
      for (const [method, path] of [
        ["GET", `/api/books/${evil}/chapters/0`],
        ["GET", `/api/books/${evil}/index`],
        ["DELETE", `/api/books/${evil}`],
        ["POST", `/api/books/${evil}/reindex`],
        ["POST", `/api/books/${evil}/ingest-chunk`],
      ] as const) {
        const res = await api(srv.base, cookie, path, { method });
        assert.equal(res.status, 404, `${method} ${path}`);
      }
      assert.equal(existsSync(sentinel), true, "the sentinel outside the data dir is untouched");
    } finally {
      cleanup(sentinel);
    }
  });

  test("a zip bomb is refused with a clean error and the server stays healthy", async () => {
    const { res, body } = await upload(srv.base, cookie, makeBombEpub(SMALL, 3, 40));
    assert.equal(res.status, 200, "metadata is tiny, so the upload itself is accepted");
    let refusal;
    for (let i = 0; i < 5 && !refusal; i++) {
      const r = await ingestChunk(srv.base, cookie, body.id!);
      if (r.status !== 200) refusal = r;
    }
    assert.equal(refusal?.status, 422);
    assert.match(refusal!.body.error!, /too large/);
    assert.equal((await fetch(`${srv.base}/healthz`)).status, 200);
    assert.equal((await api(srv.base, cookie, `/api/books/${body.id}`, { method: "DELETE" })).status, 200, "and it can be deleted");
  });

  test("deleting a book removes all of its stored files", async () => {
    const { body } = await upload(srv.base, cookie, smallEpub);
    const id = body.id!;
    await ingestAll(srv.base, cookie, id);
    assert.ok(allFiles(join(srv.dataDir, "objects")).some((f) => f.includes(id)));
    assert.equal((await api(srv.base, cookie, `/api/books/${id}`, { method: "DELETE" })).status, 200);
    assert.deepEqual(allFiles(join(srv.dataDir, "objects")).filter((f) => f.includes(id)), []);
    assert.equal((await api(srv.base, cookie, `/api/books/${id}/index`)).status, 404);
  });
});

describe("restart and cleanup", () => {
  test("an interrupted ingest resumes after the server restarts", async () => {
    let srv = await startServer();
    try {
      let cookie = await login(srv.base);
      const { body } = await upload(srv.base, cookie, bigEpub);
      const id = body.id!;
      for (let i = 0; i < 4; i++) assert.equal((await ingestChunk(srv.base, cookie, id)).status, 200);

      await srv.stop();
      srv = await startServer({ dataDir: srv.dataDir });
      cookie = await login(srv.base);
      await ingestAll(srv.base, cookie, id);
      assert.deepEqual((await verifyBook(srv.base, cookie, id, BIG)).mismatched, []);
    } finally {
      await srv.stop();
      cleanup(srv.dataDir);
    }
  });

  test("abandoned first uploads are cleaned up; a book being re-indexed never is", async () => {
    let srv = await startServer();
    try {
      let cookie = await login(srv.base);
      const abandoned = (await upload(srv.base, cookie, smallEpub)).body.id!;

      const kept = (await upload(srv.base, cookie, smallEpub)).body.id!;
      await ingestAll(srv.base, cookie, kept);
      await api(srv.base, cookie, `/api/books/${kept}/reindex`, { method: "POST" });
      await ingestChunk(srv.base, cookie, kept); // re-index left half-done

      await srv.stop();
      srv = await startServer({
        dataDir: srv.dataDir,
        env: { STALE_INGEST_HOURS: "0", MAINTENANCE_FIRST_RUN_MS: "200" },
      });
      cookie = await login(srv.base);

      const deadline = Date.now() + 10_000;
      while ((await api(srv.base, cookie, `/api/books/${abandoned}/index`)).status !== 404) {
        assert.ok(Date.now() < deadline, `abandoned upload was not removed\n${srv.logs()}`);
        await new Promise((r) => setTimeout(r, 100));
      }
      assert.deepEqual(allFiles(join(srv.dataDir, "objects")).filter((f) => f.includes(abandoned)), [], "its files are gone too");

      assert.equal((await api(srv.base, cookie, `/api/books/${kept}/index`)).status, 200, "the re-indexing book survived");
      assert.ok(allFiles(join(srv.dataDir, "objects")).some((f) => f.includes(`${kept}.epub`)), "its raw .epub is still there");
      await ingestAll(srv.base, cookie, kept);
      assert.deepEqual((await verifyBook(srv.base, cookie, kept, SMALL)).mismatched, []);
    } finally {
      await srv.stop();
      cleanup(srv.dataDir);
    }
  });
});

describe("login throttling", () => {
  test("blocks a client after 5 failures, even with the right passcode, without affecting others", async () => {
    const srv = await startServer();
    try {
      const attempt = (passcode: string, ip: string) => fetch(`${srv.base}/api/auth`, {
        method: "POST",
        headers: { "content-type": "application/json", "cf-connecting-ip": ip },
        body: JSON.stringify({ passcode }),
      });
      for (let i = 0; i < 5; i++) assert.equal((await attempt("wrong", "203.0.113.7")).status, 401);
      const blocked = await attempt(PASSCODE, "203.0.113.7");
      assert.equal(blocked.status, 429, "the right passcode is refused while blocked");
      assert.ok(Number(blocked.headers.get("retry-after")) > 0);
      assert.equal((await attempt(PASSCODE, "203.0.113.8")).status, 200, "another client is unaffected");
    } finally {
      await srv.stop();
      cleanup(srv.dataDir);
    }
  });

  test("a global ceiling stops guessing spread across many (or spoofed) addresses", async () => {
    const srv = await startServer();
    try {
      const attempt = (passcode: string, ip: string) => fetch(`${srv.base}/api/auth`, {
        method: "POST",
        headers: { "content-type": "application/json", "cf-connecting-ip": ip },
        body: JSON.stringify({ passcode }),
      });
      for (let i = 0; i < 60; i++) assert.equal((await attempt("wrong", `198.51.100.${i}`)).status, 401);
      assert.equal((await attempt(PASSCODE, "192.0.2.1")).status, 429);
    } finally {
      await srv.stop();
      cleanup(srv.dataDir);
    }
  });
});
