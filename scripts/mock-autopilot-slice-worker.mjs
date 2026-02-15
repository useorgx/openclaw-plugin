#!/usr/bin/env node
/**
 * Mock worker for Autopilot slice dispatch. Used by tests and local smoke.
 *
 * It writes its final output JSON to stdout (the plugin captures stdout into
 * autopilot output/log files).
 *
 * Scenarios:
 * - ORGX_AUTOPILOT_MOCK_SCENARIO=success (default)
 * - ORGX_AUTOPILOT_MOCK_SCENARIO=no_updates
 * - ORGX_AUTOPILOT_MOCK_SCENARIO=needs_decision
 * - ORGX_AUTOPILOT_MOCK_SCENARIO=error
 * - ORGX_AUTOPILOT_MOCK_SCENARIO=invalid_json
 * - ORGX_AUTOPILOT_MOCK_SCENARIO=stall (sleeps; prints nothing)
 *
 * Controls:
 * - ORGX_AUTOPILOT_MOCK_SLEEP_MS (default: 120)
 */

import { writeFileSync } from "node:fs";

const scenario = String(process.env.ORGX_AUTOPILOT_MOCK_SCENARIO || "success").trim();
const sleepMs = Number(process.env.ORGX_AUTOPILOT_MOCK_SLEEP_MS || "120");

const workstreamId = String(process.env.ORGX_WORKSTREAM_ID || "ws_mock").trim() || "ws_mock";
const workstreamTitle = String(process.env.ORGX_WORKSTREAM_TITLE || "Mock Workstream").trim() || null;
const runId = String(process.env.ORGX_RUN_ID || "").trim() || null;
const taskId = String(process.env.ORGX_TASK_ID || "").trim() || null;
const outputPath = String(process.env.ORGX_OUTPUT_PATH || "").trim() || null;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function emitOutput(text) {
  const payload = text.endsWith("\n") ? text : `${text}\n`;
  if (outputPath) {
    try {
      writeFileSync(outputPath, payload, { encoding: "utf8", mode: 0o600 });
    } catch {
      // best effort
    }
  }
  process.stdout.write(payload);
}

async function main() {
  if (scenario === "stall") {
    await delay(Number.isFinite(sleepMs) ? Math.max(1, sleepMs) : 5_000);
    return;
  }

  await delay(Number.isFinite(sleepMs) ? Math.max(1, sleepMs) : 120);

  if (scenario === "invalid_json") {
    emitOutput("this is not json");
    return;
  }

  if (scenario === "error") {
    emitOutput(
      JSON.stringify(
        {
          status: "error",
          summary: "Mock slice failed (simulated).",
          workstream_id: workstreamId,
          workstream_title: workstreamTitle,
          slice_id: runId,
          decisions_needed: [
            {
              question: "Mock worker error: retry slice?",
              summary: "Simulated worker failure. Retry or inspect logs.",
              options: ["Retry", "Inspect logs", "Stop autopilot"],
              urgency: "high",
              blocking: true,
            },
          ],
        },
        null,
        2
      )
    );
    return;
  }

  if (scenario === "needs_decision") {
    emitOutput(
      JSON.stringify(
        {
          status: "needs_decision",
          summary: "Mock slice needs a human decision before continuing.",
          workstream_id: workstreamId,
          workstream_title: workstreamTitle,
          slice_id: runId,
          decisions_needed: [
            {
              question: "Approve mock slice changes?",
              summary: "This simulates a slice that produced a plan but needs approval.",
              options: ["Approve", "Request changes", "Skip workstream"],
              urgency: "high",
              blocking: true,
            },
          ],
        },
        null,
        2
      )
    );
    return;
  }

  if (scenario === "no_updates") {
    emitOutput(
      JSON.stringify(
        {
          status: "completed",
          summary: "Mock slice finished but did not report artifacts or status updates.",
          workstream_id: workstreamId,
          workstream_title: workstreamTitle,
          slice_id: runId,
        },
        null,
        2
      )
    );
    return;
  }

  // success
  emitOutput(
    JSON.stringify(
      {
        status: "completed",
        summary: "Mock slice completed successfully with verifiable output.",
        workstream_id: workstreamId,
        workstream_title: workstreamTitle,
        slice_id: runId,
        artifacts: [
          {
            name: "Mock deliverable",
            artifact_type: "document",
            description: "A simulated artifact emitted by the worker.",
            url: "file://mock/artifact.txt",
            verification_steps: ["Open the artifact file", "Verify contents match expected output"],
            task_ids: taskId ? [taskId] : null,
          },
        ],
        task_updates: taskId
          ? [
              {
                task_id: taskId,
                status: "done",
                reason: "Mock worker completed the task.",
              },
            ]
          : null,
      },
      null,
      2
    )
  );
}

main().catch((err) => {
  emitOutput(
    JSON.stringify(
      {
        status: "error",
        summary: `Mock worker crashed: ${err?.message || String(err)}`,
        workstream_id: workstreamId,
        workstream_title: workstreamTitle,
        slice_id: runId,
      },
      null,
      2
    )
  );
  process.exitCode = 1;
});
