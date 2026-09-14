import { unzipSync, strFromU8 } from "fflate";
import { XMLParser } from "fast-xml-parser";
import { Parser as HtmlParser } from "htmlparser2";
import type { BlockType, TextBlock } from "./types";

export interface SpineItem {
  order: number;
  id: string;
  href: string;
}

export interface ParsedEpubMeta {
  title: string;
  author: string | null;
  language: string | null;
  spine: SpineItem[];
  tocMap: Map<string, string>;
}

export interface ChapterRangeResult {
  order: number;
  title: string | null;
  blocks: TextBlock[];
}

interface ManifestItem {
  href: string;
  mediaType: string;
  properties: string;
}

function toArray<T>(v: T | T[] | undefined | null): T[] {
  if (v == null) return [];
  return Array.isArray(v) ? v : [v];
}

// Extract text from a possibly-object XML value (fast-xml-parser wraps text as #text
// when attributes are present).
function firstDc(v: unknown): string | null {
  if (v == null) return null;
  if (Array.isArray(v)) return firstDc(v[0]);
  if (typeof v === "object") {
    const t = (v as Record<string, unknown>)["#text"];
    return t == null ? null : String(t).trim();
  }
  return String(v).trim();
}

// Resolve `rel` (a manifest/toc href) against `base` (the file it appears in).
function resolvePath(base: string, rel: string): string {
  const baseDir = base.includes("/") ? base.slice(0, base.lastIndexOf("/")) : "";
  const stack = baseDir ? baseDir.split("/") : [];
  for (const part of rel.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") stack.pop();
    else stack.push(part);
  }
  return stack.join("/");
}

function headingType(tag: string): BlockType {
  if (tag === "h1") return "h1";
  if (tag === "h2") return "h2";
  return "h3";
}

const BLOCK_TAGS = new Set([
  "p", "div", "li", "blockquote",
  "h1", "h2", "h3", "h4", "h5", "h6",
]);
const SKIP_TAGS = new Set(["script", "style", "head", "svg"]);

// Walk XHTML and produce a flat list of heading/paragraph blocks.
function extractBlocks(html: string): TextBlock[] {
  const blocks: TextBlock[] = [];
  let current: { type: BlockType; parts: string[] } | null = null;
  let skipDepth = 0;

  const flush = () => {
    if (!current) return;
    const text = current.parts.join("").replace(/\s+/g, " ").trim();
    if (text) blocks.push({ type: current.type, text });
    current = null;
  };

  const parser = new HtmlParser(
    {
      onopentag(name) {
        const tag = name.toLowerCase();
        if (SKIP_TAGS.has(tag)) {
          skipDepth++;
          return;
        }
        if (tag === "br") {
          if (current) current.parts.push(" ");
          return;
        }
        if (BLOCK_TAGS.has(tag)) {
          flush();
          current = {
            type: tag[0] === "h" && tag.length === 2 ? headingType(tag === "h1" || tag === "h2" ? tag : "h3") : "p",
            parts: [],
          };
        }
      },
      ontext(text) {
        if (skipDepth > 0) return;
        if (!current) current = { type: "p", parts: [] };
        current.parts.push(text);
      },
      onclosetag(name) {
        const tag = name.toLowerCase();
        if (SKIP_TAGS.has(tag)) {
          if (skipDepth > 0) skipDepth--;
          return;
        }
        if (BLOCK_TAGS.has(tag)) flush();
      },
    },
    { decodeEntities: true },
  );

  parser.write(html);
  parser.end();
  flush();
  return blocks;
}

// Collect TOC titles from an NCX (EPUB 2) navMap into hrefWithoutFragment -> title.
function collectNcx(node: unknown, ncxPath: string, map: Map<string, string>): void {
  for (const n of toArray(node as Record<string, unknown>)) {
    const label = (n as Record<string, unknown>)?.["navLabel"] as Record<string, unknown> | undefined;
    const rawText = label?.["text"];
    const text = typeof rawText === "object" && rawText != null
      ? String((rawText as Record<string, unknown>)["#text"] ?? "")
      : rawText != null
        ? String(rawText)
        : "";
    const content = (n as Record<string, unknown>)?.["content"] as Record<string, unknown> | undefined;
    const src = content?.["@_src"];
    if (src && text) {
      const href = resolvePath(ncxPath, decodeURIComponent(String(src).split("#")[0]));
      if (!map.has(href)) map.set(href, text.trim());
    }
    const child = (n as Record<string, unknown>)?.["navPoint"];
    if (child) collectNcx(child, ncxPath, map);
  }
}

// Collect TOC titles from an EPUB 3 nav document (anchors) into href -> title.
function collectNav(html: string, navPath: string, map: Map<string, string>): void {
  let href: string | null = null;
  let parts: string[] = [];
  const parser = new HtmlParser(
    {
      onopentag(name, attribs) {
        if (name.toLowerCase() === "a") {
          href = attribs.href ?? null;
          parts = [];
        }
      },
      ontext(text) {
        if (href != null) parts.push(text);
      },
      onclosetag(name) {
        if (name.toLowerCase() === "a" && href) {
          const resolved = resolvePath(navPath, decodeURIComponent(href.split("#")[0]));
          const text = parts.join("").replace(/\s+/g, " ").trim();
          if (text && !map.has(resolved)) map.set(resolved, text);
          href = null;
        }
      },
    },
    { decodeEntities: true },
  );
  parser.write(html);
  parser.end();
}

// Parses only the EPUB's structure — container.xml, the OPF package, and the
// nav/NCX table of contents — never touching chapter HTML. Each unzipSync
// call below is filtered to one specific small file, so fflate skips
// decompressing everything else in the archive. That makes this safe to
// re-run on every ingest-chunk request (see index.ts) without its cost
// scaling with book size: a 3000-chapter book and a 10-chapter book cost
// roughly the same here.
export function parseEpubMeta(data: Uint8Array): ParsedEpubMeta {
  const xml = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_", trimValues: true });

  const containerFiles = unzipSync(data, { filter: (f) => f.name === "META-INF/container.xml" });
  const containerRaw = containerFiles["META-INF/container.xml"];
  if (!containerRaw) throw new Error("Not a valid EPUB: missing META-INF/container.xml");
  const container = xml.parse(strFromU8(containerRaw));
  const rootfileNode = container?.container?.rootfiles?.rootfile;
  const rootfile = Array.isArray(rootfileNode) ? rootfileNode[0] : rootfileNode;
  const opfPath: string | undefined = rootfile?.["@_full-path"];
  if (!opfPath) throw new Error("Not a valid EPUB: missing OPF package file");

  const opfFiles = unzipSync(data, { filter: (f) => f.name === opfPath });
  const opfRaw = opfFiles[opfPath];
  if (!opfRaw) throw new Error("Not a valid EPUB: missing OPF package file");
  const opf = xml.parse(strFromU8(opfRaw));
  const pkg = opf?.package;
  if (!pkg) throw new Error("Not a valid EPUB: unreadable OPF package");
  const metadata = pkg.metadata ?? {};

  const title = firstDc(metadata["dc:title"]) || "Untitled";
  const author = firstDc(metadata["dc:creator"]);
  const language = firstDc(metadata["dc:language"]);

  // Manifest: id -> resolved item.
  const manifest = new Map<string, ManifestItem>();
  for (const it of toArray<Record<string, unknown>>(pkg.manifest?.item)) {
    const id = String(it["@_id"] ?? "");
    if (!id) continue;
    const rawHref = String(it["@_href"] ?? "").split("#")[0];
    manifest.set(id, {
      href: resolvePath(opfPath, decodeURIComponent(rawHref)),
      mediaType: String(it["@_media-type"] ?? ""),
      properties: String(it["@_properties"] ?? ""),
    });
  }

  // Build TOC title map from nav (EPUB 3) and/or NCX (EPUB 2) — fetched in
  // one more filtered pass, together, since both are cheap and small.
  const navItem = [...manifest.values()].find((m) => m.properties.split(/\s+/).includes("nav"));
  const tocId: string | undefined = pkg.spine?.["@_toc"];
  const ncxItem = (tocId && manifest.get(tocId)) ||
    [...manifest.values()].find((m) => m.mediaType === "application/x-dtbncx+xml");

  const tocMap = new Map<string, string>();
  const auxHrefs = new Set<string>();
  if (navItem) auxHrefs.add(navItem.href);
  if (ncxItem) auxHrefs.add(ncxItem.href);
  if (auxHrefs.size > 0) {
    const auxFiles = unzipSync(data, { filter: (f) => auxHrefs.has(f.name) });
    if (navItem && auxFiles[navItem.href]) collectNav(strFromU8(auxFiles[navItem.href]), navItem.href, tocMap);
    if (ncxItem && auxFiles[ncxItem.href]) {
      const ncx = xml.parse(strFromU8(auxFiles[ncxItem.href]));
      collectNcx(ncx?.ncx?.navMap?.navPoint, ncxItem.href, tocMap);
    }
  }

  // Walk the spine in reading order, keeping only readable (X)HTML items.
  const spine: SpineItem[] = [];
  let order = 0;
  for (const ref of toArray<Record<string, unknown>>(pkg.spine?.itemref)) {
    const idref = String(ref["@_idref"] ?? "");
    const item = manifest.get(idref);
    if (!item) continue;
    const mt = item.mediaType.toLowerCase();
    if (!(mt.includes("xhtml") || mt.includes("html"))) continue;
    spine.push({ order, id: idref, href: item.href });
    order++;
  }

  return { title, author, language, spine, tocMap };
}

// Extracts the content of just the given spine items. `unzipSync`'s filter
// decompresses only files whose name is in `items` — the cost of this call
// scales with the size of `items`, not with the whole book — so the caller
// can process an EPUB in bounded-size chunks across multiple requests to
// stay under a Worker's per-request CPU time limit.
export function extractChapterRange(
  data: Uint8Array,
  items: SpineItem[],
  tocMap: Map<string, string>,
): ChapterRangeResult[] {
  const hrefSet = new Set(items.map((i) => i.href));
  const files = unzipSync(data, { filter: (f) => hrefSet.has(f.name) });
  const results: ChapterRangeResult[] = [];
  for (const item of items) {
    const raw = files[item.href];
    if (!raw) continue;
    const blocks = extractBlocks(strFromU8(raw));
    if (blocks.length === 0) continue;
    const title = tocMap.get(item.href) || blocks.find((b) => b.type !== "p")?.text.slice(0, 120) || null;
    results.push({ order: item.order, title, blocks });
  }
  return results;
}
