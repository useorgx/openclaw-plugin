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
