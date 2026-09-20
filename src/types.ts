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
}

export type BlockType = "h1" | "h2" | "h3" | "p";

export interface TextBlock {
  type: BlockType;
  text: string;
}

