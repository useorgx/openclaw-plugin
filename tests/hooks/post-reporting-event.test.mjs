import assert from "node:assert/strict";
import test from "node:test";

import {
  buildActivityPayload,
  buildCompletionChangesetPayload,
  main,
  parseArgs,
} from "../../templates/hooks/scripts/post-reporting-event.mjs";

test("parseArgs parses --key=value pairs", () => {
  const args = parseArgs([
    "--event=session_stop",
    "--phase=completed",
    "--message=done",
    "--apply_completion=true",
  ]);

  assert.equal(args.event, "session_stop");
  assert.equal(args.phase, "completed");
  assert.equal(args.message, "done");
  assert.equal(args.apply_completion, "true");
});

test("buildActivityPayload sets expected telemetry envelope", () => {
  const payload = buildActivityPayload({
    initiativeId: "aa6d16dc-d450-417f-8a17-fd89bd597195",
    runId: "4d601b64-2b7f-495c-a13a-fef3b1de1180",
    correlationId: undefined,
    sourceClient: "codex",
    event: "agent-turn-complete",
    phase: "completed",
    message: "Finalized reporting",
    args: { event: "agent-turn-complete" },
  });

  assert.equal(payload.initiative_id, "aa6d16dc-d450-417f-8a17-fd89bd597195");
  assert.equal(payload.run_id, "4d601b64-2b7f-495c-a13a-fef3b1de1180");
  assert.equal(payload.source_client, "codex");
  assert.equal(payload.phase, "completed");
  assert.equal(payload.level, "info");
  assert.equal(payload.metadata.hook_event, "agent-turn-complete");
});

test("buildCompletionChangesetPayload emits a done task.update op", () => {
  const payload = buildCompletionChangesetPayload({
    initiativeId: "aa6d16dc-d450-417f-8a17-fd89bd597195",
    runId: "4d601b64-2b7f-495c-a13a-fef3b1de1180",
    correlationId: "corr-123",
    sourceClient: "claude-code",
    event: "stop",
    taskId: "15f34642-4fc5-47a0-b604-f0056c1958c6",
  });

  assert.equal(payload.idempotency_key, "hook:stop:15f34642-4fc5-47a0-b604-f0056c1958c6");
  assert.equal(payload.operations.length, 1);
  assert.deepEqual(payload.operations[0], {
    op: "task.update",
    task_id: "15f34642-4fc5-47a0-b604-f0056c1958c6",
    status: "done",
  });
});

test("main returns early when API key is missing", async () => {
  const result = await main({
    argv: [],
    env: {},
    fetchImpl: async () => {
      throw new Error("fetch should not be called");
    },
  });

  assert.equal(result.skipped, "missing_api_key");
});

test("main posts activity and optional completion changeset", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({
      url,
      method: init?.method,
      body: JSON.parse(init?.body ?? "{}"),
    });
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => ({ ok: true }),
      text: async () => "",
    };
  };

  const result = await main({
    argv: [
      "--event=stop",
      "--phase=completed",
      "--apply_completion=true",
      "--task_id=15f34642-4fc5-47a0-b604-f0056c1958c6",
    ],
    env: {
      ORGX_API_KEY: "oxk_test",
      ORGX_BASE_URL: "https://example.useorgx.com",
      ORGX_INITIATIVE_ID: "aa6d16dc-d450-417f-8a17-fd89bd597195",
      ORGX_RUN_ID: "4d601b64-2b7f-495c-a13a-fef3b1de1180",
      ORGX_SOURCE_CLIENT: "openclaw",
    },
    fetchImpl,
    now: () => 1700000000000,
  });

  assert.equal(result.ok, true);
  assert.equal(result.activity_posted, true);
  assert.equal(result.changeset_posted, true);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, "https://example.useorgx.com/api/client/live/activity");
  assert.equal(calls[1].url, "https://example.useorgx.com/api/client/live/changesets/apply");
  assert.equal(calls[1].body.idempotency_key, "hook:stop:15f34642-4fc5-47a0-b604-f0056c1958c6");
});
