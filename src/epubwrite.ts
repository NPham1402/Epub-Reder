// Builds a valid EPUB from chapter text, entirely in memory (fflate only, no
// runtime-specific APIs). Used to export a book and to turn a plain-text file
// into a book the normal EPUB pipeline can ingest.

import { zipSync, strToU8 } from "fflate";
import type { Zippable } from "fflate";

export interface EpubChapter {
  title: string;
  blocks: { type: string; text: string }[];
}
export interface EpubInput {
  title: string;
  author?: string | null;
  language?: string | null;
  chapters: EpubChapter[];
}

// XML 1.0 forbids most control characters, so a stray one would make a reader
// reject the whole chapter; they are dropped rather than escaped.
const BAD_XML_CHARS = new RegExp("[" + Array.from({ length: 32 }, (_, i) => i).filter((i) => i !== 9 && i !== 10 && i !== 13).concat(0xfffe, 0xffff).map((n) => String.fromCharCode(n)).join("") + "]", "g");
const esc = (s: string) =>
  s.replace(BAD_XML_CHARS, "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const fileOf = (i: number) => `c${String(i + 1).padStart(5, "0")}.xhtml`;
const isHeading = (t: string) => t === "h1" || t === "h2" || t === "h3";

function chapterXhtml(ch: EpubChapter, lang: string): string {
  const firstIsHeading = ch.blocks.length > 0 && isHeading(ch.blocks[0].type);
  const body: string[] = [];
  if (!firstIsHeading) body.push(`<h1>${esc(ch.title)}</h1>`);
  for (const b of ch.blocks) {
    const tag = isHeading(b.type) ? b.type : "p";
    body.push(`<${tag}>${esc(b.text)}</${tag}>`);
  }
  return `<?xml version="1.0" encoding="utf-8"?>\n<!DOCTYPE html>\n` +
    `<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="${esc(lang)}" lang="${esc(lang)}">` +
    `<head><meta charset="utf-8"/><title>${esc(ch.title)}</title></head>\n<body>\n${body.join("\n")}\n</body></html>\n`;
}

export function buildEpub(input: EpubInput): Uint8Array {
  const lang = input.language || "und";
  const title = input.title || "Untitled";
  const id = `urn:uuid:${crypto.randomUUID()}`;
  const chapters = input.chapters.map((c, i) => ({ ...c, title: c.title || `Part ${i + 1}` }));

  const manifest = chapters.map((_, i) => `<item id="c${i + 1}" href="${fileOf(i)}" media-type="application/xhtml+xml"/>`).join("\n    ");
  const spine = chapters.map((_, i) => `<itemref idref="c${i + 1}"/>`).join("\n    ");
  const opf = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid" xml:lang="${esc(lang)}">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="bookid">${id}</dc:identifier>
    <dc:title>${esc(title)}</dc:title>${input.author ? `\n    <dc:creator>${esc(input.author)}</dc:creator>` : ""}
    <dc:language>${esc(lang)}</dc:language>
    <meta property="dcterms:modified">${new Date().toISOString().replace(/\.\d+Z$/, "Z")}</meta>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
    ${manifest}
  </manifest>
  <spine toc="ncx">
    ${spine}
  </spine>
</package>
`;
  const navItems = chapters.map((c, i) => `<li><a href="${fileOf(i)}">${esc(c.title)}</a></li>`).join("\n      ");
  const nav = `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="${esc(lang)}">
<head><meta charset="utf-8"/><title>${esc(title)}</title></head>
<body>
  <nav epub:type="toc" id="toc">
    <ol>
      ${navItems}
    </ol>
  </nav>
</body></html>
`;
  const navPoints = chapters.map((c, i) =>
    `<navPoint id="n${i + 1}" playOrder="${i + 1}"><navLabel><text>${esc(c.title)}</text></navLabel><content src="${fileOf(i)}"/></navPoint>`).join("\n    ");
  const ncx = `<?xml version="1.0" encoding="utf-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <head><meta name="dtb:uid" content="${id}"/></head>
  <docTitle><text>${esc(title)}</text></docTitle>
  <navMap>
    ${navPoints}
  </navMap>
</ncx>
`;

  // "mimetype" must be the first entry and stored uncompressed (EPUB OCF rule).
  const files: Zippable = {
    mimetype: [strToU8("application/epub+zip"), { level: 0 }],
    "META-INF/container.xml": strToU8(
      `<?xml version="1.0" encoding="utf-8"?>\n<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">\n` +
      `  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>\n</container>\n`),
    "OEBPS/content.opf": strToU8(opf),
    "OEBPS/nav.xhtml": strToU8(nav),
    "OEBPS/toc.ncx": strToU8(ncx),
  };
  chapters.forEach((c, i) => { files[`OEBPS/${fileOf(i)}`] = strToU8(chapterXhtml(c, lang)); });
  return zipSync(files);
}

// Plain-text version of the same input: title, contents, then each chapter with
// its paragraphs separated by blank lines.
export function buildText(input: EpubInput): string {
  const out: string[] = [input.title || "Untitled"];
  if (input.author) out.push(input.author);
  out.push("", "Contents");
  input.chapters.forEach((c, i) => out.push(`${i + 1}. ${c.title || `Part ${i + 1}`}`));
  input.chapters.forEach((c, i) => {
    out.push("", "=".repeat(40), "", c.title || `Part ${i + 1}`, "");
    const skipFirst = c.blocks.length > 0 && isHeading(c.blocks[0].type) && c.blocks[0].text.trim() === (c.title || "").trim();
    c.blocks.forEach((b, k) => { if (!(k === 0 && skipFirst)) out.push(b.text, ""); });
  });
  return out.join("\n") + "\n";
}
