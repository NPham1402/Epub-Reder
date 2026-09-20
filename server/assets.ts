// Stand-in for the Workers `ASSETS` binding: serves ./public and falls back to
// index.html for unknown paths (wrangler.jsonc: not_found_handling =
// "single-page-application").

import { promises as fs } from "node:fs";
import { extname, resolve, sep } from "node:path";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".txt": "text/plain; charset=utf-8",
};

export function staticAssets(publicDir: string) {
  const root = resolve(publicDir);

  async function load(path: string) {
    const st = await fs.stat(path).catch(() => null);
    return st?.isFile() ? { path, st } : null;
  }

  return {
    async fetch(req: Request): Promise<Response> {
      let pathname: string;
      try { pathname = decodeURIComponent(new URL(req.url).pathname); }
      catch { return new Response("bad request", { status: 400 }); }

      const wanted = resolve(root, "." + (pathname.endsWith("/") ? pathname + "index.html" : pathname));
      const inside = wanted === root || wanted.startsWith(root + sep);
      const found = (inside && (await load(wanted))) || (await load(resolve(root, "index.html")));
      if (!found) return new Response("not found", { status: 404 });

      const etag = `W/"${found.st.size}-${Math.floor(found.st.mtimeMs)}"`;
      const headers = {
        "content-type": TYPES[extname(found.path).toLowerCase()] ?? "application/octet-stream",
        "cache-control": "no-cache",
        etag,
      };
      if (req.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers });
      return new Response(req.method === "HEAD" ? null : new Uint8Array(await fs.readFile(found.path)), { headers });
    },
  };
}
