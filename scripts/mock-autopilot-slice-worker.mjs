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
 * - ORGX_AUTOPILOT_MOCK_SCENARIO=blocked_no_decision
 * - ORGX_AUTOPILOT_MOCK_SCENARIO=needs_decision_optional
 * - ORGX_AUTOPILOT_MOCK_SCENARIO=needs_decision_multi_optional
 * - ORGX_AUTOPILOT_MOCK_SCENARIO=completed_optional_decision
 * - ORGX_AUTOPILOT_MOCK_SCENARIO=completed_unspecified_decision
 * - ORGX_AUTOPILOT_MOCK_SCENARIO=completed_invalid_artifact_type
 * - ORGX_AUTOPILOT_MOCK_SCENARIO=error
 * - ORGX_AUTOPILOT_MOCK_SCENARIO=invalid_json
 * - ORGX_AUTOPILOT_MOCK_SCENARIO=stall (sleeps; prints nothing)
 * - ORGX_AUTOPILOT_MOCK_SCENARIO=slow_logs_success (writes stderr heartbeats, then succeeds)
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
const requiredSkills = String(process.env.ORGX_REQUIRED_SKILLS || "")
  .split(",")
  .map((entry) => String(entry || "").replace(/^\$/, "").trim())
  .filter(Boolean);

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

function mockSkillEvidence() {
  return requiredSkills.map((skill) => ({
    skill,
    skill_file: null,
    skill_sha256: null,
    skill_heading: null,
  }));
}

function emitResult(payload) {
  const normalized = {
    artifacts: null,
    decisions_needed: null,
    skill_evidence: mockSkillEvidence(),
    task_updates: null,
    milestone_updates: null,
    next_actions: null,
    ...payload,
  };
  emitOutput(JSON.stringify(normalized, null, 2));
}

async function main() {
  if (scenario === "stall") {
    await delay(Number.isFinite(sleepMs) ? Math.max(1, sleepMs) : 5_000);
    return;
  }

  if (scenario === "slow_logs_success") {
    const totalMs = Number.isFinite(sleepMs) ? Math.max(60, sleepMs) : 250;
    const startedAt = Date.now();
    while (Date.now() - startedAt < totalMs) {
      process.stderr.write("mock heartbeat\n");
      await delay(20);
    }
    emitResult({
      status: "completed",
      summary: "Mock slice completed after extended runtime with active log heartbeats.",
      workstream_id: workstreamId,
      workstream_title: workstreamTitle,
      slice_id: runId,
      artifacts: [
        {
          name: "Mock heartbeat deliverable",
          artifact_type: "document",
          description: "Simulated artifact for slow log heartbeat success path.",
          url: "file://mock/heartbeat-success.txt",
          verification_steps: ["Check that the worker emitted heartbeat logs", "Verify completion JSON is present"],
          task_ids: taskId ? [taskId] : null,
        },
      ],
      task_updates: taskId
        ? [
            {
              task_id: taskId,
              status: "done",
              reason: "Mock worker completed the task after heartbeat activity.",
            },
          ]
        : null,
    });
    return;
  }

  await delay(Number.isFinite(sleepMs) ? Math.max(1, sleepMs) : 120);

  if (scenario === "invalid_json") {
    emitOutput("this is not json");
    return;
  }

  if (scenario === "error") {
    emitResult({
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
    });
    return;
  }

  if (scenario === "needs_decision") {
    emitResult({
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
    });
    return;
  }

  if (scenario === "blocked_no_decision") {
    emitResult({
      status: "blocked",
      summary: "Mock slice is blocked but omitted decision payload (coordinator must synthesize fallback decision).",
      workstream_id: workstreamId,
      workstream_title: workstreamTitle,
      slice_id: runId,
    });
    return;
  }

  if (scenario === "needs_decision_optional") {
    emitResult({
      status: "needs_decision",
      summary: "Mock slice completed but reported only optional follow-up decisions.",
      workstream_id: workstreamId,
      workstream_title: workstreamTitle,
      slice_id: runId,
      decisions_needed: [
        {
          question: "Optional: review mock optimization recommendation?",
          summary: "No approval is required to continue execution.",
          options: ["Review now", "Review later", "Ignore"],
          urgency: "medium",
          blocking: false,
        },
      ],
      artifacts: [
        {
          name: "Mock optional follow-up deliverable",
          artifact_type: "document",
          confidence_score: 0.82,
          description: "A simulated artifact emitted by the worker.",
          url: "file://mock/artifact-optional.txt",
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
    });
    return;
  }

  if (scenario === "needs_decision_multi_optional") {
    emitResult({
      status: "needs_decision",
      summary: "Mock slice returned multiple optional questions to validate sequential auto-answer handling.",
      workstream_id: workstreamId,
      workstream_title: workstreamTitle,
      slice_id: runId,
      decisions_needed: [
        {
          question: "Optional: validate launch copy variant A?",
          summary: "Follow-up review only.",
          options: ["Review now", "Review later", "Skip"],
          urgency: "medium",
          blocking: false,
        },
        {
          question: "Optional: validate launch copy variant B?",
          summary: "Follow-up review only.",
          options: ["Review now", "Review later", "Skip"],
          urgency: "medium",
          blocking: false,
        },
      ],
      artifacts: [
        {
          name: "Mock multi-question deliverable",
          artifact_type: "document",
          confidence_score: 0.81,
          description: "A simulated artifact emitted by the worker for multi-question validation.",
          url: "file://mock/artifact-multi-question.txt",
          verification_steps: [
            "Open the artifact file",
            "Verify contents match expected output",
          ],
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
    });
    return;
  }

  if (scenario === "completed_multi_optional_decision") {
    emitResult({
      status: "completed",
      summary:
        "Mock slice completed with multiple optional questions to validate sequential auto-answer handling.",
      workstream_id: workstreamId,
      workstream_title: workstreamTitle,
      slice_id: runId,
      decisions_needed: [
        {
          question: "Optional: validate launch copy variant A?",
          summary: "Follow-up review only.",
          options: ["Review now", "Review later", "Skip"],
          urgency: "medium",
          blocking: false,
        },
        {
          question: "Optional: validate launch copy variant B?",
          summary: "Follow-up review only.",
          options: ["Review now", "Review later", "Skip"],
          urgency: "medium",
          blocking: false,
        },
      ],
      artifacts: [
        {
          name: "Mock completed multi-question deliverable",
          artifact_type: "document",
          confidence_score: 0.81,
          description:
            "A simulated artifact emitted by the worker for completed multi-question validation.",
          url: "file://mock/artifact-completed-multi-question.txt",
          verification_steps: [
            "Open the artifact file",
            "Verify contents match expected output",
          ],
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
    });
    return;
  }

  if (scenario === "completed_optional_decision") {
    emitResult({
      status: "completed",
      summary: "Mock slice completed with an optional optimization follow-up.",
      workstream_id: workstreamId,
      workstream_title: workstreamTitle,
      slice_id: runId,
      decisions_needed: [
        {
          question: "Optional: review hook-variant optimization suggestion?",
          summary: "The slice completed successfully; this review is informational only.",
          options: ["Review now", "Review later", "Ignore"],
          urgency: "medium",
          blocking: false,
        },
      ],
      artifacts: [
        {
          name: "Mock deliverable",
          artifact_type: "document",
          confidence_score: 0.86,
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
    });
    return;
  }

  if (scenario === "completed_unspecified_decision") {
    emitResult({
      status: "completed",
      summary: "Mock slice completed with follow-up decision but no explicit blocking flag.",
      workstream_id: workstreamId,
      workstream_title: workstreamTitle,
      slice_id: runId,
      decisions_needed: [
        {
          question: "Review optional optimization recommendation?",
          summary: "Used to verify coordinator defaults completed-status decisions to non-blocking.",
          options: ["Review now", "Review later", "Ignore"],
          urgency: "medium",
        },
      ],
      artifacts: [
        {
          name: "Mock deliverable",
          artifact_type: "document",
          confidence_score: 0.79,
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
    });
    return;
  }

  if (scenario === "completed_invalid_artifact_type") {
    emitResult({
      status: "completed",
      summary: "Mock slice completed with an invalid artifact_type payload.",
      workstream_id: workstreamId,
      workstream_title: workstreamTitle,
      slice_id: runId,
      artifacts: [
        {
          name: "Mock malformed artifact",
          artifact_type: 42,
          confidence_score: 0.77,
          description: "Used to verify artifact_type coercion fallback.",
          url: "file://mock/malformed-artifact.txt",
          verification_steps: ["Run lifecycle test", "Confirm artifact_type defaults to other"],
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
    });
    return;
  }

  if (scenario === "no_updates") {
    emitResult({
      status: "completed",
      summary: "Mock slice finished but did not report artifacts or status updates.",
      workstream_id: workstreamId,
      workstream_title: workstreamTitle,
      slice_id: runId,
    });
    return;
  }

  // success
  emitResult({
    status: "completed",
    summary: "Mock slice completed successfully with verifiable output.",
    workstream_id: workstreamId,
    workstream_title: workstreamTitle,
    slice_id: runId,
    artifacts: [
      {
        name: "Mock deliverable",
        artifact_type: "document",
        confidence_score: 0.9,
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
  });
}

main().catch((err) => {
  emitResult({
    status: "error",
    summary: `Mock worker crashed: ${err?.message || String(err)}`,
    workstream_id: workstreamId,
    workstream_title: workstreamTitle,
    slice_id: runId,
  });
  process.exitCode = 1;
});
