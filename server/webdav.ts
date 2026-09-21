// A small WebDAV client: just what the off-site backup needs (make folders, upload
// and download files, list a folder, delete). Plain fetch, no dependencies beyond
// the XML parser the app already uses.

import { XMLParser } from "fast-xml-parser";
import { createReadStream, createWriteStream } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

export interface DavEntry { name: string; isDir: boolean; size: number }

const META_TIMEOUT_MS = 60_000;
const TRANSFER_TIMEOUT_MS = 30 * 60_000;

export class WebDav {
  private base: string;
  private auth: string;
  private made = new Set<string>();

  constructor(baseUrl: string, user: string, password: string) {
    this.base = baseUrl.replace(/\/+$/, "");
    this.auth = "Basic " + Buffer.from(`${user}:${password}`).toString("base64");
  }

  private url(path: string): string {
    const segs = path.split("/").filter(Boolean).map(encodeURIComponent);
    return segs.length ? `${this.base}/${segs.join("/")}` : this.base;
  }

  private async request(method: string, path: string, init: { headers?: Record<string, string>; body?: BodyInit; timeout?: number } = {}): Promise<Response> {
    let res: Response;
    try {
      res = await fetch(this.url(path), {
        method,
        headers: { authorization: this.auth, ...init.headers },
        body: init.body,
        // @ts-expect-error `duplex` is required by Node's fetch for streamed bodies but missing from the DOM types
        duplex: init.body ? "half" : undefined,
        redirect: "manual",
        signal: AbortSignal.timeout(init.timeout ?? META_TIMEOUT_MS),
      });
    } catch (err) {
      throw new Error(`WebDAV ${method} ${path}: could not reach the server (${err instanceof Error ? err.message : err})`);
    }
    if (res.status === 401 || res.status === 403) throw new Error(`WebDAV login failed (HTTP ${res.status}) — check the user name and password`);
    return res;
  }

  // Creates the folder and every parent (MKCOL, treating "already exists" as fine).
  async ensureDir(path: string): Promise<void> {
    let cur = "";
    for (const seg of path.split("/").filter(Boolean)) {
      cur += "/" + seg;
      if (this.made.has(cur)) continue;
      const res = await this.request("MKCOL", cur);
      // 201 created; 405 already exists (RFC 4918); some servers answer 200/204/301 for an existing folder.
      if (![200, 201, 204, 301, 405].includes(res.status)) throw new Error(`WebDAV MKCOL ${cur}: HTTP ${res.status}`);
      this.made.add(cur);
    }
  }

  async put(path: string, file: string, size: number): Promise<void> {
    const body = Readable.toWeb(createReadStream(file)) as unknown as BodyInit;
    const res = await this.request("PUT", path, { body, headers: { "content-length": String(size) }, timeout: TRANSFER_TIMEOUT_MS });
    if (![200, 201, 204].includes(res.status)) throw new Error(`WebDAV PUT ${path}: HTTP ${res.status}`);
  }

  async download(path: string, file: string): Promise<void> {
    const res = await this.request("GET", path, { timeout: TRANSFER_TIMEOUT_MS });
    if (!res.ok || !res.body) throw new Error(`WebDAV GET ${path}: HTTP ${res.status}`);
    await pipeline(Readable.fromWeb(res.body as never), createWriteStream(file));
  }

  async remove(path: string): Promise<void> {
    const res = await this.request("DELETE", path);
    if (![200, 204, 404].includes(res.status)) throw new Error(`WebDAV DELETE ${path}: HTTP ${res.status}`);
  }

  // The folder's direct children, or null if the folder does not exist.
  async list(path: string): Promise<DavEntry[] | null> {
    const res = await this.request("PROPFIND", path, {
      headers: { depth: "1", "content-type": "application/xml" },
      body: `<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/><d:getcontentlength/></d:prop></d:propfind>`,
    });
    if (res.status === 404) return null;
    if (res.status !== 207) throw new Error(`WebDAV PROPFIND ${path}: HTTP ${res.status}`);
    const parsed = new XMLParser({ removeNSPrefix: true, ignoreAttributes: true }).parse(await res.text());
    const raw = parsed?.multistatus?.response;
    const responses: unknown[] = Array.isArray(raw) ? raw : raw ? [raw] : [];
    const self = this.url(path).replace(/^https?:\/\/[^/]+/, "").replace(/\/+$/, "");
    const out: DavEntry[] = [];
    for (const r of responses as { href?: string; propstat?: unknown }[]) {
      const href = decodeURIComponent(String(r.href ?? "")).replace(/^https?:\/\/[^/]+/, "");
      const trimmed = href.replace(/\/+$/, "");
      if (trimmed === decodeURIComponent(self) || trimmed === "") continue; // the folder itself
      const stats = Array.isArray(r.propstat) ? r.propstat : [r.propstat];
      const okStat = (stats as { status?: string; prop?: { resourcetype?: unknown; getcontentlength?: unknown } }[])
        .find((s) => !s.status || /\s200\s/.test(String(s.status))) ?? {};
      const prop = okStat.prop ?? {};
      const rt = prop.resourcetype;
      const isDir = (typeof rt === "object" && rt !== null && "collection" in rt) || href.endsWith("/");
      out.push({ name: trimmed.split("/").pop() ?? "", isDir, size: Number(prop.getcontentlength ?? 0) || 0 });
    }
    return out;
  }
}
