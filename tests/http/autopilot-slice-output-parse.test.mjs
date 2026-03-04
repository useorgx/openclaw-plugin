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

test("parseSliceResult unwraps common structured envelope variants", () => {
  const cases = [
    {
      name: "Claude structured_output object",
      raw: JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: false,
        structured_output: sampleSliceResult({ summary: "Claude envelope" }),
      }),
      summary: "Claude envelope",
    },
    {
      name: "final_output object",
      raw: JSON.stringify({
        type: "result",
        final_output: sampleSliceResult({ summary: "Final output object" }),
      }),
      summary: "Final output object",
    },
    {
      name: "final_output output_text object",
      raw: JSON.stringify({
        type: "result",
        final_output: {
          type: "output_text",
          text: [
            {
              type: "text",
              value: JSON.stringify(
                sampleSliceResult({ summary: "Final output object text" })
              ),
            },
          ],
        },
      }),
      summary: "Final output object text",
    },
    {
      name: "final_output message content array",
      raw: JSON.stringify({
        type: "result",
        final_output: {
          type: "message",
          role: "assistant",
          content: [
            {
              type: "output_text",
              text: JSON.stringify(
                sampleSliceResult({ summary: "Final output content array" })
              ),
            },
          ],
        },
      }),
      summary: "Final output content array",
    },
    {
      name: "final_output message content prose with inline JSON",
      raw: JSON.stringify({
        type: "result",
        final_output: {
          type: "message",
          role: "assistant",
          content: [
            {
              type: "output_text",
              text: [
                "Worker log line",
                JSON.stringify(
                  sampleSliceResult({ summary: "Final output content prose inline json" })
                ),
              ].join("\n"),
            },
          ],
        },
      }),
      summary: "Final output content prose inline json",
    },
    {
      name: "final_output string",
      raw: JSON.stringify({
        type: "result",
        final_output: JSON.stringify(
          sampleSliceResult({ summary: "Final output string" })
        ),
      }),
      summary: "Final output string",
    },
    {
      name: "result JSON string",
      raw: JSON.stringify({
        type: "result",
        subtype: "success",
        result: JSON.stringify(sampleSliceResult({ summary: "Claude result json" })),
      }),
      summary: "Claude result json",
    },
    {
      name: "result output_text object",
      raw: JSON.stringify({
        type: "result",
        subtype: "success",
        result: {
          type: "output_text",
          text: [
            {
              type: "text",
              value: JSON.stringify(
                sampleSliceResult({ summary: "Claude result object text json" })
              ),
            },
          ],
        },
      }),
      summary: "Claude result object text json",
    },
    {
      name: "result array text",
      raw: JSON.stringify({
        type: "result",
        subtype: "success",
        result: [
          {
            type: "text",
            value: JSON.stringify(
              sampleSliceResult({ summary: "Claude result array text json" })
            ),
          },
        ],
      }),
      summary: "Claude result array text json",
    },
    {
      name: "structured_output fenced JSON",
      raw: JSON.stringify({
        type: "result",
        subtype: "success",
        structured_output: [
          "```json",
          JSON.stringify(sampleSliceResult({ summary: "Claude structured fenced json" })),
          "```",
        ].join("\n"),
      }),
      summary: "Claude structured fenced json",
    },
    {
      name: "structured_output output_text object",
      raw: JSON.stringify({
        type: "result",
        subtype: "success",
        structured_output: {
          type: "output_text",
          text: [
            {
              type: "text",
              value: JSON.stringify(
                sampleSliceResult({ summary: "Claude structured object text json" })
              ),
            },
          ],
        },
      }),
      summary: "Claude structured object text json",
    },
    {
      name: "result fenced JSON",
      raw: JSON.stringify({
        type: "result",
        subtype: "success",
        result: [
          "```json",
          JSON.stringify(sampleSliceResult({ summary: "Claude result fenced json" })),
          "```",
        ].join("\n"),
      }),
      summary: "Claude result fenced json",
    },
    {
      name: "result fenced BOM-prefixed JSON",
      raw: JSON.stringify({
        type: "result",
        subtype: "success",
        result: [
          "```json",
          `\uFEFF${JSON.stringify(sampleSliceResult({ summary: "Claude result bom fenced json" }))}`,
          "```",
        ].join("\n"),
      }),
      summary: "Claude result bom fenced json",
    },
    {
      name: "top-level output_text string",
      raw: JSON.stringify({
        type: "response",
        output_text: JSON.stringify(
          sampleSliceResult({ summary: "output text envelope" })
        ),
      }),
      summary: "output text envelope",
    },
    {
      name: "top-level output_text object",
      raw: JSON.stringify({
        type: "response",
        output_text: {
          type: "output_text",
          text: [
            {
              type: "text",
              value: JSON.stringify(
                sampleSliceResult({ summary: "output text object envelope" })
              ),
            },
          ],
        },
      }),
      summary: "output text object envelope",
    },
    {
      name: "output message content text",
      raw: JSON.stringify({
        type: "response",
        output: [
          { type: "reasoning", summary: [] },
          {
            type: "message",
            role: "assistant",
            content: [
              {
                type: "output_text",
                text: JSON.stringify(
                  sampleSliceResult({ summary: "output message content envelope" })
                ),
              },
            ],
          },
        ],
      }),
      summary: "output message content envelope",
    },
    {
      name: "output message object/array text",
      raw: JSON.stringify({
        type: "response",
        output: [
          {
            type: "message",
            role: "assistant",
            content: [
              { type: "text", text: { value: "Not JSON yet" } },
              {
                type: "output_text",
                text: [
                  {
                    type: "text",
                    value: JSON.stringify(
                      sampleSliceResult({
                        summary: "output message object text envelope",
                      })
                    ),
                  },
                ],
              },
            ],
          },
        ],
      }),
      summary: "output message object text envelope",
    },
  ];

  for (const { name, raw, summary } of cases) {
    const parsed = parseSliceResult(raw);
    assert.equal(parsed?.summary, summary, `expected summary for case: ${name}`);
    assert.equal(parsed?.workstream_id, "ws_test", `expected workstream_id for case: ${name}`);
    assert.equal(parsed?.status, "completed", `expected completed status for case: ${name}`);
  }
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

test("parseSliceResult normalizes mixed-case status values", () => {
  const raw = JSON.stringify(
    sampleSliceResult({
      status: " Completed ",
      summary: "mixed case status",
      artifacts: [{ name: "result", artifact_type: "document" }],
    })
  );
  const parsed = parseSliceResult(raw);
  assert.equal(parsed?.status, "completed");
  assert.equal(parsed?.summary, "mixed case status");
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

test("parseSliceResult normalizes completed payloads without outcome arrays to error", () => {
  const payload = sampleSliceResult({
    artifacts: undefined,
    task_updates: undefined,
    milestone_updates: undefined,
    decisions_needed: undefined,
    next_actions: undefined,
  });
  const raw = JSON.stringify(payload);
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

test("parseSliceResult rejects status values outside allowed set even when cased", () => {
  const raw = JSON.stringify(
    sampleSliceResult({
      status: " IN-PROGRESS ",
      artifacts: [{ name: "result", artifact_type: "document" }],
    })
  );
  const parsed = parseSliceResult(raw);
  assert.equal(parsed, null);
});

// ---------------------------------------------------------------------------
// Session ID extraction tests
// ---------------------------------------------------------------------------

import {
  extractSessionIdFromOutput,
  extractSessionIdFromLog,
} from "../../dist/http/helpers/autopilot-slice-utils.js";

const SAMPLE_UUID = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";

// --- extractSessionIdFromOutput ---

test("extractSessionIdFromOutput parses supported envelope variants", () => {
  const cases = [
    { name: "top-level session_id", raw: JSON.stringify({ session_id: SAMPLE_UUID }) },
    { name: "top-level sessionId", raw: JSON.stringify({ sessionId: SAMPLE_UUID }) },
    { name: "top-level conversation_id", raw: JSON.stringify({ conversation_id: SAMPLE_UUID }) },
    {
      name: "structured_output envelope",
      raw: JSON.stringify({
        structured_output: { session_id: SAMPLE_UUID, status: "completed" },
      }),
    },
    { name: "result envelope", raw: JSON.stringify({ result: { session_id: SAMPLE_UUID } }) },
    {
      name: "final_output object",
      raw: JSON.stringify({ final_output: { session_id: SAMPLE_UUID } }),
    },
    {
      name: "final_output stringified JSON",
      raw: JSON.stringify({
        final_output: JSON.stringify({ session_id: SAMPLE_UUID }),
      }),
    },
    {
      name: "final_output nested output_text",
      raw: JSON.stringify({
        final_output: {
          type: "output_text",
          text: [{ type: "text", value: JSON.stringify({ sessionId: SAMPLE_UUID }) }],
        },
      }),
    },
    {
      name: "responses output content envelope",
      raw: JSON.stringify({
        output: [
          {
            type: "message",
            content: [
              {
                type: "output_text",
                text: JSON.stringify({ conversation_id: SAMPLE_UUID }),
              },
            ],
          },
        ],
      }),
    },
    { name: "inline fallback pattern", raw: `some text session_id: ${SAMPLE_UUID} more text` },
  ];

  for (const { name, raw } of cases) {
    assert.equal(extractSessionIdFromOutput(raw), SAMPLE_UUID, `expected session id for case: ${name}`);
  }
});

test("extractSessionIdFromOutput returns null for missing, empty, and invalid ids", () => {
  assert.equal(
    extractSessionIdFromOutput(JSON.stringify({ status: "completed", summary: "Done" })),
    null
  );
  assert.equal(extractSessionIdFromOutput(""), null);
  assert.equal(extractSessionIdFromOutput(null), null);
  assert.equal(extractSessionIdFromOutput(undefined), null);
  assert.equal(extractSessionIdFromOutput(JSON.stringify({ session_id: "not-a-uuid" })), null);
});

test("extractSessionIdFromOutput normalizes mixed session id strings to raw UUID", () => {
  const raw = JSON.stringify({
    session_id: `Resume with: codex --resume ${SAMPLE_UUID}`,
  });
  assert.equal(extractSessionIdFromOutput(raw), SAMPLE_UUID);
});

// --- extractSessionIdFromLog ---

test("extractSessionIdFromLog extracts all supported session footer patterns", () => {
  const logs = [
    `Some output\nResume this session with: claude --resume ${SAMPLE_UUID}\nDone.`,
    `Some output\ncodex resume ${SAMPLE_UUID}\nDone.`,
    `Starting...\nSession: ${SAMPLE_UUID}\nDone.`,
    `session_id: ${SAMPLE_UUID}`,
    `saving session ${SAMPLE_UUID}`,
  ];

  for (const log of logs) {
    assert.equal(extractSessionIdFromLog(log), SAMPLE_UUID);
  }
});

test("extractSessionIdFromLog returns null for missing and empty logs", () => {
  assert.equal(extractSessionIdFromLog("just some random log output"), null);
  assert.equal(extractSessionIdFromLog(""), null);
  assert.equal(extractSessionIdFromLog(null), null);
  assert.equal(extractSessionIdFromLog(undefined), null);
});
