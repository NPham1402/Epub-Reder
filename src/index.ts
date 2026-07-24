import { Hono } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import type { Env, ParsedChapter } from "./types";
import { parseEpub } from "./epub";
import { fakeCodeName, fakeFileName } from "./names";
import { passcodeMatches, signSession, verifySession } from "./auth";

const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30; // 30 days
const MAX_EPUB_BYTES = 80 * 1024 * 1024; // 80 MB guard
const META_PER_BATCH = 150; // chapter-metadata inserts per D1 batch

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

// Serialize every chapter into one contiguous byte blob and record each
// chapter's byte range. Offsets are UTF-8 byte positions (not char counts).
function buildContent(chapters: ParsedChapter[]): { blob: Uint8Array; meta: ChapterMeta[] } {
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [];
  const meta: ChapterMeta[] = [];
  let offset = 0;
  for (let i = 0; i < chapters.length; i++) {
    const ch = chapters[i];
    const bytes = enc.encode(JSON.stringify(ch.blocks));
    parts.push(bytes);
    meta.push({
      idx: i,
      title: ch.title,
      file_name: fakeFileName(i),
      char_count: ch.blocks.reduce((s, b) => s + b.text.length, 0),
      offset,
      length: bytes.length,
    });
    offset += bytes.length;
  }
  const blob = new Uint8Array(offset);
  let pos = 0;
  for (const p of parts) { blob.set(p, pos); pos += p.length; }
  return { blob, meta };
}

// Insert chapter metadata (small — no blocks) in bounded batches.
async function writeChapterMeta(env: Env, bookId: string, meta: ChapterMeta[]): Promise<void> {
  for (let i = 0; i < meta.length; i += META_PER_BATCH) {
    const slice = meta.slice(i, i + META_PER_BATCH);
    const stmts = slice.map((m) =>
      env.DB.prepare(
        `INSERT INTO chapters (book_id, idx, title, file_name, content_key, char_count, byte_offset, byte_length)
         VALUES (?, ?, ?, ?, '', ?, ?, ?)`,
      ).bind(bookId, m.idx, m.title, m.file_name, m.char_count, m.offset, m.length),
    );
    await env.DB.batch(stmts);
  }
}

// Store one book's content blob + metadata. Used by upload and reindex.
async function storeBookContent(env: Env, bookId: string, chapters: ParsedChapter[]): Promise<void> {
  const { blob, meta } = buildContent(chapters);
  await env.BOOKS.put(contentBinKey(bookId), blob, {
    httpMetadata: { contentType: "application/octet-stream" },
  });
  await writeChapterMeta(env, bookId, meta);
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

    let book;
    try { book = parseEpub(bytes); }
    catch (err) { return c.json({ error: "could not parse EPUB: " + errMsg(err) }, 422); }

    id = crypto.randomUUID();
    const codeName = fakeCodeName(book.title);
    const now = Date.now();
    rawKey = `raw/${id}.epub`;

    await c.env.BOOKS.put(rawKey, bytes, { httpMetadata: { contentType: "application/epub+zip" } });
    await c.env.DB.prepare(
      `INSERT INTO books (id, title, author, language, r2_key, code_name, chapter_count, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(id, book.title, book.author, book.language, rawKey, codeName, book.chapters.length, now).run();
    await storeBookContent(c.env, id, book.chapters);

    return c.json({ id, title: book.title, code_name: codeName, chapters: book.chapters.length });
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

  let parsed;
  try { parsed = parseEpub(bytes); }
  catch (err) { return c.json({ error: "parse failed: " + errMsg(err) }, 422); }

  await c.env.DB.prepare(`DELETE FROM chapters WHERE book_id = ?`).bind(id).run();
  await storeBookContent(c.env, id, parsed.chapters);
  await c.env.DB.prepare(`UPDATE books SET chapter_count = ? WHERE id = ?`)
    .bind(parsed.chapters.length, id).run();
  await c.env.BOOKS.delete(legacyContentKey(id));

  return c.json({ ok: true, chapters: parsed.chapters.length });
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
