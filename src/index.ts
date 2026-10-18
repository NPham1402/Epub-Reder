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
import { passcodeMatches, secretDigest, secretMatches, signSession, verifySession } from "./auth";
import { FailureLimiter } from "./ratelimit";
import {
  abortIngest, busyBooks, contentBinKey, legacyContentKey, spineMetaKey, stagedKey, stagedPrefix, uploadPartKey, uploadPrefix,
} from "./storage";
import { discardUploadParts } from "./maintenance";
import { buildProgressBackup, findParagraph, readVbookBackup, sameTitle, sessionBuckets, vbookBackupName, type VbookBook } from "./vbook";

const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30; // 30 days
const MAX_EPUB_BYTES = 80 * 1024 * 1024; // 80 MB guard
// A vBook backup (.tar.zst) is streamed, never held whole in memory.
const MAX_VBOOK_BYTES = 1024 * 1024 * 1024;
const VBOOK_NAME_RE = /.zst$/i;
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
    workerSrc: ["'self'"], // the offline-reading service worker
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
  if (size > (VBOOK_NAME_RE.test(String(body.name ?? "")) ? MAX_VBOOK_BYTES : MAX_EPUB_BYTES)) return c.json({ error: "file too large" }, 413);
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

    if (VBOOK_NAME_RE.test(up.name ?? "")) return c.json({ error: "this is a vBook backup: use /api/uploads/:id/vbook" }, 400);

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

// --- vBook backup import (docs/platform-upgrade.md §13, EPR-19) ---------------
// The backup arrives through the same part-by-part upload as a book. Reading
// it takes far longer than a proxy waits for one request, so it runs as a
// background job the page polls. Two passes over the (streamed) archive:
// "preview" lists the books and what would happen to each; "import" applies
// the reader's choices. A created book is registered like any upload and the
// page then drives its /ingest-chunk to completion, as for a normal import.
type VbookAction = "create" | "update" | "progress" | "skip";
interface VbookRow {
  id: string; title: string; author: string | null; code_name: string; chapter_count: number;
  vbook_id: string | null; ingest_done: number; vbook_downloaded: number | null;
}
interface VbookItem {
  vbook_id: string; title: string; author: string | null; source: string | null;
  chapters: number; downloaded: number; bookmarks: number;
  progress: { chapter: number; ratio: number; at: number; name: string | null } | null;
  match: { id: string; code_name: string; title: string; by: "vbook" | "title" } | null;
  options: VbookAction[]; action: VbookAction;
  outcome?: string;
}
interface VbookJob {
  id: string; uploadId: string; mode: "preview" | "import"; at: number;
  state: "running" | "done" | "error"; scanned: number; current: string | null;
  error: string | null;
  device: string | null; created_at: number | null;
  items: VbookItem[];
  ingest: { id: string; code_name: string; title: string; total: number }[];
  // vBook's reading sessions; "fresh" = not added to Activity Insights before.
  history: { sessions: number; fresh: number; fresh_seconds: number; added: number } | null;
}
const vbookJobs = new Map<string, VbookJob>();
// Placeholder for a chapter vBook listed but never downloaded: keeps chapter
// numbers identical to vBook's, so progress maps one-to-one.
const VBOOK_MISSING = "(This section has not been downloaded in vBook yet.)";

async function* uploadedBytes(env: Env, id: string, parts: number): AsyncGenerator<Uint8Array> {
  for (let i = 0; i < parts; i++) {
    const obj = await env.BOOKS.get(uploadPartKey(id, i));
    if (!obj) throw new Error(`part ${i} of the upload is missing`);
    yield new Uint8Array(await obj.arrayBuffer());
  }
}

function planVbook(b: VbookBook, rows: VbookRow[]): VbookItem {
  const byId = rows.find((r) => r.vbook_id === b.id);
  const byName = byId ? undefined : rows.find((r) =>
    !r.vbook_id && sameTitle(r.title, b.title) && (!r.author || !b.author || sameTitle(r.author, b.author)));
  const match = byId ?? byName;
  // A vBook book downloaded further (or whose novel grew) since the last
  // import: refresh its text in place (same book, so highlights, bookmarks and
  // position stay) rather than only moving the position.
  const grew = !!byId && b.downloaded > 0 && (b.downloaded > (byId.vbook_downloaded ?? 0) || b.toc.length > byId.chapter_count);
  const options: VbookAction[] = [];
  if (grew) options.push("update");
  if (match) options.push("progress");
  if (byId && !grew && b.downloaded > 0) options.push("update");
  if (!byId && b.downloaded > 0) options.push("create");
  options.push("skip");
  return {
    vbook_id: b.id, title: b.title, author: b.author, source: b.source,
    chapters: b.toc.length, downloaded: b.downloaded, bookmarks: b.bookmarks.length,
    progress: b.progress ? { chapter: b.progress.idx, ratio: b.progress.ratio, at: b.progress.at, name: b.progress.chapter } : null,
    match: match ? { id: match.id, code_name: match.code_name, title: match.title, by: byId ? "vbook" : "title" } : null,
    // Defaults (§13.5): a book that is already here keeps its copy, only its
    // progress moves; a book with no downloaded text can't become readable.
    options, action: options[0],
  };
}

// Where vBook's reading position lands in a book here. A book imported from
// vBook has vBook's exact chapter list; any other copy is matched by title.
async function vbookChapterIdx(env: Env, row: VbookRow, b: VbookBook): Promise<number | null> {
  const p = b.progress;
  if (!p) return null;
  if (row.vbook_id === b.id) return Math.min(p.idx, Math.max(0, row.chapter_count - 1));
  const name = p.chapter ?? b.toc[p.idx];
  const { results } = await env.DB.prepare(`SELECT idx, title FROM chapters WHERE book_id = ? ORDER BY idx`)
    .bind(row.id).all<{ idx: number; title: string | null }>();
  const hit = results.find((r) => sameTitle(r.title, name));
  return hit ? hit.idx : null;
}

// New text for an existing book, keeping its id (and so its highlights,
// bookmarks and position): the same steps as /reindex, plus the new raw EPUB
// and its spine. The page then indexes it like a fresh upload.
async function replaceBookContent(env: Env, id: string, bytes: Uint8Array): Promise<string | null> {
  if (busyBooks.has(id)) return "another operation is running for this book";
  busyBooks.add(id);
  try {
    const meta = parseEpubMeta(bytes);
    const book = await env.DB.prepare(`SELECT r2_key, ingest_upload_id FROM books WHERE id = ?`)
      .bind(id).first<{ r2_key: string; ingest_upload_id: string | null }>();
    if (!book) return "the book is gone";
    await abortIngest(env, id, book.ingest_upload_id);
    await env.BOOKS.put(book.r2_key, bytes, { httpMetadata: { contentType: "application/epub+zip" } });
    await env.BOOKS.put(spineMetaKey(id), JSON.stringify({ spine: meta.spine, toc: [...meta.tocMap.entries()] }),
      { httpMetadata: { contentType: "application/json" } });
    await env.DB.prepare(`DELETE FROM chapters WHERE book_id = ?`).bind(id).run();
    await dropSearchIndex(env, id);
    await env.DB.prepare(
      `UPDATE books SET chapter_count = ?, ingest_done = 0, ingest_upload_id = NULL, ingest_part_number = 1,
         ingest_offset = 0, ingest_parts_json = '[]' WHERE id = ?`,
    ).bind(meta.spine.length, id).run();
    await env.BOOKS.delete([legacyContentKey(id), davEpubKey(id)]);
    return null;
  } catch (err) {
    return errMsg(err);
  } finally {
    busyBooks.delete(id);
  }
}

// vBook bookmarks -> this app's bookmarks (one per paragraph, same rule as the
// route). The paragraph is found by the bookmarked text. fresh = the book's
// text is the one just built from this backup (chapter blocks are the
// chapter's paragraphs behind one heading); otherwise the stored text is read.
async function vbookBookmarks(env: Env, row: VbookRow, b: VbookBook, fresh: boolean): Promise<string> {
  if (!b.bookmarks.length) return "";
  const own = row.vbook_id === b.id;
  let titles: { idx: number; title: string | null }[] | null = null;
  let added = 0;
  for (const bm of b.bookmarks) {
    let idx: number | null = own && bm.chapter < row.chapter_count ? bm.chapter : null;
    if (idx === null && !own) {
      titles ??= (await env.DB.prepare(`SELECT idx, title FROM chapters WHERE book_id = ? ORDER BY idx`).bind(row.id).all<{ idx: number; title: string | null }>()).results;
      const name = bm.chapterName ?? b.toc[bm.chapter];
      idx = titles.find((t) => sameTitle(t.title, name))?.idx ?? null;
    }
    if (idx === null) continue;
    let p = 0;
    if (fresh) {
      const at = findParagraph(b.contents.get(bm.chapter) ?? [], bm.content);
      if (at >= 0) p = at + 1;
    } else {
      const ch = await env.DB.prepare(`SELECT idx, title, file_name, byte_offset, byte_length, blocks FROM chapters WHERE book_id = ? AND idx = ?`)
        .bind(row.id, idx).first<{ idx: number; title: string | null; file_name: string; byte_offset: number | null; byte_length: number | null; blocks: string | null }>();
      if (ch) p = Math.max(0, findParagraph((await readBlocks(env, row.id, ch)).map((x) => x.text), bm.content));
    }
    const dup = await env.DB.prepare(`SELECT 1 AS ok FROM bookmarks WHERE book_id = ? AND chapter_idx = ? AND p = ?`).bind(row.id, idx, p).first();
    if (dup) continue;
    await env.DB.prepare(`INSERT INTO bookmarks (id, book_id, chapter_idx, p, snippet, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .bind(crypto.randomUUID(), row.id, idx, p, (bm.content || bm.chapterName || "").slice(0, 120), bm.note.slice(0, 500), bm.at || Date.now()).run();
    added++;
  }
  return added ? ` · ${added} bookmark${added === 1 ? "" : "s"}` : "";
}

async function runVbookJob(
  env: Env, job: VbookJob, parts: number, choices: Record<string, string>, opts: { history: boolean; tzOffset: number },
): Promise<void> {
  const unzstd = env.VBOOK_UNZSTD!;
  const { results: rows } = await env.DB.prepare(
    `SELECT id, title, author, code_name, chapter_count, vbook_id, ingest_done, vbook_downloaded FROM books`,
  ).all<VbookRow>();
  const want = (it: VbookItem): VbookAction => {
    const c = choices[it.vbook_id] as VbookAction | undefined;
    return c && it.options.includes(c) ? c : it.action;
  };

  // Preview needs only the small JSON files; import keeps chapter text only for
  // the books being created.
  let only: Set<string> | undefined;
  if (job.mode === "import") {
    only = new Set<string>();
    await readVbookBackup(unzstd(uploadedBytes(env, job.uploadId, parts)), async (b) => {
      const a = want(planVbook(b, rows));
      if (a === "create" || a === "update") only!.add(b.id);
    }, { withContent: false });
  }

  const { manifest, sessions } = await readVbookBackup(unzstd(uploadedBytes(env, job.uploadId, parts)), async (b) => {
    job.scanned++;
    job.current = b.title;
    const item = planVbook(b, rows);
    job.items.push(item);
    if (job.mode === "preview") return;
    item.action = want(item);

    if (item.action === "skip") { item.outcome = "skipped"; return; }

    const last = Math.max(b.toc.length, ...[...b.contents.keys()].map((k) => k + 1));
    const vbookEpub = () => buildEpub({
      title: b.title, author: b.author, language: b.language,
      chapters: Array.from({ length: last }, (_, pos) => ({
        title: b.toc[pos] || `Chapter ${pos + 1}`,
        blocks: (b.contents.get(pos) ?? [VBOOK_MISSING]).map((text) => ({ type: "p", text })),
      })),
    });

    if (item.action === "update") {
      const row = rows.find((r) => r.id === item.match!.id)!;
      const err = await replaceBookContent(env, row.id, vbookEpub());
      if (err) { item.outcome = `error: ${err}`; return; }
      await env.DB.prepare(`UPDATE books SET vbook_json = ?, vbook_downloaded = ? WHERE id = ?`)
        .bind(JSON.stringify(b.meta), b.downloaded, row.id).run();
      row.chapter_count = last;
      job.ingest.push({ id: row.id, code_name: row.code_name, title: row.title, total: last });
      if (b.progress) await upsertProgress(env, row.id, Math.min(b.progress.idx, last - 1), b.progress.ratio, clampTs(b.progress.at));
      item.outcome = `content updated (${b.downloaded}/${last} sections with text)` + await vbookBookmarks(env, row, b, true);
      return;
    }

    if (item.action === "create") {
      const r = await createBookFromBytes(env, vbookEpub());
      if (r.status !== 200) { item.outcome = `error: ${String(r.body.error ?? r.status)}`; return; }
      const id = r.body.id as string;
      await env.DB.prepare(`UPDATE books SET vbook_id = ?, vbook_json = ?, vbook_downloaded = ? WHERE id = ?`)
        .bind(b.id, JSON.stringify(b.meta), b.downloaded, id).run();
      const row: VbookRow = { id, title: b.title, author: b.author, code_name: r.body.code_name as string, chapter_count: last, vbook_id: b.id, ingest_done: 0, vbook_downloaded: b.downloaded };
      rows.push(row);
      item.match = { id, code_name: row.code_name, title: b.title, by: "vbook" };
      job.ingest.push({ id, code_name: row.code_name, title: b.title, total: last });
      if (b.progress) await upsertProgress(env, id, Math.min(b.progress.idx, last - 1), b.progress.ratio, clampTs(b.progress.at));
      item.outcome = `created (${b.downloaded}/${last} sections with text)` + await vbookBookmarks(env, row, b, true);
      return;
    }

    // progress only
    const row = rows.find((r) => r.id === item.match!.id)!;
    // Keep the snapshot of vBook's own record current: the positions backup
    // (EPR-21) is built from it and compared against its last_read.
    if (row.vbook_id === b.id) {
      await env.DB.prepare(`UPDATE books SET vbook_json = ? WHERE id = ?`).bind(JSON.stringify(b.meta), row.id).run();
    }
    if (row.vbook_id === b.id && !row.ingest_done) {
      // Created by an earlier import whose indexing never finished: finish it now.
      job.ingest.push({ id: row.id, code_name: row.code_name, title: row.title, total: row.chapter_count });
    }
    const marks = await vbookBookmarks(env, row, b, false);
    const idx = await vbookChapterIdx(env, row, b);
    if (idx === null) { item.outcome = (b.progress ? "progress not applied: vBook's chapter was not found in this copy" : "no reading position in vBook") + marks; return; }
    await upsertProgress(env, row.id, idx, b.progress!.ratio, clampTs(b.progress!.at));
    item.outcome = `progress: section ${idx + 1}` + marks;
  }, { withContent: job.mode === "import", only });

  job.device = manifest?.device_name ?? null;
  job.created_at = manifest?.create_at ?? null;
  job.current = null;

  // Reading time: vBook's sessions aren't tied to a book, so they count under
  // one pseudo-book "vbook". Each session is added once, ever.
  const { results: seen } = await env.DB.prepare(`SELECT id FROM vbook_sessions`).all<{ id: string }>();
  const seenIds = new Set(seen.map((r) => r.id));
  const fresh = sessions.filter((x) => !seenIds.has(x.id));
  job.history = { sessions: sessions.length, fresh: fresh.length, fresh_seconds: fresh.reduce((a, x) => a + x.seconds, 0), added: 0 };
  if (job.mode === "import" && opts.history && fresh.length) {
    const buckets = new Map<string, number>();
    for (const x of fresh) {
      for (const b of sessionBuckets(x.at, x.seconds, opts.tzOffset)) {
        const k = `${b.day}|${b.hour}`;
        buckets.set(k, Math.min(3600, (buckets.get(k) ?? 0) + b.seconds));
      }
    }
    const stmts = [
      ...[...buckets].map(([k, sec]) => {
        const [day, hour] = k.split("|");
        return env.DB.prepare(
          `INSERT INTO reading_hourly (day, hour, book_id, seconds) VALUES (?, ?, 'vbook', ?)
           ON CONFLICT(day, hour, book_id) DO UPDATE SET seconds = seconds + excluded.seconds`,
        ).bind(day, Number(hour), sec);
      }),
      ...fresh.map((x) => env.DB.prepare(`INSERT OR IGNORE INTO vbook_sessions (id, imported_at) VALUES (?, ?)`).bind(x.id, Date.now())),
    ];
    for (let i = 0; i < stmts.length; i += 100) await env.DB.batch(stmts.slice(i, i + 100));
    job.history.added = fresh.length;
  }
  if (job.mode === "import") {
    await discardUploadParts(env, job.uploadId);
    await env.DB.prepare(`DELETE FROM uploads WHERE id = ?`).bind(job.uploadId).run();
  }
}

app.post("/api/uploads/:id/vbook", async (c) => {
  if (!c.env.VBOOK_UNZSTD) return c.json({ error: "vBook backups can only be imported on the self-hosted server" }, 501);
  const id = c.req.param("id");
  const body = (await c.req.json().catch(() => ({}))) as { mode?: string; actions?: Record<string, string>; history?: boolean; tz_offset?: number };
  const mode = body.mode === "import" ? "import" : "preview";
  const tzOffset = isInt(body.tz_offset, -840, 840) ? (body.tz_offset as number) : 0;
  const up = await c.env.DB.prepare(`SELECT size, part_size, book_id, name FROM uploads WHERE id = ?`).bind(id).first<UploadRow>();
  if (!up) return c.json({ error: "not found" }, 404);
  if (!VBOOK_NAME_RE.test(up.name ?? "")) return c.json({ error: "not a vBook backup (.tar.zst)" }, 400);
  const parts = Math.ceil(up.size / up.part_size);
  const { objects } = await c.env.BOOKS.list({ prefix: uploadPrefix(id) });
  const have = new Set(objects.map((o) => o.key));
  const missing: number[] = [];
  for (let i = 0; i < parts; i++) if (!have.has(uploadPartKey(id, i))) missing.push(i);
  if (missing.length) return c.json({ error: `missing parts: ${missing.slice(0, 10).join(", ")}`, missing }, 409);

  for (const [k, j] of vbookJobs) if (Date.now() - j.at > 3_600_000) vbookJobs.delete(k);
  for (const j of vbookJobs.values()) {
    if (j.uploadId === id && j.state === "running") {
      if (j.mode !== mode) return c.json({ error: "this backup is still being read — wait for it to finish" }, 409);
      return c.json({ job: j.id }); // a retried request: same job
    }
  }
  const job: VbookJob = {
    id: crypto.randomUUID(), uploadId: id, mode, at: Date.now(), state: "running", scanned: 0, current: null,
    error: null, device: null, created_at: null, items: [], ingest: [], history: null,
  };
  vbookJobs.set(job.id, job);
  runVbookJob(c.env, job, parts, body.actions ?? {}, { history: body.history !== false, tzOffset }).then(
    () => { job.state = "done"; },
    (err) => { job.state = "error"; job.error = errMsg(err); console.error("vbook import", err); },
  );
  return c.json({ job: job.id });
});

app.get("/api/vbook-jobs/:id", (c) => {
  const job = vbookJobs.get(c.req.param("id"));
  if (!job) return c.json({ error: "not found" }, 404);
  const { uploadId: _u, at: _a, ...view } = job;
  return c.json(view);
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
      void davWarm(c.env);
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
    await c.env.BOOKS.delete([book.r2_key, contentBinKey(id), legacyContentKey(id), spineMetaKey(id), davEpubKey(id)]);
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
    await c.env.BOOKS.delete([legacyContentKey(id), davEpubKey(id)]);

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
  await upsertProgress(c.env, id, chapterIdx, ratio, clientTs);
  return c.json({ ok: true });
});

async function upsertProgress(env: Env, id: string, chapterIdx: number, ratio: number, clientTs: number): Promise<void> {
  // Two rules in one row. The *current* position (used to resume) belongs to
  // whichever device wrote last by its own clock. The *furthest* position (used
  // for "% read") only ever moves forward, whatever order requests arrive in.
  const ahead = `(excluded.furthest_idx > progress.furthest_idx
    OR (excluded.furthest_idx = progress.furthest_idx AND excluded.furthest_ratio > progress.furthest_ratio))`;
  await env.DB.prepare(
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
}

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
  const input = await exportInput(c.env, id, book, from, to);
  if (!input) return c.json({ error: "no chapters in that range" }, 404);

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

async function exportInput(
  env: Env, id: string, book: { title: string; author: string | null; language: string | null }, from: number, to: number,
) {
  const { results: rows } = await env.DB.prepare(
    `SELECT idx, title, file_name, byte_offset, byte_length, blocks FROM chapters WHERE book_id = ? AND idx BETWEEN ? AND ? ORDER BY idx`,
  ).bind(id, from, to).all<{ idx: number; title: string | null; file_name: string; byte_offset: number | null; byte_length: number | null; blocks: string | null }>();
  if (!rows.length) return null;
  const chapters = [];
  for (const r of rows) chapters.push({ title: r.title || r.file_name, blocks: await readBlocks(env, id, r) });
  return { title: book.title, author: book.author, language: book.language, chapters };
}

// --- Reading positions back to vBook (EPR-21) ----------------------------------
// A minimal vBook backup holding only the book records of books that came from
// vBook, with this app's reading position. Restored in vBook's "merge" mode.
// Only books read further here than vBook knows (its last_read in the record
// from the newest imported backup). vBook's merge restore replaces the whole
// book record, so including a book read further on the phone since would drag
// vBook's position backwards.
async function vbookPositionsAhead(env: Env) {
  const { results } = await env.DB.prepare(
    `SELECT b.vbook_id, b.vbook_json, p.chapter_idx, p.scroll_ratio, p.client_ts, p.updated_at,
            (SELECT title FROM chapters ch WHERE ch.book_id = b.id AND ch.idx = p.chapter_idx) AS chapter_title
     FROM books b JOIN progress p ON p.book_id = b.id
     WHERE b.vbook_id IS NOT NULL AND b.vbook_json IS NOT NULL`,
  ).all<{ vbook_id: string; vbook_json: string; chapter_idx: number; scroll_ratio: number; client_ts: number | null; updated_at: number; chapter_title: string | null }>();
  return results.map((r) => ({
    vbook_id: r.vbook_id,
    meta: (safeParse(r.vbook_json) as Record<string, unknown>) ?? {},
    chapter_idx: r.chapter_idx,
    ratio: r.scroll_ratio,
    at: r.client_ts || r.updated_at,
    chapter_title: r.chapter_title,
  })).filter((x) => x.at > (Number(x.meta.last_read) || 0));
}

async function progressBackup(env: Env): Promise<{ name: string; bytes: Uint8Array } | null> {
  if (!env.VBOOK_ZSTD) return null;
  const items = await vbookPositionsAhead(env);
  if (!items.length) return null;
  // Named and stamped after the newest reading position, so the WebDAV listing
  // shows the same file name until a position actually changes.
  const { name, tar } = buildProgressBackup(items, Math.max(...items.map((x) => x.at)));
  return { name, bytes: env.VBOOK_ZSTD(tar) };
}

app.get("/api/vbook/status", async (c) => {
  const r = await c.env.DB.prepare(`SELECT COUNT(*) AS n FROM books WHERE vbook_id IS NOT NULL`).first<{ n: number }>();
  const ahead = await vbookPositionsAhead(c.env);
  const dav = c.env.DAV_PASSWORD ? "cluster" : (await storedDavDigest(c.env)) ? "app" : null;
  return c.json({ import: !!c.env.VBOOK_UNZSTD, dav, books: r?.n ?? 0, positions: ahead.length });
});

app.get("/api/vbook/progress-backup", async (c) => {
  if (!c.env.VBOOK_ZSTD) return c.json({ error: "only available on the self-hosted server" }, 501);
  const b = await progressBackup(c.env);
  if (!b) return c.json({ error: "no book from vBook has been read further here than in vBook's last backup" }, 404);
  return new Response(b.bytes as unknown as BodyInit, {
    headers: { "content-type": "application/zstd", "content-disposition": `attachment; filename="${b.name}"` },
  });
});

// --- WebDAV, read-only, for vBook (EPR-20, docs §13.4) --------------------------
// vBook can use a WebDAV server as a book source: it lists the folder
// (PROPFIND) and downloads a file (GET). Here every finished book is an .epub
// built from the stored chapters (the original upload is not kept in a form
// vBook reads) and cached, plus a vbook_*.tar.zst of reading positions vBook
// can restore. Own password (DAV_PASSWORD), separate from the reader passcode,
// throttled like login; books are read-only (the one writable folder is vbook_backup, below). Without DAV_PASSWORD there is
// no endpoint at all.
const davPerClient = new FailureLimiter({ max: 10, windowMs: LOGIN_WINDOW_MS });
const davGlobal = new FailureLimiter({ max: 100, windowMs: LOGIN_WINDOW_MS });
const davEpubKey = (id: string) => `dav/${id}.epub`;
const davBuilding = new Map<string, Promise<number>>();

interface DavBook { id: string; title: string; author: string | null; language: string | null; chapter_count: number; created_at: number }
interface DavFile { name: string; size: number | null; type: string; modified: number; book?: DavBook; backup?: boolean }

async function davEnsureEpub(env: Env, b: DavBook): Promise<number> {
  let p = davBuilding.get(b.id);
  if (!p) {
    p = (async () => {
      const input = await exportInput(env, b.id, b, 0, Math.max(0, b.chapter_count - 1));
      const bytes = buildEpub(input ?? { title: b.title, author: b.author, language: b.language, chapters: [] });
      await env.BOOKS.put(davEpubKey(b.id), bytes, { httpMetadata: { contentType: "application/epub+zip" } });
      // The book was re-indexed or replaced while this was being built: that
      // reset already dropped the cache, so don't leave the stale build behind.
      const still = await env.DB.prepare(`SELECT 1 AS ok FROM books WHERE id = ? AND ingest_done = 1 AND chapter_count = ?`).bind(b.id, b.chapter_count).first();
      if (!still) await env.BOOKS.delete(davEpubKey(b.id));
      return bytes.length;
    })().finally(() => davBuilding.delete(b.id));
    davBuilding.set(b.id, p);
  }
  return p;
}

// A client that sees a file listed with no length (or 0) may skip it, so the
// .epub files are built ahead of time, one after another (one build at a time
// keeps memory flat), whenever it could matter: a book finishes indexing, the
// WebDAV password is set, or a listing finds some missing. Node-only: a
// Workers request can't outlive its response.
let davWarming = false;
async function davWarm(env: Env): Promise<void> {
  if (davWarming || !env.VBOOK_ZSTD) return;
  if (!env.DAV_PASSWORD && !(await storedDavDigest(env))) return;
  davWarming = true;
  try {
    const { results } = await env.DB.prepare(
      `SELECT id, title, author, language, chapter_count, created_at FROM books WHERE ingest_done = 1`,
    ).all<DavBook>();
    const { objects } = await env.BOOKS.list({ prefix: "dav/" });
    const have = new Set(objects.map((o) => o.key));
    for (const b of results) if (!have.has(davEpubKey(b.id))) await davEnsureEpub(env, b).catch((e) => console.error("dav warm", errMsg(e)));
  } catch (e) {
    console.error("dav warm", errMsg(e));
  } finally {
    davWarming = false;
  }
}

async function davListing(env: Env): Promise<DavFile[]> {
  const { results } = await env.DB.prepare(
    `SELECT id, title, author, language, chapter_count, created_at FROM books WHERE ingest_done = 1 ORDER BY title`,
  ).all<DavBook>();
  const { objects } = await env.BOOKS.list({ prefix: "dav/" });
  const sizes = new Map(objects.map((o) => [o.key, o.size]));
  if (results.some((b) => !sizes.has(davEpubKey(b.id)))) void davWarm(env); // sizes appear on the next listing
  const used = new Set<string>();
  const files: DavFile[] = results.map((b) => {
    const base = b.title.replace(/[\\/:*?"<>|\u0000-\u001F]/g, "_").trim().slice(0, 120) || "book";
    let name = `${base}.epub`;
    for (let n = 2; used.has(name.toLowerCase()); n++) name = `${base} (${n}).epub`;
    used.add(name.toLowerCase());
    return { name, size: sizes.get(davEpubKey(b.id)) ?? null, type: "application/epub+zip", modified: b.created_at, book: b };
  });
  if (env.VBOOK_ZSTD) {
    const ahead = await vbookPositionsAhead(env);
    if (ahead.length) {
      const at = Math.max(...ahead.map((x) => x.at));
      files.push({ name: vbookBackupName(at), size: null, type: "application/zstd", modified: at, backup: true });
    }
  }
  return files;
}

const xmlEsc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
function davResponse(href: string, props: { collection?: boolean; name: string; size?: number | null; type?: string; modified: number }): string {
  const p = [
    `<d:displayname>${xmlEsc(props.name)}</d:displayname>`,
    props.collection ? "<d:resourcetype><d:collection/></d:resourcetype>" : "<d:resourcetype/>",
    `<d:getlastmodified>${new Date(props.modified).toUTCString()}</d:getlastmodified>`,
  ];
  if (!props.collection) {
    p.push(`<d:getcontenttype>${props.type}</d:getcontenttype>`);
    if (props.size != null) p.push(`<d:getcontentlength>${props.size}</d:getcontentlength>`);
    p.push(`<d:getetag>"${props.modified.toString(36)}-${props.size ?? 0}"</d:getetag>`);
  }
  return `<d:response><d:href>${xmlEsc(href)}</d:href><d:propstat><d:prop>${p.join("")}</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`;
}

// The last requests the WebDAV endpoint saw (no passwords, no IPs), shown on
// the vBook card: when the phone app reports an error, this says what it
// actually sent and what it got back.
interface DavLogEntry { at: number; method: string; path: string; status: number; depth: string | null; auth: boolean; agent: string; note?: string; ms: number }
const davLog: DavLogEntry[] = [];
app.all("/dav/*", async (c) => davLogged(c));
app.all("/dav", async (c) => davLogged(c));
app.get("/api/vbook/dav-log", (c) => c.json({ log: davLog }));
async function davLogged(c: Context<{ Bindings: Env }>): Promise<Response> {
  let res: Response;
  let note: string | undefined;
  const t0 = Date.now();
  try { res = await davHandler(c); }
  catch (err) {
    note = errMsg(err).slice(0, 160);
    console.error("dav", c.req.method, note);
    res = new Response("temporarily unavailable, try again", { status: 503, headers: { "retry-after": "2", "cache-control": "private, no-store" } });
  }
  let path = new URL(c.req.url).pathname;
  try { path = decodeURIComponent(path); } catch { /* keep it raw */ }
  davLog.unshift({
    at: Date.now(), method: c.req.method.toUpperCase(), path: path.slice(0, 120), status: res.status,
    depth: c.req.header("depth") ?? null, auth: /^basic /i.test(c.req.header("authorization") ?? ""),
    agent: (c.req.header("user-agent") ?? "").slice(0, 80), note, ms: Date.now() - t0,
  });
  if (davLog.length > 40) davLog.length = 40;
  return res;
}
// The WebDAV password: DAV_PASSWORD from the cluster Secret wins; otherwise the
// one set in the app (Sync & Backup), kept only as a keyed hash.
async function storedDavDigest(env: Env): Promise<string | null> {
  try {
    const r = await env.DB.prepare(`SELECT digest FROM dav_auth WHERE id = 1`).first<{ digest: string }>();
    return r?.digest ?? null;
  } catch (err) {
    // Only "the table doesn't exist yet" (migration not applied) means "no
    // password". Any other error (a busy database...) must not look like
    // "WebDAV is off" or "wrong password": let it surface as a retryable 503.
    if (/no such table/i.test(errMsg(err))) return null;
    throw err;
  }
}
async function davPasswordOk(env: Env, password: string): Promise<boolean> {
  if (env.DAV_PASSWORD) return passcodeMatches(password, env.DAV_PASSWORD, env.SESSION_SECRET);
  const digest = await storedDavDigest(env);
  return !!digest && secretMatches(password, digest, env.SESSION_SECRET);
}

app.put("/api/vbook/dav-password", async (c) => {
  if (c.env.DAV_PASSWORD) return c.json({ error: "the WebDAV password is set by the server (DAV_PASSWORD) and can't be changed here" }, 409);
  const body = (await c.req.json().catch(() => null)) as { password?: unknown } | null;
  const pw = typeof body?.password === "string" ? body.password : "";
  if (pw.length < 8 || pw.length > 200) return c.json({ error: "the password must be 8 to 200 characters" }, 400);
  if (await passcodeMatches(pw, c.env.ACCESS_PASSCODE, c.env.SESSION_SECRET)) {
    return c.json({ error: "use a different password than the reader passcode (this one is typed into another app)" }, 400);
  }
  await c.env.DB.prepare(
    `INSERT INTO dav_auth (id, digest, updated_at) VALUES (1, ?, ?)
     ON CONFLICT(id) DO UPDATE SET digest = excluded.digest, updated_at = excluded.updated_at`,
  ).bind(await secretDigest(c.env.SESSION_SECRET, pw), Date.now()).run();
  void davWarm(c.env);
  return c.json({ ok: true });
});
app.delete("/api/vbook/dav-password", async (c) => {
  if (c.env.DAV_PASSWORD) return c.json({ error: "the WebDAV password is set by the server (DAV_PASSWORD)" }, 409);
  await c.env.DB.prepare(`DELETE FROM dav_auth WHERE id = 1`).run();
  return c.json({ ok: true });
});

async function davHandler(c: Context<{ Bindings: Env }>): Promise<Response> {
  if (!c.env.DAV_PASSWORD && !(await storedDavDigest(c.env))) return c.json({ error: "not found" }, 404);
  const noStore = { "cache-control": "private, no-store" };
  const client = clientKey(c);
  const wait = Math.max(davPerClient.retryAfter(client), davGlobal.retryAfter("*"));
  if (wait > 0) return new Response("too many attempts", { status: 429, headers: { "retry-after": String(Math.ceil(wait / 1000)) } });
  const auth = c.req.header("authorization") ?? "";
  let password = "";
  if (/^basic /i.test(auth)) {
    try { password = atob(auth.slice(6).trim()).split(":").slice(1).join(":"); } catch { password = ""; }
  }
  if (!password || !(await davPasswordOk(c.env, password))) {
    if (password) { davPerClient.fail(client); davGlobal.fail("*"); }
    return new Response("authentication required", { status: 401, headers: { "www-authenticate": 'Basic realm="books", charset="UTF-8"', ...noStore } });
  }

  const method = c.req.method.toUpperCase();
  // Extra slashes (a base URL plus vBook's "root folder" can double them) are not a different path.
  const rel = decodeURIComponent(new URL(c.req.url).pathname.replace(/^\/dav\/?/, "")).replace(/^\/+|\/+$/g, "");
  if (method === "OPTIONS") return new Response(null, { headers: { dav: "1", allow: "OPTIONS, PROPFIND, GET, HEAD, PUT, DELETE, MKCOL", ...noStore } });
  if (rel === BACKUP_DIR || rel.startsWith(`${BACKUP_DIR}/`)) return davBackup(c, method, rel.slice(BACKUP_DIR.length + 1));
  if (!["PROPFIND", "GET", "HEAD"].includes(method)) return new Response("read-only", { status: 405, headers: { allow: "OPTIONS, PROPFIND, GET, HEAD" } });

  const files = await davListing(c.env);
  if (rel === "") {
    if (method !== "PROPFIND") return new Response("this is a folder", { status: 405, headers: noStore });
    const depth = c.req.header("depth") ?? "1";
    const parts = [davResponse("/dav/", { collection: true, name: "books", modified: Date.now() })];
    if (depth !== "0") for (const f of files) parts.push(davResponse(`/dav/${encodeURIComponent(f.name)}`, f));
    return new Response(`<?xml version="1.0" encoding="utf-8"?>\n<d:multistatus xmlns:d="DAV:">${parts.join("")}</d:multistatus>`,
      { status: 207, headers: { "content-type": 'application/xml; charset="utf-8"', ...noStore } });
  }
  const f = files.find((x) => x.name === rel);
  if (!f) return new Response("not found", { status: 404, headers: noStore });

  let bytes: Uint8Array;
  if (f.backup) {
    const b = await progressBackup(c.env);
    if (!b) return new Response("not found", { status: 404, headers: noStore });
    bytes = b.bytes;
  } else {
    if (f.size == null) await davEnsureEpub(c.env, f.book!);
    const obj = await c.env.BOOKS.get(davEpubKey(f.book!.id));
    if (!obj) return new Response("not found", { status: 404, headers: noStore });
    bytes = new Uint8Array(await obj.arrayBuffer());
  }
  if (method === "PROPFIND") {
    return new Response(`<?xml version="1.0" encoding="utf-8"?>\n<d:multistatus xmlns:d="DAV:">${davResponse(`/dav/${encodeURIComponent(f.name)}`, { ...f, size: bytes.length })}</d:multistatus>`,
      { status: 207, headers: { "content-type": 'application/xml; charset="utf-8"', ...noStore } });
  }
  const headers = { "content-type": f.type, "content-length": String(bytes.length), "last-modified": new Date(f.modified).toUTCString(), ...noStore };
  return new Response(method === "HEAD" ? null : (bytes as unknown as BodyInit), { headers });
}

// The one writable place: /dav/vbook_backup/. vBook's "Sync & backup → WebDAV"
// checks (HEAD), creates (MKCOL) and lists (PROPFIND) this folder, then PUTs
// its backups into it and restores from it. Books at the root stay read-only.
// Only backup-shaped names, one folder deep, size-capped, newest few kept.
// The folder always "exists", MKCOL is idempotent, so no step fails on state.
// Objects are stored as vbook-backup/<ms>__<name>; the time is the file's date.
const BACKUP_DIR = "vbook_backup";
const BACKUP_MAX_BYTES = 128 * 1024 * 1024;
const BACKUP_KEEP = 8;
const backupNameOk = (n: string) => /^\w[\w .()-]{0,99}\.(tar\.zst|zip)$/i.test(n);
async function davBackupFiles(env: Env): Promise<{ key: string; name: string; size: number | null; modified: number }[]> {
  const { objects } = await env.BOOKS.list({ prefix: "vbook-backup/" });
  const out: { key: string; name: string; size: number | null; modified: number }[] = [];
  for (const o of objects) {
    const m = /^vbook-backup\/(\d+)__(.+)$/.exec(o.key);
    if (m) out.push({ key: o.key, name: m[2], size: o.size, modified: Number(m[1]) });
  }
  const files = out.sort((a, b) => b.modified - a.modified);
  if (env.VBOOK_ZSTD) {
    const ahead = await vbookPositionsAhead(env);
    if (ahead.length) {
      const at = Math.max(...ahead.map((x) => x.at));
      files.push({ key: "", name: vbookBackupName(at), size: null, modified: at });
    }
  }
  return files;
}
// Reads an upload chunk by chunk so that a connection that drops half-way
// (a 48 MB backup over a slow link, a proxy timeout) is reported with how far it got.
async function readUpload(req: Request, declared: number): Promise<Uint8Array> {
  if (!req.body) return new Uint8Array(0);
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let got = 0;
  const t0 = Date.now();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      got += value.length;
      if (got > BACKUP_MAX_BYTES) { await reader.cancel().catch(() => undefined); throw new Error("upload too large"); }
      chunks.push(value);
    }
  } catch (err) {
    throw new Error(`upload interrupted after ${got} of ${declared || "?"} bytes in ${Math.round((Date.now() - t0) / 1000)}s: ${errMsg(err)}`);
  }
  const out = new Uint8Array(got);
  let at = 0;
  for (const ch of chunks) { out.set(ch, at); at += ch.length; }
  return out;
}
async function davBackup(c: Context<{ Bindings: Env }>, method: string, sub: string): Promise<Response> {
  const env = c.env;
  const noStore = { "cache-control": "private, no-store" };
  const xml = (inner: string) => new Response(`<?xml version="1.0" encoding="utf-8"?>\n<d:multistatus xmlns:d="DAV:">${inner}</d:multistatus>`,
    { status: 207, headers: { "content-type": 'application/xml; charset="utf-8"', ...noStore } });
  const folder = davResponse(`/dav/${BACKUP_DIR}/`, { collection: true, name: BACKUP_DIR, modified: Date.now() });
  if (sub === "") {
    if (method === "MKCOL") return new Response(null, { status: 201, headers: noStore });
    if (method === "HEAD") return new Response(null, { headers: noStore });
    if (method === "PROPFIND") {
      const parts = [folder];
      if ((c.req.header("depth") ?? "1") !== "0") {
        for (const f of await davBackupFiles(env)) parts.push(davResponse(`/dav/${BACKUP_DIR}/${encodeURIComponent(f.name)}`, { ...f, type: "application/zstd" }));
      }
      return xml(parts.join(""));
    }
    return new Response("this is a folder", { status: 405, headers: { allow: "OPTIONS, PROPFIND, HEAD, MKCOL", ...noStore } });
  }
  if (!backupNameOk(sub)) return new Response("not found", { status: 404, headers: noStore });
  const files = await davBackupFiles(env);
  const f = files.find((x) => x.name === sub);

  if (method === "PUT") {
    if (c.req.header("if-none-match") === "*" && f) return new Response("exists", { status: 412, headers: noStore });
    const declared = Number(c.req.header("content-length") ?? 0);
    if (declared > BACKUP_MAX_BYTES) return new Response("too large", { status: 413, headers: noStore });
    const body = await readUpload(c.req.raw, declared);
    if (!body.length) return new Response("empty", { status: 400, headers: noStore });
    if (body.length > BACKUP_MAX_BYTES) return new Response("too large", { status: 413, headers: noStore });
    await env.BOOKS.put(`vbook-backup/${Date.now()}__${sub}`, body, { httpMetadata: { contentType: "application/zstd" } });
    const stored = files.filter((x) => x.key);
    const stale = [...(f?.key ? [f.key] : []), ...stored.filter((x) => x.name !== sub).slice(BACKUP_KEEP - 1).map((x) => x.key)];
    if (stale.length) await env.BOOKS.delete(stale);
    return new Response(null, { status: f?.key ? 204 : 201, headers: noStore });
  }
  if (method === "DELETE") {
    if (!f?.key) return new Response("not found", { status: 404, headers: noStore });
    await env.BOOKS.delete(f.key);
    return new Response(null, { status: 204, headers: noStore });
  }
  if (!["PROPFIND", "GET", "HEAD"].includes(method)) {
    return new Response("not supported", { status: 405, headers: { allow: "OPTIONS, PROPFIND, GET, HEAD, PUT, DELETE", ...noStore } });
  }
  if (!f) return new Response("not found", { status: 404, headers: noStore });
  let bytes: Uint8Array;
  if (f.key) {
    const obj = await env.BOOKS.get(f.key);
    if (!obj) return new Response("not found", { status: 404, headers: noStore });
    bytes = new Uint8Array(await obj.arrayBuffer());
  } else {
    const b = await progressBackup(env);
    if (!b) return new Response("not found", { status: 404, headers: noStore });
    bytes = b.bytes;
  }
  if (method === "PROPFIND") return xml(davResponse(`/dav/${BACKUP_DIR}/${encodeURIComponent(f.name)}`, { ...f, size: bytes.length, type: "application/zstd" }));
  return new Response(method === "HEAD" ? null : (bytes as unknown as BodyInit),
    { headers: { "content-type": "application/zstd", "content-length": String(bytes.length), "last-modified": new Date(f.modified).toUTCString(), ...noStore } });
}

// --- Static assets fallback --------------------------------------------------
app.all("*", (c) => c.env.ASSETS.fetch(c.req.raw));

export default app;
