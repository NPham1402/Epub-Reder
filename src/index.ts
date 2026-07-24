import { Hono } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import type { Env } from "./types";
import { parseEpub } from "./epub";
import { fakeCodeName, fakeFileName } from "./names";
import { passcodeMatches, signSession, verifySession } from "./auth";

const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30; // 30 days
const MAX_EPUB_BYTES = 60 * 1024 * 1024; // 60 MB guard

const app = new Hono<{ Bindings: Env }>();

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
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
    path: "/",
    maxAge: SESSION_TTL_MS / 1000,
  });
  return c.json({ ok: true });
});

app.post("/api/logout", (c) => {
  deleteCookie(c, "session", { path: "/" });
  return c.json({ ok: true });
});

// --- Books -------------------------------------------------------------------
app.get("/api/books", async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT id, title, author, code_name, chapter_count, created_at
     FROM books ORDER BY created_at DESC`,
  ).all();
  return c.json({ books: results });
});

app.post("/api/books", async (c) => {
  const form = await c.req.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File)) return c.json({ error: "missing file" }, 400);
  const buffer = await file.arrayBuffer();
  if (buffer.byteLength > MAX_EPUB_BYTES) return c.json({ error: "file too large" }, 413);

  const bytes = new Uint8Array(buffer);
  let book;
  try {
    book = parseEpub(bytes);
  } catch (err) {
    return c.json({ error: "could not parse EPUB", detail: String(err) }, 422);
  }

  const id = crypto.randomUUID();
  const codeName = fakeCodeName(book.title);
  const rawKey = `raw/${id}.epub`;
  const now = Date.now();

  // Store the raw epub plus one JSON blob per chapter in R2.
  const contentPuts: Promise<unknown>[] = [
    c.env.BOOKS.put(rawKey, bytes, {
      httpMetadata: { contentType: "application/epub+zip" },
    }),
  ];
  const chapterMeta = book.chapters.map((ch, i) => {
    const contentKey = `books/${id}/ch/${i}.json`;
    contentPuts.push(
      c.env.BOOKS.put(contentKey, JSON.stringify({ title: ch.title, blocks: ch.blocks }), {
        httpMetadata: { contentType: "application/json" },
      }),
    );
    const charCount = ch.blocks.reduce((sum, b) => sum + b.text.length, 0);
    return { i, title: ch.title, fileName: fakeFileName(i), contentKey, charCount };
  });
  await Promise.all(contentPuts);

  const statements = [
    c.env.DB.prepare(
      `INSERT INTO books (id, title, author, language, r2_key, code_name, chapter_count, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(id, book.title, book.author, book.language, rawKey, codeName, book.chapters.length, now),
    ...chapterMeta.map((m) =>
      c.env.DB.prepare(
        `INSERT INTO chapters (book_id, idx, title, file_name, content_key, char_count)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).bind(id, m.i, m.title, m.fileName, m.contentKey, m.charCount),
    ),
  ];
  await c.env.DB.batch(statements);

  return c.json({ id, title: book.title, code_name: codeName, chapters: book.chapters.length });
});

app.delete("/api/books/:id", async (c) => {
  const id = c.req.param("id");
  const book = await c.env.DB.prepare(`SELECT r2_key FROM books WHERE id = ?`).bind(id).first<{ r2_key: string }>();
  if (!book) return c.json({ error: "not found" }, 404);

  const { results } = await c.env.DB.prepare(
    `SELECT content_key FROM chapters WHERE book_id = ?`,
  ).bind(id).all<{ content_key: string }>();

  const keys = [book.r2_key, ...results.map((r) => r.content_key)];
  await c.env.BOOKS.delete(keys);
  await c.env.DB.batch([
    c.env.DB.prepare(`DELETE FROM chapters WHERE book_id = ?`).bind(id),
    c.env.DB.prepare(`DELETE FROM progress WHERE book_id = ?`).bind(id),
    c.env.DB.prepare(`DELETE FROM books WHERE id = ?`).bind(id),
  ]);
  return c.json({ ok: true });
});

// --- Chapters ----------------------------------------------------------------
app.get("/api/books/:id/chapters", async (c) => {
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

  return c.json({ book, chapters, progress: progress ?? null });
});

app.get("/api/books/:id/chapters/:idx", async (c) => {
  const id = c.req.param("id");
  const idx = Number(c.req.param("idx"));
  const row = await c.env.DB.prepare(
    `SELECT content_key, file_name, title FROM chapters WHERE book_id = ? AND idx = ?`,
  ).bind(id, idx).first<{ content_key: string; file_name: string; title: string | null }>();
  if (!row) return c.json({ error: "not found" }, 404);

  const obj = await c.env.BOOKS.get(row.content_key);
  if (!obj) return c.json({ error: "content missing" }, 404);
  const data = (await obj.json()) as { title: string | null; blocks: unknown[] };

  return c.json({ idx, file_name: row.file_name, title: row.title ?? data.title, blocks: data.blocks });
});

// --- Progress ----------------------------------------------------------------
app.post("/api/books/:id/progress", async (c) => {
  const id = c.req.param("id");
  const body = (await c.req.json().catch(() => ({}))) as {
    chapter_idx?: number;
    scroll_ratio?: number;
  };
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

// --- Static assets fallback (index.html for any non-API route) ---------------
app.all("*", (c) => c.env.ASSETS.fetch(c.req.raw));

export default app;
