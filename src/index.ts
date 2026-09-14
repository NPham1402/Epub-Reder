import { Hono } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import type { Env } from "./types";
import { parseEpubMeta, extractChapterRange, type SpineItem } from "./epub";
import { fakeCodeName, fakeFileName } from "./names";
import { passcodeMatches, signSession, verifySession } from "./auth";

const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30; // 30 days
const MAX_EPUB_BYTES = 80 * 1024 * 1024; // 80 MB guard
const META_PER_BATCH = 150; // chapter-metadata inserts per D1 batch
// R2 multipart parts must all be the exact same size except the last, and
// >= 5MiB; 8MiB gives headroom above that minimum.
const PART_SIZE_BYTES = 8 * 1024 * 1024;
// Chapters processed per /ingest-chunk call. Cloudflare's Free plan kills a
// request around ~2s of CPU time; extracting+encoding a chapter costs well
// under 1ms, so this leaves a wide safety margin while still finishing a
// multi-thousand-chapter book in a handful of requests.
const CHUNK_SIZE = 300;

const app = new Hono<{ Bindings: Env }>();

const contentBinKey = (id: string) => `books/${id}/content.bin`;
const legacyContentKey = (id: string) => `books/${id}/content.json`;
const pendingKey = (id: string) => `books/${id}/_pending.bin`;

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

interface ChapterMeta {
  idx: number;
  title: string | null;
  file_name: string;
  char_count: number;
  offset: number;
  length: number;
}

interface ContentWriterState {
  uploadId: string | null;
  partNumber: number;
  offset: number;
  parts: R2UploadedPart[];
  pendingBytes: Uint8Array | null;
}

// Accumulates chapter byte-blocks and writes them to one contiguous R2
// object without ever holding the whole book in memory at once. R2 requires
// every multipart part except the last to be exactly the same size (not
// merely "at least 5MiB"), so once buffered data reaches PART_SIZE_BYTES we
// slice off exactly that many bytes as a part and keep any overflow for the
// next one. Small books that never reach the threshold fall back to a
// single put() so the common case doesn't pay for multipart overhead.
//
// An instance lives only for one HTTP request (one ingest-chunk call), so
// its constructor accepts a snapshot of state from the previous request and
// snapshot() hands back new state for the caller to persist (D1 columns +
// an R2 scratch object for the not-yet-part-sized leftover bytes) — that's
// what lets ingestion resume across requests instead of needing to fit a
// whole book's CPU cost into one.
class ContentWriter {
  private multipart: R2MultipartUpload | null;
  private parts: R2UploadedPart[];
  private partNumber: number;
  private pending: Uint8Array[];
  private pendingLen: number;
  private offset: number;

  constructor(private env: Env, private key: string, state: ContentWriterState) {
    this.multipart = state.uploadId ? env.BOOKS.resumeMultipartUpload(key, state.uploadId) : null;
    this.parts = [...state.parts];
    this.partNumber = state.partNumber;
    this.offset = state.offset;
    this.pending = state.pendingBytes && state.pendingBytes.length ? [state.pendingBytes] : [];
    this.pendingLen = state.pendingBytes?.length ?? 0;
  }

  // Records `bytes` at the next offset and returns its {offset, length}.
  async append(bytes: Uint8Array): Promise<{ offset: number; length: number }> {
    const offset = this.offset;
    this.pending.push(bytes);
    this.pendingLen += bytes.length;
    this.offset += bytes.length;
    while (this.pendingLen >= PART_SIZE_BYTES) await this.flushPart(PART_SIZE_BYTES);
    return { offset, length: bytes.length };
  }

  // Merges buffered chunks into one contiguous view (copying only when more
  // than one chunk is pending). Non-destructive — safe to call more than once.
  private mergePending(): Uint8Array {
    if (this.pending.length <= 1) return this.pending[0] ?? new Uint8Array(0);
    const out = new Uint8Array(this.pendingLen);
    let pos = 0;
    for (const chunk of this.pending) { out.set(chunk, pos); pos += chunk.length; }
    return out;
  }

  // Uploads exactly `size` bytes as one part, keeping any overflow buffered.
  private async flushPart(size: number): Promise<void> {
    if (!this.multipart) {
      this.multipart = await this.env.BOOKS.createMultipartUpload(this.key, {
        httpMetadata: { contentType: "application/octet-stream" },
      });
    }
    const merged = this.mergePending();
    const chunk = merged.subarray(0, size);
    const rest = merged.subarray(size);
    this.pending = rest.length ? [rest] : [];
    this.pendingLen = rest.length;
    const part = await this.multipart.uploadPart(this.partNumber++, chunk);
    this.parts.push(part);
  }

  // Snapshot of resumable state for the caller to persist between requests.
  snapshot(): ContentWriterState {
    return {
      uploadId: this.multipart?.uploadId ?? null,
      partNumber: this.partNumber,
      offset: this.offset,
      parts: this.parts,
      pendingBytes: this.mergePending(),
    };
  }

  // Completes the object: the true final part (which may be smaller than
  // PART_SIZE_BYTES — only the very last part is allowed to differ in size).
  async finish(): Promise<void> {
    if (!this.multipart) {
      await this.env.BOOKS.put(this.key, this.mergePending(), {
        httpMetadata: { contentType: "application/octet-stream" },
      });
      return;
    }
    if (this.pendingLen > 0) {
      const part = await this.multipart.uploadPart(this.partNumber++, this.mergePending());
      this.parts.push(part);
    }
    await this.multipart.complete(this.parts);
  }

  async abort(): Promise<void> {
    if (this.multipart) { try { await this.multipart.abort(); } catch {} }
  }
}

// Buffers chapter-metadata rows (small — no blocks) and inserts them in
// bounded D1 batches as they arrive, instead of waiting for the whole chunk.
class MetaWriter {
  private pending: ChapterMeta[] = [];
  constructor(private env: Env, private bookId: string) {}

  async add(meta: ChapterMeta): Promise<void> {
    this.pending.push(meta);
    if (this.pending.length >= META_PER_BATCH) await this.flush();
  }

  async flush(): Promise<void> {
    if (this.pending.length === 0) return;
    const slice = this.pending;
    this.pending = [];
    const stmts = slice.map((m) =>
      this.env.DB.prepare(
        `INSERT INTO chapters (book_id, idx, title, file_name, content_key, char_count, byte_offset, byte_length)
         VALUES (?, ?, ?, ?, '', ?, ?, ?)`,
      ).bind(this.bookId, m.idx, m.title, m.file_name, m.char_count, m.offset, m.length),
    );
    await this.env.DB.batch(stmts);
  }
}

interface BookIngestRow {
  r2_key: string;
  chapter_count: number;
  ingest_done: number;
  ingest_upload_id: string | null;
  ingest_part_number: number;
  ingest_offset: number;
  ingest_parts_json: string;
}

// Aborts a book's in-progress multipart upload (if any) and clears its
// scratch pending object. Used before re-indexing and before deleting a book
// that was left mid-ingest.
async function abortIngest(env: Env, id: string, uploadId: string | null): Promise<void> {
  if (uploadId) {
    try { await env.BOOKS.resumeMultipartUpload(contentBinKey(id), uploadId).abort(); } catch {}
  }
  await env.BOOKS.delete(pendingKey(id)).catch(() => {});
}

// --- Auth gate for all API routes except login/logout ------------------------
app.use("/api/*", async (c, next) => {
  const path = new URL(c.req.url).pathname;
  if (path === "/api/auth" || path === "/api/logout") return next();
  const token = getCookie(c, "session");
  if (!token || !(await verifySession(token, c.env.SESSION_SECRET))) {
    return c.json({ error: "unauthorized" }, 401);
  }
  return next();
});

// --- Auth --------------------------------------------------------------------
app.post("/api/auth", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { passcode?: string };
  if (!body.passcode || !passcodeMatches(body.passcode, c.env.ACCESS_PASSCODE)) {
    return c.json({ error: "invalid passcode" }, 401);
  }
  const token = await signSession(c.env.SESSION_SECRET, SESSION_TTL_MS);
  setCookie(c, "session", token, {
    httpOnly: true, secure: true, sameSite: "Lax", path: "/", maxAge: SESSION_TTL_MS / 1000,
  });
  return c.json({ ok: true });
});

app.post("/api/logout", (c) => {
  deleteCookie(c, "session", { path: "/" });
  return c.json({ ok: true });
});

// --- Books list --------------------------------------------------------------
// Only fully-ingested books are listed — a book mid-chunked-ingest has no
// usable content yet, and its own upload/reindex flow tracks its progress.
app.get("/api/books", async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT id, title, author, code_name, chapter_count, created_at
     FROM books WHERE ingest_done = 1 ORDER BY created_at DESC`,
  ).all();
  return c.json({ books: results });
});

// --- Upload: stage 1 — store the raw file + cheap metadata, no chapter
// content yet. The client then drives /ingest-chunk to completion. ----------
app.post("/api/books", async (c) => {
  let id: string | null = null;
  let rawKey: string | null = null;
  try {
    const form = await c.req.formData().catch(() => null);
    const file = form?.get("file");
    if (!(file instanceof File)) return c.json({ error: "missing file" }, 400);
    const buffer = await file.arrayBuffer();
    if (buffer.byteLength > MAX_EPUB_BYTES) return c.json({ error: "file too large" }, 413);
    const bytes = new Uint8Array(buffer);

    let meta;
    try { meta = parseEpubMeta(bytes); }
    catch (err) { return c.json({ error: "could not parse EPUB: " + errMsg(err) }, 422); }
    if (meta.spine.length === 0) {
      return c.json({ error: "could not parse EPUB: no readable chapters found" }, 422);
    }

    id = crypto.randomUUID();
    rawKey = `raw/${id}.epub`;
    const codeName = fakeCodeName(meta.title);
    await c.env.BOOKS.put(rawKey, bytes, { httpMetadata: { contentType: "application/epub+zip" } });
    await c.env.DB.prepare(
      `INSERT INTO books (id, title, author, language, r2_key, code_name, chapter_count, created_at, ingest_done)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)`,
    ).bind(id, meta.title, meta.author, meta.language, rawKey, codeName, meta.spine.length, Date.now()).run();

    return c.json({ id, title: meta.title, code_name: codeName, total: meta.spine.length });
  } catch (err) {
    if (id) {
      try {
        await c.env.DB.batch([
          c.env.DB.prepare(`DELETE FROM chapters WHERE book_id = ?`).bind(id),
          c.env.DB.prepare(`DELETE FROM books WHERE id = ?`).bind(id),
        ]);
        await c.env.BOOKS.delete([contentBinKey(id), ...(rawKey ? [rawKey] : [])]);
      } catch {}
    }
    console.error("upload error", err);
    return c.json({ error: "server error: " + errMsg(err) }, 500);
  }
});

// --- Upload: stage 2 — process the next CHUNK_SIZE chapters. Call
// repeatedly until the response says done: true. Safe to retry: it resumes
// from MAX(idx)+1 already in D1, so a failed call just redoes a few
// chapters rather than corrupting anything. -----------------------------------
app.post("/api/books/:id/ingest-chunk", async (c) => {
  const id = c.req.param("id");
  const book = await c.env.DB.prepare(
    `SELECT r2_key, chapter_count, ingest_done, ingest_upload_id, ingest_part_number, ingest_offset, ingest_parts_json
     FROM books WHERE id = ?`,
  ).bind(id).first<BookIngestRow>();
  if (!book) return c.json({ error: "not found" }, 404);
  if (book.ingest_done) return c.json({ done: true, processed: book.chapter_count, total: book.chapter_count });

  const obj = await c.env.BOOKS.get(book.r2_key);
  if (!obj) return c.json({ error: "raw epub missing" }, 404);
  const bytes = new Uint8Array(await obj.arrayBuffer());

  let meta;
  try { meta = parseEpubMeta(bytes); }
  catch (err) { return c.json({ error: "parse failed: " + errMsg(err) }, 422); }

  const nextRow = await c.env.DB.prepare(
    `SELECT COALESCE(MAX(idx) + 1, 0) AS n FROM chapters WHERE book_id = ?`,
  ).bind(id).first<{ n: number }>();
  const nextIdx = nextRow?.n ?? 0;
  const slice: SpineItem[] = meta.spine.slice(nextIdx, nextIdx + CHUNK_SIZE);
  const isLast = nextIdx + slice.length >= meta.spine.length;

  const pendingObj = await c.env.BOOKS.get(pendingKey(id));
  const pendingBytes = pendingObj ? new Uint8Array(await pendingObj.arrayBuffer()) : null;

  const content = new ContentWriter(c.env, contentBinKey(id), {
    uploadId: book.ingest_upload_id,
    partNumber: book.ingest_part_number,
    offset: book.ingest_offset,
    parts: JSON.parse(book.ingest_parts_json || "[]"),
    pendingBytes,
  });
  const metaWriter = new MetaWriter(c.env, id);
  const enc = new TextEncoder();

  try {
    const chapters = extractChapterRange(bytes, slice, meta.tocMap);
    for (const chapter of chapters) {
      const encoded = enc.encode(JSON.stringify(chapter.blocks));
      const { offset, length } = await content.append(encoded);
      await metaWriter.add({
        idx: chapter.order,
        title: chapter.title,
        file_name: fakeFileName(chapter.order),
        char_count: chapter.blocks.reduce((s, b) => s + b.text.length, 0),
        offset,
        length,
      });
    }
    await metaWriter.flush();

    if (isLast) {
      await content.finish();
      await c.env.BOOKS.delete(pendingKey(id)).catch(() => {});
      await c.env.DB.prepare(`UPDATE books SET ingest_done = 1 WHERE id = ?`).bind(id).run();
      return c.json({ done: true, processed: meta.spine.length, total: meta.spine.length });
    }

    const snap = content.snapshot();
    await c.env.BOOKS.put(pendingKey(id), snap.pendingBytes);
    await c.env.DB.prepare(
      `UPDATE books SET ingest_upload_id = ?, ingest_part_number = ?, ingest_offset = ?, ingest_parts_json = ?
       WHERE id = ?`,
    ).bind(snap.uploadId, snap.partNumber, snap.offset, JSON.stringify(snap.parts), id).run();

    return c.json({ done: false, processed: nextIdx + slice.length, total: meta.spine.length });
  } catch (err) {
    await content.abort();
    console.error("ingest-chunk error", err);
    return c.json({ error: "server error: " + errMsg(err) }, 500);
  }
});

app.delete("/api/books/:id", async (c) => {
  const id = c.req.param("id");
  const book = await c.env.DB.prepare(`SELECT r2_key, ingest_done, ingest_upload_id FROM books WHERE id = ?`)
    .bind(id).first<{ r2_key: string; ingest_done: number; ingest_upload_id: string | null }>();
  if (!book) return c.json({ error: "not found" }, 404);

  if (!book.ingest_done) await abortIngest(c.env, id, book.ingest_upload_id);
  await c.env.BOOKS.delete([book.r2_key, contentBinKey(id), legacyContentKey(id)]);
  await c.env.DB.batch([
    c.env.DB.prepare(`DELETE FROM chapters WHERE book_id = ?`).bind(id),
    c.env.DB.prepare(`DELETE FROM progress WHERE book_id = ?`).bind(id),
    c.env.DB.prepare(`DELETE FROM books WHERE id = ?`).bind(id),
  ]);
  return c.json({ ok: true });
});

// --- Chapter index (metadata only) -------------------------------------------
app.get("/api/books/:id/index", async (c) => {
  const id = c.req.param("id");
  const book = await c.env.DB.prepare(
    `SELECT id, title, author, code_name, chapter_count FROM books WHERE id = ?`,
  ).bind(id).first();
  if (!book) return c.json({ error: "not found" }, 404);

  const { results: chapters } = await c.env.DB.prepare(
    `SELECT idx, title, file_name, char_count FROM chapters WHERE book_id = ? ORDER BY idx`,
  ).bind(id).all();
  const progress = await c.env.DB.prepare(
    `SELECT chapter_idx, scroll_ratio FROM progress WHERE book_id = ?`,
  ).bind(id).first();

  return c.json({ ...book, chapters, progress: progress ?? null });
});

// --- Single chapter — fetched via R2 byte range ------------------------------
app.get("/api/books/:id/chapters/:idx", async (c) => {
  const id = c.req.param("id");
  const idx = Number(c.req.param("idx"));
  const row = await c.env.DB.prepare(
    `SELECT idx, title, file_name, byte_offset, byte_length, blocks
     FROM chapters WHERE book_id = ? AND idx = ?`,
  ).bind(id, idx).first<{
    idx: number; title: string | null; file_name: string;
    byte_offset: number | null; byte_length: number | null; blocks: string | null;
  }>();
  if (!row) return c.json({ error: "not found" }, 404);

  let blocks: unknown[] = [];
  if (row.byte_offset != null && row.byte_length != null && row.byte_length > 0) {
    const obj = await c.env.BOOKS.get(contentBinKey(id), {
      range: { offset: row.byte_offset, length: row.byte_length },
    });
    if (obj) { try { blocks = JSON.parse(await obj.text()); } catch {} }
  } else if (row.blocks) {
    // Fallback for a book still stored in the earlier per-row D1 format.
    try { blocks = JSON.parse(row.blocks); } catch {}
  }
  return c.json({ idx: row.idx, title: row.title, file_name: row.file_name, blocks });
});

// --- Re-index: reset a book's ingest state and wipe its chapters, then the
// client drives /ingest-chunk the same way it does for a fresh upload. -------
app.post("/api/books/:id/reindex", async (c) => {
  const id = c.req.param("id");
  const book = await c.env.DB.prepare(`SELECT id, ingest_upload_id FROM books WHERE id = ?`)
    .bind(id).first<{ id: string; ingest_upload_id: string | null }>();
  if (!book) return c.json({ error: "not found" }, 404);

  await abortIngest(c.env, id, book.ingest_upload_id);
  await c.env.DB.prepare(`DELETE FROM chapters WHERE book_id = ?`).bind(id).run();
  await c.env.DB.prepare(
    `UPDATE books SET ingest_done = 0, ingest_upload_id = NULL, ingest_part_number = 1,
       ingest_offset = 0, ingest_parts_json = '[]'
     WHERE id = ?`,
  ).bind(id).run();
  await c.env.BOOKS.delete(legacyContentKey(id));

  return c.json({ ok: true });
});

// --- Progress ----------------------------------------------------------------
app.post("/api/books/:id/progress", async (c) => {
  const id = c.req.param("id");
  const body = (await c.req.json().catch(() => ({}))) as { chapter_idx?: number; scroll_ratio?: number };
  const chapterIdx = Number.isFinite(body.chapter_idx) ? Math.floor(body.chapter_idx as number) : 0;
  const ratio = Number.isFinite(body.scroll_ratio) ? Math.min(1, Math.max(0, body.scroll_ratio as number)) : 0;

  await c.env.DB.prepare(
    `INSERT INTO progress (book_id, chapter_idx, scroll_ratio, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(book_id) DO UPDATE SET
       chapter_idx = excluded.chapter_idx,
       scroll_ratio = excluded.scroll_ratio,
       updated_at = excluded.updated_at`,
  ).bind(id, chapterIdx, ratio, Date.now()).run();

  return c.json({ ok: true });
});

// --- Static assets fallback --------------------------------------------------
app.all("*", (c) => c.env.ASSETS.fetch(c.req.raw));

export default app;
