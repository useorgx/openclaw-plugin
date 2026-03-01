import test from "node:test";
import assert from "node:assert/strict";
import { parseJsonSafe } from "../dist/json-utils.js";

test("parseJsonSafe parses valid JSON", () => {
  assert.deepEqual(parseJsonSafe('{"ok":true}'), { ok: true });
});

test("parseJsonSafe handles UTF-8 BOM-prefixed JSON", () => {
  assert.deepEqual(parseJsonSafe("\ufeff{\"ok\":true}"), { ok: true });
});

test("parseJsonSafe returns null for invalid JSON", () => {
  assert.equal(parseJsonSafe("{invalid"), null);
});

test("parseJsonSafe returns null for empty input", () => {
  assert.equal(parseJsonSafe(""), null);
});
