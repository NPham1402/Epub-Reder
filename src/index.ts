import { Hono } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import type { Env } from "./types";
import { parseEpub } from "./epub";
import { fakeCodeName, fakeFileName } from "./names";
import { passcodeMatches, signSession, verifySession } from "./auth";

const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30; // 30 days
const MAX_EPUB_BYTES = 60 * 1024 * 1024; // 60 MB guard

const app = new Hono<{ Bindings: Env }>();

const contentKeyFor = (id: string) => `books/${id}/content.json`;

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

// --- Books list --------------------------------------------------------------
app.get("/api/books", async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT id, title, author, code_name, chapter_count, created_at
     FROM books ORDER BY created_at DESC`,
  ).all();
  return c.json({ books: results });
});

// --- Upload ------------------------------------------------------------------
// Whole parsed book is stored as ONE R2 object; only book metadata goes to D1.
// This keeps every upload at a constant 2 R2 writes + 1 D1 write regardless of
// chapter count (important for the free plan's subrequest limit).
app.post("/api/books", async (c) => {
  try {
    const form = await c.req.formData().catch(() => null);
    const file = form?.get("file");
    if (!(file instanceof File)) return c.json({ error: "missing file" }, 400);

    const buffer = await file.arrayBuffer();
    if (buffer.byteLength > MAX_EPUB_BYTES) return c.json({ error: "file too large (max 60 MB)" }, 413);
    const bytes = new Uint8Array(buffer);

    let book;
    try {
      book = parseEpub(bytes);
    } catch (err) {
      return c.json({ error: "could not parse EPUB: " + errMsg(err) }, 422);
    }

    const id = crypto.randomUUID();
    const codeName = fakeCodeName(book.title);
    const now = Date.now();
    const rawKey = `raw/${id}.epub`;

    const content = {
      id,
      title: book.title,
      author: book.author,
      language: book.language,
      code_name: codeName,
      chapters: book.chapters.map((ch, i) => ({
        idx: i,
        title: ch.title,
        file_name: fakeFileName(i),
        char_count: ch.blocks.reduce((s, b) => s + b.text.length, 0),
        blocks: ch.blocks,
      })),
    };

    await Promise.all([
      c.env.BOOKS.put(rawKey, bytes, { httpMetadata: { contentType: "application/epub+zip" } }),
      c.env.BOOKS.put(contentKeyFor(id), JSON.stringify(content), {
        httpMetadata: { contentType: "application/json" },
      }),
    ]);

    await c.env.DB.prepare(
      `INSERT INTO books (id, title, author, language, r2_key, code_name, chapter_count, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(id, book.title, book.author, book.language, rawKey, codeName, book.chapters.length, now).run();

    return c.json({ id, title: book.title, code_name: codeName, chapters: book.chapters.length });
  } catch (err) {
    console.error("upload error", err);
    return c.json({ error: "server error: " + errMsg(err) }, 500);
  }
});

// --- Full book content (chapters + blocks) -----------------------------------
app.get("/api/books/:id/content", async (c) => {
  const id = c.req.param("id");
  const obj = await c.env.BOOKS.get(contentKeyFor(id));
  if (!obj) return c.json({ error: "not found" }, 404);
  const content = (await obj.json()) as Record<string, unknown>;
  const progress = await c.env.DB.prepare(
    `SELECT chapter_idx, scroll_ratio FROM progress WHERE book_id = ?`,
  ).bind(id).first();
  return c.json({ ...content, progress: progress ?? null });
});

app.delete("/api/books/:id", async (c) => {
  const id = c.req.param("id");
  const book = await c.env.DB.prepare(`SELECT r2_key FROM books WHERE id = ?`)
    .bind(id).first<{ r2_key: string }>();
  if (!book) return c.json({ error: "not found" }, 404);

  await c.env.BOOKS.delete([book.r2_key, contentKeyFor(id)]);
  await c.env.DB.batch([
    c.env.DB.prepare(`DELETE FROM progress WHERE book_id = ?`).bind(id),
    c.env.DB.prepare(`DELETE FROM chapters WHERE book_id = ?`).bind(id),
    c.env.DB.prepare(`DELETE FROM books WHERE id = ?`).bind(id),
  ]);
  return c.json({ ok: true });
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

function errMsg(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

export default app;
