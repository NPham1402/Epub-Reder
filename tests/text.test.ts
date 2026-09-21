// Plain text -> chapters, and chapters -> EPUB / text.

import { test } from "node:test";
import assert from "node:assert/strict";
import { unzipSync, strFromU8 } from "fflate";
import { decodeText, htmlToText, splitChapters } from "../src/textsplit.ts";
import { buildEpub, buildText } from "../src/epubwrite.ts";
import { parseEpubMeta, extractChapterRange } from "../src/epub.ts";

const para = (tag: string, n = 260) => `${tag} `.repeat(Math.ceil(n / (tag.length + 1))).trim();
const chapterText = (heading: string, tag: string) => [heading, para(tag + "a"), para(tag + "b"), ""].join("\n");

test("Vietnamese headings are recognised, and ordinary sentences are not mistaken for them", () => {
  const text = [
    chapterText("Chương 1: Khởi đầu", "one"),
    "Chương trình học rất hay, nhưng còn dài lắm và chưa xong.",
    "Tập di chuyển nhanh hơn mỗi ngày, cho tới khi quen hẳn.",
    chapterText("Chương 2", "two"),
    chapterText("Hồi 3 - Kết", "three"),
  ].join("\n");
  const r = splitChapters(text);
  assert.equal(r.rule, "vi");
  assert.deepEqual(r.chapters.map((c) => c.title), ["Chương 1: Khởi đầu", "Chương 2", "Hồi 3 - Kết"]);
  assert.equal(r.chapters[0].paragraphs.length, 4, "the two decoy sentences stay in chapter 1's text");
});

test("Chinese and English headings", () => {
  const zh = splitChapters([chapterText("第一章 起点", "x"), chapterText("第二章", "y"), chapterText("第12回 归来", "z")].join("\n"));
  assert.equal(zh.rule, "zh");
  assert.equal(zh.chapters.length, 3);
  const en = splitChapters([chapterText("Chapter 1", "a"), chapterText("CHAPTER II", "b"), chapterText("Chapter Three: The End", "c")].join("\n"));
  assert.equal(en.rule, "en");
  assert.deepEqual(en.chapters.map((c) => c.title), ["Chapter 1", "CHAPTER II", "Chapter Three: The End"]);
});

test("numbered headings count only when they run 1, 2, 3...; a short list is just text", () => {
  const seq = Array.from({ length: 6 }, (_, i) => chapterText(`${i + 1}. Title ${i + 1}`, "n" + i)).join("\n");
  assert.equal(splitChapters(seq).rule, "numbered");
  assert.equal(splitChapters(seq).chapters.length, 6);
  const list = ["Shopping:", "1. eggs", "2. milk", "3. bread", para("some prose", 400)].join("\n");
  assert.notEqual(splitChapters(list).rule, "numbered");
});

test("no headings: cut by length, with a warning; short text stays one piece", () => {
  const long = Array.from({ length: 100 }, (_, i) => para("word" + i, 500)).join("\n");
  const r = splitChapters(long, { targetChars: 20_000 });
  assert.equal(r.rule, "length");
  assert.ok(r.chapters.length >= 2 && r.chapters.every((c) => /^Part \d+$/.test(c.title)));
  assert.ok(r.warnings.some((w) => w.includes("No chapter headings")));
  const short = splitChapters("Just a few lines.\nAnd another one.", { fallbackTitle: "My story" });
  assert.equal(short.rule, "single");
  assert.deepEqual(short.chapters.map((c) => c.title), ["My story"]);
});

test("front matter is kept when it is long enough; hard-wrapped blocks are re-joined", () => {
  const wrapped = (tag: string) => [tag + " first line of the paragraph", tag + " second line of it", tag + " and the last"].join("\n");
  const body = (tag: string) => Array.from({ length: 4 }, () => wrapped(tag)).join("\n\n");
  const text = [para("preface", 300), "", "Chapter 1", body("a"), "", "Chapter 2", body("b")].join("\n");
  const r = splitChapters(text, { fallbackTitle: "Book" });
  assert.deepEqual(r.chapters.map((c) => c.title), ["Book", "Chapter 1", "Chapter 2"]);
  assert.equal(r.chapters[1].paragraphs.length, 4);
  assert.equal(r.chapters[1].paragraphs[0], "a first line of the paragraph a second line of it a and the last");
});

test("very short chapters are reported", () => {
  const text = ["Chapter 1", "short", "Chapter 2", "short", "Chapter 3", "short"].join("\n");
  assert.ok(splitChapters(text).warnings.some((w) => w.includes("very short")));
});

test("decodeText: UTF-8 (BOM dropped) or GB18030; htmlToText keeps paragraphs, drops scripts", () => {
  assert.equal(decodeText(new Uint8Array([0xef, 0xbb, 0xbf, 0x68, 0x69])), "hi");
  assert.equal(decodeText(new Uint8Array([0xc4, 0xe3, 0xba, 0xc3])), "你好");
  const text = htmlToText("<h1>Chương 1</h1><p>Hello &amp; bye</p><script>evil()</script><p>Two<br>lines</p>");
  assert.deepEqual(text.split("\n").filter(Boolean), ["Chương 1", "Hello & bye", "Two", "lines"]);
});

test("buildEpub makes an EPUB our own reader parses back, with escaped text", () => {
  const nasty = "Fish & <chips> \"quoted\" " + String.fromCharCode(0, 8, 11) + "end";
  const bytes = buildEpub({
    title: "A & B", author: "Someone", language: "vi",
    chapters: [
      { title: "One <1>", blocks: [{ type: "p", text: nasty }, { type: "p", text: "second" }] },
      { title: "Two", blocks: [{ type: "h1", text: "Two" }, { type: "p", text: "body" }] },
    ],
  });
  // "mimetype" first and stored, as the EPUB container format requires
  assert.equal(strFromU8(bytes.slice(30, 38)), "mimetype");
  assert.equal(bytes[8], 0, "stored, not deflated");
  assert.equal(strFromU8(unzipSync(bytes)["mimetype"]), "application/epub+zip");

  const meta = parseEpubMeta(bytes);
  assert.equal(meta.title, "A & B");
  assert.equal(meta.author, "Someone");
  assert.equal(meta.language, "vi");
  assert.equal(meta.spine.length, 2);
  const got = extractChapterRange(bytes, meta.spine, meta.tocMap);
  assert.deepEqual(got.map((c) => c.title), ["One <1>", "Two"]);
  assert.equal(got[0].blocks.find((b) => b.type === "p")!.text, "Fish & <chips> \"quoted\" end", "control characters dropped, the rest intact");
  assert.equal(got[1].blocks.filter((b) => b.type === "h1").length, 1, "a chapter that starts with its own heading does not get a second one");
});

test("buildText lists the contents, then each chapter", () => {
  const out = buildText({ title: "T", author: "A", chapters: [
    { title: "One", blocks: [{ type: "p", text: "alpha" }] },
    { title: "Two", blocks: [{ type: "h1", text: "Two" }, { type: "p", text: "beta" }] },
  ] });
  assert.match(out, /^T\nA\n\nContents\n1\. One\n2\. Two\n/);
  assert.ok(out.indexOf("alpha") < out.indexOf("beta"));
  assert.equal(out.split("Two").length - 1, 2, "heading is not printed twice (contents + one heading)");
});
