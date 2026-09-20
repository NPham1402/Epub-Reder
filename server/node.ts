// Node/Docker entry point: runs the same Hono app as the Cloudflare Worker,
// with D1 → SQLite, R2 → a directory, and ASSETS → ./public (see the sibling
// modules). No Worker CPU/memory limits apply here.
//
// Environment:
//   ACCESS_PASSCODE, SESSION_SECRET  required (same meaning as on Cloudflare)
//   PORT            default 8787
//   DATA_DIR        default ./data     (SQLite file + book files live here)
//   PUBLIC_DIR      default ./public
//   MIGRATIONS_DIR  default ./migrations
//   CHUNK_SIZE      chapters per ingest request (default 300 here)
//   COOKIE_SECURE   "true" | "false"; default: detect from the request
//   APP_TITLE

import { serve } from "@hono/node-server";
import { resolve } from "node:path";
import app from "../src/index";
import type { Env } from "../src/types";
import { SqliteD1 } from "./d1-sqlite";
import { FsR2 } from "./r2-fs";
import { staticAssets } from "./assets";

function need(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing required environment variable ${name}`);
    process.exit(1);
  }
  return v;
}

const passcode = need("ACCESS_PASSCODE");
const secret = need("SESSION_SECRET");
if (secret.length < 16) console.warn("SESSION_SECRET is short — use a long random string.");

const port = Number(process.env.PORT ?? 8787);
const dataDir = resolve(process.env.DATA_DIR ?? "./data");
const publicDir = resolve(process.env.PUBLIC_DIR ?? "./public");
const migrationsDir = resolve(process.env.MIGRATIONS_DIR ?? "./migrations");

const db = new SqliteD1(resolve(dataDir, "app.sqlite"));
const applied = db.migrate(migrationsDir);
if (applied.length) console.log(`applied migrations: ${applied.join(", ")}`);

const env = {
  DB: db,
  BOOKS: new FsR2(dataDir),
  ASSETS: staticAssets(publicDir),
  ACCESS_PASSCODE: passcode,
  SESSION_SECRET: secret,
  APP_TITLE: process.env.APP_TITLE ?? "Internal Developer Docs",
  CHUNK_SIZE: process.env.CHUNK_SIZE ?? "300",
  COOKIE_SECURE: process.env.COOKIE_SECURE,
} as unknown as Env;

const server = serve(
  {
    hostname: "0.0.0.0",
    port,
    fetch: async (req) => {
      const t0 = Date.now();
      const res = await app.fetch(req, env);
      const path = new URL(req.url).pathname;
      if (path.startsWith("/api/")) console.log(`${req.method} ${path} ${res.status} ${Date.now() - t0}ms`);
      return res;
    },
  },
  (info) => console.log(`listening on :${info.port}  data=${dataDir}`),
);

// Sit comfortably above the idle timeout of proxies in front (Traefik,
// cloudflared) so they never reuse a connection Node just closed.
(server as import("node:http").Server).keepAliveTimeout = 65_000;
(server as import("node:http").Server).headersTimeout = 66_000;

function shutdown() {
  server.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 10_000).unref();
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
