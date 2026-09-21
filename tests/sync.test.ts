// State a reader creates (progress, settings, highlights, bookmarks) lives on
// the server, so it follows them across devices and is backed up.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, cleanup, login, api, upload, ingestAll, makeEpub, type TestServer } from "./helpers.ts";

const JSON_HEADERS = { "content-type": "application/json" };
const post = (srv: TestServer, cookie: string, path: string, body: unknown, method = "POST") =>
  api(srv.base, cookie, path, { method, body: JSON.stringify(body), headers: JSON_HEADERS });

type Progress = { chapter_idx: number; scroll_ratio: number; furthest_idx: number; furthest_ratio: number };

describe("synced reader state", () => {
  let srv: TestServer;
  let cookie: string;
  let bookId: string;

  before(async () => {
    srv = await startServer();
    cookie = await login(srv.base);
    const { body } = await upload(srv.base, cookie, makeEpub("Sync Book", Array.from({ length: 5 }, (_, i) => ({ title: `Ch ${i}`, paragraphs: 3, paragraphChars: 60 }))));
    bookId = body.id!;
    await ingestAll(srv.base, cookie, bookId);
  });
  after(async () => { await srv.stop(); cleanup(srv.dataDir); });

  const progress = async (): Promise<Progress> =>
    ((await (await api(srv.base, cookie, `/api/books/${bookId}/index`)).json()) as { progress: Progress }).progress;
  const report = (idx: number, ratio: number, ts?: number) =>
    post(srv, cookie, `/api/books/${bookId}/progress`, { chapter_idx: idx, scroll_ratio: ratio, ...(ts ? { client_ts: ts } : {}) });

  test("progress: the furthest point only moves forward; the current position follows the newest device clock", async () => {
    const t0 = Date.now() - 100_000;
    await report(4, 0.5, t0 + 1000);
    assert.deepEqual(await progress().then((p) => [p.chapter_idx, p.scroll_ratio, p.furthest_idx, p.furthest_ratio]), [4, 0.5, 4, 0.5]);

    await report(2, 0.1, t0 + 2000); // re-reading an early chapter, on a later clock
    let p = await progress();
    assert.deepEqual([p.chapter_idx, p.scroll_ratio], [2, 0.1], "resume goes where the reader last was");
    assert.deepEqual([p.furthest_idx, p.furthest_ratio], [4, 0.5], "but progress never goes backwards");

    await report(1, 0.9, t0 + 500); // a slow device delivering an older position late
    p = await progress();
    assert.deepEqual([p.chapter_idx, p.scroll_ratio], [2, 0.1], "an older position does not replace a newer one");
    assert.deepEqual([p.furthest_idx, p.furthest_ratio], [4, 0.5]);

    await report(4, 0.8, t0 + 3000);
    p = await progress();
    assert.deepEqual([p.furthest_idx, p.furthest_ratio], [4, 0.8], "moving on within the same chapter counts");
    await report(3, 0.2, t0 + 4000);
    assert.equal((await progress()).furthest_idx, 4);
  });

  test("progress: a device with no clock field (older UI) still works, and a wrong clock cannot freeze the value", async () => {
    await report(1, 0.3); // no client_ts
    assert.equal((await progress()).chapter_idx, 1);
    const tenYears = Date.now() + 10 * 365 * 24 * 3600 * 1000;
    await report(2, 0.4, tenYears); // a clock ten years ahead is capped to about a minute ahead...
    await report(3, 0.5, tenYears); // ...so a later write from the same device is not shut out by its own past
    assert.equal((await progress()).chapter_idx, 3, "future timestamps are capped, not stored as-is");
  });

  test("the library list carries the furthest point too", async () => {
    const listed = await (await api(srv.base, cookie, "/api/books")).json() as { books: { id: string; furthest_idx: number }[] };
    assert.equal(listed.books.find((b) => b.id === bookId)!.furthest_idx, 4);
  });

  test("settings: newest timestamp wins per key; bad input is refused", async () => {
    const t = Date.now() - 50_000;
    let res = await post(srv, cookie, "/api/settings", { changes: { fontSize: { value: 18, updated_at: t }, theme: { value: "light", updated_at: t } } }, "PUT");
    assert.equal(res.status, 200);
    res = await post(srv, cookie, "/api/settings", { changes: { fontSize: { value: 12, updated_at: t - 1000 } } }, "PUT"); // older
    let s = ((await res.json()) as { settings: Record<string, { value: unknown }> }).settings;
    assert.equal(s.fontSize.value, 18, "an older change does not overwrite");
    res = await post(srv, cookie, "/api/settings", { changes: { fontSize: { value: 20, updated_at: t + 1000 }, extensions: { value: { "focus-timer": true }, updated_at: t } } }, "PUT");
    s = ((await res.json()) as { settings: Record<string, { value: unknown }> }).settings;
    assert.equal(s.fontSize.value, 20);
    assert.equal(s.theme.value, "light");
    assert.deepEqual(s.extensions.value, { "focus-timer": true });
    const got = ((await (await api(srv.base, cookie, "/api/settings")).json()) as { settings: Record<string, unknown> }).settings;
    assert.deepEqual(Object.keys(got).sort(), ["extensions", "fontSize", "theme"]);

    assert.equal((await post(srv, cookie, "/api/settings", { changes: { "bad key!": { value: 1, updated_at: t } } }, "PUT")).status, 400);
    assert.equal((await post(srv, cookie, "/api/settings", {}, "PUT")).status, 400);
    assert.equal((await post(srv, cookie, "/api/settings", { changes: { big: { value: "x".repeat(9000), updated_at: t } } }, "PUT")).status, 400);
  });

  test("highlights: stored per chapter, newest set wins, validated", async () => {
    const t = Date.now() - 40_000;
    const put = (idx: number, items: unknown, ts: number) => post(srv, cookie, `/api/books/${bookId}/chapters/${idx}/highlights`, { items, updated_at: ts }, "PUT");
    assert.equal((await put(2, [{ p: 1, start: 0, end: 5 }], t)).status, 200);
    const older = await (await put(2, [{ p: 9, start: 1, end: 2 }], t - 5000)).json() as { items: unknown[] };
    assert.deepEqual(older.items, [{ p: 1, start: 0, end: 5 }], "an older set does not replace a newer one");
    const newer = await (await put(2, [], t + 1000)).json() as { items: unknown[] };
    assert.deepEqual(newer.items, [], "removing every highlight is a change too");
    await put(3, [{ p: 0, start: 2, end: 9 }], t);

    const all = await (await api(srv.base, cookie, `/api/books/${bookId}/highlights`)).json() as { chapters: Record<string, { items: unknown[] }> };
    assert.deepEqual(Object.keys(all.chapters).sort(), ["2", "3"]);
    assert.equal(all.chapters["3"].items.length, 1);

    assert.equal((await put(2, [{ p: 0, start: 5, end: 5 }], t)).status, 400, "end must be after start");
    assert.equal((await put(2, "nope", t)).status, 400);
    assert.equal((await put(-1, [], t)).status, 400);
    assert.equal((await post(srv, cookie, "/api/books/00000000-0000-0000-0000-000000000000/chapters/0/highlights", { items: [], updated_at: t }, "PUT")).status, 404);
  });

  test("bookmarks: add (once per paragraph), list, edit the note, delete", async () => {
    const add = (idx: number, p: number, snippet = "") => post(srv, cookie, `/api/books/${bookId}/bookmarks`, { chapter_idx: idx, p, snippet });
    const first = await (await add(1, 2, "the quick brown fox")).json() as { bookmark: { id: string; snippet: string } };
    assert.equal(first.bookmark.snippet, "the quick brown fox");
    const again = await (await add(1, 2, "different text")).json() as { bookmark: { id: string } };
    assert.equal(again.bookmark.id, first.bookmark.id, "asking twice for the same paragraph returns the same bookmark");
    await add(3, 0);

    const list = await (await api(srv.base, cookie, "/api/bookmarks")).json() as { bookmarks: { id: string; chapter_idx: number }[] };
    assert.equal(list.bookmarks.length, 2);

    assert.equal((await post(srv, cookie, `/api/bookmarks/${first.bookmark.id}`, { note: "come back here" }, "PUT")).status, 200);
    const after = await (await api(srv.base, cookie, "/api/bookmarks")).json() as { bookmarks: { id: string; note: string }[] };
    assert.equal(after.bookmarks.find((b) => b.id === first.bookmark.id)!.note, "come back here");

    assert.equal((await post(srv, cookie, `/api/books/${bookId}/bookmarks`, { chapter_idx: -1, p: 0 })).status, 400);
    assert.equal((await post(srv, cookie, "/api/books/00000000-0000-0000-0000-000000000000/bookmarks", { chapter_idx: 0, p: 0 })).status, 404);
    assert.equal((await api(srv.base, cookie, `/api/bookmarks/${first.bookmark.id}`, { method: "DELETE" })).status, 200);
    assert.equal((await api(srv.base, cookie, `/api/bookmarks/${first.bookmark.id}`, { method: "DELETE" })).status, 404);
  });

  test("everything needs a session", async () => {
    for (const [method, path] of [
      ["GET", "/api/settings"], ["PUT", "/api/settings"], ["GET", `/api/books/${bookId}/highlights`],
      ["PUT", `/api/books/${bookId}/chapters/0/highlights`], ["GET", "/api/bookmarks"], ["POST", `/api/books/${bookId}/bookmarks`],
    ] as const) {
      assert.equal((await fetch(`${srv.base}${path}`, { method })).status, 401, `${method} ${path}`);
    }
  });

  test("deleting a book removes its highlights and bookmarks with it", async () => {
    const { body } = await upload(srv.base, cookie, makeEpub("Temp", [{ title: "c", paragraphs: 2, paragraphChars: 40 }]));
    await ingestAll(srv.base, cookie, body.id!);
    await post(srv, cookie, `/api/books/${body.id}/chapters/0/highlights`, { items: [{ p: 0, start: 0, end: 3 }], updated_at: Date.now() - 1000 }, "PUT");
    await post(srv, cookie, `/api/books/${body.id}/bookmarks`, { chapter_idx: 0, p: 0 });
    assert.equal((await api(srv.base, cookie, `/api/books/${body.id}`, { method: "DELETE" })).status, 200);
    const marks = await (await api(srv.base, cookie, "/api/bookmarks")).json() as { bookmarks: { book_id: string }[] };
    assert.ok(!marks.bookmarks.some((b) => b.book_id === body.id));
    const hl = await (await api(srv.base, cookie, `/api/books/${body.id}/highlights`)).json() as { chapters: object };
    assert.deepEqual(hl.chapters, {});
  });
});
