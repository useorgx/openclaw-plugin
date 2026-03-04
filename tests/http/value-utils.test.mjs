import test from "node:test";
import assert from "node:assert/strict";

import { parsePositiveInt } from "../../dist/http/helpers/value-utils.js";

test("parsePositiveInt keeps zero for offset-like params when fallback is zero", () => {
  assert.equal(parsePositiveInt("0", 0), 0);
  assert.equal(parsePositiveInt("-2", 0), 0);
  assert.equal(parsePositiveInt("2.9", 0), 2);
});

test("parsePositiveInt enforces minimum one for limit-like params", () => {
  assert.equal(parsePositiveInt("0", 24), 1);
  assert.equal(parsePositiveInt("-4", 24), 1);
  assert.equal(parsePositiveInt("3.2", 24), 3);
});

test("parsePositiveInt treats whitespace-only values as missing and uses fallback", () => {
  assert.equal(parsePositiveInt("   ", 24), 24);
});

test("parsePositiveInt clamps to max when provided", () => {
  assert.equal(parsePositiveInt("999", 24, 100), 100);
  assert.equal(parsePositiveInt("999", 0, 150), 150);
});

test("parsePositiveInt preserves minimum when max is restrictive", () => {
  assert.equal(parsePositiveInt("-5", 24, 2), 1);
  assert.equal(parsePositiveInt("-5", 0, 2), 0);
  assert.equal(parsePositiveInt("-5", 24, 0), 1);
});
