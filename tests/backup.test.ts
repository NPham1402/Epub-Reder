import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  ROOT, cleanup, ingestAll, login, makeEpub, startServer, tempDir, upload, verifyBook, type ChapterSpec,
} from "./helpers.ts";

const A: ChapterSpec[] = Array.from({ length: 30 }, (_, i) => ({ title: `Alpha ${i}`, paragraphs: 120, paragraphChars: 800 }));
const B: ChapterSpec[] = Array.from({ length: 10 }, (_, i) => ({ title: `Beta ${i}`, paragraphs: 15, paragraphChars: 400 }));

function backupTool(mode: string | null, env: Record<string, string>) {
  const r = spawnSync(
    process.execPath,
    ["--disable-warning=ExperimentalWarning", join(ROOT, "dist/backup.mjs"), ...(mode ? [mode] : [])],
    { env: { ...process.env, ...env }, encoding: "utf-8" },
  );
  return { code: r.status, out: r.stdout, err: r.stderr };
}

test("restore drill: back up a live server, lose everything, restore, every chapter matches", async () => {
  const dataA = tempDir("epub-live-");
  const backupDir = tempDir("epub-backup-");
  const dataC = tempDir("epub-restored-");
  let srv = await startServer({ dataDir: dataA });
  let restored;
  try {
    let cookie = await login(srv.base);
    const idA = (await upload(srv.base, cookie, makeEpub("Alpha", A))).body.id!;
    const idB = (await upload(srv.base, cookie, makeEpub("Beta", B))).body.id!;
    await ingestAll(srv.base, cookie, idA);
    await ingestAll(srv.base, cookie, idB);

    // Back up while the server is running (consistency must not need downtime).
    const env = { DATA_DIR: dataA, BACKUP_DIR: backupDir, BACKUP_KEEP: "2" };
    const first = backupTool(null, env);
    assert.equal(first.code, 0, first.err);
    const summary = JSON.parse(readFileSync(join(backupDir, "latest.json"), "utf-8"));
    assert.ok(summary.object_files_copied >= 6, "raw .epub + content.bin + spine cache for both books");

    // An unchanged second run copies nothing new: object files are immutable.
    const second = backupTool(null, env);
    assert.equal(second.code, 0, second.err);
    assert.equal(JSON.parse(second.out).object_files_copied, 0);

    // Retention keeps only BACKUP_KEEP snapshots.
    assert.equal(backupTool(null, env).code, 0);
    const snaps = readdirSync(join(backupDir, "db")).filter((f) => f.endsWith(".sqlite"));
    assert.equal(snaps.length, 2);
    assert.ok(!readdirSync(join(backupDir, "db")).some((f) => f.endsWith(".tmp")), "no half-written snapshot left behind");

    // The snapshot is a real, healthy database with the data in it.
    const db = new DatabaseSync(join(backupDir, "db", snaps.sort().pop()!), { readOnly: true });
    assert.equal((db.prepare("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check, "ok");
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM books").get() as { n: number }).n, 2);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM chapters").get() as { n: number }).n, 40);
    db.close();

    // Disaster: the live server and all of its data are gone.
    await srv.stop();
    cleanup(dataA);
    assert.equal(existsSync(dataA), false);

    const rest = backupTool("restore", { DATA_DIR: dataC, BACKUP_DIR: backupDir });
    assert.equal(rest.code, 0, rest.err);

    restored = await startServer({ dataDir: dataC });
    cookie = await login(restored.base);
    const listed = await (await fetch(`${restored.base}/api/books`, { headers: { cookie } })).json() as { books: { id: string }[] };
    assert.deepEqual(listed.books.map((b) => b.id).sort(), [idA, idB].sort());
    assert.deepEqual((await verifyBook(restored.base, cookie, idA, A)).mismatched, []);
    assert.deepEqual((await verifyBook(restored.base, cookie, idB, B)).mismatched, []);

    // Restore never overwrites an existing database.
    const again = backupTool("restore", { DATA_DIR: dataC, BACKUP_DIR: backupDir });
    assert.notEqual(again.code, 0);
    assert.match(again.err, /already has a database/);
  } finally {
    await srv.stop();
    await restored?.stop();
    cleanup(dataA, backupDir, dataC);
  }
});

test("backup fails loudly (non-zero) when there is nothing to back up", () => {
  const empty = tempDir();
  const dest = tempDir();
  try {
    const r = backupTool(null, { DATA_DIR: empty, BACKUP_DIR: dest });
    assert.notEqual(r.code, 0);
    assert.match(r.err, /no database/);
  } finally {
    cleanup(empty, dest);
  }
});
