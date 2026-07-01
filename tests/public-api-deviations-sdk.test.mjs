import assert from "node:assert/strict";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

test("public package entrypoints expose the deviations SDK", async () => {
  const api = await import("../dist/api.js");
  const root = await import("../dist/index.js");

  assert.equal(typeof api.computeDedupeKey, "function");
  assert.equal(typeof api.postDeviation, "function");
  assert.equal(typeof api.postDeviationBatch, "function");
  assert.equal(typeof root.computeDedupeKey, "function");
  assert.equal(typeof root.postDeviation, "function");
  assert.equal(typeof root.postDeviationBatch, "function");
});

test("dist output does not include compiled test artifacts", () => {
  const files = walk("dist");
  const compiledTests = files.filter((file) => /\.test\.(js|d\.ts)$/.test(file));

  assert.deepEqual(compiledTests, []);
});

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...walk(full));
    } else {
      out.push(full);
    }
  }
  return out;
}
