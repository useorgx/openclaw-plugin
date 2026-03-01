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

test("parseSliceResult unwraps final_output object envelopes", () => {
  const expected = sampleSliceResult({ summary: "Final output object" });
  const raw = JSON.stringify({
    type: "result",
    final_output: expected,
  });
  const parsed = parseSliceResult(raw);
  assert.equal(parsed?.summary, "Final output object");
  assert.equal(parsed?.workstream_id, "ws_test");
});

test("parseSliceResult unwraps final_output object text envelopes", () => {
  const expected = sampleSliceResult({ summary: "Final output object text" });
  const raw = JSON.stringify({
    type: "result",
    final_output: {
      type: "output_text",
      text: [{ type: "text", value: JSON.stringify(expected) }],
    },
  });
  const parsed = parseSliceResult(raw);
  assert.equal(parsed?.summary, "Final output object text");
  assert.equal(parsed?.workstream_id, "ws_test");
});

test("parseSliceResult unwraps final_output content array envelopes", () => {
  const expected = sampleSliceResult({ summary: "Final output content array" });
  const raw = JSON.stringify({
    type: "result",
    final_output: {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: JSON.stringify(expected) }],
    },
  });
  const parsed = parseSliceResult(raw);
  assert.equal(parsed?.summary, "Final output content array");
  assert.equal(parsed?.workstream_id, "ws_test");
});

test("parseSliceResult unwraps final_output string envelopes", () => {
  const expected = sampleSliceResult({ summary: "Final output string" });
  const raw = JSON.stringify({
    type: "result",
    final_output: JSON.stringify(expected),
  });
  const parsed = parseSliceResult(raw);
  assert.equal(parsed?.summary, "Final output string");
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

test("parseSliceResult unwraps Claude result object text payloads", () => {
  const expected = sampleSliceResult({ summary: "Claude result object text json" });
  const raw = JSON.stringify({
    type: "result",
    subtype: "success",
    result: {
      type: "output_text",
      text: [{ type: "text", value: JSON.stringify(expected) }],
    },
  });
  const parsed = parseSliceResult(raw);
  assert.equal(parsed?.summary, "Claude result object text json");
  assert.equal(parsed?.status, "completed");
});

test("parseSliceResult unwraps Claude result array text payloads", () => {
  const expected = sampleSliceResult({ summary: "Claude result array text json" });
  const raw = JSON.stringify({
    type: "result",
    subtype: "success",
    result: [{ type: "text", value: JSON.stringify(expected) }],
  });
  const parsed = parseSliceResult(raw);
  assert.equal(parsed?.summary, "Claude result array text json");
  assert.equal(parsed?.workstream_id, "ws_test");
});

test("parseSliceResult unwraps Claude structured_output when JSON is fenced", () => {
  const expected = sampleSliceResult({ summary: "Claude structured fenced json" });
  const raw = JSON.stringify({
    type: "result",
    subtype: "success",
    structured_output: ["```json", JSON.stringify(expected), "```"].join("\n"),
  });
  const parsed = parseSliceResult(raw);
  assert.equal(parsed?.summary, "Claude structured fenced json");
  assert.equal(parsed?.status, "completed");
});

test("parseSliceResult unwraps Claude structured_output object text payloads", () => {
  const expected = sampleSliceResult({ summary: "Claude structured object text json" });
  const raw = JSON.stringify({
    type: "result",
    subtype: "success",
    structured_output: {
      type: "output_text",
      text: [{ type: "text", value: JSON.stringify(expected) }],
    },
  });
  const parsed = parseSliceResult(raw);
  assert.equal(parsed?.summary, "Claude structured object text json");
  assert.equal(parsed?.status, "completed");
});

test("parseSliceResult unwraps Claude result when JSON is fenced", () => {
  const expected = sampleSliceResult({ summary: "Claude result fenced json" });
  const raw = JSON.stringify({
    type: "result",
    subtype: "success",
    result: ["```json", JSON.stringify(expected), "```"].join("\n"),
  });
  const parsed = parseSliceResult(raw);
  assert.equal(parsed?.summary, "Claude result fenced json");
  assert.equal(parsed?.workstream_id, "ws_test");
});

test("parseSliceResult unwraps Claude result when fenced JSON is BOM-prefixed", () => {
  const expected = sampleSliceResult({ summary: "Claude result bom fenced json" });
  const raw = JSON.stringify({
    type: "result",
    subtype: "success",
    result: ["```json", `\uFEFF${JSON.stringify(expected)}`, "```"].join("\n"),
  });
  const parsed = parseSliceResult(raw);
  assert.equal(parsed?.summary, "Claude result bom fenced json");
  assert.equal(parsed?.workstream_id, "ws_test");
});

test("parseSliceResult unwraps output_text envelopes", () => {
  const expected = sampleSliceResult({ summary: "output text envelope" });
  const raw = JSON.stringify({
    type: "response",
    output_text: JSON.stringify(expected),
  });
  const parsed = parseSliceResult(raw);
  assert.equal(parsed?.summary, "output text envelope");
  assert.equal(parsed?.status, "completed");
});

test("parseSliceResult unwraps top-level output_text object envelopes", () => {
  const expected = sampleSliceResult({ summary: "output text object envelope" });
  const raw = JSON.stringify({
    type: "response",
    output_text: {
      type: "output_text",
      text: [{ type: "text", value: JSON.stringify(expected) }],
    },
  });
  const parsed = parseSliceResult(raw);
  assert.equal(parsed?.summary, "output text object envelope");
  assert.equal(parsed?.status, "completed");
});

test("parseSliceResult unwraps output message content text envelopes", () => {
  const expected = sampleSliceResult({ summary: "output message content envelope" });
  const raw = JSON.stringify({
    type: "response",
    output: [
      { type: "reasoning", summary: [] },
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: JSON.stringify(expected) }],
      },
    ],
  });
  const parsed = parseSliceResult(raw);
  assert.equal(parsed?.summary, "output message content envelope");
  assert.equal(parsed?.workstream_id, "ws_test");
});

test("parseSliceResult unwraps output message content object and array text envelopes", () => {
  const expected = sampleSliceResult({ summary: "output message object text envelope" });
  const raw = JSON.stringify({
    type: "response",
    output: [
      {
        type: "message",
        role: "assistant",
        content: [
          {
            type: "text",
            text: { value: "Not JSON yet" },
          },
          {
            type: "output_text",
            text: [{ type: "text", value: JSON.stringify(expected) }],
          },
        ],
      },
    ],
  });
  const parsed = parseSliceResult(raw);
  assert.equal(parsed?.summary, "output message object text envelope");
  assert.equal(parsed?.status, "completed");
});

test("parseSliceResult parses markdown-fenced JSON payloads", () => {
  const expected = sampleSliceResult({ summary: "fenced json" });
  const raw = ["```json", JSON.stringify(expected, null, 2), "```"].join("\n");
  const parsed = parseSliceResult(raw);
  assert.equal(parsed?.summary, "fenced json");
  assert.equal(parsed?.status, "completed");
});

test("parseSliceResult parses markdown-fenced JSON wrapped with prose", () => {
  const expected = sampleSliceResult({ summary: "fenced json in prose" });
  const raw = [
    "Here is the final output:",
    "```json",
    JSON.stringify(expected, null, 2),
    "```",
    "Thanks.",
  ].join("\n");
  const parsed = parseSliceResult(raw);
  assert.equal(parsed?.summary, "fenced json in prose");
  assert.equal(parsed?.status, "completed");
});

test("parseSliceResult prefers the last valid fenced JSON payload", () => {
  const expected = sampleSliceResult({ summary: "last fenced json wins" });
  const raw = [
    "```json",
    "{",
    "```",
    "Intermediary commentary",
    "```json",
    JSON.stringify(expected, null, 2),
    "```",
  ].join("\n");
  const parsed = parseSliceResult(raw);
  assert.equal(parsed?.summary, "last fenced json wins");
  assert.equal(parsed?.status, "completed");
});

test("parseSliceResult parses UTF-8 BOM-prefixed JSON payloads", () => {
  const expected = sampleSliceResult({ summary: "bom json" });
  const raw = `\uFEFF${JSON.stringify(expected)}`;
  const parsed = parseSliceResult(raw);
  assert.equal(parsed?.summary, "bom json");
  assert.equal(parsed?.status, "completed");
});

test("parseSliceResult unwraps BOM-prefixed final_output string envelopes", () => {
  const expected = sampleSliceResult({ summary: "bom final output string" });
  const raw = JSON.stringify({
    type: "result",
    final_output: `\uFEFF${JSON.stringify(expected)}`,
  });
  const parsed = parseSliceResult(raw);
  assert.equal(parsed?.summary, "bom final output string");
  assert.equal(parsed?.status, "completed");
});

test("parseSliceResult unwraps BOM-prefixed Claude result field JSON payloads", () => {
  const expected = sampleSliceResult({ summary: "bom claude result string" });
  const raw = JSON.stringify({
    type: "result",
    subtype: "success",
    result: `\uFEFF${JSON.stringify(expected)}`,
  });
  const parsed = parseSliceResult(raw);
  assert.equal(parsed?.summary, "bom claude result string");
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

test("parseSliceResult normalizes completed payloads without outcomes to error", () => {
  const raw = JSON.stringify(
    sampleSliceResult({
      artifacts: [],
      task_updates: [],
      milestone_updates: [],
    })
  );
  const parsed = parseSliceResult(raw);
  assert.equal(parsed?.status, "error");
});

test("parseSliceResult normalizes completed payloads with only decisions to error", () => {
  const raw = JSON.stringify(
    sampleSliceResult({
      artifacts: [],
      task_updates: [],
      milestone_updates: [],
      decisions_needed: [{ question: "Need follow-up", blocking: false }],
    })
  );
  const parsed = parseSliceResult(raw);
  assert.equal(parsed?.status, "error");
});

test("parseSliceResult normalizes completed payloads with blocking decisions", () => {
  const raw = JSON.stringify(
    sampleSliceResult({
      artifacts: [{ name: "result", artifact_type: "document" }],
      decisions_needed: [{ question: "Need approval", blocking: true }],
    })
  );
  const parsed = parseSliceResult(raw);
  assert.equal(parsed?.status, "needs_decision");
  assert.equal(parsed?.decisions_needed?.[0]?.blocking, true);
});

test("parseSliceResult preserves needs_decision when completed payload has only blocking decisions", () => {
  const raw = JSON.stringify(
    sampleSliceResult({
      artifacts: [],
      task_updates: [],
      milestone_updates: [],
      decisions_needed: [{ question: "Need approval", blocking: true }],
    })
  );
  const parsed = parseSliceResult(raw);
  assert.equal(parsed?.status, "needs_decision");
  assert.equal(parsed?.decisions_needed?.[0]?.blocking, true);
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
  assert.equal(parsed?.decisions_needed?.[0]?.blocking, false);
});

test("parseSliceResult adds blocking decision for blocked payloads without one", () => {
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
  assert.equal(parsed?.decisions_needed?.[1]?.blocking, true);
});

test("parseSliceResult adds blocking decision for blocked payloads with null decisions", () => {
  const raw = JSON.stringify(
    sampleSliceResult({
      status: "blocked",
      artifacts: [{ name: "partial", artifact_type: "document" }],
      decisions_needed: null,
    })
  );
  const parsed = parseSliceResult(raw);
  assert.equal(parsed?.status, "blocked");
  assert.equal(parsed?.decisions_needed?.length, 1);
  assert.equal(parsed?.decisions_needed?.[0]?.blocking, true);
});

test("parseSliceResult rejects invalid structured_output envelopes", () => {
  const raw = JSON.stringify({
    type: "result",
    structured_output: {
      status: "completed",
      workstream_id: "ws_test",
    },
  });
  const parsed = parseSliceResult(raw);
  assert.equal(parsed, null);
});

test("parseSliceResult falls back to result when structured_output object is invalid", () => {
  const expected = sampleSliceResult({ summary: "fallback from invalid structured_output" });
  const raw = JSON.stringify({
    type: "result",
    structured_output: { status: "completed", workstream_id: "ws_test" },
    result: JSON.stringify(expected),
  });
  const parsed = parseSliceResult(raw);
  assert.equal(parsed?.summary, "fallback from invalid structured_output");
  assert.equal(parsed?.status, "completed");
});

test("parseSliceResult adds blocking decision for needs_decision payloads without one in result envelopes", () => {
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
  assert.equal(parsed?.decisions_needed?.[1]?.blocking, true);
});

test("parseSliceResult accepts blocked payloads with blocking decisions", () => {
  const raw = JSON.stringify(
    sampleSliceResult({
      status: "blocked",
      decisions_needed: [{ question: "Need approval", blocking: true }],
    })
  );
  const parsed = parseSliceResult(raw);
  assert.equal(parsed?.status, "blocked");
  assert.equal(parsed?.decisions_needed?.[0]?.blocking, true);
});

test("parseSliceResult accepts needs_decision payloads with blocking decisions", () => {
  const raw = JSON.stringify({
    type: "result",
    result: JSON.stringify(
      sampleSliceResult({
        status: "needs_decision",
        decisions_needed: [{ question: "Need input", blocking: true }],
      })
    ),
  });
  const parsed = parseSliceResult(raw);
  assert.equal(parsed?.status, "needs_decision");
  assert.equal(parsed?.decisions_needed?.[0]?.blocking, true);
});

test("parseSliceResult adds blocking decision for needs_decision payloads without one", () => {
  const raw = JSON.stringify(
    sampleSliceResult({
      status: "needs_decision",
      decisions_needed: [{ question: "Need input", blocking: false }],
    })
  );
  const parsed = parseSliceResult(raw);
  assert.equal(parsed?.status, "needs_decision");
  assert.equal(parsed?.decisions_needed?.[0]?.blocking, false);
  assert.equal(parsed?.decisions_needed?.[1]?.blocking, true);
});

test("parseSliceResult adds blocking decision for error payloads without one", () => {
  const raw = JSON.stringify(
    sampleSliceResult({
      status: "error",
      decisions_needed: [{ question: "Needs triage", blocking: false }],
    })
  );
  const parsed = parseSliceResult(raw);
  assert.equal(parsed?.status, "error");
  assert.equal(parsed?.decisions_needed?.[0]?.blocking, false);
  assert.equal(parsed?.decisions_needed?.[1]?.blocking, true);
});

test("parseSliceResult preserves error payloads with blocking decisions", () => {
  const raw = JSON.stringify(
    sampleSliceResult({
      status: "error",
      decisions_needed: [{ question: "Needs triage", blocking: true }],
    })
  );
  const parsed = parseSliceResult(raw);
  assert.equal(parsed?.status, "error");
  assert.equal(parsed?.decisions_needed?.[0]?.blocking, true);
});

test("parseSliceResult rejects invalid structured_output payloads", () => {
  const raw = JSON.stringify({
    type: "result",
    structured_output: sampleSliceResult({
      summary: "",
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
