import { Hono, type Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { secureHeaders } from "hono/secure-headers";
import type { Env } from "./types";
import { parseEpubMeta, extractChapterRange, EpubLimitError, type SpineItem } from "./epub";
import { buildEpub, buildText } from "./epubwrite";
import { readBlocks } from "./chapters";
import { buildMatch, findHits, foldVi } from "./search";
import { decodeText, htmlToText, splitChapters } from "./textsplit";
import { fakeCodeName, fakeFileName } from "./names";
import { passcodeMatches, signSession, verifySession } from "./auth";
import { FailureLimiter } from "./ratelimit";
import {
  abortIngest, busyBooks, contentBinKey, legacyContentKey, spineMetaKey, stagedKey, stagedPrefix, uploadPartKey, uploadPrefix,
} from "./storage";
import { discardUploadParts } from "./maintenance";

const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30; // 30 days
const MAX_EPUB_BYTES = 80 * 1024 * 1024; // 80 MB guard
const META_PER_BATCH = 150; // chapter-metadata inserts per D1 batch
// R2 multipart parts must all be the exact same size except the last, and
// >= 5MiB. Kept close to that minimum so each (occasional — see
// ContentWriter) consolidation reads/writes as little as possible.
const PART_SIZE_BYTES = 5 * 1024 * 1024 + 65536;
// Chapters processed per /ingest-chunk call. Kept small: Cloudflare's Free
// plan CPU budget per request has proven inconsistent in practice (one
// request ran 2s of CPU before being killed, another was killed at 51ms) —
// so this stays conservative rather than tuned to a number that isn't
// actually reliable.
const CHUNK_SIZE = 30;
// Size of one upload part. Small enough that even a very slow link (tens of
// KB/s) finishes a part in seconds, well inside the ~60 s a proxy in front
// will wait for a single request body.
const UPLOAD_PART_BYTES = 256 * 1024;

const app = new Hono<{ Bindings: Env }>();

// Failed-login throttling: a few tries per client, plus a global ceiling so
// spoofing the client address (or having many addresses) still can't turn the
// passcode into an unlimited-guess oracle. The global cap means someone
// hammering the login can lock the owner out too, for at most one window —
// the accepted trade for a single-passcode app on the public internet.
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const loginPerClient = new FailureLimiter({ max: 5, windowMs: LOGIN_WINDOW_MS });
const loginGlobal = new FailureLimiter({ max: 60, windowMs: LOGIN_WINDOW_MS });

function clientKey(c: Context<{ Bindings: Env }>): string {
  return c.req.header("cf-connecting-ip")
    ?? c.req.header("x-forwarded-for")?.split(",")[0].trim()
    ?? "unknown";
}

// Current session epoch; a missing table (migration not applied yet) must not
// lock everyone out, so that case falls back to the initial value.
async function sessionEpoch(env: Env): Promise<number> {
  try {
    const row = await env.DB.prepare(`SELECT value FROM app_state WHERE key = 'session_epoch'`).first<{ value: string }>();
    return Number(row?.value) || 1;
  } catch {
    return 1;
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// Whether the session cookie should carry the Secure flag. A browser drops a
// Secure cookie set over plain HTTP, so it must follow how the user actually
// reaches the app — including behind a TLS-terminating proxy or tunnel,
// which is why X-Forwarded-Proto counts. COOKIE_SECURE forces either way.
function cookieSecure(c: Context<{ Bindings: Env }>): boolean {
  if (c.env.COOKIE_SECURE === "true") return true;
  if (c.env.COOKIE_SECURE === "false") return false;
  const proto = c.req.header("x-forwarded-proto")?.split(",")[0].trim() ?? new URL(c.req.url).protocol.replace(":", "");
  return proto === "https";
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
}

// Merges a set of R2 objects (already fetched) into one contiguous buffer,
// in the given order.
async function fetchAndMerge(env: Env, keys: string[], totalLen: number): Promise<Uint8Array> {
  const merged = new Uint8Array(totalLen);
  let pos = 0;
  for (const key of keys) {
    const obj = await env.BOOKS.get(key);
    if (!obj) continue;
    const bytes = new Uint8Array(await obj.arrayBuffer());
    merged.set(bytes, pos);
    pos += bytes.length;
  }
  return merged;
}

// Accumulates chapter byte-blocks into one contiguous R2 object without
// ever holding more than one request's worth of new bytes in memory — and
// without re-reading previously-staged bytes on every request either.
//
// stage() writes only its own new bytes as a small standalone R2 object,
// keyed by its absolute offset so objects sort in content order — cheap and
// constant-cost no matter how much has accumulated so far. Only once staged
// objects add up to a full multipart part (PART_SIZE_BYTES, which R2
// requires every part except the last to match exactly) does
// maybeConsolidate() do the heavier work of reading them back, cutting an
// exact-size part, uploading it, and deleting the consumed staged objects —
// and that happens only once per PART_SIZE_BYTES of content, not on every
// request. (An earlier version re-read and re-wrote the whole growing
// leftover on every single request, which is what made ingestion get
// slower — and eventually blow the CPU budget — the further into a book it
// got.)
//
// An instance lives only for one HTTP request; its constructor takes a
// snapshot of state from the previous request (persisted in D1 by the
// caller) and snapshot() hands back new state to persist for the next one.
class ContentWriter {
  private multipart: R2MultipartUpload | null;
  private parts: R2UploadedPart[];
  private partNumber: number;
  private offset: number;

  constructor(private env: Env, private bookId: string, private key: string, state: ContentWriterState) {
    this.multipart = state.uploadId ? env.BOOKS.resumeMultipartUpload(key, state.uploadId) : null;
    this.parts = [...state.parts];
    this.partNumber = state.partNumber;
    this.offset = state.offset;
  }

  // The absolute offset the next staged byte will occupy.
  get currentOffset(): number {
    return this.offset;
  }

  // Stages this request's whole chunk (already concatenated by the caller)
  // as one small R2 object and advances the running offset.
  async stage(bytes: Uint8Array): Promise<void> {
    if (bytes.length === 0) return;
    await this.env.BOOKS.put(stagedKey(this.bookId, this.offset), bytes);
    this.offset += bytes.length;
  }

  // Cuts as many exact-size real parts as currently-staged bytes allow.
  async maybeConsolidate(): Promise<void> {
    let stagedTotal = this.offset - (this.partNumber - 1) * PART_SIZE_BYTES;
    while (stagedTotal >= PART_SIZE_BYTES) {
      const { objects } = await this.env.BOOKS.list({ prefix: stagedPrefix(this.bookId) });
      objects.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
      const total = objects.reduce((s, o) => s + o.size, 0);
      const keys = objects.map((o) => o.key);
      const merged = await fetchAndMerge(this.env, keys, total);
      const startOffset = this.offset - total;

      if (!this.multipart) {
        this.multipart = await this.env.BOOKS.createMultipartUpload(this.key, {
          httpMetadata: { contentType: "application/octet-stream" },
        });
      }
      const part = await this.multipart.uploadPart(this.partNumber++, merged.subarray(0, PART_SIZE_BYTES));
      this.parts.push(part);
      await this.env.BOOKS.delete(keys);

      const rest = merged.subarray(PART_SIZE_BYTES);
      if (rest.length > 0) await this.env.BOOKS.put(stagedKey(this.bookId, startOffset + PART_SIZE_BYTES), rest);
      stagedTotal -= PART_SIZE_BYTES;
    }
  }

  // Snapshot of resumable state for the caller to persist between requests.
  snapshot(): ContentWriterState {
    return {
      uploadId: this.multipart?.uploadId ?? null,
      partNumber: this.partNumber,
      offset: this.offset,
      parts: this.parts,
    };
  }

  // Completes the object: whatever remains staged becomes the true final
  // part (allowed to be smaller than PART_SIZE_BYTES — only the last part
  // may differ in size).
  async finish(): Promise<void> {
    const { objects } = await this.env.BOOKS.list({ prefix: stagedPrefix(this.bookId) });
    objects.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    const total = objects.reduce((s, o) => s + o.size, 0);
    const keys = objects.map((o) => o.key);
    const merged = await fetchAndMerge(this.env, keys, total);

    if (!this.multipart) {
      await this.env.BOOKS.put(this.key, merged, { httpMetadata: { contentType: "application/octet-stream" } });
    } else {
      if (merged.length > 0) {
        const part = await this.multipart.uploadPart(this.partNumber++, merged);
        this.parts.push(part);
      }
      await this.multipart.complete(this.parts);
    }
    if (keys.length) await this.env.BOOKS.delete(keys);
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

// The spine list + TOC titles never change for a given raw .epub, but
// re-deriving them means re-scanning the archive's central directory —
// cheap once, but wasteful when repeated on every single ingest-chunk call.
// Cache the result in R2 after the first computation (at upload, or lazily
// here for a book reindexed before this cache existed) so every chunk after
// the first skips straight to extracting its own slice of chapters.
async function loadSpineMeta(
  env: Env,
  id: string,
  rawBytes: Uint8Array,
): Promise<{ spine: SpineItem[]; tocMap: Map<string, string> }> {
  const cached = await env.BOOKS.get(spineMetaKey(id));
  if (cached) {
    const parsed = JSON.parse(await cached.text()) as { spine: SpineItem[]; toc: [string, string][] };
    return { spine: parsed.spine, tocMap: new Map(parsed.toc) };
  }
  const meta = parseEpubMeta(rawBytes);
  await env.BOOKS.put(
    spineMetaKey(id),
    JSON.stringify({ spine: meta.spine, toc: [...meta.tocMap.entries()] }),
    { httpMetadata: { contentType: "application/json" } },
  );
  return { spine: meta.spine, tocMap: meta.tocMap };
}

// --- Response hardening ------------------------------------------------------
// The UI is one same-origin script, one stylesheet and a data-URI icon font,
// so the CSP can be strict: no inline script, no third-party origins, and it
// can't be framed. (style-src keeps 'unsafe-inline' because the UI sets style
// attributes and properties directly.)
app.use("*", secureHeaders({
  contentSecurityPolicy: {
    defaultSrc: ["'self'"],
    scriptSrc: ["'self'"],
    styleSrc: ["'self'", "'unsafe-inline'"],
    imgSrc: ["'self'", "data:"],
    fontSrc: ["'self'", "data:"],
    connectSrc: ["'self'"],
    objectSrc: ["'none'"],
    baseUri: ["'none'"],
    formAction: ["'self'"],
    frameAncestors: ["'none'"],
  },
  xFrameOptions: "DENY",
  referrerPolicy: "no-referrer",
  crossOriginOpenerPolicy: "same-origin",
  strictTransportSecurity: "max-age=15552000",
  permissionsPolicy: { camera: [], microphone: [], geolocation: [], payment: [] },
}));

// Book content and session state must never be stored by a shared cache.
app.use("/api/*", async (c, next) => {
  await next();
  c.header("Cache-Control", "no-store");
});

// Liveness/readiness for orchestrators: proves the database answers, not just
// that the process is up. Unauthenticated and reveals nothing.
app.get("/healthz", async (c) => {
  try {
    await c.env.DB.prepare(`SELECT 1 AS ok`).first();
    return c.json({ ok: true, ...(c.env.HEALTH_EXTRA ? await c.env.HEALTH_EXTRA() : {}) });
  } catch {
    return c.json({ ok: false }, 503);
  }
});

// --- Auth gate for all API routes except login/logout ------------------------
app.use("/api/*", async (c, next) => {
  const path = new URL(c.req.url).pathname;
  if (path === "/api/auth" || path === "/api/logout") return next();
  const token = getCookie(c, "session");
  if (!token || !(await verifySession(token, c.env.SESSION_SECRET, await sessionEpoch(c.env)))) {
    return c.json({ error: "unauthorized" }, 401);
  }
  return next();
});

// --- Auth --------------------------------------------------------------------
app.post("/api/auth", async (c) => {
  const client = clientKey(c);
  const wait = Math.max(loginPerClient.retryAfter(client), loginGlobal.retryAfter("*"));
  if (wait > 0) {
    c.header("Retry-After", String(Math.ceil(wait / 1000)));
    return c.json({ error: "too many attempts, try again later" }, 429);
  }

  const body = (await c.req.json().catch(() => ({}))) as { passcode?: string };
  if (!body.passcode || !(await passcodeMatches(body.passcode, c.env.ACCESS_PASSCODE, c.env.SESSION_SECRET))) {
    loginPerClient.fail(client);
    loginGlobal.fail("*");
    return c.json({ error: "invalid passcode" }, 401);
  }
  loginPerClient.reset(client);
  const token = await signSession(c.env.SESSION_SECRET, SESSION_TTL_MS, await sessionEpoch(c.env));
  setCookie(c, "session", token, {
    httpOnly: true, secure: cookieSecure(c), sameSite: "Lax", path: "/", maxAge: SESSION_TTL_MS / 1000,
  });
  return c.json({ ok: true });
});

app.post("/api/logout", (c) => {
  deleteCookie(c, "session", { path: "/" });
  return c.json({ ok: true });
});

// Revokes every session, including this one and any stolen/forgotten copy.
app.post("/api/logout-all", async (c) => {
  await c.env.DB.prepare(
    `UPDATE app_state SET value = CAST(value AS INTEGER) + 1 WHERE key = 'session_epoch'`,
  ).run();
  deleteCookie(c, "session", { path: "/" });
  return c.json({ ok: true });
});

// --- Books list --------------------------------------------------------------
// Listed: finished books, and finished books currently being re-indexed (the
// UI resumes those when opened). Not listed: uploads that never finished
// their first ingest — they have no usable content, and the stale-ingest
// cleanup removes them.
app.get("/api/books", async (c) => {
  // Reading progress rides along so the library view can sort and show it
  // without opening every book.
  const { results } = await c.env.DB.prepare(
    `SELECT b.id, b.title, b.author, b.code_name, b.chapter_count, b.created_at,
            p.chapter_idx AS progress_idx, p.scroll_ratio AS progress_ratio, p.updated_at AS last_read_at,
            p.furthest_idx AS furthest_idx, p.furthest_ratio AS furthest_ratio
     FROM books b LEFT JOIN progress p ON p.book_id = b.id
     WHERE b.ingest_done = 1 OR b.ever_completed = 1 ORDER BY b.created_at DESC`,
  ).all();
  return c.json({ books: results });
});

// --- Upload: stage 1 — store the raw file + cheap metadata, no chapter
// content yet. The client then drives /ingest-chunk to completion. ----------
interface CreateResult { status: number; body: Record<string, unknown> }

// Validates the bytes as an EPUB and registers it as a not-yet-ingested book.
async function createBookFromBytes(env: Env, bytes: Uint8Array): Promise<CreateResult> {
  let id: string | null = null;
  let rawKey: string | null = null;
  try {
    if (bytes.byteLength > MAX_EPUB_BYTES) return { status: 413, body: { error: "file too large" } };

    let meta;
    try { meta = parseEpubMeta(bytes); }
    catch (err) {
      const msg = errMsg(err);
      // fflate's own wording for a zip with its index missing/cut off means nothing to a user.
      const cutOff = /invalid zip data|unexpected eof/i.test(msg);
      return {
        status: 422,
        body: { error: "could not parse EPUB: " + (cutOff
          ? "the zip data is missing or cut off (an incomplete download?) — get the file again" : msg) },
      };
    }
    if (meta.spine.length === 0) {
      return { status: 422, body: { error: "could not parse EPUB: no readable chapters found" } };
    }

    id = crypto.randomUUID();
    rawKey = `raw/${id}.epub`;
    const codeName = fakeCodeName(meta.title);
    await env.BOOKS.put(rawKey, bytes, { httpMetadata: { contentType: "application/epub+zip" } });
    await env.BOOKS.put(
      spineMetaKey(id),
      JSON.stringify({ spine: meta.spine, toc: [...meta.tocMap.entries()] }),
      { httpMetadata: { contentType: "application/json" } },
    );
    await env.DB.prepare(
      `INSERT INTO books (id, title, author, language, r2_key, code_name, chapter_count, created_at, ingest_done, ever_completed)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0)`,
    ).bind(id, meta.title, meta.author, meta.language, rawKey, codeName, meta.spine.length, Date.now()).run();

    return { status: 200, body: { id, title: meta.title, code_name: codeName, total: meta.spine.length } };
  } catch (err) {
    if (id) {
      try {
        await env.DB.batch([
          env.DB.prepare(`DELETE FROM chapters WHERE book_id = ?`).bind(id),
          env.DB.prepare(`DELETE FROM books WHERE id = ?`).bind(id),
        ]);
        await env.BOOKS.delete([contentBinKey(id), spineMetaKey(id), ...(rawKey ? [rawKey] : [])]);
      } catch {}
    }
    console.error("upload error", err);
    return { status: 500, body: { error: "server error: " + errMsg(err) } };
  }
}

// One-request upload (kept for scripts and small files; the web UI uses the
// part-by-part routes below). If the client says how big the file is, a
// mismatch means the request was cut off in transit: say so, rather than
// letting the parser report a confusing "invalid zip data".
app.post("/api/books", async (c) => {
  const form = await c.req.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File)) return c.json({ error: "missing file" }, 400);
  const declared = Number(form?.get("size"));
  if (declared && declared !== file.size) {
    return c.json({ error: `upload was cut off: received ${file.size} of ${declared} bytes` }, 400);
  }
  const r = await createBookFromBytes(c.env, new Uint8Array(await file.arrayBuffer()));
  return c.json(r.body, r.status as ContentfulStatusCode);
});

// --- Upload in parts: create -> PUT each part (any order, safe to repeat) ->
// complete. Each request is small and short, so a slow or flaky link never
// hits a proxy's whole-request timeout. -------------------------------------
app.post("/api/uploads", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { size?: number; name?: string };
  const size = Number(body.size);
  if (!Number.isInteger(size) || size <= 0) return c.json({ error: "size is required" }, 400);
  if (size > MAX_EPUB_BYTES) return c.json({ error: "file too large" }, 413);
  const id = crypto.randomUUID();
  await c.env.DB.prepare(
    `INSERT INTO uploads (id, size, part_size, name, created_at) VALUES (?, ?, ?, ?, ?)`,
  ).bind(id, size, UPLOAD_PART_BYTES, String(body.name ?? "").slice(0, 200), Date.now()).run();
  return c.json({ id, part_size: UPLOAD_PART_BYTES, parts: Math.ceil(size / UPLOAD_PART_BYTES) });
});

const TEXT_NAME_RE = /\.(txt|text|html?|xhtml)$/i;
function convertTextUpload(bytes: Uint8Array, name: string) {
  let text = decodeText(bytes);
  if (/\.(html?|xhtml)$/i.test(name)) text = htmlToText(text);
  const title = name.replace(/\.[^.]+$/, "").trim() || "Untitled";
  const split = splitChapters(text, { fallbackTitle: title });
  const sizeOf = (c: { paragraphs: string[] }) => c.paragraphs.join("").length;
  const samples = split.chapters.map((c, i) => ({ n: i + 1, title: c.title, chars: sizeOf(c) }));
  const preview = {
    title, rule: split.rule, chapters: split.chapters.length, chars: split.chars, warnings: split.warnings,
    samples: samples.length > 14 ? [...samples.slice(0, 10), ...samples.slice(-3)] : samples,
  };
  const epub = split.chapters.length
    ? buildEpub({ title, chapters: split.chapters.map((c) => ({ title: c.title, blocks: c.paragraphs.map((p) => ({ type: "p", text: p })) })) })
    : new Uint8Array();
  return { preview, epub };
}

interface UploadRow { size: number; part_size: number; book_id: string | null; name?: string | null }

app.put("/api/uploads/:id/parts/:n", async (c) => {
  const id = c.req.param("id");
  const n = Number(c.req.param("n"));
  const up = await c.env.DB.prepare(`SELECT size, part_size, book_id FROM uploads WHERE id = ?`)
    .bind(id).first<UploadRow>();
  if (!up || up.book_id) return c.json({ error: "not found" }, 404);
  const parts = Math.ceil(up.size / up.part_size);
  if (!Number.isInteger(n) || n < 0 || n >= parts) return c.json({ error: "no such part" }, 400);
  const expected = n === parts - 1 ? up.size - n * up.part_size : up.part_size;
  const data = new Uint8Array(await c.req.arrayBuffer());
  if (data.byteLength !== expected) {
    return c.json({ error: `part ${n} must be ${expected} bytes but ${data.byteLength} arrived (cut off?)` }, 400);
  }
  await c.env.BOOKS.put(uploadPartKey(id, n), data);
  return c.json({ ok: true });
});

app.delete("/api/uploads/:id", async (c) => {
  const id = c.req.param("id");
  await discardUploadParts(c.env, id);
  await c.env.DB.prepare(`DELETE FROM uploads WHERE id = ? AND book_id IS NULL`).bind(id).run();
  return c.json({ ok: true });
});

app.post("/api/uploads/:id/complete", async (c) => {
  const id = c.req.param("id");
  const lock = `upload:${id}`;
  if (busyBooks.has(lock)) return c.json({ error: "this upload is already being completed" }, 409);
  busyBooks.add(lock);
  try {
    const up = await c.env.DB.prepare(`SELECT size, part_size, book_id, name FROM uploads WHERE id = ?`)
      .bind(id).first<UploadRow>();
    if (!up) return c.json({ error: "not found" }, 404);

    // Already assembled (the client is retrying after a lost response): answer with the same book.
    if (up.book_id) {
      const book = await c.env.DB.prepare(`SELECT id, title, code_name, chapter_count FROM books WHERE id = ?`)
        .bind(up.book_id).first<{ id: string; title: string; code_name: string; chapter_count: number }>();
      if (!book) return c.json({ error: "the book from this upload no longer exists" }, 404);
      return c.json({ id: book.id, title: book.title, code_name: book.code_name, total: book.chapter_count });
    }

    const parts = Math.ceil(up.size / up.part_size);
    const { objects } = await c.env.BOOKS.list({ prefix: uploadPrefix(id) });
    const have = new Set(objects.map((o) => o.key));
    const missing: number[] = [];
    for (let i = 0; i < parts; i++) if (!have.has(uploadPartKey(id, i))) missing.push(i);
    if (missing.length) {
      return c.json({ error: `missing parts: ${missing.slice(0, 10).join(", ")}${missing.length > 10 ? "..." : ""}`, missing }, 409);
    }

    const bytes = new Uint8Array(up.size);
    let pos = 0;
    for (let i = 0; i < parts; i++) {
      const obj = await c.env.BOOKS.get(uploadPartKey(id, i));
      if (!obj) return c.json({ error: `part ${i} is missing`, missing: [i] }, 409);
      const chunk = new Uint8Array(await obj.arrayBuffer());
      bytes.set(chunk, pos);
      pos += chunk.length;
    }
    if (pos !== up.size) return c.json({ error: "assembled size does not match" }, 400);

    // A .txt/.html file is cut into chapters and wrapped as an EPUB, then goes
    // through the same pipeline as any book. ?dry=1 only reports what it would
    // do (parts stay, so the real import needs no second upload).
    let source: Uint8Array = bytes;
    if (TEXT_NAME_RE.test(up.name ?? "")) {
      const conv = convertTextUpload(bytes, up.name ?? "");
      if (!conv.preview.chapters) {
        await discardUploadParts(c.env, id);
        await c.env.DB.prepare(`DELETE FROM uploads WHERE id = ?`).bind(id).run();
        return c.json({ error: "could not find any text in this file" }, 422);
      }
      if (c.req.query("dry") === "1") return c.json({ preview: conv.preview });
      source = conv.epub;
    }
    const r = await createBookFromBytes(c.env, source);
    await discardUploadParts(c.env, id);
    if (r.status === 200) {
      await c.env.DB.prepare(`UPDATE uploads SET book_id = ? WHERE id = ?`).bind(r.body.id as string, id).run();
    } else {
      // A definitive refusal (not an EPUB, too large...): retrying can't change it.
      await c.env.DB.prepare(`DELETE FROM uploads WHERE id = ?`).bind(id).run();
    }
    return c.json(r.body, r.status as ContentfulStatusCode);
  } finally {
    busyBooks.delete(lock);
  }
});

// --- Upload: stage 2 — process the next CHUNK_SIZE chapters. Call
// repeatedly until the response says done: true. Safe to retry: it resumes
// from MAX(idx)+1 already in D1, so a failed call just redoes a few
// chapters rather than corrupting anything. -----------------------------------
app.post("/api/books/:id/ingest-chunk", async (c) => {
  const id = c.req.param("id");
  if (busyBooks.has(id)) return c.json({ error: "another operation is running for this book" }, 409);
  busyBooks.add(id);
  try { return await ingestChunk(c, id); }
  finally { busyBooks.delete(id); }
});

async function ingestChunk(c: Context<{ Bindings: Env }>, id: string): Promise<Response> {
  const book = await c.env.DB.prepare(
    `SELECT r2_key, chapter_count, ingest_done, ingest_upload_id, ingest_part_number, ingest_offset, ingest_parts_json
     FROM books WHERE id = ?`,
  ).bind(id).first<BookIngestRow>();
  if (!book) return c.json({ error: "not found" }, 404);
  if (book.ingest_done) return c.json({ done: true, processed: book.chapter_count, total: book.chapter_count });

  const obj = await c.env.BOOKS.get(book.r2_key);
  if (!obj) return c.json({ error: "raw epub missing" }, 404);
  const bytes = new Uint8Array(await obj.arrayBuffer());

  let spine: SpineItem[], tocMap: Map<string, string>;
  try { ({ spine, tocMap } = await loadSpineMeta(c.env, id, bytes)); }
  catch (err) { return c.json({ error: "parse failed: " + errMsg(err) }, 422); }

  const nextRow = await c.env.DB.prepare(
    `SELECT COALESCE(MAX(idx) + 1, 0) AS n FROM chapters WHERE book_id = ?`,
  ).bind(id).first<{ n: number }>();
  const nextIdx = nextRow?.n ?? 0;
  const chunkSize = Math.min(2000, Math.max(1, Number(c.env.CHUNK_SIZE) || CHUNK_SIZE));
  const slice: SpineItem[] = spine.slice(nextIdx, nextIdx + chunkSize);
  const isLast = nextIdx + slice.length >= spine.length;

  const content = new ContentWriter(c.env, id, contentBinKey(id), {
    uploadId: book.ingest_upload_id,
    partNumber: book.ingest_part_number,
    offset: book.ingest_offset,
    parts: JSON.parse(book.ingest_parts_json || "[]"),
  });
  const metaWriter = new MetaWriter(c.env, id);
  const enc = new TextEncoder();

  try {
    const chapters = extractChapterRange(bytes, slice, tocMap);

    // Encode every chapter in this chunk first, then stage them as one
    // combined R2 object — a single write, not one per chapter.
    const encoded = chapters.map((chapter) => ({
      chapter,
      bytes: enc.encode(JSON.stringify(chapter.blocks)),
    }));
    const combinedLen = encoded.reduce((s, e) => s + e.bytes.length, 0);
    const combined = new Uint8Array(combinedLen);
    let pos = 0;
    const chunkStartOffset = content.currentOffset;
    for (const { chapter, bytes: chBytes } of encoded) {
      await metaWriter.add({
        idx: chapter.order,
        title: chapter.title,
        file_name: fakeFileName(chapter.order),
        char_count: chapter.blocks.reduce((s, b) => s + b.text.length, 0),
        offset: chunkStartOffset + pos,
        length: chBytes.length,
      });
      combined.set(chBytes, pos);
      pos += chBytes.length;
    }
    await content.stage(combined);
    await metaWriter.flush();
    await content.maybeConsolidate();

    if (isLast) {
      await content.finish();
      await c.env.DB.prepare(`UPDATE books SET ingest_done = 1, ever_completed = 1 WHERE id = ?`).bind(id).run();
      return c.json({ done: true, processed: spine.length, total: spine.length });
    }

    const snap = content.snapshot();
    await c.env.DB.prepare(
      `UPDATE books SET ingest_upload_id = ?, ingest_part_number = ?, ingest_offset = ?, ingest_parts_json = ?
       WHERE id = ?`,
    ).bind(snap.uploadId, snap.partNumber, snap.offset, JSON.stringify(snap.parts), id).run();

    return c.json({ done: false, processed: nextIdx + slice.length, total: spine.length });
  } catch (err) {
    await content.abort();
    console.error("ingest-chunk error", err);
    if (err instanceof EpubLimitError) return c.json({ error: errMsg(err) }, 422);
    return c.json({ error: "server error: " + errMsg(err) }, 500);
  }
}

app.delete("/api/books/:id", async (c) => {
  const id = c.req.param("id");
  if (busyBooks.has(id)) return c.json({ error: "another operation is running for this book" }, 409);
  busyBooks.add(id);
  try {
    const book = await c.env.DB.prepare(`SELECT r2_key, ingest_done, ingest_upload_id FROM books WHERE id = ?`)
      .bind(id).first<{ r2_key: string; ingest_done: number; ingest_upload_id: string | null }>();
    if (!book) return c.json({ error: "not found" }, 404);

    if (!book.ingest_done) await abortIngest(c.env, id, book.ingest_upload_id);
    await c.env.BOOKS.delete([book.r2_key, contentBinKey(id), legacyContentKey(id), spineMetaKey(id)]);
    await c.env.DB.batch([
      c.env.DB.prepare(`DELETE FROM chapters WHERE book_id = ?`).bind(id),
      c.env.DB.prepare(`DELETE FROM progress WHERE book_id = ?`).bind(id),
      c.env.DB.prepare(`DELETE FROM highlights WHERE book_id = ?`).bind(id),
      c.env.DB.prepare(`DELETE FROM bookmarks WHERE book_id = ?`).bind(id),
      c.env.DB.prepare(`DELETE FROM books WHERE id = ?`).bind(id),
    ]);
    await dropSearchIndex(c.env, id);
    return c.json({ ok: true });
  } finally {
    busyBooks.delete(id);
  }
});

// --- Chapter index (metadata only) -------------------------------------------
app.get("/api/books/:id/index", async (c) => {
  const id = c.req.param("id");
  const book = await c.env.DB.prepare(
    `SELECT id, title, author, code_name, chapter_count, ingest_done FROM books WHERE id = ?`,
  ).bind(id).first();
  if (!book) return c.json({ error: "not found" }, 404);

  const { results: chapters } = await c.env.DB.prepare(
    `SELECT idx, title, file_name, char_count FROM chapters WHERE book_id = ? ORDER BY idx`,
  ).bind(id).all();
  const progress = await c.env.DB.prepare(
    `SELECT chapter_idx, scroll_ratio, furthest_idx, furthest_ratio, updated_at FROM progress WHERE book_id = ?`,
  ).bind(id).first();

  return c.json({ ...book, chapters, progress: progress ?? null });
});

// --- Single chapter — fetched via R2 byte range ------------------------------
app.get("/api/books/:id/chapters/:idx", async (c) => {
  const id = c.req.param("id");
  const idx = Number(c.req.param("idx"));
  // While a book is (re-)indexing, its chapter rows point into a content file
  // that is still being rewritten — serving them would return wrong text.
  const state = await c.env.DB.prepare(`SELECT ingest_done FROM books WHERE id = ?`)
    .bind(id).first<{ ingest_done: number }>();
  if (state && !state.ingest_done) return c.json({ error: "book is being indexed" }, 409);
  const row = await c.env.DB.prepare(
    `SELECT idx, title, file_name, byte_offset, byte_length, blocks
     FROM chapters WHERE book_id = ? AND idx = ?`,
  ).bind(id, idx).first<{
    idx: number; title: string | null; file_name: string;
    byte_offset: number | null; byte_length: number | null; blocks: string | null;
  }>();
  if (!row) return c.json({ error: "not found" }, 404);

  const blocks = await readBlocks(c.env, id, row);
  return c.json({ idx: row.idx, title: row.title, file_name: row.file_name, blocks });
});

// --- Re-index: reset a book's ingest state and wipe its chapters, then the
// client drives /ingest-chunk the same way it does for a fresh upload. -------
app.post("/api/books/:id/reindex", async (c) => {
  const id = c.req.param("id");
  if (busyBooks.has(id)) return c.json({ error: "another operation is running for this book" }, 409);
  busyBooks.add(id);
  try {
    const book = await c.env.DB.prepare(`SELECT id, ingest_upload_id FROM books WHERE id = ?`)
      .bind(id).first<{ id: string; ingest_upload_id: string | null }>();
    if (!book) return c.json({ error: "not found" }, 404);

    await abortIngest(c.env, id, book.ingest_upload_id);
    await c.env.DB.prepare(`DELETE FROM chapters WHERE book_id = ?`).bind(id).run();
    await dropSearchIndex(c.env, id); // its chapter text is about to be rewritten
    await c.env.DB.prepare(
      `UPDATE books SET ingest_done = 0, ingest_upload_id = NULL, ingest_part_number = 1,
         ingest_offset = 0, ingest_parts_json = '[]'
       WHERE id = ?`,
    ).bind(id).run();
    await c.env.BOOKS.delete(legacyContentKey(id));

    return c.json({ ok: true });
  } finally {
    busyBooks.delete(id);
  }
});

// --- Progress ----------------------------------------------------------------
app.post("/api/books/:id/progress", async (c) => {
  const id = c.req.param("id");
  const body = (await c.req.json().catch(() => ({}))) as { chapter_idx?: number; scroll_ratio?: number; client_ts?: number };
  const chapterIdx = Number.isFinite(body.chapter_idx) ? Math.floor(body.chapter_idx as number) : 0;
  const ratio = Number.isFinite(body.scroll_ratio) ? Math.min(1, Math.max(0, body.scroll_ratio as number)) : 0;
  // Devices that predate client_ts send none: treat the request as "now".
  const clientTs = clampTs(body.client_ts);

  const exists = await c.env.DB.prepare(`SELECT 1 AS ok FROM books WHERE id = ?`).bind(id).first();
  if (!exists) return c.json({ error: "not found" }, 404);
  // Two rules in one row. The *current* position (used to resume) belongs to
  // whichever device wrote last by its own clock. The *furthest* position (used
  // for "% read") only ever moves forward, whatever order requests arrive in.
  const ahead = `(excluded.furthest_idx > progress.furthest_idx
    OR (excluded.furthest_idx = progress.furthest_idx AND excluded.furthest_ratio > progress.furthest_ratio))`;
  await c.env.DB.prepare(
    `INSERT INTO progress (book_id, chapter_idx, scroll_ratio, updated_at, furthest_idx, furthest_ratio, client_ts)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(book_id) DO UPDATE SET
       chapter_idx    = CASE WHEN excluded.client_ts >= progress.client_ts THEN excluded.chapter_idx ELSE progress.chapter_idx END,
       scroll_ratio   = CASE WHEN excluded.client_ts >= progress.client_ts THEN excluded.scroll_ratio ELSE progress.scroll_ratio END,
       client_ts      = MAX(excluded.client_ts, progress.client_ts),
       updated_at     = excluded.updated_at,
       furthest_idx   = CASE WHEN ${ahead} THEN excluded.furthest_idx ELSE progress.furthest_idx END,
       furthest_ratio = CASE WHEN ${ahead} THEN excluded.furthest_ratio ELSE progress.furthest_ratio END`,
  ).bind(id, chapterIdx, ratio, Date.now(), chapterIdx, ratio, clientTs).run();

  return c.json({ ok: true });
});

// --- Synced reader state: settings, highlights, bookmarks ----------------------
// Everything a reader creates lives in SQLite (backed up, follows the reader
// across devices); the browser only keeps a cache. Conflicts: for settings and
// highlights the newest device timestamp wins; progress has its own rule (see
// the progress route).

// A device with a wrong clock must not be able to freeze a value in the future.
const MAX_TS_SKEW_MS = 60_000;
function clampTs(v: unknown): number {
  const n = typeof v === "number" && Number.isFinite(v) ? Math.floor(v) : Date.now();
  return Math.max(0, Math.min(n, Date.now() + MAX_TS_SKEW_MS));
}
const isInt = (v: unknown, min: number, max: number): v is number =>
  typeof v === "number" && Number.isInteger(v) && v >= min && v <= max;
function safeParse(s: string): unknown {
  try { return JSON.parse(s); } catch { return null; }
}

type SettingsMap = Record<string, { value: unknown; updated_at: number }>;
async function readSettings(env: Env): Promise<SettingsMap> {
  const { results } = await env.DB.prepare(`SELECT key, value, updated_at FROM settings`)
    .all<{ key: string; value: string; updated_at: number }>();
  const out: SettingsMap = {};
  for (const r of results) out[r.key] = { value: safeParse(r.value), updated_at: r.updated_at };
  return out;
}

app.get("/api/settings", async (c) => c.json({ settings: await readSettings(c.env) }));

app.put("/api/settings", async (c) => {
  const body = (await c.req.json().catch(() => null)) as
    | { changes?: Record<string, { value?: unknown; updated_at?: unknown }> }
    | null;
  const changes = body?.changes;
  if (!changes || typeof changes !== "object") return c.json({ error: "changes required" }, 400);
  const entries = Object.entries(changes);
  if (entries.length > 100) return c.json({ error: "too many settings in one request" }, 400);

  const stmts = [];
  for (const [key, change] of entries) {
    if (!/^[A-Za-z0-9_.-]{1,64}$/.test(key)) return c.json({ error: `bad setting name: ${key}` }, 400);
    const raw = JSON.stringify(change?.value ?? null);
    if (raw.length > 8192) return c.json({ error: `setting too large: ${key}` }, 400);
    stmts.push(c.env.DB.prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
       WHERE excluded.updated_at >= settings.updated_at`,
    ).bind(key, raw, clampTs(change?.updated_at)));
  }
  if (stmts.length) {
    const { n } = (await c.env.DB.prepare(`SELECT COUNT(*) AS n FROM settings`).first<{ n: number }>()) ?? { n: 0 };
    if (n > 300) return c.json({ error: "too many stored settings" }, 400);
    await c.env.DB.batch(stmts);
  }
  return c.json({ settings: await readSettings(c.env) });
});

// Highlights: the set for one chapter is replaced as a whole.
type HighlightItem = { p: number; start: number; end: number };
function validHighlights(items: unknown): items is HighlightItem[] {
  return Array.isArray(items) && items.length <= 5000 && items.every((h) =>
    h && typeof h === "object" &&
    isInt((h as HighlightItem).p, 0, 100_000) &&
    isInt((h as HighlightItem).start, 0, 1_000_000) &&
    isInt((h as HighlightItem).end, 1, 1_000_000) &&
    (h as HighlightItem).end > (h as HighlightItem).start);
}

app.get("/api/books/:id/highlights", async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT chapter_idx, items, updated_at FROM highlights WHERE book_id = ?`,
  ).bind(c.req.param("id")).all<{ chapter_idx: number; items: string; updated_at: number }>();
  const chapters: Record<string, { items: unknown; updated_at: number }> = {};
  for (const r of results) chapters[String(r.chapter_idx)] = { items: safeParse(r.items) ?? [], updated_at: r.updated_at };
  return c.json({ chapters });
});

app.put("/api/books/:id/chapters/:idx/highlights", async (c) => {
  const id = c.req.param("id");
  const idx = Number(c.req.param("idx"));
  if (!isInt(idx, 0, 100_000)) return c.json({ error: "bad chapter" }, 400);
  const body = (await c.req.json().catch(() => null)) as { items?: unknown; updated_at?: unknown } | null;
  if (!body || !validHighlights(body.items)) return c.json({ error: "bad highlights" }, 400);
  const exists = await c.env.DB.prepare(`SELECT 1 AS ok FROM books WHERE id = ?`).bind(id).first();
  if (!exists) return c.json({ error: "not found" }, 404);

  await c.env.DB.prepare(
    `INSERT INTO highlights (book_id, chapter_idx, items, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(book_id, chapter_idx) DO UPDATE SET items = excluded.items, updated_at = excluded.updated_at
     WHERE excluded.updated_at >= highlights.updated_at`,
  ).bind(id, idx, JSON.stringify(body.items), clampTs(body.updated_at)).run();
  const cur = await c.env.DB.prepare(`SELECT items, updated_at FROM highlights WHERE book_id = ? AND chapter_idx = ?`)
    .bind(id, idx).first<{ items: string; updated_at: number }>();
  return c.json({ ok: true, items: cur ? safeParse(cur.items) : [], updated_at: cur?.updated_at ?? 0 });
});

// Bookmarks (a paragraph in a chapter, plus a short snippet to recognise it by).
app.get("/api/bookmarks", async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT id, book_id, chapter_idx, p, snippet, note, created_at FROM bookmarks ORDER BY created_at DESC LIMIT 2000`,
  ).all();
  return c.json({ bookmarks: results });
});

app.post("/api/books/:id/bookmarks", async (c) => {
  const id = c.req.param("id");
  const body = (await c.req.json().catch(() => null)) as
    | { chapter_idx?: unknown; p?: unknown; snippet?: unknown; note?: unknown }
    | null;
  if (!body || !isInt(body.chapter_idx, 0, 100_000) || !isInt(body.p, 0, 100_000)) return c.json({ error: "bad bookmark" }, 400);
  const exists = await c.env.DB.prepare(`SELECT 1 AS ok FROM books WHERE id = ?`).bind(id).first();
  if (!exists) return c.json({ error: "not found" }, 404);

  // One bookmark per paragraph: asking again returns the existing one.
  const dup = await c.env.DB.prepare(
    `SELECT id, book_id, chapter_idx, p, snippet, note, created_at FROM bookmarks WHERE book_id = ? AND chapter_idx = ? AND p = ?`,
  ).bind(id, body.chapter_idx, body.p).first();
  if (dup) return c.json({ bookmark: dup });
  const { n } = (await c.env.DB.prepare(`SELECT COUNT(*) AS n FROM bookmarks`).first<{ n: number }>()) ?? { n: 0 };
  if (n >= 5000) return c.json({ error: "too many bookmarks" }, 400);

  const bookmark = {
    id: crypto.randomUUID(),
    book_id: id,
    chapter_idx: body.chapter_idx,
    p: body.p,
    snippet: typeof body.snippet === "string" ? body.snippet.slice(0, 120) : "",
    note: typeof body.note === "string" ? body.note.slice(0, 500) : "",
    created_at: Date.now(),
  };
  await c.env.DB.prepare(
    `INSERT INTO bookmarks (id, book_id, chapter_idx, p, snippet, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).bind(bookmark.id, bookmark.book_id, bookmark.chapter_idx, bookmark.p, bookmark.snippet, bookmark.note, bookmark.created_at).run();
  return c.json({ bookmark });
});

app.put("/api/bookmarks/:bid", async (c) => {
  const body = (await c.req.json().catch(() => null)) as { note?: unknown } | null;
  if (!body || typeof body.note !== "string") return c.json({ error: "note required" }, 400);
  const res = await c.env.DB.prepare(`UPDATE bookmarks SET note = ? WHERE id = ?`).bind(body.note.slice(0, 500), c.req.param("bid")).run();
  if (!res.meta.changes) return c.json({ error: "not found" }, 404);
  return c.json({ ok: true });
});

app.delete("/api/bookmarks/:bid", async (c) => {
  const res = await c.env.DB.prepare(`DELETE FROM bookmarks WHERE id = ?`).bind(c.req.param("bid")).run();
  if (!res.meta.changes) return c.json({ error: "not found" }, 404);
  return c.json({ ok: true });
});

// --- Full-text search ------------------------------------------------------------
// One FTS5 row per chapter (see src/search.ts). The table is created on first use
// rather than by a migration: if a database engine lacks FTS5, search reports
// itself unavailable instead of stopping the whole app from starting.
let ftsReady: boolean | null = null;
async function ensureFts(env: Env): Promise<boolean> {
  if (ftsReady !== null) return ftsReady;
  try {
    await env.DB.prepare(
      `CREATE VIRTUAL TABLE IF NOT EXISTS chapter_fts USING fts5(book_id UNINDEXED, idx UNINDEXED, text, tokenize = 'unicode61 remove_diacritics 2')`,
    ).run();
    ftsReady = true;
  } catch (err) {
    console.error("full-text search is unavailable:", errMsg(err));
    ftsReady = false;
  }
  return ftsReady;
}

// Forget everything indexed for a book (deleted, or about to be re-indexed).
async function dropSearchIndex(env: Env, bookId: string): Promise<void> {
  try {
    if (!(await ensureFts(env))) return;
    await env.DB.batch([
      env.DB.prepare(`DELETE FROM chapter_fts WHERE book_id = ?`).bind(bookId),
      env.DB.prepare(`DELETE FROM search_state WHERE book_id = ?`).bind(bookId),
    ]);
  } catch (err) { console.error("could not drop the search index:", errMsg(err)); }
}

app.get("/api/search/status", async (c) => {
  const available = await ensureFts(c.env);
  const { results } = await c.env.DB.prepare(
    `SELECT b.id AS book_id, b.chapter_count AS total, COALESCE(s.indexed_upto, 0) AS indexed
     FROM books b LEFT JOIN search_state s ON s.book_id = b.id WHERE b.ingest_done = 1`,
  ).all();
  return c.json({ available, books: results });
});

// Indexes the next batch of a book's chapters; call until done is true. Safe to
// repeat: a chapter's row is replaced, never duplicated.
app.post("/api/books/:id/search-index", async (c) => {
  const id = c.req.param("id");
  if (!(await ensureFts(c.env))) return c.json({ error: "search is not available on this server" }, 501);
  const lock = `search:${id}`;
  if (busyBooks.has(lock) || busyBooks.has(id)) return c.json({ error: "another operation is running for this book" }, 409);
  busyBooks.add(lock);
  try {
    const book = await c.env.DB.prepare(`SELECT chapter_count, ingest_done FROM books WHERE id = ?`)
      .bind(id).first<{ chapter_count: number; ingest_done: number }>();
    if (!book) return c.json({ error: "not found" }, 404);
    if (!book.ingest_done) return c.json({ error: "book is being indexed" }, 409);

    const st = await c.env.DB.prepare(`SELECT indexed_upto FROM search_state WHERE book_id = ?`)
      .bind(id).first<{ indexed_upto: number }>();
    const from = st?.indexed_upto ?? 0;
    const batch = Math.min(500, Math.max(1, Number(c.env.CHUNK_SIZE) || 30));
    const { results: rows } = await c.env.DB.prepare(
      `SELECT idx, byte_offset, byte_length, blocks FROM chapters WHERE book_id = ? AND idx >= ? ORDER BY idx LIMIT ?`,
    ).bind(id, from, batch).all<{ idx: number; byte_offset: number | null; byte_length: number | null; blocks: string | null }>();

    const stmts = [];
    let upto = from;
    for (const r of rows) {
      const text = foldVi((await readBlocks(c.env, id, r)).map((b) => b.text).join("\n"));
      stmts.push(c.env.DB.prepare(`DELETE FROM chapter_fts WHERE book_id = ? AND idx = ?`).bind(id, r.idx));
      stmts.push(c.env.DB.prepare(`INSERT INTO chapter_fts (book_id, idx, text) VALUES (?, ?, ?)`).bind(id, r.idx, text));
      upto = r.idx + 1;
    }
    if (!rows.length) upto = book.chapter_count;
    stmts.push(c.env.DB.prepare(
      `INSERT INTO search_state (book_id, indexed_upto, total, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(book_id) DO UPDATE SET indexed_upto = excluded.indexed_upto, total = excluded.total, updated_at = excluded.updated_at`,
    ).bind(id, upto, book.chapter_count, Date.now()));
    await c.env.DB.batch(stmts);
    return c.json({ done: upto >= book.chapter_count, indexed: upto, total: book.chapter_count });
  } finally {
    busyBooks.delete(lock);
  }
});

app.get("/api/search", async (c) => {
  if (!(await ensureFts(c.env))) return c.json({ error: "search is not available on this server" }, 501);
  const q = buildMatch(c.req.query("q") ?? "");
  if (!q) return c.json({ error: "type at least one word" }, 400);
  const book = c.req.query("book");
  const limit = Math.min(40, Math.max(1, Math.floor(Number(c.req.query("limit"))) || 20));

  const { results: chapterHits } = await c.env.DB.prepare(
    `SELECT book_id, idx FROM chapter_fts WHERE chapter_fts MATCH ?${book ? " AND book_id = ?" : ""} ORDER BY rank LIMIT ?`,
  ).bind(...(book ? [q.match, book, limit] : [q.match, limit])).all<{ book_id: string; idx: number }>();

  const results = [];
  for (const h of chapterHits) {
    const row = await c.env.DB.prepare(
      `SELECT idx, title, file_name, byte_offset, byte_length, blocks FROM chapters WHERE book_id = ? AND idx = ?`,
    ).bind(h.book_id, h.idx).first<{ idx: number; title: string | null; file_name: string; byte_offset: number | null; byte_length: number | null; blocks: string | null }>();
    if (!row) continue;
    for (const hit of findHits(await readBlocks(c.env, h.book_id, row), q.tokens)) {
      results.push({ book_id: h.book_id, idx: h.idx, chapter_title: row.title || row.file_name, ...hit });
    }
    if (results.length >= limit * 3) break;
  }
  return c.json({ query: q.tokens.join(" "), results });
});

// --- Reading time statistics ---------------------------------------------------
// The UI reports how long the window was in front of the reader, in small
// batches. Only durations are stored (see migration 0008).
type Ping = { book_id: string; day: string; hour: number; seconds: number };
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
function validPing(p: unknown): p is Ping {
  if (!p || typeof p !== "object") return false;
  const x = p as Ping;
  return typeof x.book_id === "string" && x.book_id.length >= 1 && x.book_id.length <= 64 &&
    typeof x.day === "string" && DAY_RE.test(x.day) &&
    isInt(x.hour, 0, 23) && isInt(x.seconds, 1, 3600);
}

app.post("/api/stats/ping", async (c) => {
  const body = (await c.req.json().catch(() => null)) as { pings?: unknown } | null;
  const pings = body?.pings;
  if (!Array.isArray(pings) || pings.length === 0 || pings.length > 200 || !pings.every(validPing)) {
    return c.json({ error: "bad pings" }, 400);
  }
  await c.env.DB.batch(pings.map((p) => c.env.DB.prepare(
    `INSERT INTO reading_hourly (day, hour, book_id, seconds) VALUES (?, ?, ?, ?)
     ON CONFLICT(day, hour, book_id) DO UPDATE SET seconds = seconds + excluded.seconds`,
  ).bind(p.day, p.hour, p.book_id, p.seconds)));
  return c.json({ ok: true, accepted: pings.length });
});

// One year of activity by default: per day, per hour of day, per book.
app.get("/api/stats", async (c) => {
  const days = Math.min(732, Math.max(1, Math.floor(Number(c.req.query("days"))) || 371));
  const since = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
  const [daily, hourly, perBook] = await Promise.all([
    c.env.DB.prepare(`SELECT day, SUM(seconds) AS seconds FROM reading_hourly WHERE day >= ? GROUP BY day ORDER BY day`).bind(since).all(),
    c.env.DB.prepare(`SELECT hour, SUM(seconds) AS seconds FROM reading_hourly WHERE day >= ? GROUP BY hour ORDER BY hour`).bind(since).all(),
    c.env.DB.prepare(`SELECT book_id, SUM(seconds) AS seconds FROM reading_hourly WHERE day >= ? GROUP BY book_id ORDER BY seconds DESC LIMIT 20`).bind(since).all(),
  ]);
  return c.json({ since, daily: daily.results, hourly: hourly.results, per_book: perBook.results });
});

// --- Export a book as EPUB or plain text ----------------------------------------
// The original file is not kept (only parsed text), so the EPUB is rebuilt from
// the stored chapters. The file is named after the module's disguise name unless
// ?real=1 asks for the real title.
app.get("/api/books/:id/export", async (c) => {
  const id = c.req.param("id");
  const format = c.req.query("format");
  if (format !== "epub" && format !== "txt") return c.json({ error: "format must be epub or txt" }, 400);
  const book = await c.env.DB.prepare(
    `SELECT title, author, language, code_name, chapter_count, ingest_done FROM books WHERE id = ?`,
  ).bind(id).first<{ title: string; author: string | null; language: string | null; code_name: string; chapter_count: number; ingest_done: number }>();
  if (!book) return c.json({ error: "not found" }, 404);
  if (!book.ingest_done) return c.json({ error: "book is being indexed" }, 409);

  const last = Math.max(0, book.chapter_count - 1);
  const from = Math.min(last, Math.max(0, Math.floor(Number(c.req.query("from"))) || 0));
  const to = Math.min(last, Math.max(from, Number.isFinite(Number(c.req.query("to"))) && c.req.query("to") ? Math.floor(Number(c.req.query("to"))) : last));
  const { results: rows } = await c.env.DB.prepare(
    `SELECT idx, title, file_name, byte_offset, byte_length, blocks FROM chapters WHERE book_id = ? AND idx BETWEEN ? AND ? ORDER BY idx`,
  ).bind(id, from, to).all<{ idx: number; title: string | null; file_name: string; byte_offset: number | null; byte_length: number | null; blocks: string | null }>();
  if (!rows.length) return c.json({ error: "no chapters in that range" }, 404);

  const chapters = [];
  for (const r of rows) chapters.push({ title: r.title || r.file_name, blocks: await readBlocks(c.env, id, r) });
  const input = { title: book.title, author: book.author, language: book.language, chapters };

  const real = c.req.query("real") === "1";
  const base = (real ? book.title : book.code_name).replace(/[\\/:*?"<>|\u0000-\u001F]/g, "_").trim().slice(0, 100) || "book";
  const name = `${base}.${format}`;
  const headers = {
    "content-disposition": `attachment; filename="${name.replace(/[^A-Za-z0-9._-]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(name)}`,
    "content-type": format === "epub" ? "application/epub+zip" : "text/plain; charset=utf-8",
  };
  if (format === "txt") return new Response(buildText(input), { headers });
  return new Response(buildEpub(input) as unknown as BodyInit, { headers });
});

// --- Static assets fallback --------------------------------------------------
app.all("*", (c) => c.env.ASSETS.fetch(c.req.raw));

export default app;
