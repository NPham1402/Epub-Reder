import { test } from "node:test";
import assert from "node:assert/strict";
import { FailureLimiter } from "../src/ratelimit.ts";
import { passcodeMatches, signSession, verifySession } from "../src/auth.ts";
import { extractChapterRange, parseEpubMeta } from "../src/epub.ts";
import { expectedBlocks, makeEpub, type ChapterSpec } from "./helpers.ts";

test("FailureLimiter blocks after max failures and frees after the window", () => {
  let now = 1_000;
  const l = new FailureLimiter({ max: 3, windowMs: 1000 }, () => now);
  assert.equal(l.retryAfter("a"), 0);
  l.fail("a"); l.fail("a");
  assert.equal(l.retryAfter("a"), 0, "still under the limit");
  l.fail("a");
  assert.ok(l.retryAfter("a") > 0, "blocked at the limit");
  assert.equal(l.retryAfter("b"), 0, "other keys are unaffected");
  now += 1001;
  assert.equal(l.retryAfter("a"), 0, "window has passed");
});

test("FailureLimiter.reset clears a key; maxKeys bounds memory", () => {
  const l = new FailureLimiter({ max: 1, windowMs: 60_000, maxKeys: 3 });
  l.fail("a");
  assert.ok(l.retryAfter("a") > 0);
  l.reset("a");
  assert.equal(l.retryAfter("a"), 0);
  for (const k of ["k1", "k2", "k3", "k4", "k5"]) l.fail(k);
  assert.equal(l.retryAfter("k1"), 0, "oldest keys were evicted");
  assert.ok(l.retryAfter("k5") > 0);
});

test("session tokens: valid, wrong epoch, tampered, expired, wrong secret", async () => {
  const token = await signSession("secret", 60_000, 4);
  assert.equal(await verifySession(token, "secret", 4), true);
  assert.equal(await verifySession(token, "secret", 5), false, "epoch bumped -> revoked");
  assert.equal(await verifySession(token, "other", 4), false, "wrong secret");
  const [v, exp, ep, sig] = token.split(".");
  assert.equal(await verifySession([v, exp, "5", sig].join("."), "secret", 5), false, "epoch can't be edited in place");
  assert.equal(await verifySession([v, String(Number(exp) + 1e9), ep, sig].join("."), "secret", 4), false, "expiry can't be extended");
  assert.equal(await verifySession(await signSession("secret", -1, 4), "secret", 4), false, "expired");
  assert.equal(await verifySession("v1.123.abc", "secret", 1), false, "old token format rejected");
  assert.equal(await verifySession("garbage", "secret", 1), false);
});

test("passcodeMatches", async () => {
  assert.equal(await passcodeMatches("hunter2", "hunter2", "s"), true);
  assert.equal(await passcodeMatches("hunter", "hunter2", "s"), false);
  assert.equal(await passcodeMatches("", "hunter2", "s"), false);
  assert.equal(await passcodeMatches("hunter2 ", "hunter2", "s"), false);
});

const specs: ChapterSpec[] = [
  { title: "Chapter One", paragraphs: 3, paragraphChars: 50 },
  { title: "Chapter Two", paragraphs: 1, paragraphChars: 10 },
  { title: "Chapter Three", paragraphs: 5, paragraphChars: 200 },
];

test("parseEpubMeta reads metadata, TOC and skips non-HTML spine items", () => {
  const meta = parseEpubMeta(makeEpub("Sample Book", specs));
  assert.equal(meta.title, "Sample Book");
  assert.equal(meta.author, "Test Author");
  assert.equal(meta.language, "en");
  assert.equal(meta.spine.length, 3, "the image in the spine is not a chapter");
  assert.deepEqual(meta.spine.map((s) => s.order), [0, 1, 2]);
  assert.equal(meta.tocMap.get("OEBPS/text/ch1.xhtml"), "Chapter Two");
});

test("extractChapterRange returns exactly the requested slice with correct text", () => {
  const epub = makeEpub("Sample Book", specs);
  const meta = parseEpubMeta(epub);
  const got = extractChapterRange(epub, meta.spine.slice(1, 3), meta.tocMap);
  assert.deepEqual(got.map((c) => c.order), [1, 2]);
  assert.deepEqual(got[0].blocks, expectedBlocks(1, specs[1]));
  assert.deepEqual(got[1].blocks, expectedBlocks(2, specs[2]));
  assert.equal(got[1].title, "Chapter Three");
});

test("parseEpubMeta rejects things that aren't EPUBs", () => {
  assert.throws(() => parseEpubMeta(new TextEncoder().encode("not a zip")));
  assert.throws(() => parseEpubMeta(makeEpub("x", []).slice(0, 10)));
});

test("zip-bomb guard: an oversized chapter is refused before it is inflated; others are unaffected", async () => {
  const { makeBombEpub } = await import("./helpers.ts");
  const { EpubLimitError } = await import("../src/epub.ts");
  const bomb = makeBombEpub(specs, 1, 40);
  assert.ok(bomb.length < 200_000, "the archive itself is small — that's the point");
  const meta = parseEpubMeta(bomb); // upload-time parsing never touches chapter bodies
  assert.equal(meta.spine.length, 3);
  assert.equal(extractChapterRange(bomb, [meta.spine[0]], meta.tocMap).length, 1, "a normal chapter still works");
  assert.throws(() => extractChapterRange(bomb, [meta.spine[1]], meta.tocMap), EpubLimitError);
  assert.throws(() => extractChapterRange(bomb, meta.spine, meta.tocMap), /too large/);
});
