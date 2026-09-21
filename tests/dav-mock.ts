// A small in-memory WebDAV server for tests. It is deliberately strict in the way
// real servers are: a file can only be created inside an existing folder (else
// 409), MKCOL on an existing folder is 405, and PROPFIND answers with the "D:"
// XML prefix so a client must not depend on the namespace prefix.

import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

export interface MockDav {
  url: string;
  files: Map<string, Uint8Array>;
  dirs: Set<string>;
  log: string[]; // "METHOD /path", in order
  stop: () => Promise<void>;
}

export async function startMockDav(opts: { user: string; pass: string; base?: string }): Promise<MockDav> {
  const base = opts.base ?? "/dav";
  const files = new Map<string, Uint8Array>();
  const dirs = new Set<string>(["/"]);
  const log: string[] = [];
  const expected = "Basic " + Buffer.from(`${opts.user}:${opts.pass}`).toString("base64");
  const parent = (p: string) => (p.lastIndexOf("/") <= 0 ? "/" : p.slice(0, p.lastIndexOf("/")));

  const server = createServer(async (req, res) => {
    if (req.headers.authorization !== expected) { res.writeHead(401, { "www-authenticate": 'Basic realm="dav"' }).end(); return; }
    const raw = decodeURIComponent((req.url ?? "/").split("?")[0]);
    if (!raw.startsWith(base)) { res.writeHead(404).end(); return; }
    const path = (raw.slice(base.length).replace(/\/+$/, "") || "/");
    log.push(`${req.method} ${path}`);

    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = new Uint8Array(Buffer.concat(chunks));

    switch (req.method) {
      case "MKCOL":
        if (dirs.has(path) || files.has(path)) { res.writeHead(405).end(); return; }
        if (!dirs.has(parent(path))) { res.writeHead(409).end(); return; }
        dirs.add(path);
        res.writeHead(201).end();
        return;
      case "PUT": {
        if (!dirs.has(parent(path))) { res.writeHead(409).end(); return; }
        const existed = files.has(path);
        files.set(path, body);
        res.writeHead(existed ? 204 : 201).end();
        return;
      }
      case "GET": {
        const f = files.get(path);
        if (!f) { res.writeHead(404).end(); return; }
        res.writeHead(200, { "content-length": String(f.length) }).end(Buffer.from(f));
        return;
      }
      case "DELETE":
        if (files.delete(path)) { res.writeHead(204).end(); return; }
        if (dirs.has(path)) {
          for (const k of [...files.keys()]) if (k.startsWith(path + "/")) files.delete(k);
          for (const d of [...dirs]) if (d === path || d.startsWith(path + "/")) dirs.delete(d);
          res.writeHead(204).end();
          return;
        }
        res.writeHead(404).end();
        return;
      case "PROPFIND": {
        if (!dirs.has(path)) { res.writeHead(404).end(); return; }
        const prefix = path === "/" ? "/" : path + "/";
        const kids = new Map<string, { dir: boolean; size: number }>();
        for (const d of dirs) if (d !== path && d.startsWith(prefix) && !d.slice(prefix.length).includes("/")) kids.set(d, { dir: true, size: 0 });
        for (const [f, data] of files) if (f.startsWith(prefix) && !f.slice(prefix.length).includes("/")) kids.set(f, { dir: false, size: data.length });
        const entry = (p: string, dir: boolean, size: number) =>
          `<D:response><D:href>${base}${encodeURI(p)}${dir && p !== "/" ? "/" : ""}</D:href><D:propstat><D:prop>` +
          `<D:resourcetype>${dir ? "<D:collection/>" : ""}</D:resourcetype>${dir ? "" : `<D:getcontentlength>${size}</D:getcontentlength>`}` +
          `</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`;
        const xml = `<?xml version="1.0" encoding="utf-8"?><D:multistatus xmlns:D="DAV:">` +
          entry(path, true, 0) + [...kids].map(([p, k]) => entry(p, k.dir, k.size)).join("") + `</D:multistatus>`;
        res.writeHead(207, { "content-type": "application/xml" }).end(xml);
        return;
      }
      default:
        res.writeHead(405).end();
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}${base}`,
    files, dirs, log,
    stop: () => new Promise((r) => server.close(() => r())),
  };
}
