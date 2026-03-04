import test from "node:test";
import assert from "node:assert/strict";

import { safeErrorMessage } from "../../dist/http/helpers/mission-control.js";

test("safeErrorMessage maps structured internal errors to temporary server issue", () => {
  const message = safeErrorMessage(
    JSON.stringify({
      error: {
        code: "internal_error",
        message: "Internal server error",
        requestId: "req_123",
        docsUrl: "https://docs.example.com/errors",
      },
    })
  );
  assert.equal(message, "temporary server issue");
});

test("safeErrorMessage maps decision-list failures to decision data unavailable", () => {
  const message = safeErrorMessage(
    JSON.stringify({
      error: {
        message: "Failed to list decisions for workspace",
        requestId: "req_123",
      },
    })
  );
  assert.equal(message, "decision data temporarily unavailable");
});

test("safeErrorMessage strips structured metadata noise from plain text payloads", () => {
  const message = safeErrorMessage(
    'error: {"message":"upstream unavailable","requestId":"req_123","timestamp":"2026-03-03T12:00:00.000Z"}'
  );
  assert.equal(message, "upstream unavailable");
});

test("safeErrorMessage extracts nested detail from embedded JSON payloads", () => {
  const message = safeErrorMessage(
    'gateway failed: {"error":{"detail":"rate limit hit","requestId":"req_123"}}'
  );
  assert.equal(message, "rate limit hit");
});

test("safeErrorMessage uses top-level error string when no nested envelope exists", () => {
  const message = safeErrorMessage('{"error":"bad gateway","requestId":"req_123"}');
  assert.equal(message, "bad gateway");
});
