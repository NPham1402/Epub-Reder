// Shared test helpers: a synthetic EPUB builder (so no real book is needed in
// the repo) and a harness that runs the real built server as a child process.
// Run `npm run build:server` first — `npm test` does.

import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { strToU8, unzipSync, zipSync } from "fflate";

export const ROOT = resolve(import.meta.dirname, "..");
export const PASSCODE = "correct horse battery staple";
export const SECRET = "test-secret-test-secret-test-secret";

// ---- synthetic EPUB ---------------------------------------------------------

export interface ChapterSpec { title: string; paragraphs: number; paragraphChars: number }

// Deterministic text: the same (chapter, paragraph) always yields the same
// string, so a test can rebuild what any chapter should contain.
export function paragraphText(chapter: number, para: number, chars: number): string {
  const word = `c${chapter}p${para}`;
  return Array.from({ length: Math.ceil(chars / (word.length + 1)) }, () => word).join(" ").slice(0, chars).trim();
}

export function expectedBlocks(chapter: number, spec: ChapterSpec) {
  return [
    { type: "h1", text: `Heading ${chapter}` },
    ...Array.from({ length: spec.paragraphs }, (_, p) => ({
      type: "p",
      text: paragraphText(chapter, p, spec.paragraphChars),
    })),
  ];
}

export function makeEpub(title: string, chapters: ChapterSpec[]): Uint8Array {
  const items = chapters.map((_, i) => `<item id="ch${i}" href="text/ch${i}.xhtml" media-type="application/xhtml+xml"/>`);
  const refs = chapters.map((_, i) => `<itemref idref="ch${i}"/>`);
  const nav = chapters.map((c, i) =>
    `<navPoint id="n${i}" playOrder="${i + 1}"><navLabel><text>${c.title}</text></navLabel><content src="text/ch${i}.xhtml"/></navPoint>`);
  const files: Record<string, Uint8Array | [Uint8Array, { level: 0 }]> = {
    mimetype: [strToU8("application/epub+zip"), { level: 0 }],
    "META-INF/container.xml": strToU8(
      `<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">` +
      `<rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`),
    "OEBPS/content.opf": strToU8(
      `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="2.0">` +
      `<metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>${title}</dc:title>` +
      `<dc:creator>Test Author</dc:creator><dc:language>en</dc:language></metadata>` +
      `<manifest><item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>` +
      `<item id="img" href="cover.png" media-type="image/png"/>${items.join("")}</manifest>` +
      // The image sits in the spine on purpose: it must be skipped, not counted as a chapter.
      `<spine toc="ncx"><itemref idref="img"/>${refs.join("")}</spine></package>`),
    "OEBPS/toc.ncx": strToU8(
      `<?xml version="1.0"?><ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">` +
      `<navMap>${nav.join("")}</navMap></ncx>`),
    "OEBPS/cover.png": new Uint8Array([137, 80, 78, 71]),
  };
  chapters.forEach((c, i) => {
    const paras = Array.from({ length: c.paragraphs }, (_, p) => `<p>${paragraphText(i, p, c.paragraphChars)}</p>`).join("");
    files[`OEBPS/text/ch${i}.xhtml`] = strToU8(
      `<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>t</title></head>` +
      `<body><h1>Heading ${i}</h1>${paras}</body></html>`);
  });
  return zipSync(files);
}

// ---- server harness ---------------------------------------------------------

async function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address() as { port: number };
      s.close(() => res(port));
    });
    s.on("error", rej);
  });
}

export interface TestServer {
  base: string;
  dataDir: string;
  logs: () => string;
  stop: () => Promise<void>;
}

export function tempDir(prefix = "epub-test-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function cleanup(...dirs: string[]) {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
}

export async function startServer(opts: { dataDir?: string; env?: Record<string, string> } = {}): Promise<TestServer> {
  const dataDir = opts.dataDir ?? tempDir();
  const port = await freePort();
  const child: ChildProcess = spawn(
    process.execPath,
    ["--disable-warning=ExperimentalWarning", join(ROOT, "dist/server.mjs")],
    {
      cwd: ROOT,
      env: {
        ...process.env,
        ACCESS_PASSCODE: PASSCODE,
        SESSION_SECRET: SECRET,
        PORT: String(port),
        DATA_DIR: dataDir,
        CHUNK_SIZE: "7",
        MAINTENANCE_FIRST_RUN_MS: "3600000", // no surprise cleanup unless a test asks
        ...opts.env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let log = "";
  child.stdout!.on("data", (d) => (log += d));
  child.stderr!.on("data", (d) => (log += d));

  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 15_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`server exited early:\n${log}`);
    try {
      if ((await fetch(`${base}/healthz`)).ok) break;
    } catch {}
    if (Date.now() > deadline) { child.kill(); throw new Error(`server did not start:\n${log}`); }
    await new Promise((r) => setTimeout(r, 100));
  }
  return {
    base,
    dataDir,
    logs: () => log,
    // Safe to call more than once. A process ended by a signal has
    // exitCode === null, so signalCode must be checked too — otherwise a
    // second call waits forever for an "exit" event that already happened.
    stop: () => new Promise((res) => {
      if (child.exitCode !== null || child.signalCode !== null) return res();
      child.once("exit", () => res());
      child.kill();
    }),
  };
}

// ---- API helpers ------------------------------------------------------------

export async function login(base: string, passcode = PASSCODE, headers: Record<string, string> = {}): Promise<string> {
  const res = await fetch(`${base}/api/auth`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ passcode }),
  });
  if (!res.ok) throw new Error(`login failed: HTTP ${res.status}`);
  return res.headers.get("set-cookie")!.split(";")[0];
}

export function api(base: string, cookie: string, path: string, init: RequestInit = {}) {
  return fetch(`${base}${path}`, { ...init, headers: { cookie, ...(init.headers as object) } });
}

export async function upload(base: string, cookie: string, epub: Uint8Array, name = "book.epub") {
  const fd = new FormData();
  fd.append("file", new File([epub as Uint8Array<ArrayBuffer>], name, { type: "application/epub+zip" }));
  const res = await api(base, cookie, "/api/books", { method: "POST", body: fd });
  return { res, body: await res.json().catch(() => ({})) as { id?: string; total?: number; error?: string } };
}

export async function ingestChunk(base: string, cookie: string, id: string) {
  const res = await api(base, cookie, `/api/books/${id}/ingest-chunk`, { method: "POST" });
  return { status: res.status, body: await res.json() as { done?: boolean; processed?: number; total?: number; error?: string } };
}

export async function ingestAll(base: string, cookie: string, id: string, maxCalls = 200) {
  for (let i = 0; i < maxCalls; i++) {
    const r = await ingestChunk(base, cookie, id);
    if (r.status !== 200) throw new Error(`ingest-chunk failed: ${r.status} ${JSON.stringify(r.body)}`);
    if (r.body.done) return i + 1;
  }
  throw new Error("ingest did not finish");
}

export async function verifyBook(base: string, cookie: string, id: string, specs: ChapterSpec[]) {
  const idx = await (await api(base, cookie, `/api/books/${id}/index`)).json() as {
    chapters: { idx: number; title: string }[]; chapter_count: number; ingest_done: number;
  };
  if (idx.chapters.length !== specs.length) throw new Error(`expected ${specs.length} chapters, index has ${idx.chapters.length}`);
  const bad: number[] = [];
  for (let i = 0; i < specs.length; i++) {
    const ch = await (await api(base, cookie, `/api/books/${id}/chapters/${i}`)).json() as { title: string; blocks: unknown[] };
    if (ch.title !== specs[i].title || JSON.stringify(ch.blocks) !== JSON.stringify(expectedBlocks(i, specs[i]))) bad.push(i);
  }
  return { mismatched: bad, index: idx };
}

// A valid-looking EPUB whose chapter `bombIndex` claims to be `bombMB` MB
// uncompressed (compresses to a few KB): the classic "zip bomb" shape.
export function makeBombEpub(chapters: ChapterSpec[], bombIndex: number, bombMB: number): Uint8Array {
  const files = unzipSync(makeEpub("Bomb", chapters));
  files[`OEBPS/text/ch${bombIndex}.xhtml`] = strToU8(
    `<html><body><p>${" ".repeat(bombMB * 1024 * 1024)}</p></body></html>`);
  return zipSync(files);
}
