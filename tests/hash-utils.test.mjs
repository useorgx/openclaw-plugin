import test from "node:test";
import assert from "node:assert/strict";

import { idempotencyKey, stableHash } from "../dist/hash-utils.js";

test("stableHash returns deterministic sha256 hex output", () => {
  assert.equal(
    stableHash("abc"),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
  );
});

test("idempotencyKey sanitizes unsafe characters and keeps <=120 chars", () => {
  const value = idempotencyKey(["scope", "name with spaces/and?symbols", "run-1"]);
  assert.match(value, /^scope:name-with-spaces-and-symbols:run-1:[a-f0-9]{20}$/);
  assert.ok(value.length <= 120);
});

test("idempotencyKey uses stable non-empty prefix when parts are empty", () => {
  const value = idempotencyKey([null, undefined, ""]);
  assert.match(value, /^openclaw:[a-f0-9]{20}$/);
});
