#!/usr/bin/env node
// Uploads an EPUB straight into the production D1 database + R2 bucket from
// your own machine, bypassing the deployed Worker (and its Cloudflare
// Workers CPU-time-per-request limit) entirely for the heavy lifting. All
// the parsing/extraction work — the part that's too CPU-expensive for a
// single Worker request on a multi-thousand-chapter book — runs locally,
// where there's no such limit. The result is written via `wrangler r2
// object put --remote` and `wrangler d1 execute --remote`, so the deployed
// app sees it exactly as if it had gone through /api/books itself.
//
// Usage:
//   node scripts/upload-book.ts <path-to-book.epub> [--dry-run] [--bucket <name>] [--db <name>]
//
// Requires `wrangler` to be authenticated for this account (`wrangler login`,
// or a CLOUDFLARE_API_TOKEN env var — the same one used in CI).
//
// --dry-run parses the EPUB and writes content.bin + insert.sql to a temp
// directory (path printed) without touching R2/D1 — use it first to sanity
// check a book before actually uploading it.

import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { parseEpubMeta, extractChapterRange } from "../src/epub.ts";
import { fakeCodeName, fakeFileName } from "../src/names.ts";

const DEFAULT_BUCKET = "epub-reader-books";
const DEFAULT_DB = "epub_reader_db";

function parseArgs(argv: string[]) {
  let epubPath: string | null = null;
  let bucket = DEFAULT_BUCKET;
  let db = DEFAULT_DB;
  let dryRun = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") dryRun = true;
    else if (a === "--bucket") bucket = argv[++i];
    else if (a === "--db") db = argv[++i];
    else if (!a.startsWith("--") && !epubPath) epubPath = a;
    else { console.error(`Unrecognized argument: ${a}`); process.exit(1); }
  }
  if (!epubPath) {
    console.error("Usage: node scripts/upload-book.ts <path-to-book.epub> [--dry-run] [--bucket <name>] [--db <name>]");
    process.exit(1);
  }
  return { epubPath, bucket, db, dryRun };
}

function sqlStr(v: string | null): string {
  if (v == null) return "NULL";
  return "'" + v.replace(/'/g, "''") + "'";
}

function run(cmd: string, args: string[]) {
  console.log(`> ${cmd} ${args.join(" ")}`);
  execFileSync(cmd, args, { stdio: "inherit" });
}

async function main() {
  const { epubPath, bucket, db, dryRun } = parseArgs(process.argv.slice(2));

  console.log(`Reading ${epubPath} ...`);
  const bytes = new Uint8Array(readFileSync(epubPath));

  const meta = parseEpubMeta(bytes);
  if (meta.spine.length === 0) {
    console.error("No readable chapters found in this EPUB.");
    process.exit(1);
  }
  console.log(`"${meta.title}" by ${meta.author ?? "(unknown)"} — ${meta.spine.length} chapters. Extracting...`);

  const t0 = Date.now();
  const chapters = extractChapterRange(bytes, meta.spine, meta.tocMap);
  console.log(`Extracted ${chapters.length} chapters in ${Date.now() - t0}ms (no CPU limit here — this is your machine).`);

  // Build one contiguous content blob + each chapter's byte range within it,
  // same layout the Worker itself writes (books/<id>/content.bin).
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [];
  const rows: { idx: number; title: string | null; file_name: string; char_count: number; offset: number; length: number }[] = [];
  let offset = 0;
  for (const ch of chapters) {
    const encoded = enc.encode(JSON.stringify(ch.blocks));
    parts.push(encoded);
    rows.push({
      idx: ch.order,
      title: ch.title,
      file_name: fakeFileName(ch.order),
      char_count: ch.blocks.reduce((s, b) => s + b.text.length, 0),
      offset,
      length: encoded.length,
    });
    offset += encoded.length;
  }
  const content = new Uint8Array(offset);
  let pos = 0;
  for (const p of parts) { content.set(p, pos); pos += p.length; }

  const id = randomUUID();
  const codeName = fakeCodeName(meta.title);
  const rawKey = `raw/${id}.epub`;
  const createdAt = Date.now();
  console.log(`Book id: ${id}  code_name: "${codeName}"  content.bin: ${(content.length / 1024 / 1024).toFixed(1)} MB`);

  const tmpDir = mkdtempSync(join(tmpdir(), "epub-upload-"));
  const contentPath = join(tmpDir, "content.bin");
  writeFileSync(contentPath, content);

  let sql = `INSERT INTO books (id, title, author, language, r2_key, code_name, chapter_count, created_at) VALUES (${sqlStr(id)}, ${sqlStr(meta.title)}, ${sqlStr(meta.author)}, ${sqlStr(meta.language)}, ${sqlStr(rawKey)}, ${sqlStr(codeName)}, ${rows.length}, ${createdAt});\n`;
  const BATCH = 500;
  for (let i = 0; i < rows.length; i += BATCH) {
    const values = rows.slice(i, i + BATCH)
      .map((r) => `(${sqlStr(id)}, ${r.idx}, ${sqlStr(r.title)}, ${sqlStr(r.file_name)}, '', ${r.char_count}, ${r.offset}, ${r.length})`)
      .join(",\n  ");
    sql += `INSERT INTO chapters (book_id, idx, title, file_name, content_key, char_count, byte_offset, byte_length) VALUES\n  ${values};\n`;
  }
  const sqlPath = join(tmpDir, "insert.sql");
  writeFileSync(sqlPath, sql, "utf-8");

  if (dryRun) {
    console.log(`\nDry run — nothing uploaded. Inspect the output:\n  content.bin: ${contentPath}\n  insert.sql:  ${sqlPath}`);
    return;
  }

  console.log("\nUploading raw .epub to R2...");
  run("npx", ["wrangler", "r2", "object", "put", `${bucket}/${rawKey}`, "--remote", "--file", epubPath, "--content-type", "application/epub+zip"]);

  console.log("Uploading content.bin to R2...");
  run("npx", ["wrangler", "r2", "object", "put", `${bucket}/books/${id}/content.bin`, "--remote", "--file", contentPath, "--content-type", "application/octet-stream"]);

  console.log("Inserting book + chapter rows into D1...");
  run("npx", ["wrangler", "d1", "execute", db, "--remote", "--file", sqlPath, "--yes"]);

  console.log(`\nDone. "${meta.title}" is live as "${codeName}" — ${rows.length} chapters.`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
