// Just enough of Cloudflare R2's binding API (get with range, put, delete,
// list, multipart) on top of a directory, so src/index.ts runs unchanged
// outside Cloudflare. Objects live under <root>/objects/<key>; in-progress
// multipart uploads under <root>/multipart/<uploadId>/ (outside objects/ so
// list() never shows them, and they survive restarts — the uploadId is
// persisted in the database, exactly like it is with real R2).

import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join, resolve, sep } from "node:path";

type Bytes = ArrayBuffer | ArrayBufferView | string;

function toBuffer(value: Bytes): Buffer {
  if (typeof value === "string") return Buffer.from(value, "utf-8");
  if (ArrayBuffer.isView(value)) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  return Buffer.from(value);
}

const UPLOAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

class FsObject {
  constructor(readonly key: string, private data: Buffer) {}
  get size() { return this.data.length; }
  async arrayBuffer(): Promise<ArrayBuffer> {
    return this.data.buffer.slice(this.data.byteOffset, this.data.byteOffset + this.data.byteLength) as ArrayBuffer;
  }
  async text(): Promise<string> { return this.data.toString("utf-8"); }
}

export class FsR2 {
  private objects: string;
  private multipart: string;

  constructor(root: string) {
    this.objects = resolve(root, "objects");
    this.multipart = resolve(root, "multipart");
  }

  // Maps a key to a path and refuses anything that would escape the root —
  // keys embed ids that come from URLs.
  private pathOf(key: string): string {
    const p = resolve(this.objects, ...key.split("/"));
    if (!p.startsWith(this.objects + sep)) throw new Error("invalid object key");
    return p;
  }

  private async writeAtomic(path: string, data: Buffer) {
    await fs.mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.tmp-${randomUUID()}`;
    await fs.writeFile(tmp, data);
    await fs.rename(tmp, path);
  }

  async put(key: string, value: Bytes, _opts?: unknown) {
    const buf = toBuffer(value);
    await this.writeAtomic(this.pathOf(key), buf);
    return { key, size: buf.length };
  }

  async get(key: string, opts?: { range?: { offset: number; length: number } }) {
    const path = this.pathOf(key);
    try {
      if (opts?.range) {
        const fh = await fs.open(path, "r");
        try {
          const { size } = await fh.stat();
          const offset = Math.min(opts.range.offset, size);
          const length = Math.max(0, Math.min(opts.range.length, size - offset));
          const buf = Buffer.alloc(length);
          await fh.read(buf, 0, length, offset);
          return new FsObject(key, buf);
        } finally {
          await fh.close();
        }
      }
      return new FsObject(key, await fs.readFile(path));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT" || (err as NodeJS.ErrnoException).code === "EISDIR") return null;
      throw err;
    }
  }

  async delete(keys: string | string[]): Promise<void> {
    for (const key of Array.isArray(keys) ? keys : [keys]) {
      const path = this.pathOf(key);
      await fs.rm(path, { force: true });
      // Tidy up now-empty parent directories (never the root itself).
      let dir = dirname(path);
      while (dir.startsWith(this.objects + sep)) {
        try { await fs.rmdir(dir); } catch { break; }
        dir = dirname(dir);
      }
    }
  }

  async list(opts?: { prefix?: string }): Promise<{ objects: { key: string; size: number }[]; truncated: false }> {
    const prefix = opts?.prefix ?? "";
    const out: { key: string; size: number }[] = [];
    const walk = async (dir: string, rel: string) => {
      let entries;
      try { entries = await fs.readdir(dir, { withFileTypes: true }); }
      catch { return; }
      for (const e of entries) {
        const key = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) await walk(join(dir, e.name), key);
        else if (e.isFile() && key.startsWith(prefix) && !e.name.includes(".tmp-")) {
          out.push({ key, size: (await fs.stat(join(dir, e.name))).size });
        }
      }
    };
    await walk(this.objects, "");
    out.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    return { objects: out, truncated: false };
  }

  private multipartDir(uploadId: string): string {
    if (!UPLOAD_ID.test(uploadId)) throw new Error("invalid upload id");
    return join(this.multipart, uploadId);
  }

  private handle(key: string, uploadId: string) {
    const dir = this.multipartDir(uploadId);
    const partPath = (n: number) => join(dir, String(n).padStart(6, "0"));
    return {
      key,
      uploadId,
      uploadPart: async (partNumber: number, value: Bytes) => {
        const buf = toBuffer(value);
        await fs.mkdir(dir, { recursive: true });
        await fs.writeFile(partPath(partNumber), buf);
        return { partNumber, etag: `${partNumber}-${buf.length}` };
      },
      abort: async () => { await fs.rm(dir, { recursive: true, force: true }); },
      complete: async (parts: { partNumber: number; etag: string }[]) => {
        const target = this.pathOf(key);
        await fs.mkdir(dirname(target), { recursive: true });
        const tmp = `${target}.tmp-${randomUUID()}`;
        const out = await fs.open(tmp, "w");
        let size = 0;
        try {
          for (const p of [...parts].sort((a, b) => a.partNumber - b.partNumber)) {
            const buf = await fs.readFile(partPath(p.partNumber));
            await out.write(buf);
            size += buf.length;
          }
        } finally {
          await out.close();
        }
        await fs.rename(tmp, target);
        await fs.rm(dir, { recursive: true, force: true });
        return { key, size };
      },
    };
  }

  async createMultipartUpload(key: string, _opts?: unknown) {
    const uploadId = randomUUID();
    await fs.mkdir(this.multipartDir(uploadId), { recursive: true });
    return this.handle(key, uploadId);
  }

  resumeMultipartUpload(key: string, uploadId: string) {
    return this.handle(key, uploadId);
  }
}
