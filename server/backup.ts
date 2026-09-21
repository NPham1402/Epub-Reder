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
// Off-site copy (optional): set BACKUP_WEBDAV_URL, BACKUP_WEBDAV_USER and
// BACKUP_WEBDAV_PASSWORD and every backup also uploads to that WebDAV folder
// (BACKUP_WEBDAV_DIR, default "epub-reader"; BACKUP_WEBDAV_KEEP snapshots, default
// BACKUP_KEEP): db/app-<time>.sqlite plus a mirror of objects/ (only what is new).
//   node backup.mjs restore-webdav  pulls the newest snapshot that passes
//                                   integrity_check plus the objects from there
//                                   into BACKUP_DIR, then restores as above
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
import { WebDav } from "./webdav";

const dataDir = resolve(process.env.DATA_DIR ?? "./data");
const backupDir = resolve(process.env.BACKUP_DIR ?? "./backup");
const keep = Math.max(1, Number(process.env.BACKUP_KEEP) || 7);
const davDir = (process.env.BACKUP_WEBDAV_DIR ?? "epub-reader").replace(/^\/+|\/+$/g, "");
const davKeep = Math.max(1, Number(process.env.BACKUP_WEBDAV_KEEP) || keep);

function davFromEnv(required: boolean): WebDav | null {
  const url = process.env.BACKUP_WEBDAV_URL;
  if (!url) {
    if (required) throw new Error("BACKUP_WEBDAV_URL (with BACKUP_WEBDAV_USER and BACKUP_WEBDAV_PASSWORD) is required");
    return null;
  }
  return new WebDav(url, process.env.BACKUP_WEBDAV_USER ?? "", process.env.BACKUP_WEBDAV_PASSWORD ?? "");
}

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

// Every file under a remote folder: relative path -> size.
async function remoteFiles(dav: WebDav, root: string): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const walk = async (rel: string) => {
    const entries = await dav.list(rel ? `${root}/${rel}` : root);
    if (!entries) return;
    for (const e of entries) {
      const child = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDir) await walk(child); else out.set(child, e.size);
    }
  };
  await walk("");
  return out;
}

// Every file under a local folder: relative (posix) path -> size. Transient
// upload parts and scratch files are not worth keeping.
async function localFiles(root: string): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const walk = async (dir: string, rel: string) => {
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const child = rel ? `${rel}/${e.name}` : e.name;
      if (!rel && e.name === "uploads") continue;
      if (e.name === "_staged" || e.name.includes(".tmp-")) continue;
      if (e.isDirectory()) await walk(join(dir, e.name), child);
      else if (e.isFile()) out.set(child, (await fs.stat(join(dir, e.name))).size);
    }
  };
  await walk(root, "");
  return out;
}

const parentOf = (rel: string) => rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "";

async function offsite(dav: WebDav, snapshotFile: string) {
  await dav.ensureDir(`${davDir}/db`);
  await dav.ensureDir(`${davDir}/objects`);

  // Objects first (a snapshot must never reference files the copy lacks), only what is new.
  const remote = await remoteFiles(dav, `${davDir}/objects`);
  const local = await localFiles(join(backupDir, "objects"));
  let files = 0, bytes = 0;
  for (const [rel, size] of local) {
    if (remote.get(rel) === size) continue;
    await dav.ensureDir(`${davDir}/objects/${parentOf(rel)}`);
    await dav.put(`${davDir}/objects/${rel}`, join(backupDir, "objects", rel), size);
    files++; bytes += size;
  }

  // Then the snapshot, checked by size before anything old is pruned.
  const name = snapshotFile.split(/[\\/]/).pop()!;
  const snapSize = (await fs.stat(snapshotFile)).size;
  await dav.put(`${davDir}/db/${name}`, snapshotFile, snapSize);
  const listed = (await dav.list(`${davDir}/db`)) ?? [];
  if (listed.find((e) => e.name === name)?.size !== snapSize) throw new Error(`the uploaded snapshot ${name} does not have the expected size`);

  const snaps = listed.filter((e) => !e.isDir && /^app-.*\.sqlite$/.test(e.name)).map((e) => e.name).sort();
  for (const old of snaps.slice(0, Math.max(0, snaps.length - davKeep))) await dav.remove(`${davDir}/db/${old}`);
  return { uploaded_files: files, uploaded_bytes: bytes, remote_snapshots: Math.min(snaps.length, davKeep) };
}

async function pullFromWebDav(dav: WebDav) {
  await fs.mkdir(join(backupDir, "db"), { recursive: true });
  const names = ((await dav.list(`${davDir}/db`)) ?? []).filter((e) => !e.isDir && /^app-.*\.sqlite$/.test(e.name)).map((e) => e.name).sort();
  if (!names.length) throw new Error(`no snapshots in the WebDAV folder ${davDir}/db`);

  // Newest snapshot that is intact: a half-uploaded or damaged one is skipped, not restored.
  let chosen: string | null = null;
  for (const name of names.reverse()) {
    const part = join(backupDir, "db", `${name}.part`);
    try {
      await dav.download(`${davDir}/db/${name}`, part);
      const snap = new DatabaseSync(part);
      try {
        const check = (snap.prepare("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check;
        if (check !== "ok") throw new Error(check);
      } finally { snap.close(); }
      await fs.rename(part, join(backupDir, "db", name));
      chosen = name;
      break;
    } catch (err) {
      console.error(`skipping snapshot ${name}: ${err instanceof Error ? err.message : err}`);
      await fs.rm(part, { force: true });
    }
  }
  if (!chosen) throw new Error("none of the snapshots on the WebDAV server is intact");

  const remote = await remoteFiles(dav, `${davDir}/objects`);
  let files = 0, bytes = 0;
  for (const [rel, size] of remote) {
    const dest = join(backupDir, "objects", rel);
    if ((await fs.stat(dest).catch(() => null))?.size === size) continue;
    await fs.mkdir(dirname(dest), { recursive: true });
    const tmp = `${dest}.tmp-${randomUUID()}`;
    await dav.download(`${davDir}/objects/${rel}`, tmp);
    await fs.rename(tmp, dest);
    files++; bytes += size;
  }
  console.log(JSON.stringify({ pulled_snapshot: chosen, object_files: files, object_bytes: bytes }));
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

  // The local copy is complete by now; a failing off-site step must not hide that,
  // but it must fail the run so the CronJob shows red.
  const dav = davFromEnv(false);
  if (dav) {
    try {
      console.log(JSON.stringify({ offsite: await offsite(dav, finalPath) }));
    } catch (err) {
      throw new Error(`off-site copy FAILED (the local backup above is fine): ${err instanceof Error ? err.message : err}`);
    }
  }
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
const run = mode === "restore" ? restore()
  : mode === "backup" ? backup()
  : mode === "restore-webdav" ? pullFromWebDav(davFromEnv(true)!).then(restore)
  : Promise.reject(new Error(`unknown mode "${mode}"`));
run
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
