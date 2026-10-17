export interface Env {
  DB: D1Database;
  BOOKS: R2Bucket;
  ASSETS: Fetcher;
  ACCESS_PASSCODE: string;
  SESSION_SECRET: string;
  APP_TITLE: string;
  // Optional overrides — unset on Cloudflare, set by the Node/Docker server.
  CHUNK_SIZE?: string; // chapters per /ingest-chunk call
  COOKIE_SECURE?: string; // "true" | "false"; unset = detect from the request
  // Extra fields merged into the /healthz response (the Node server reports disk space).
  HEALTH_EXTRA?: () => Record<string, unknown> | Promise<Record<string, unknown>>;
  // zstd decompression for vBook backups (.tar.zst). Only the Node server has
  // it; without it the vBook import answers 501.
  VBOOK_UNZSTD?: (src: AsyncIterable<Uint8Array>) => AsyncIterable<Uint8Array>;
  VBOOK_ZSTD?: (bytes: Uint8Array) => Uint8Array;
  // Password for the read-only WebDAV endpoint (/dav/) vBook reads books from.
  // Unset = the endpoint does not exist.
  DAV_PASSWORD?: string;
}

export type BlockType = "h1" | "h2" | "h3" | "p";

export interface TextBlock {
  type: BlockType;
  text: string;
}

