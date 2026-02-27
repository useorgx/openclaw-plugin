import test from "node:test";
import assert from "node:assert/strict";

import {
  normalizeBaseUrl,
  resolveRuntimeUserId,
  resolveDocsUrl,
} from "../dist/config/resolution.js";

test("resolveRuntimeUserId keeps only UUID candidates for oxk_ keys", () => {
  const resolved = resolveRuntimeUserId("oxk_user_scoped", [
    "not-a-uuid",
    "  550e8400-e29b-41d4-a716-446655440000  ",
  ]);

  assert.equal(resolved, "550e8400-e29b-41d4-a716-446655440000");
});

test("resolveRuntimeUserId returns first non-empty value for non-oxk keys", () => {
  const resolved = resolveRuntimeUserId("org_service_key", ["  team-user  ", "fallback-user"]);

  assert.equal(resolved, "team-user");
});

test("normalizeBaseUrl rejects credential-bearing URLs", () => {
  assert.equal(normalizeBaseUrl("https://user:pass@example.com/api"), "https://www.useorgx.com");
});

test("normalizeBaseUrl rejects non-loopback http URLs", () => {
  assert.equal(normalizeBaseUrl("http://example.com/api"), "https://www.useorgx.com");
});

test("normalizeBaseUrl allows loopback http URLs and strips query/hash", () => {
  assert.equal(normalizeBaseUrl("http://localhost:8787/api/?q=1#frag"), "http://localhost:8787/api");
});

test("resolveDocsUrl points to local docs path for loopback hosts", () => {
  assert.equal(
    resolveDocsUrl("http://127.0.0.1:54321"),
    "http://127.0.0.1:54321/docs/mintlify/guides/openclaw-plugin-setup"
  );
});
