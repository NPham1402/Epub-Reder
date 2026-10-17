// Reads a vBook backup (the .tar.zst its "Backup" screen writes) one book at a
// time. Runtime-agnostic: the caller decompresses (zstd) and hands over the tar
// bytes as a stream, so a 200 MB backup never has to sit in memory at once.
//
// Layout (backup_version 1, see docs/platform-upgrade.md §13.2):
//   manifest.json
//   books/<id>/book.json        name/author/source + last_read_chapter_index/_percent, last_read
//   books/<id>/toc_links.json   [{ title: { raw }, position }]  — vBook's chapter order
//   books/<id>/contents/<id>_<position>/raw.txt   chapter text as simple HTML (only downloaded ones)
// Entries of one book are contiguous with book.json first; we still tolerate
// any order inside a book.

import { Parser as HtmlParser } from "htmlparser2";

export interface TarEntry { name: string; data: Uint8Array }

// Minimal streaming ustar reader (+ GNU long names and pax "path"), enough for
// what vBook writes. Regular files only.
export async function* tarEntries(src: AsyncIterable<Uint8Array>): AsyncGenerator<TarEntry> {
  const it = src[Symbol.asyncIterator]();
  let buf = new Uint8Array(0);
  let done = false;
  async function need(n: number): Promise<boolean> {
    while (buf.length < n && !done) {
      const r = await it.next();
      if (r.done) { done = true; break; }
      const merged = new Uint8Array(buf.length + r.value.length);
      merged.set(buf);
      merged.set(r.value, buf.length);
      buf = merged;
    }
    return buf.length >= n;
  }
  const take = (n: number) => { const out = buf.slice(0, n); buf = buf.subarray(n); return out; };
  const dec = new TextDecoder();
  const str = (h: Uint8Array, a: number, b: number) => dec.decode(h.subarray(a, b)).replace(/\0[\s\S]*$/, "");

  let longName: string | null = null;
  for (;;) {
    if (!(await need(512))) return;
    const h = take(512);
    if (h.every((b) => b === 0)) return; // end-of-archive block
    let name = str(h, 0, 100);
    const prefix = str(h, 345, 500);
    if (prefix) name = `${prefix}/${name}`;
    const size = parseInt(str(h, 124, 136).trim() || "0", 8);
    const type = str(h, 156, 157) || "0";
    const padded = Math.ceil(size / 512) * 512;
    if (!(await need(padded))) throw new Error("the backup is cut off (truncated tar entry)");
    const data = take(padded).subarray(0, size);
    if (type === "L") { longName = dec.decode(data).replace(/\0[\s\S]*$/, ""); continue; }
    if (type === "x") {
      const m = dec.decode(data).match(/\d+ path=([^\n]*)\n/);
      if (m) longName = m[1];
      continue;
    }
    if (type !== "0") { longName = null; continue; } // directories, links, global headers
    yield { name: longName ?? name, data };
    longName = null;
  }
}

export interface VbookProgress { idx: number; ratio: number; at: number; chapter: string | null }
export interface VbookBook {
  id: string;
  title: string;
  author: string | null;
  language: string | null;
  source: string | null;
  toc: string[];                          // chapter titles in vBook's order
  downloaded: number;                     // chapters with text in the backup
  contents: Map<number, string[]>;        // position -> paragraphs (only when asked for)
  progress: VbookProgress | null;
  meta: Record<string, unknown>;          // book.json without the long description
}
export interface VbookManifest { device_name?: string; backup_version?: number; create_at?: number }

const json = (d: Uint8Array) => JSON.parse(new TextDecoder().decode(d)) as unknown;
const raw = (v: unknown): string => (v && typeof v === "object" && "raw" in v ? String((v as { raw: unknown }).raw ?? "") : String(v ?? "")).trim();

// "Chương 2 - Nộ phạm thiên điều" and "Chương 2: Nộ phạm thiên điều" are the same title.
export const sameTitle = (a: string | null | undefined, b: string | null | undefined) =>
  !!a && !!b && a.normalize("NFC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "") === b.normalize("NFC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");

// vBook stores a chapter as simple HTML (text + <br><br>, sometimes <p>, <i>,
// <b>) whose first line repeats the title.
const BREAKS = new Set(["p", "div", "br", "li", "tr", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote"]);
export function chapterParagraphs(html: string, title: string): string[] {
  const out: string[] = [];
  let skip = 0;
  const parser = new HtmlParser({
    onopentag(name) { if (name === "script" || name === "style") skip++; else if (BREAKS.has(name)) out.push("\n"); },
    onclosetag(name) { if (name === "script" || name === "style") skip = Math.max(0, skip - 1); else if (BREAKS.has(name)) out.push("\n"); },
    ontext(t) { if (!skip) out.push(t); },
  }, { decodeEntities: true });
  parser.write(html);
  parser.end();
  const paras = out.join("").split("\n").map((s) => s.replace(/\s+/g, " ").trim()).filter(Boolean);
  if (paras.length > 1 && sameTitle(paras[0], title)) paras.shift();
  return paras;
}

interface Pending {
  meta: Record<string, unknown> | null;
  toc: { title: string; position: number }[] | null;
  contents: Map<number, string>;
  downloaded: number;
}

function finish(id: string, p: Pending, withContent: boolean): VbookBook | null {
  if (!p.meta) return null;
  const toc = (p.toc ?? []).slice().sort((a, b) => a.position - b.position).map((t) => t.title);
  const m = p.meta;
  const contents = new Map<number, string[]>();
  if (withContent) for (const [pos, html] of p.contents) contents.set(pos, chapterParagraphs(html, toc[pos] ?? ""));
  const idx = Number(m.last_read_chapter_index);
  const at = Number(m.last_read);
  return {
    id,
    title: raw(m.name) || "Untitled",
    author: raw(m.author) || null,
    language: typeof m.language === "string" ? m.language.replace("_", "-") : null,
    source: typeof m.source === "string" ? m.source : null,
    toc,
    downloaded: p.downloaded,
    contents,
    progress: Number.isFinite(idx) && idx >= 0 && Number.isFinite(at) && at > 0
      ? { idx, ratio: Math.min(1, Math.max(0, Number(m.last_read_chapter_percent) || 0)), at, chapter: typeof m.last_read_chapter_name === "string" ? m.last_read_chapter_name : null }
      : null,
    meta: Object.fromEntries(Object.entries(m).filter(([k]) => k !== "description")),
  };
}

// Calls onBook for every book, in archive order. With withContent=false the
// chapter text is only counted, not kept (a cheap preview pass).
export async function readVbookBackup(
  src: AsyncIterable<Uint8Array>,
  onBook: (b: VbookBook) => Promise<void>,
  opts: { withContent: boolean; only?: Set<string> },
): Promise<{ manifest: VbookManifest | null; books: number }> {
  let manifest: VbookManifest | null = null;
  let curId: string | null = null;
  let cur: Pending | null = null;
  const finished = new Set<string>();
  let books = 0;
  const flush = async () => {
    if (curId && cur) {
      const b = finish(curId, cur, opts.withContent);
      if (b) { books++; await onBook(b); }
      finished.add(curId);
    }
    curId = null;
    cur = null;
  };

  for await (const e of tarEntries(src)) {
    const name = e.name.replace(/^\.\//, "");
    if (name === "manifest.json") { manifest = json(e.data) as VbookManifest; continue; }
    const m = name.match(/^books\/([^/]+)\/(.+)$/);
    if (!m) continue;
    const [, id, rest] = m;
    if (id !== curId) {
      await flush();
      if (finished.has(id)) throw new Error("unexpected backup layout: a book's files are split up");
      curId = id;
      cur = { meta: null, toc: null, contents: new Map(), downloaded: 0 };
    }
    const keep = opts.withContent && (!opts.only || opts.only.has(id));
    if (rest === "book.json") cur!.meta = json(e.data) as Record<string, unknown>;
    else if (rest === "toc_links.json") {
      const list = json(e.data);
      cur!.toc = Array.isArray(list) ? list.map((t, i) => ({ title: raw((t as { title?: unknown }).title) || `Chapter ${i + 1}`, position: Number((t as { position?: unknown }).position ?? i) })) : [];
    } else {
      const c = rest.match(/^contents\/[^/]*_(\d+)\/raw\.txt$/);
      if (c) {
        cur!.downloaded++;
        if (keep) cur!.contents.set(Number(c[1]), new TextDecoder().decode(e.data));
      }
    }
  }
  await flush();
  return { manifest, books };
}
