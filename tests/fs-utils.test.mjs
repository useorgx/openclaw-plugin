import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function importFreshFsUtils() {
  const url = new URL("../dist/fs-utils.js", import.meta.url);
  url.searchParams.set("t", `${Date.now()}-${Math.random()}`);
  return import(url.href);
}

test("writeFileAtomicSync writes content to target path", async () => {
  const { writeFileAtomicSync } = await importFreshFsUtils();
  const dir = mkdtempSync(join(tmpdir(), "orgx-fs-utils-write-"));
  const target = join(dir, "payload.json");

  writeFileAtomicSync(target, '{"ok":true}\n');

  assert.equal(readFileSync(target, "utf8"), '{"ok":true}\n');
});

test("writeFileAtomicSync rejects null-byte-like path patterns", async () => {
  const { writeFileAtomicSync } = await importFreshFsUtils();
  const dir = mkdtempSync(join(tmpdir(), "orgx-fs-utils-null-"));
  const target = join(dir, "bad%00path.json");

  assert.throws(
    () => writeFileAtomicSync(target, "{}"),
    /safe, non-empty file path/
  );
});

test("backupCorruptFileSync moves corrupt file to timestamped backup", async () => {
  const { backupCorruptFileSync } = await importFreshFsUtils();
  const dir = mkdtempSync(join(tmpdir(), "orgx-fs-utils-backup-"));
  const target = join(dir, "snapshot.json");
  const original = '{"state":"broken"}\n';
  writeFileSync(target, original, "utf8");

  const backupPath = backupCorruptFileSync(target);

  assert.ok(backupPath, "expected backup path");
  assert.equal(existsSync(target), false, "original path should be renamed away");
  assert.equal(readFileSync(backupPath, "utf8"), original);
});

test("backupCorruptFileSync rejects unsafe path values", async () => {
  const { backupCorruptFileSync } = await importFreshFsUtils();

  assert.equal(backupCorruptFileSync(""), null);
  assert.equal(backupCorruptFileSync("bad%00name.json"), null);
  assert.equal(backupCorruptFileSync("bad\u0000name.json"), null);
});

test("writeJsonFileAtomicSync writes pretty JSON output atomically", async () => {
  const { writeJsonFileAtomicSync } = await importFreshFsUtils();
  const dir = mkdtempSync(join(tmpdir(), "orgx-fs-utils-json-"));
  const target = join(dir, "state.json");

  writeJsonFileAtomicSync(target, { ok: true, count: 2 });

  assert.equal(readFileSync(target, "utf8"), '{\n  "ok": true,\n  "count": 2\n}');
});
