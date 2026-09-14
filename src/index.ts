import { Hono } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import type { Env, ParsedBookMeta } from "./types";
import { parseEpub } from "./epub";
import { fakeCodeName, fakeFileName } from "./names";
import { passcodeMatches, signSession, verifySession } from "./auth";

const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30; // 30 days
const MAX_EPUB_BYTES = 80 * 1024 * 1024; // 80 MB guard
const META_PER_BATCH = 150; // chapter-metadata inserts per D1 batch
// R2 multipart parts must all be the exact same size except the last, and
// >= 5MiB; 8MiB gives headroom above that minimum.
const PART_MIN_BYTES = 8 * 1024 * 1024;

const app = new Hono<{ Bindings: Env }>();

const contentBinKey = (id: string) => `books/${id}/content.bin`;
const legacyContentKey = (id: string) => `books/${id}/content.json`;

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

// Accumulates chapter byte-blocks and writes them to one contiguous R2
// object without ever holding the whole book in memory at once. R2 requires
// every multipart part except the last to be exactly the same size (not
// merely "at least 5MiB"), so once buffered data reaches PART_SIZE_BYTES we
// slice off exactly that many bytes as a part and keep any overflow for the
// next one. Small books that never reach the threshold fall back to a
// single put() so the common case doesn't pay for multipart overhead.
class ContentWriter {
  private multipart: R2MultipartUpload | null = null;
  private parts: R2UploadedPart[] = [];
  private partNumber = 1;
  private pending: Uint8Array[] = [];
  private pendingLen = 0;
  private offset = 0;

  constructor(private env: Env, private key: string) {}

  // Records `bytes` at the next offset and returns its {offset, length}.
  async append(bytes: Uint8Array): Promise<{ offset: number; length: number }> {
    const offset = this.offset;
    this.pending.push(bytes);
    this.pendingLen += bytes.length;
    this.offset += bytes.length;
    while (this.pendingLen >= PART_MIN_BYTES) await this.flushPart(PART_MIN_BYTES);
    return { offset, length: bytes.length };
  }

  // Merges buffered chunks into one contiguous view (copying only when more
  // than one chunk is pending).
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
// bounded D1 batches as they arrive, instead of waiting for the whole book.
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

// Parses an EPUB and streams its chapters straight into R2 + D1 as they're
// decoded — no per-book array is ever fully materialized in memory, so
// upload time no longer scales with chapter count. `onMeta` fires once,
// before any chapter, so the caller can create the book's row first (chapter
// rows below reference it via FOREIGN KEY). On any failure, whatever chapter
// rows/parts were written for this attempt are rolled back so the book is
// left either fully ingested or absent, never half-written.
async function ingestBook(
  env: Env,
  bookId: string,
  bytes: Uint8Array,
  onMeta: (meta: ParsedBookMeta) => Promise<void>,
): Promise<{ chapterCount: number }> {
  const content = new ContentWriter(env, contentBinKey(bookId));
  const meta = new MetaWriter(env, bookId);
  const enc = new TextEncoder();
  try {
    const result = await parseEpub(bytes, {
      onMeta,
      onChapter: async (chapter) => {
        const encoded = enc.encode(JSON.stringify(chapter.blocks));
        const { offset, length } = await content.append(encoded);
        await meta.add({
          idx: chapter.order,
          title: chapter.title,
          file_name: fakeFileName(chapter.order),
          char_count: chapter.blocks.reduce((s, b) => s + b.text.length, 0),
          offset,
          length,
        });
      },
    });
    await meta.flush();
    await content.finish();
    return result;
  } catch (err) {
    await content.abort();
    await env.DB.prepare(`DELETE FROM chapters WHERE book_id = ?`).bind(bookId).run().catch(() => {});
    throw err;
  }
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
app.get("/api/books", async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT id, title, author, code_name, chapter_count, created_at
     FROM books ORDER BY created_at DESC`,
  ).all();
  return c.json({ books: results });
});

// --- Upload ------------------------------------------------------------------
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

    id = crypto.randomUUID();
    const bookId = id;
    rawKey = `raw/${id}.epub`;
    await c.env.BOOKS.put(rawKey, bytes, { httpMetadata: { contentType: "application/epub+zip" } });

    let bookMeta: ParsedBookMeta | null = null;
    let codeName = "";
    let result;
    try {
      result = await ingestBook(c.env, bookId, bytes, async (meta) => {
        bookMeta = meta;
        codeName = fakeCodeName(meta.title);
        await c.env.DB.prepare(
          `INSERT INTO books (id, title, author, language, r2_key, code_name, chapter_count, created_at)
           VALUES (?, ?, ?, ?, ?, ?, 0, ?)`,
        ).bind(bookId, meta.title, meta.author, meta.language, rawKey, codeName, Date.now()).run();
      });
    } catch (err) {
      // Nothing was committed yet (onMeta never ran) — a clean parse failure.
      if (!bookMeta) return c.json({ error: "could not parse EPUB: " + errMsg(err) }, 422);
      throw err;
    }

    await c.env.DB.prepare(`UPDATE books SET chapter_count = ? WHERE id = ?`)
      .bind(result.chapterCount, bookId).run();

    return c.json({ id, title: bookMeta!.title, code_name: codeName, chapters: result.chapterCount });
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

app.delete("/api/books/:id", async (c) => {
  const id = c.req.param("id");
  const book = await c.env.DB.prepare(`SELECT r2_key FROM books WHERE id = ?`)
    .bind(id).first<{ r2_key: string }>();
  if (!book) return c.json({ error: "not found" }, 404);

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

// --- Re-index from the stored .epub into byte-range format --------------------
app.post("/api/books/:id/reindex", async (c) => {
  const id = c.req.param("id");
  const book = await c.env.DB.prepare(`SELECT id, r2_key FROM books WHERE id = ?`)
    .bind(id).first<{ id: string; r2_key: string }>();
  if (!book) return c.json({ error: "not found" }, 404);

  const obj = await c.env.BOOKS.get(book.r2_key);
  if (!obj) return c.json({ error: "raw epub missing" }, 404);
  const bytes = new Uint8Array(await obj.arrayBuffer());

  await c.env.DB.prepare(`DELETE FROM chapters WHERE book_id = ?`).bind(id).run();

  let result;
  try {
    result = await ingestBook(c.env, id, bytes, () => Promise.resolve());
  } catch (err) {
    return c.json({ error: "parse failed: " + errMsg(err) }, 422);
  }

  await c.env.DB.prepare(`UPDATE books SET chapter_count = ? WHERE id = ?`)
    .bind(result.chapterCount, id).run();
  await c.env.BOOKS.delete(legacyContentKey(id));

  return c.json({ ok: true, chapters: result.chapterCount });
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
