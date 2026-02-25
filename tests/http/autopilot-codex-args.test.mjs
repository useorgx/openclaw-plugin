import test from "node:test";
import assert from "node:assert/strict";

import { normalizeCodexArgs } from "../../dist/http/helpers/autopilot-slice-utils.js";

test("normalizeCodexArgs prepends exec for empty args", () => {
  const parsed = normalizeCodexArgs([]);
  assert.deepEqual(parsed, ["exec", "--skip-git-repo-check"]);
});

test("normalizeCodexArgs prepends exec for flag-first args", () => {
  const parsed = normalizeCodexArgs(["--model", "gpt-5"]);
  assert.deepEqual(parsed, ["exec", "--model", "gpt-5", "--skip-git-repo-check"]);
});

test("normalizeCodexArgs preserves known subcommands", () => {
  const parsed = normalizeCodexArgs(["review", "--json"]);
  assert.deepEqual(parsed, ["review", "--json", "--skip-git-repo-check"]);
});

test("normalizeCodexArgs does not duplicate skip-git-repo-check", () => {
  const parsed = normalizeCodexArgs(["exec", "--skip-git-repo-check", "--json"]);
  assert.deepEqual(parsed, ["exec", "--skip-git-repo-check", "--json"]);
});

test("normalizeCodexArgs inserts skip-git-repo-check before passthrough marker", () => {
  const parsed = normalizeCodexArgs(["exec", "--", "echo", "ok"]);
  assert.deepEqual(parsed, ["exec", "--skip-git-repo-check", "--", "echo", "ok"]);
});

test("normalizeCodexArgs keeps existing skip-git-repo-check ahead of passthrough marker", () => {
  const parsed = normalizeCodexArgs(["exec", "--skip-git-repo-check", "--", "echo", "ok"]);
  assert.deepEqual(parsed, ["exec", "--skip-git-repo-check", "--", "echo", "ok"]);
});
