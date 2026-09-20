// Just enough of Cloudflare D1's API (prepare/bind/first/all/run + batch) on
// top of Node's built-in SQLite, so src/index.ts runs unchanged outside
// Cloudflare. node:sqlite is synchronous; the async wrappers only exist to
// match D1's promise-returning surface.

import { DatabaseSync, type StatementSync, type SQLInputValue } from "node:sqlite";
import { readdirSync, readFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

class Statement {
  constructor(
    private db: DatabaseSync,
    private cache: Map<string, StatementSync>,
    readonly sql: string,
    readonly params: SQLInputValue[] = [],
  ) {}

  bind(...params: SQLInputValue[]): Statement {
    return new Statement(this.db, this.cache, this.sql, params);
  }

  private prepared(): StatementSync {
    let stmt = this.cache.get(this.sql);
    if (!stmt) {
      stmt = this.db.prepare(this.sql);
      this.cache.set(this.sql, stmt);
    }
    return stmt;
  }

  runSync() {
    const r = this.prepared().run(...this.params);
    return { success: true, results: [], meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
  }

  async first<T = unknown>(): Promise<T | null> {
    return (this.prepared().get(...this.params) ?? null) as T | null;
  }

  async all<T = unknown>(): Promise<{ results: T[]; success: true; meta: object }> {
    return { results: this.prepared().all(...this.params) as T[], success: true, meta: {} };
  }

  async run() {
    return this.runSync();
  }
}

export class SqliteD1 {
  readonly db: DatabaseSync;
  private cache = new Map<string, StatementSync>();

  constructor(file: string) {
    mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = OFF;");
  }

  prepare(sql: string): Statement {
    return new Statement(this.db, this.cache, sql);
  }

  // D1 batches are atomic: all statements apply or none do.
  async batch(stmts: Statement[]) {
    this.db.exec("BEGIN");
    try {
      const out = stmts.map((s) => s.runSync());
      this.db.exec("COMMIT");
      return out;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  // Applies migrations/*.sql in filename order, once each — the same files
  // `wrangler d1 migrations apply` uses on Cloudflare.
  migrate(dir: string): string[] {
    this.db.exec("CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)");
    const done = new Set(
      (this.db.prepare("SELECT name FROM _migrations").all() as { name: string }[]).map((r) => r.name),
    );
    const applied: string[] = [];
    for (const name of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
      if (done.has(name)) continue;
      const sql = readFileSync(join(dir, name), "utf-8");
      this.db.exec("BEGIN");
      try {
        this.db.exec(sql);
        this.db.prepare("INSERT INTO _migrations (name, applied_at) VALUES (?, ?)").run(name, Date.now());
        this.db.exec("COMMIT");
      } catch (err) {
        this.db.exec("ROLLBACK");
        throw new Error(`migration ${name} failed: ${err instanceof Error ? err.message : err}`);
      }
      applied.push(name);
    }
    return applied;
  }

  close() {
    this.db.close();
  }
}
