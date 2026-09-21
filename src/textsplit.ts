// Turns a plain-text (or simple HTML) file into chapters: decode it, find the
// chapter headings, and cut. Runs on the server so the rules live in one place
// and are tested; the browser only sends the file and shows the preview.

import { Parser as HtmlParser } from "htmlparser2";

export interface SplitChapter { title: string; paragraphs: string[] }
export type SplitRule = "vi" | "zh" | "en" | "numbered" | "length" | "single";
export interface SplitResult {
  chapters: SplitChapter[];
  rule: SplitRule;
  chars: number;
  warnings: string[];
}

// Characters that are invisible or look like spaces, built from code points so no
// invisible character has to live in this source file.
const BOM = String.fromCharCode(0xfeff);
const CR = String.fromCharCode(13);
const LF = String.fromCharCode(10);
const ZERO_WIDTH = new RegExp("[" + String.fromCharCode(0x200b, 0x200c, 0x200d, 0xfeff) + "]", "g");
const SPACES = new RegExp("[" + String.fromCharCode(0x3000, 9, 32) + "]+", "g");
const stripBom = (s: string) => (s.startsWith(BOM) ? s.slice(1) : s);

// UTF-8 when the bytes are valid UTF-8
// common legacy encoding for Chinese text files, GB18030.
export function decodeText(bytes: Uint8Array): string {
  try {
    return stripBom(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes));
  } catch {
    return new TextDecoder("gb18030").decode(bytes);
  }
}

const BLOCK_TAGS = new Set(["p", "div", "br", "li", "tr", "h1", "h2", "h3", "h4", "h5", "h6", "section", "article", "blockquote"]);
export function htmlToText(html: string): string {
  const out: string[] = [];
  let skip = 0;
  const parser = new HtmlParser({
    onopentag(name) { if (name === "script" || name === "style") skip++; else if (BLOCK_TAGS.has(name)) out.push("\n"); },
    onclosetag(name) { if (name === "script" || name === "style") skip = Math.max(0, skip - 1); else if (BLOCK_TAGS.has(name)) out.push("\n"); },
    ontext(t) { if (!skip) out.push(t); },
  }, { decodeEntities: true });
  parser.write(html);
  parser.end();
  return out.join("").replace(/[ \t]*\n[ \t]*/g, "\n");
}

// ---- Chapter headings ---------------------------------------------------------
const VI_WORDS = "một|hai|ba|bốn|năm|sáu|bảy|tám|chín|mười|mươi|mốt|lăm|trăm|nghìn|ngàn|nhất";
const VI = new RegExp(
  `^(?:chương|chuong|hồi|hoi|quyển|quyen|tập|tap|phần|phan)\\s*(?:thứ\\s*)?[.:\\-–—]?\\s*(\\d{1,5}|[ivxlcdmIVXLCDM]{1,8}|(?:${VI_WORDS})(?:\\s+(?:${VI_WORDS}))*)(?=$|[\\s:.\\-–—])`, "i");
const EN_WORDS = "one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|hundred";
const EN = new RegExp(`^(?:chapter|chap\\.?|part|book)\\s*(\\d{1,5}|[ivxlcdmIVXLCDM]{1,8}|(?:${EN_WORDS})(?:[- ](?:${EN_WORDS}))*)(?=$|[\\s:.\\-–—])`, "i");
const ZH = /^第\s*[0-9零〇一二三四五六七八九十百千万两]{1,9}\s*[章回节節卷集篇部]/;
const NUMBERED = /^(\d{1,5})\s*[.、:：)\-–—]\s*\S/;

// A roman numeral is only a number when written in capitals ("Phần I", not
// "Tập di chuyển"), so "d" or "mix" in an ordinary sentence never counts.
function numberTokenOk(tok: string): boolean {
  if (/^[ivxlcdm]+$/i.test(tok)) return /^[IVXLCDM]+$/.test(tok) || /^\d+$/.test(tok);
  return true;
}
function matchHeading(rule: "vi" | "en", t: string): boolean {
  const m = (rule === "vi" ? VI : EN).exec(t);
  return !!m && numberTokenOk(m[1]);
}

function isHeadingLine(rule: SplitRule, t: string): boolean {
  if (t.length === 0 || t.length > 60 || /[,;，；]$/.test(t)) return false;
  switch (rule) {
    case "vi": return matchHeading("vi", t);
    case "en": return matchHeading("en", t);
    case "zh": return ZH.test(t);
    case "numbered": return NUMBERED.test(t);
    default: return false;
  }
}

function isCjk(s: string): boolean {
  for (const ch of s) {
    const n = ch.codePointAt(0)!;
    if ((n >= 0x3040 && n <= 0x30ff) || (n >= 0x3400 && n <= 0x9fff)) return true;
  }
  return false;
}
const tidy = (s: string) => s.replace(ZERO_WIDTH, "").replace(SPACES, " ").trim();

export function splitChapters(input: string, opts: { targetChars?: number; fallbackTitle?: string } = {}): SplitResult {
  const target = opts.targetChars ?? 20_000;
  const fallbackTitle = opts.fallbackTitle || "Text";
  const text = stripBom(input.split(CR + LF).join(LF).split(CR).join(LF));
  const lines = text.split("\n");
  const chars = text.replace(/\s/g, "").length;
  const warnings: string[] = [];

  // Which rule fits best? Count heading-looking lines under each.
  const hits: Record<string, number[]> = { vi: [], zh: [], en: [], numbered: [] };
  for (let i = 0; i < lines.length; i++) {
    const t = tidy(lines[i]);
    for (const r of ["vi", "zh", "en", "numbered"] as const) if (isHeadingLine(r, t)) hits[r].push(i);
  }
  // "1. Foo" lines also appear in lists: only trust them as chapters when they
  // count up one by one.
  const nums = hits.numbered.map((i) => Number(NUMBERED.exec(tidy(lines[i]))![1]));
  const steps = nums.slice(1).filter((n, k) => n === nums[k] + 1).length;
  if (nums.length < 5 || steps < (nums.length - 1) * 0.8) hits.numbered = [];

  let rule: SplitRule = "length";
  let best = 0;
  for (const r of ["vi", "zh", "en", "numbered"] as const) {
    if (hits[r].length > best) { best = hits[r].length; rule = r; }
  }
  if (best < 2) rule = "length";

  // Are paragraphs one per line, or hard-wrapped blocks separated by blank lines?
  // Hard-wrapped text (e.g. Project Gutenberg) has short lines (~60-80 chars) in
  // blocks separated by blank lines. A novel with one paragraph per line and a
  // blank line between chapters also has multi-line blocks, but its lines are long.
  const headingLines = new Set<number>(rule === "length" ? [] : hits[rule]);
  const blocks: number[] = [];
  const lengths: number[] = [];
  let run = 0;
  for (let i = 0; i < lines.length; i++) {
    const t = tidy(lines[i]);
    if (t && !headingLines.has(i)) { run++; lengths.push(t.length); }
    else if (run) { blocks.push(run); run = 0; }
  }
  if (run) blocks.push(run);
  lengths.sort((a, b) => a - b);
  const median = lengths.length ? lengths[lengths.length >> 1] : 0;
  const wrapped = blocks.length >= 5 && blocks.filter((n) => n >= 2).length / blocks.length > 0.3 && median <= 100;
  const cjk = isCjk(text.slice(0, 5000));
  const toParagraphs = (chunk: string[]): string[] => {
    if (!wrapped) return chunk.map(tidy).filter(Boolean);
    const out: string[] = [];
    let cur: string[] = [];
    const flush = () => { if (cur.length) out.push(cur.join(cjk ? "" : " ")); cur = []; };
    for (const l of chunk) { const t = tidy(l); if (t) cur.push(t); else flush(); }
    flush();
    return out;
  };

  let chapters: SplitChapter[] = [];
  if (rule !== "length") {
    const starts = hits[rule];
    const pre = toParagraphs(lines.slice(0, starts[0]));
    if (pre.join("").length >= 200) chapters.push({ title: fallbackTitle, paragraphs: pre });
    starts.forEach((s, k) => {
      const paragraphs = toParagraphs(lines.slice(s + 1, k + 1 < starts.length ? starts[k + 1] : lines.length));
      if (paragraphs.length) chapters.push({ title: tidy(lines[s]), paragraphs });
    });
  } else {
    const paragraphs = toParagraphs(lines);
    let cur: string[] = [];
    let size = 0;
    for (const p of paragraphs) {
      cur.push(p);
      size += p.length;
      if (size >= target) { chapters.push({ title: "", paragraphs: cur }); cur = []; size = 0; }
    }
    if (cur.length) chapters.push({ title: "", paragraphs: cur });
    chapters = chapters.map((c, i) => ({ ...c, title: chapters.length === 1 ? fallbackTitle : `Part ${i + 1}` }));
    if (chapters.length > 1) warnings.push(`No chapter headings were recognised, so the text was cut every ~${target.toLocaleString("en")} characters.`);
    else rule = "single";
  }

  const size = (c: SplitChapter) => c.paragraphs.join("").length;
  const tiny = chapters.filter((c) => size(c) < 200).length;
  const huge = chapters.filter((c) => size(c) > 200_000).length;
  if (tiny) warnings.push(`${tiny} chapter${tiny === 1 ? " is" : "s are"} very short (under 200 characters) — the headings may be mis-detected.`);
  if (huge) warnings.push(`${huge} chapter${huge === 1 ? " is" : "s are"} very long (over 200,000 characters).`);
  return { chapters, rule, chars, warnings };
}
