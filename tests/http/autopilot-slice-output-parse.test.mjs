import test from "node:test";
import assert from "node:assert/strict";

import { parseSliceResult } from "../../dist/http/helpers/autopilot-slice-utils.js";

function sampleSliceResult(overrides = {}) {
  return {
    status: "completed",
    summary: "Done",
    workstream_id: "ws_test",
    workstream_title: "WS Test",
    slice_id: "slice_test",
    artifacts: [{ name: "slice report", artifact_type: "document" }],
    decisions_needed: [],
    skill_evidence: [],
    task_updates: [],
    milestone_updates: [],
    next_actions: [],
    ...overrides,
  };
}

test("parseSliceResult preserves direct slice JSON", () => {
  const expected = sampleSliceResult();
  const parsed = parseSliceResult(JSON.stringify(expected));
  assert.equal(parsed?.status, "completed");
  assert.equal(parsed?.workstream_id, "ws_test");
});

test("parseSliceResult unwraps Claude structured_output envelopes", () => {
  const expected = sampleSliceResult({ summary: "Claude envelope" });
  const raw = JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    structured_output: expected,
  });
  const parsed = parseSliceResult(raw);
  assert.equal(parsed?.summary, "Claude envelope");
  assert.equal(parsed?.status, "completed");
});

test("parseSliceResult unwraps Claude result field JSON payloads", () => {
  const expected = sampleSliceResult({ summary: "Claude result json" });
  const raw = JSON.stringify({
    type: "result",
    subtype: "success",
    result: JSON.stringify(expected),
  });
  const parsed = parseSliceResult(raw);
  assert.equal(parsed?.summary, "Claude result json");
  assert.equal(parsed?.workstream_id, "ws_test");
});

test("parseSliceResult parses markdown-fenced JSON payloads", () => {
  const expected = sampleSliceResult({ summary: "fenced json" });
  const raw = ["```json", JSON.stringify(expected, null, 2), "```"].join("\n");
  const parsed = parseSliceResult(raw);
  assert.equal(parsed?.summary, "fenced json");
  assert.equal(parsed?.status, "completed");
});

test("parseSliceResult extracts final JSON object from mixed worker logs", () => {
  const expected = sampleSliceResult({ summary: "mixed logs" });
  const raw = [
    "tool: orgx_report_progress start",
    "{\"type\":\"status\",\"message\":\"working\"}",
    JSON.stringify({
      type: "result",
      structured_output: expected,
    }),
  ].join("\n");
  const parsed = parseSliceResult(raw);
  assert.equal(parsed?.summary, "mixed logs");
  assert.equal(parsed?.slice_id, "slice_test");
});

test("parseSliceResult ignores trailing non-slice JSON objects in worker logs", () => {
  const expected = sampleSliceResult({ summary: "prefer structured output" });
  const raw = [
    "{\"type\":\"status\",\"message\":\"working\"}",
    JSON.stringify({
      type: "result",
      structured_output: expected,
    }),
    "{\"type\":\"status\",\"message\":\"cleanup complete\"}",
  ].join("\n");
  const parsed = parseSliceResult(raw);
  assert.equal(parsed?.summary, "prefer structured output");
  assert.equal(parsed?.status, "completed");
});

test("parseSliceResult rejects completed payloads without outcomes", () => {
  const raw = JSON.stringify(
    sampleSliceResult({
      artifacts: [],
      task_updates: [],
      milestone_updates: [],
    })
  );
  const parsed = parseSliceResult(raw);
  assert.equal(parsed, null);
});

test("parseSliceResult rejects completed payloads with blocking decisions", () => {
  const raw = JSON.stringify(
    sampleSliceResult({
      artifacts: [{ name: "result", artifact_type: "document" }],
      decisions_needed: [{ question: "Need approval", blocking: true }],
    })
  );
  const parsed = parseSliceResult(raw);
  assert.equal(parsed, null);
});

test("parseSliceResult accepts decisions without explicit blocking fields", () => {
  const raw = JSON.stringify(
    sampleSliceResult({
      artifacts: [{ name: "result", artifact_type: "document" }],
      decisions_needed: [{ question: "Need approval" }],
    })
  );
  const parsed = parseSliceResult(raw);
  assert.equal(parsed?.status, "completed");
  assert.equal(parsed?.decisions_needed?.[0]?.question, "Need approval");
});

test("parseSliceResult accepts blocked payloads without blocking decisions", () => {
  const raw = JSON.stringify(
    sampleSliceResult({
      status: "blocked",
      artifacts: [{ name: "partial", artifact_type: "document" }],
      decisions_needed: [{ question: "FYI", blocking: false }],
    })
  );
  const parsed = parseSliceResult(raw);
  assert.equal(parsed?.status, "blocked");
  assert.equal(parsed?.decisions_needed?.[0]?.blocking, false);
});

test("parseSliceResult rejects invalid structured_output envelopes", () => {
  const raw = JSON.stringify({
    type: "result",
    structured_output: sampleSliceResult({
      artifacts: [],
      task_updates: [],
      milestone_updates: [],
    }),
  });
  const parsed = parseSliceResult(raw);
  assert.equal(parsed, null);
});

test("parseSliceResult accepts needs_decision payloads that only include optional decisions", () => {
  const raw = JSON.stringify({
    type: "result",
    result: JSON.stringify(
      sampleSliceResult({
        status: "needs_decision",
        decisions_needed: [{ question: "Need input", blocking: false }],
      })
    ),
  });
  const parsed = parseSliceResult(raw);
  assert.equal(parsed?.status, "needs_decision");
  assert.equal(parsed?.decisions_needed?.[0]?.blocking, false);
});

test("parseSliceResult rejects invalid structured_output payloads", () => {
  const raw = JSON.stringify({
    type: "result",
    structured_output: sampleSliceResult({
      artifacts: [],
      task_updates: [],
      milestone_updates: [],
    }),
  });
  const parsed = parseSliceResult(raw);
  assert.equal(parsed, null);
});

test("parseSliceResult rejects unknown status values", () => {
  const raw = JSON.stringify(
    sampleSliceResult({
      status: "in_progress",
      artifacts: [{ name: "result", artifact_type: "document" }],
    })
  );
  const parsed = parseSliceResult(raw);
  assert.equal(parsed, null);
});
