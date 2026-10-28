import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, open, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { hashLocalArtifactContent } from "../../dist/artifacts/content-hash.js";

test("content identity follows bytes across locations and revisions", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "orgx-content-hash-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const first = path.join(dir, "first.bin");
  const second = path.join(dir, "second.bin");
  const bytes = Buffer.from([0, 255, 128, 10]);
  await writeFile(first, bytes);
  await writeFile(second, bytes);
  const expected = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  assert.equal(await hashLocalArtifactContent(first), expected);
  assert.equal(await hashLocalArtifactContent(second), expected);
  await writeFile(first, "changed");
  assert.notEqual(await hashLocalArtifactContent(first), expected);
});

test("unavailable, non-file and oversized inputs remain without content evidence", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "orgx-content-bound-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  assert.equal(await hashLocalArtifactContent(path.join(dir, "missing")), null);
  assert.equal(await hashLocalArtifactContent(dir), null);
  const largePath = path.join(dir, "large.bin");
  const file = await open(largePath, "w");
  await file.truncate(16 * 1024 * 1024 + 1);
  await file.close();
  assert.equal(await hashLocalArtifactContent(largePath), null);
});
