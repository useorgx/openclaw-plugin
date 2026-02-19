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
    artifacts: [],
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
