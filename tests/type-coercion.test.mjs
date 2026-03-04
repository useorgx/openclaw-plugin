import test from "node:test";
import assert from "node:assert/strict";

import {
  asArray,
  asNumber,
  asRecord,
  asString,
  asStringArray,
} from "../dist/lib/type-coercion.js";

test("asArray wraps a plain object into a single-item array", () => {
  const input = { id: "agent-1", name: "Agent One" };
  const result = asArray(input);
  assert.equal(result.length, 1);
  assert.equal(result[0], input);
});

test("asArray keeps array inputs unchanged", () => {
  const input = ["a", "b"];
  const result = asArray(input);
  assert.equal(result, input);
});

test("asStringArray deduplicates and trims JSON-string array payloads", () => {
  const result = asStringArray('[" alpha ", "beta", "alpha", "", "  "]');
  assert.deepEqual(result, ["alpha", "beta"]);
});

test("asArray wraps a JSON object string into a single-item array", () => {
  const result = asArray('{"id":"agent-2"}');
  assert.equal(result.length, 1);
  assert.deepEqual(result[0], { id: "agent-2" });
});

test("asArray returns [] for non-array JSON primitives", () => {
  assert.deepEqual(asArray("42"), []);
  assert.deepEqual(asArray('"hello"'), []);
});

test("asStringArray supports plain string values", () => {
  assert.deepEqual(asStringArray(" agent-1 "), ["agent-1"]);
});

test("asStringArray supports comma-separated string values", () => {
  assert.deepEqual(asStringArray(" alpha, beta ,alpha, , "), ["alpha", "beta"]);
});

test("asArray ignores non-plain objects", () => {
  assert.deepEqual(asArray(new Date("2026-01-01T00:00:00.000Z")), []);
  assert.deepEqual(asArray(new Map([["id", "agent-3"]])), []);
});

test("asRecord only accepts plain objects", () => {
  assert.equal(asRecord({ id: "agent-4" })?.id, "agent-4");
  assert.equal(asRecord(Object.create(null))?.id, undefined);
  assert.equal(asRecord(new Date("2026-01-01T00:00:00.000Z")), null);
  assert.equal(asRecord(new Map()), null);
});

test("asString trims and rejects blank/non-string values", () => {
  assert.equal(asString("  agent-5  "), "agent-5");
  assert.equal(asString("   "), null);
  assert.equal(asString(123), null);
});

test("asNumber accepts finite values and rejects non-finite/empty values", () => {
  assert.equal(asNumber(42), 42);
  assert.equal(asNumber(" 3.14 "), 3.14);
  assert.equal(asNumber(""), null);
  assert.equal(asNumber("NaN"), null);
  assert.equal(asNumber("Infinity"), null);
});
