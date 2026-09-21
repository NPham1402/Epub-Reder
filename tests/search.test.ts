// Full-text search: Vietnamese-aware matching, per-book scope, kept in step with
// deletes and re-indexes.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, cleanup, login, api, upload, ingestAll, type TestServer } from "./helpers.ts";
import { buildEpub } from "../src/epubwrite.ts";
import { buildMatch, findHits, foldVi, foldWithMap } from "../src/search.ts";

test("folding: đ becomes d, other marks are stripped only for matching, positions map back", () => {
  assert.equal(foldVi("Đạo chủ, đường"), "Dạo chủ, dường");
  const { folded, map } = foldWithMap("Trạch Nhật Đạo");
  assert.equal(folded, "trach nhat dao");
  assert.equal(map.length, folded.length);
  assert.deepEqual([map[0], map[6], map[13]], [0, 6, 13], "each folded character points at its original");
});

test("the MATCH expression only ever contains quoted words, the last as a prefix", () => {
  assert.deepEqual(buildMatch("Trạch  nhat, phi Th"), { match: '"trach" "nhat" "phi" "th"*', tokens: ["trach", "nhat", "phi", "th"] });
  assert.equal(buildMatch("  ,, "), null);
  assert.deepEqual(buildMatch('" OR text:x* NEAR('), { match: '"or" "text" "x" "near"*', tokens: ["or", "text", "x", "near"] });
});

test("hits are shown in the original wording; words spread over paragraphs fall back to the first word", () => {
  const blocks = [{ text: "Xin chào" }, { text: "Hứa Ứng gặp Trạch Nhật Phi Thăng, đạo chủ của thôn." }, { text: "Nhật thực" }];
  const [hit] = findHits(blocks, ["trach", "nhat"]);
  assert.equal(hit.p, 1);
  assert.equal(hit.snippet.slice(hit.from, hit.to), "Trạch");
  assert.ok(hit.snippet.includes("Trạch Nhật Phi Thăng"));
  const spread = findHits([{ text: "chỉ có trạch ở đây" }, { text: "còn nhật ở đây" }], ["trach", "nhat"]);
  assert.deepEqual(spread.map((h) => h.p), [0], "no paragraph has both words: show where the first word is");
  const long = findHits([{ text: "a".repeat(200) + " needle " + "b".repeat(200) }], ["needle"])[0];
  assert.ok(long.snippet.startsWith("…") && long.snippet.endsWith("…"));
  assert.equal(long.snippet.slice(long.from, long.to), "needle");
});

describe("search over HTTP", () => {
  let srv: TestServer;
  let cookie: string;
  let bookA: string;
  let bookB: string;

  const makeBook = (title: string, chapters: { title: string; paragraphs: string[] }[]) =>
    buildEpub({ title, language: "vi", chapters: chapters.map((c) => ({ title: c.title, blocks: c.paragraphs.map((text) => ({ type: "p", text })) })) });
  const indexAll = async (id: string) => {
    for (let i = 0; i < 50; i++) {
      const r = await api(srv.base, cookie, `/api/books/${id}/search-index`, { method: "POST" });
      assert.equal(r.status, 200);
      if (((await r.json()) as { done: boolean }).done) return;
    }
    assert.fail("indexing never finished");
  };
  const search = async (q: string, book?: string) => {
    const r = await api(srv.base, cookie, `/api/search?q=${encodeURIComponent(q)}${book ? `&book=${book}` : ""}`);
    return { status: r.status, body: (await r.json()) as { results: { book_id: string; idx: number; p: number; snippet: string; chapter_title: string }[] } };
  };
  const status = async () => (await (await api(srv.base, cookie, "/api/search/status")).json()) as { available: boolean; books: { book_id: string; indexed: number; total: number }[] };

  before(async () => {
    srv = await startServer({ env: { CHUNK_SIZE: "2" } }); // small batches: indexing must loop
    cookie = await login(srv.base);
    bookA = (await upload(srv.base, cookie, makeBook("Tìm kiếm", [
      { title: "Mở đầu", paragraphs: ["Một ngày nắng đẹp.", "Không có gì đặc biệt."] },
      { title: "Hai", paragraphs: ["Gió thổi qua đồng."] },
      { title: "Ba", paragraphs: ["Ai cũng biết Hứa Ứng là người bắt rắn.", "Trạch Nhật Phi Thăng, đạo chủ của vùng này, đã xuất hiện."] },
      { title: "Bốn", paragraphs: ["Kết thúc."] },
      { title: "Năm", paragraphs: ["Hết truyện."] },
    ]))).body.id!;
    bookB = (await upload(srv.base, cookie, makeBook("Sách khác", [{ title: "Một", paragraphs: ["Trạch Nhật cũng có trong sách này."] }]))).body.id!;
    await ingestAll(srv.base, cookie, bookA);
    await ingestAll(srv.base, cookie, bookB);
  });
  after(async () => { await srv.stop(); cleanup(srv.dataDir); });

  test("nothing is searchable until indexed; indexing runs in batches", async () => {
    let s = await status();
    assert.equal(s.available, true);
    assert.deepEqual(s.books.find((b) => b.book_id === bookA), { book_id: bookA, indexed: 0, total: 5 });
    assert.equal((await search("trach")).body.results.length, 0);

    const first = (await (await api(srv.base, cookie, `/api/books/${bookA}/search-index`, { method: "POST" })).json()) as { done: boolean; indexed: number };
    assert.deepEqual([first.done, first.indexed], [false, 2], "two chapters per request with CHUNK_SIZE=2");
    await indexAll(bookA);
    await indexAll(bookB);
    s = await status();
    assert.deepEqual(s.books.find((b) => b.book_id === bookA), { book_id: bookA, indexed: 5, total: 5 });
  });

  test("Vietnamese matching: without marks, with marks, đ, and prefixes", async () => {
    for (const q of ["trach nhat", "Trạch Nhật", "dao chu", "đạo chủ", "phi th", "HỨA ỨNG"]) {
      const r = await search(q, bookA);
      assert.equal(r.status, 200, q);
      assert.ok(r.body.results.some((h) => h.idx === 2 && h.chapter_title === "Ba"), `"${q}" finds chapter 3`);
    }
    const hit = (await search("đạo chủ", bookA)).body.results[0];
    assert.equal(hit.p, 2, "it points at the block the reader shows (block 0 is the chapter heading), so it can jump there");
    assert.ok(hit.snippet.includes("đạo chủ"), "and shows the original spelling, not the folded one");
    assert.equal((await search("khong co trong truyen", bookA)).body.results.length, 0);
  });

  test("scope: one book, or all of them", async () => {
    assert.ok((await search("trach nhat")).body.results.some((h) => h.book_id === bookB));
    assert.ok(!(await search("trach nhat", bookA)).body.results.some((h) => h.book_id === bookB));
    assert.deepEqual([...new Set((await search("trach nhat")).body.results.map((h) => h.book_id))].sort(), [bookA, bookB].sort());
  });

  test("bad queries and no session", async () => {
    assert.equal((await search("  ,, ")).status, 400);
    assert.equal((await search('" OR x')).status, 200, "quotes and operators are harmless");
    assert.equal((await fetch(`${srv.base}/api/search?q=x`)).status, 401);
    assert.equal((await fetch(`${srv.base}/api/books/${bookA}/search-index`, { method: "POST" })).status, 401);
    assert.equal((await api(srv.base, cookie, "/api/books/00000000-0000-0000-0000-000000000000/search-index", { method: "POST" })).status, 404);
  });

  test("re-indexing a book clears its index; deleting a book removes it from results", async () => {
    assert.equal((await api(srv.base, cookie, `/api/books/${bookA}/reindex`, { method: "POST" })).status, 200);
    await ingestAll(srv.base, cookie, bookA);
    assert.equal((await status()).books.find((b) => b.book_id === bookA)!.indexed, 0, "its text was rewritten, so it must be indexed again");
    assert.equal((await search("trach nhat", bookA)).body.results.length, 0);
    await indexAll(bookA);
    assert.ok((await search("trach nhat", bookA)).body.results.length > 0);

    assert.equal((await api(srv.base, cookie, `/api/books/${bookB}`, { method: "DELETE" })).status, 200);
    assert.ok(!(await search("trach nhat")).body.results.some((h) => h.book_id === bookB));
  });
});
