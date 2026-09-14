export interface Env {
  DB: D1Database;
  BOOKS: R2Bucket;
  ASSETS: Fetcher;
  ACCESS_PASSCODE: string;
  SESSION_SECRET: string;
  APP_TITLE: string;
}

export type BlockType = "h1" | "h2" | "h3" | "p";

export interface TextBlock {
  type: BlockType;
  text: string;
}

export interface ParsedChapter {
  order: number;
  id: string;
  href: string;
  title: string | null;
  blocks: TextBlock[];
}

export interface ParsedBookMeta {
  title: string;
  author: string | null;
  language: string | null;
}
