// Off-site backup to a WebDAV server: upload only what is new, keep a few
// snapshots, and restore an empty machine from it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  ROOT, cleanup, ingestAll, login, makeEpub, startServer, tempDir, upload, verifyBook, type ChapterSpec,
} from "./helpers.ts";
import { startMockDav } from "./dav-mock.ts";

const SPECS: ChapterSpec[] = Array.from({ length: 12 }, (_, i) => ({ title: `Dav ${i}`, paragraphs: 40, paragraphChars: 500 }));

// Async on purpose: the mock server lives in this process and must keep answering.
function tool(mode: string | null, env: Record<string, string>): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", join(ROOT, "dist/backup.mjs"), ...(mode ? [mode] : [])],
      { env: { ...process.env, ...env } });
    let out = "", err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("close", (code) => resolve({ code, out, err }));
  });
}

test("WebDAV off-site backup: incremental, pruned, and restorable onto an empty machine", async () => {
  const dav = await startMockDav({ user: "reader", pass: "s3cret", base: "/remote.php/dav/files/reader" });
  const dataA = tempDir("epub-dav-live-");
  const localBackup = tempDir("epub-dav-backup-");
  const dataC = tempDir("epub-dav-restored-");
  const backupC = tempDir("epub-dav-restore-work-");
  const srv = await startServer({ dataDir: dataA });
  let restored;
  try {
    const cookie = await login(srv.base);
    const id = (await upload(srv.base, cookie, makeEpub("Dav Book", SPECS))).body.id!;
    await ingestAll(srv.base, cookie, id);

    const env = {
      DATA_DIR: dataA, BACKUP_DIR: localBackup, BACKUP_KEEP: "5",
      BACKUP_WEBDAV_URL: dav.url, BACKUP_WEBDAV_USER: "reader", BACKUP_WEBDAV_PASSWORD: "s3cret",
      BACKUP_WEBDAV_KEEP: "2", BACKUP_WEBDAV_DIR: "backups/epub-reader",
    };

    // ---- first run: everything goes up, folders are created one level at a time ----
    const first = await tool(null, env);
    assert.equal(first.code, 0, first.err);
    const remoteSnaps = () => [...dav.files.keys()].filter((k) => /\/db\/app-.*\.sqlite$/.test(k));
    assert.equal(remoteSnaps().length, 1);
    const localObjects = (dir: string): string[] => readdirSync(dir, { recursive: true, withFileTypes: true })
      .filter((e) => e.isFile() && !e.parentPath.includes("uploads")).map((e) => join(e.parentPath, e.name).slice(dir.length + 1).replaceAll("\\", "/")).sort();
    const remoteObjects = [...dav.files.keys()].filter((k) => k.includes("/objects/")).map((k) => k.split("/objects/")[1]).sort();
    assert.deepEqual(remoteObjects, localObjects(join(localBackup, "objects")), "every object file is on the WebDAV server");
    for (const k of dav.files.keys()) {
      if (!k.includes("/objects/")) continue;
      const rel = k.split("/objects/")[1];
      assert.equal(dav.files.get(k)!.length, readFileSync(join(localBackup, "objects", rel)).length, `${rel} arrived whole`);
    }
    assert.ok(dav.dirs.has("/backups/epub-reader/objects"), "nested folders were created");

    // ---- second run: only the new snapshot is uploaded ----
    dav.log.length = 0;
    const second = await tool(null, env);
    assert.equal(second.code, 0, second.err);
    const puts = dav.log.filter((l) => l.startsWith("PUT "));
    assert.equal(puts.filter((l) => l.includes("/objects/")).length, 0, "unchanged objects are not uploaded again");
    assert.equal(puts.filter((l) => l.includes("/db/")).length, 1, "one new snapshot");
    assert.equal(remoteSnaps().length, 2);

    // ---- third run: the oldest snapshot is pruned (keep = 2) ----
    const oldest = remoteSnaps().sort()[0];
    assert.equal((await tool(null, env)).code, 0);
    assert.equal(remoteSnaps().length, 2);
    assert.ok(!dav.files.has(oldest), "the oldest snapshot was removed");

    // ---- restore onto an empty machine from the WebDAV server alone ----
    const restoreEnv = { ...env, DATA_DIR: dataC, BACKUP_DIR: backupC };
    // a damaged newest snapshot (e.g. an interrupted upload) must be skipped, not restored
    writeFileSync(join(backupC, "placeholder"), "");
    dav.files.set("/backups/epub-reader/db/app-99991231-235959-999.sqlite", new Uint8Array(Buffer.from("this is not a sqlite file")));
    const res = await tool("restore-webdav", restoreEnv);
    assert.equal(res.code, 0, res.err);
    assert.match(res.err, /skipping snapshot app-99991231/, "the damaged snapshot was noticed");
    assert.ok(existsSync(join(dataC, "app.sqlite")));

    restored = await startServer({ dataDir: dataC });
    const c2 = await login(restored.base);
    const books = (await (await fetch(`${restored.base}/api/books`, { headers: { cookie: c2 } })).json()) as { books: { id: string }[] };
    assert.deepEqual(books.books.map((b) => b.id), [id]);
    const { mismatched } = await verifyBook(restored.base, c2, id, SPECS);
    assert.deepEqual(mismatched, [], "every chapter is byte-identical after restoring from WebDAV");
  } finally {
    await srv.stop();
    if (restored) await restored.stop();
    await dav.stop();
    cleanup(dataA, localBackup, dataC, backupC);
  }
});

test("WebDAV backup: a wrong password fails the run but keeps the local backup; a missing URL for restore is an error", async () => {
  const dav = await startMockDav({ user: "reader", pass: "right" });
  const dataA = tempDir("epub-dav-live-");
  const localBackup = tempDir("epub-dav-backup-");
  const srv = await startServer({ dataDir: dataA });
  try {
    const cookie = await login(srv.base);
    await ingestAll(srv.base, cookie, (await upload(srv.base, cookie, makeEpub("Pw Book", SPECS.slice(0, 3)))).body.id!);
    const bad = await tool(null, {
      DATA_DIR: dataA, BACKUP_DIR: localBackup,
      BACKUP_WEBDAV_URL: dav.url, BACKUP_WEBDAV_USER: "reader", BACKUP_WEBDAV_PASSWORD: "wrong",
    });
    assert.notEqual(bad.code, 0, "the run is reported as failed");
    assert.match(bad.err, /off-site copy FAILED.*login failed/s);
    assert.equal(dav.files.size, 0, "nothing was uploaded");
    assert.ok(existsSync(join(localBackup, "latest.json")), "the local backup completed before the off-site step");

    const nourl = await tool("restore-webdav", { DATA_DIR: tempDir("epub-x-"), BACKUP_DIR: tempDir("epub-y-"), BACKUP_WEBDAV_URL: "" });
    assert.notEqual(nourl.code, 0);
    assert.match(nourl.err, /BACKUP_WEBDAV_URL/);
  } finally {
    await srv.stop();
    await dav.stop();
    cleanup(dataA, localBackup);
  }
});
