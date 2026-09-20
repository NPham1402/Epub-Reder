// Sliding-window limiter for *failed* attempts (used on the login endpoint).
// State is per process: fine for the single-process Node/Docker server; on
// Cloudflare Workers each isolate counts separately, so there it only slows
// an attacker down rather than capping them.

export interface FailureLimiterOptions {
  max: number; // failures allowed inside the window
  windowMs: number;
  maxKeys?: number; // bound on tracked keys, so spoofed keys can't grow memory
}

export class FailureLimiter {
  private hits = new Map<string, number[]>();
  private opts: FailureLimiterOptions;
  private now: () => number;

  // (Explicit fields rather than parameter properties: the unit tests import
  // this file straight through Node's type-stripping, which rejects those.)
  constructor(opts: FailureLimiterOptions, now: () => number = Date.now) {
    this.opts = opts;
    this.now = now;
  }

  private live(key: string): number[] {
    const cutoff = this.now() - this.opts.windowMs;
    const kept = (this.hits.get(key) ?? []).filter((t) => t > cutoff);
    if (kept.length) this.hits.set(key, kept);
    else this.hits.delete(key);
    return kept;
  }

  // Milliseconds until `key` may try again; 0 means it may try now.
  retryAfter(key: string): number {
    const kept = this.live(key);
    if (kept.length < this.opts.max) return 0;
    return Math.max(0, kept[kept.length - this.opts.max] + this.opts.windowMs - this.now());
  }

  fail(key: string): void {
    const kept = this.live(key);
    kept.push(this.now());
    this.hits.set(key, kept);
    const maxKeys = this.opts.maxKeys ?? 10_000;
    while (this.hits.size > maxKeys) {
      const oldest = this.hits.keys().next().value as string;
      this.hits.delete(oldest);
    }
  }

  reset(key: string): void {
    this.hits.delete(key);
  }
}
