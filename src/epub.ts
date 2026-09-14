import { unzipSync, strFromU8 } from "fflate";
import { XMLParser } from "fast-xml-parser";
import { Parser as HtmlParser } from "htmlparser2";
import type { BlockType, ParsedBookMeta, ParsedChapter, TextBlock } from "./types";

export interface EpubCallbacks {
  // Called once, after the OPF/manifest/TOC are parsed but before any chapter
  // is decoded — lets the caller create the book's DB row up front so
  // chapter rows (inserted per-chapter as streaming proceeds) always have a
  // parent to reference.
  onMeta: (meta: ParsedBookMeta) => void | Promise<void>;
  // Called once per spine chapter, in reading order. The caller should
  // persist/serialize the chapter immediately and let it go — parseEpub does
  // not retain chapters after this returns, which is what keeps memory
  // bounded for books with thousands of chapters.
  onChapter: (chapter: ParsedChapter) => void | Promise<void>;
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

// Parses an EPUB and streams its chapters out one at a time via callbacks
// instead of returning them all as one in-memory array. A book with a few
// thousand chapters can hold tens of MB of decoded text; retaining every
// chapter until the end (plus the still-live decompressed zip contents)
// is what pushes a Worker isolate over its memory limit. Discarding each
// chapter's blocks as soon as the caller has consumed them keeps peak memory
// roughly constant regardless of book length.
export async function parseEpub(data: Uint8Array, cb: EpubCallbacks): Promise<{ chapterCount: number }> {
  const files = unzipSync(data);
  const xml = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_", trimValues: true });

  const containerRaw = files["META-INF/container.xml"];
  if (!containerRaw) throw new Error("Not a valid EPUB: missing META-INF/container.xml");
  const container = xml.parse(strFromU8(containerRaw));
  const rootfileNode = container?.container?.rootfiles?.rootfile;
  const rootfile = Array.isArray(rootfileNode) ? rootfileNode[0] : rootfileNode;
  const opfPath: string | undefined = rootfile?.["@_full-path"];
  if (!opfPath || !files[opfPath]) throw new Error("Not a valid EPUB: missing OPF package file");

  const opf = xml.parse(strFromU8(files[opfPath]));
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

  // Build TOC title map from nav (EPUB 3) and/or NCX (EPUB 2).
  const tocMap = new Map<string, string>();
  const navItem = [...manifest.values()].find((m) =>
    m.properties.split(/\s+/).includes("nav"),
  );
  if (navItem && files[navItem.href]) {
    collectNav(strFromU8(files[navItem.href]), navItem.href, tocMap);
  }
  const tocId: string | undefined = pkg.spine?.["@_toc"];
  const ncxItem = (tocId && manifest.get(tocId)) ||
    [...manifest.values()].find((m) => m.mediaType === "application/x-dtbncx+xml");
  if (ncxItem && files[ncxItem.href]) {
    const ncx = xml.parse(strFromU8(files[ncxItem.href]));
    collectNcx(ncx?.ncx?.navMap?.navPoint, ncxItem.href, tocMap);
  }

  await cb.onMeta({ title, author, language });

  // Walk the spine in reading order, streaming each chapter to the caller
  // and dropping our own reference to its decompressed source (`files[href]`)
  // right after — freeing that share of the unzipped archive incrementally
  // instead of holding the whole thing until the request ends.
  let order = 0;
  for (const ref of toArray<Record<string, unknown>>(pkg.spine?.itemref)) {
    const idref = String(ref["@_idref"] ?? "");
    const item = manifest.get(idref);
    if (!item) continue;
    const mt = item.mediaType.toLowerCase();
    if (!(mt.includes("xhtml") || mt.includes("html"))) continue;
    const raw = files[item.href];
    if (!raw) continue;

    const blocks = extractBlocks(strFromU8(raw));
    delete files[item.href];
    if (blocks.length === 0) continue;

    const chapterTitle =
      tocMap.get(item.href) ||
      blocks.find((b) => b.type !== "p")?.text.slice(0, 120) ||
      null;

    await cb.onChapter({ order, id: idref, href: item.href, title: chapterTitle, blocks });
    order++;
  }

  if (order === 0) throw new Error("No readable chapters found in EPUB");
  return { chapterCount: order };
}
