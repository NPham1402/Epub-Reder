// Helpers for the part-by-part upload protocol (/api/uploads).

import { randomBytes } from "node:crypto";
import { unzipSync, zipSync } from "fflate";
import { api } from "./helpers.ts";

// Adds incompressible filler to a zip so it is big enough to span several
// upload parts (the synthetic chapters compress to almost nothing).
export function padEpub(epub: Uint8Array, padBytes: number): Uint8Array {
  const files = unzipSync(epub) as Record<string, Uint8Array | [Uint8Array, { level: 0 }]>;
  files["OEBPS/pad.bin"] = [new Uint8Array(randomBytes(padBytes)), { level: 0 }];
  return zipSync(files);
}

export async function startUpload(base: string, cookie: string, size: number, name = "book.epub") {
  const res = await api(base, cookie, "/api/uploads", {
    method: "POST", body: JSON.stringify({ size, name }), headers: { "content-type": "application/json" },
  });
  return { res, body: await res.json().catch(() => ({})) as { id?: string; part_size?: number; parts?: number; error?: string } };
}

export function putPart(base: string, cookie: string, id: string, n: number, bytes: Uint8Array) {
  return api(base, cookie, `/api/uploads/${id}/parts/${n}`, {
    method: "PUT", body: bytes as Uint8Array<ArrayBuffer>, headers: { "content-type": "application/octet-stream" },
  });
}

export async function completeUpload(base: string, cookie: string, id: string) {
  const res = await api(base, cookie, `/api/uploads/${id}/complete`, { method: "POST" });
  return {
    res,
    body: await res.json().catch(() => ({})) as { id?: string; total?: number; title?: string; error?: string; missing?: number[] },
  };
}
