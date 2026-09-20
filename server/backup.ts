// Backup and restore for the Node/Docker deployment. Ships in the same image
// as the server (dist/backup.mjs) so a Kubernetes CronJob can run it against
// the same volume.
//
//   node backup.mjs                 snapshot DATA_DIR into BACKUP_DIR
//   node backup.mjs restore         copy the latest snapshot from BACKUP_DIR
//                                   into an EMPTY DATA_DIR (refuses otherwise)
//
// Environment: DATA_DIR (default ./data), BACKUP_DIR (default ./backup),
// BACKUP_KEEP (database snapshots to keep, default 7).
//
// What a backup is: a consistent copy of the SQLite database (VACUUM INTO,
// safe while the server is writing) plus a mirror of objects/ (raw .epub,
// content.bin, spine cache). Object files are immutable once written, so the
// mirror only copies what's new. The mirror never deletes: a book removed by
// mistake stays recoverable, at the price of disk that a later prune (out of
// scope here) must reclaim.
//
// This protects against corruption, bad upgrades and accidental deletion. It
// is NOT off-site: if BACKUP_DIR lives on the same disk/node as DATA_DIR, a
// dead disk takes both — copy BACKUP_DIR somewhere else too.

import { DatabaseSync } from "node:sqlite";
import { promises as fs } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

const dataDir = resolve(process.env.DATA_DIR ?? "./data");
const backupDir = resolve(process.env.BACKUP_DIR ?? "./backup");
const keep = Math.max(1, Number(process.env.BACKUP_KEEP) || 7);

async function exists(p: string) {
  return fs.access(p).then(() => true, () => false);
}

// Copies files from src to dst that are missing or differ in size, skipping
// in-flight scratch data. Returns bytes and file counts copied.
async function mirror(src: string, dst: string): Promise<{ files: number; bytes: number }> {
  let files = 0, bytes = 0;
  const walk = async (from: string, to: string) => {
    let entries;
    try { entries = await fs.readdir(from, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name === "_staged" || e.name.includes(".tmp-")) continue;
      const a = join(from, e.name), b = join(to, e.name);
      if (e.isDirectory()) { await walk(a, b); continue; }
      if (!e.isFile()) continue;
      const st = await fs.stat(a);
      const have = await fs.stat(b).catch(() => null);
      if (have && have.size === st.size) continue;
      await fs.mkdir(dirname(b), { recursive: true });
      const tmp = `${b}.tmp-${randomUUID()}`;
      await fs.copyFile(a, tmp);
      await fs.rename(tmp, b);
      files++; bytes += st.size;
    }
  };
  await walk(src, dst);
  return { files, bytes };
}

function stamp() {
  const d = new Date();
  const iso = d.toISOString(); // 2026-09-20T10:11:12.345Z
  return `${iso.slice(0, 10).replaceAll("-", "")}-${iso.slice(11, 19).replaceAll(":", "")}-${iso.slice(20, 23)}`;
}

async function backup() {
  const src = join(dataDir, "app.sqlite");
  if (!(await exists(src))) throw new Error(`no database at ${src}`);
  await fs.mkdir(join(backupDir, "db"), { recursive: true });

  // Objects first, then the snapshot, then objects again: a book that finishes
  // in between is caught by the second pass, so the snapshot never references
  // files the mirror lacks.
  const first = await mirror(join(dataDir, "objects"), join(backupDir, "objects"));

  const finalPath = join(backupDir, "db", `app-${stamp()}.sqlite`);
  const tmpPath = `${finalPath}.tmp`;
  const db = new DatabaseSync(src);
  try {
    db.exec("PRAGMA busy_timeout = 10000");
    db.exec(`VACUUM INTO '${tmpPath.replace(/'/g, "''")}'`);
  } finally {
    db.close();
  }
  const snap = new DatabaseSync(tmpPath);
  try {
    const check = (snap.prepare("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check;
    if (check !== "ok") throw new Error(`snapshot failed integrity_check: ${check}`);
  } finally {
    snap.close();
  }
  await fs.rename(tmpPath, finalPath);

  const second = await mirror(join(dataDir, "objects"), join(backupDir, "objects"));

  const snaps = (await fs.readdir(join(backupDir, "db"))).filter((f) => /^app-.*\.sqlite$/.test(f)).sort();
  for (const old of snaps.slice(0, Math.max(0, snaps.length - keep))) await fs.rm(join(backupDir, "db", old));

  const summary = {
    at: new Date().toISOString(),
    snapshot: finalPath,
    object_files_copied: first.files + second.files,
    object_bytes_copied: first.bytes + second.bytes,
    snapshots_kept: Math.min(snaps.length, keep),
  };
  await fs.writeFile(join(backupDir, "latest.json"), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary));
}

async function restore() {
  if (await exists(join(dataDir, "app.sqlite"))) {
    throw new Error(`${dataDir} already has a database — restore only into an empty data directory`);
  }
  const snaps = (await fs.readdir(join(backupDir, "db")).catch(() => []))
    .filter((f) => /^app-.*\.sqlite$/.test(f)).sort();
  if (!snaps.length) throw new Error(`no snapshots in ${join(backupDir, "db")}`);
  const latest = snaps[snaps.length - 1];

  await fs.mkdir(dataDir, { recursive: true });
  const copied = await mirror(join(backupDir, "objects"), join(dataDir, "objects"));
  await fs.copyFile(join(backupDir, "db", latest), join(dataDir, "app.sqlite"));
  console.log(JSON.stringify({ restored: latest, object_files: copied.files, object_bytes: copied.bytes, into: dataDir }));
}

const mode = process.argv[2] ?? "backup";
(mode === "restore" ? restore() : mode === "backup" ? backup() : Promise.reject(new Error(`unknown mode "${mode}"`)))
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
