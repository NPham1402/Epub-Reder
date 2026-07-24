// Deterministic "plausible source code" names used for the disguise.

function hash(n: number): number {
  let x = (n * 2654435761) >>> 0;
  x ^= x >>> 15;
  x = Math.imul(x, 2246822519) >>> 0;
  x ^= x >>> 13;
  return x >>> 0;
}

function strHash(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

const EXT = ["ts", "tsx", "go", "py", "rs", "java", "sql", "md", "yaml", "kt"];
const PREFIX = [
  "core", "auth", "net", "db", "api", "ui", "sync", "cache", "queue", "event",
  "user", "data", "http", "crypto", "config", "mesh", "edge", "worker",
];
const NOUN = [
  "handler", "service", "client", "store", "router", "schema", "model",
  "worker", "adapter", "gateway", "resolver", "pipeline", "session", "registry",
  "codec", "builder", "context", "provider", "manager", "runtime", "controller",
];

export function fakeFileName(idx: number): string {
  const p = PREFIX[hash(idx * 7 + 3) % PREFIX.length];
  const n = NOUN[hash(idx * 13 + 5) % NOUN.length];
  const ext = EXT[hash(idx * 17 + 9) % EXT.length];
  const num = String(idx + 1).padStart(4, "0");
  return `${num}_${p}_${n}.${ext}`;
}

export function fakeCodeName(title: string): string {
  const seed = strHash(title || "module");
  const p = PREFIX[seed % PREFIX.length];
  const n = NOUN[(seed >>> 8) % NOUN.length];
  return `${p}-${n}`;
}
