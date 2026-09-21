// Full-text search helpers. The index (SQLite FTS5) stores each chapter's text
// with "đ" folded to "d" — FTS5's diacritic removal handles every other
// Vietnamese mark, but not that one — and queries get the same treatment, so
// "dao chu" finds "đạo chủ".

// Folds đ/Đ to d/D. (Other diacritics are removed by the FTS5 tokenizer.)
export const foldVi = (s: string): string => s.normalize("NFC").replace(/đ/g, "d").replace(/Đ/g, "D");

const isCombining = (cp: number) => cp >= 0x300 && cp <= 0x36f;

// Lower-cased text with every diacritic stripped, plus where each character
// came from in the original — so a match found in the plain text can be shown
// (and highlighted) in the original wording.
export function foldWithMap(text: string): { folded: string; map: number[] } {
  let folded = "";
  const map: number[] = [];
  let i = 0;
  for (const ch of text) {
    // NFD splits a letter from its marks (which are then dropped); đ has no such split.
    const plain = ch.normalize("NFD").replace(/đ/g, "d").replace(/Đ/g, "D").toLowerCase();
    for (const c of plain) {
      if (isCombining(c.codePointAt(0)!)) continue;
      folded += c;
      for (let k = 0; k < c.length; k++) map.push(i);
    }
    i += ch.length;
  }
  return { folded, map };
}

// An FTS5 MATCH expression: every word must appear (in any order), the last one
// as a prefix so results appear while typing. Words are letters/digits only, so
// nothing the user types can change the query's structure.
export function buildMatch(query: string): { match: string; tokens: string[] } | null {
  const tokens = foldWithMap(query).folded.split(/[^\p{L}\p{N}]+/u).filter(Boolean).slice(0, 8);
  if (!tokens.length) return null;
  return { match: tokens.map((t, i) => `"${t}"${i === tokens.length - 1 ? "*" : ""}`).join(" "), tokens };
}

export interface Hit { p: number; snippet: string; from: number; to: number }

// The paragraphs of a chapter that show the query: those containing every word
// first, then (if the words are spread over different paragraphs) those with
// the first word. Each comes with a short snippet in the original text.
export function findHits(blocks: { text: string }[], tokens: string[], maxHits = 3, context = 60): Hit[] {
  const all: Hit[] = [];
  const some: Hit[] = [];
  blocks.forEach((b, p) => {
    if (!b.text) return;
    const { folded, map } = foldWithMap(b.text);
    const at = folded.indexOf(tokens[0]);
    if (at < 0) return;
    const start = map[at] ?? 0;
    const endFolded = Math.min(folded.length, at + tokens[0].length) - 1;
    const end = (map[endFolded] ?? start) + 1;
    const lo = Math.max(0, start - context);
    const hi = Math.min(b.text.length, end + context);
    const hit: Hit = {
      p,
      snippet: (lo > 0 ? "…" : "") + b.text.slice(lo, hi) + (hi < b.text.length ? "…" : ""),
      from: start - lo + (lo > 0 ? 1 : 0),
      to: end - lo + (lo > 0 ? 1 : 0),
    };
    (tokens.every((t) => folded.includes(t)) ? all : some).push(hit);
  });
  return (all.length ? all : some).slice(0, maxHits);
}
