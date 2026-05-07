import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  buildActivityPayload,
  buildCompletionChangesetPayload,
  buildRuntimePayload,
  buildWorkGraphHookRecord,
  main,
  parseArgs,
  sanitizeArgs,
} from "../../templates/hooks/scripts/post-reporting-event.mjs";

async function createOutboxPath(prefix = "orgx-openclaw-hook-") {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  return join(dir, "events.jsonl");
}

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

test("buildRuntimePayload emits runtime relay envelope", () => {
  const payload = buildRuntimePayload({
    initiativeId: "aa6d16dc-d450-417f-8a17-fd89bd597195",
    runId: "4d601b64-2b7f-495c-a13a-fef3b1de1180",
    correlationId: undefined,
    sourceClient: "claude-code",
    event: "session_start",
    phase: "intent",
    message: "Claude session started",
    workstreamId: "ws-1",
    taskId: "task-1",
    agentId: "engineering-agent",
    agentName: "Engineering",
    progressPct: 12,
    args: { event: "session_start" },
  });

  assert.equal(payload.source_client, "claude-code");
  assert.equal(payload.event, "session_start");
  assert.equal(payload.phase, "intent");
  assert.equal(payload.progress_pct, 12);
  assert.equal(payload.metadata.source, "hook_runtime_relay");
});

test("sanitizeArgs redacts token-like hook arguments", () => {
  const sanitized = sanitizeArgs({
    event: "session_stop",
    hook_token: "secret-token",
    runtime_hook_token: "secret-token",
    api_key: "oxk_secret",
  });
  assert.equal(sanitized.event, "session_stop");
  assert.equal(sanitized.hook_token, "[redacted]");
  assert.equal(sanitized.runtime_hook_token, "[redacted]");
  assert.equal(sanitized.api_key, "[redacted]");
});

test("buildWorkGraphHookRecord emits redacted reconciliation metadata", () => {
  const payload = buildWorkGraphHookRecord({
    args: { run_id: "run-1", task_id: "task-1" },
    payload: {
      session_id: "session-1",
      prompt: "do the work",
      secret: "do-not-copy",
    },
    sourceClient: "codex",
    event: "Stop",
    cwd: "/repo",
    timestamp: "2026-05-07T00:00:00.000Z",
  });

  assert.equal(payload.source, "orgx_openclaw_plugin_runtime_hook");
  assert.equal(payload.source_client, "codex");
  assert.equal(payload.session_id, "session-1");
  assert.equal(payload.summary.prompt_chars, 11);
  assert.equal(payload.summary.task_id, "task-1");
  assert.equal(JSON.stringify(payload).includes("do the work"), false);
  assert.equal(JSON.stringify(payload).includes("do-not-copy"), false);
});

test("main returns early when API key is missing", async () => {
  const result = await main({
    argv: [`--outbox=${await createOutboxPath()}`],
    env: {},
    fetchImpl: async () => {
      throw new Error("fetch should not be called");
    },
  });

  assert.equal(result.skipped, "missing_api_key");
});

test("main spools Work Graph event when API key is missing", async () => {
  const outbox = await createOutboxPath();

  const result = await main({
    argv: ["--event=session_stop", "--source_client=codex", `--outbox=${outbox}`],
    env: {},
    stdinText: JSON.stringify({ session_id: "session-1", prompt: "hello" }),
    fetchImpl: async () => {
      throw new Error("fetch should not be called");
    },
    now: () => Date.parse("2026-05-07T00:00:00.000Z"),
    cwd: "/repo",
  });

  assert.equal(result.ok, true);
  assert.equal(result.work_graph_spooled, true);
  assert.equal(result.skipped, "missing_api_key");

  const lines = (await readFile(outbox, "utf8")).trim().split("\n");
  assert.equal(lines.length, 1);
  const event = JSON.parse(lines[0]);
  assert.equal(event.source, "orgx_openclaw_plugin_runtime_hook");
  assert.equal(event.source_client, "codex");
  assert.equal(event.summary.prompt_chars, 5);
});

test("main posts runtime relay when hook token is provided", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({
      url,
      method: init?.method,
      headers: init?.headers ?? {},
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
      "--event=session_start",
      "--phase=intent",
      "--source_client=codex",
      `--outbox=${await createOutboxPath()}`,
    ],
    env: {
      ORGX_HOOK_TOKEN: "hook_test",
      ORGX_RUNTIME_HOOK_URL: "http://127.0.0.1:18789/orgx/api/hooks/runtime",
      ORGX_INITIATIVE_ID: "aa6d16dc-d450-417f-8a17-fd89bd597195",
    },
    fetchImpl,
  });

  assert.equal(result.ok, true);
  assert.equal(result.runtime_posted, true);
  assert.equal(result.skipped, "missing_api_key");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "http://127.0.0.1:18789/orgx/api/hooks/runtime");
  assert.equal(calls[0].body.source_client, "codex");
  assert.equal(calls[0].headers["X-OrgX-Hook-Token"], "hook_test");
});

test("main does not synthesize correlation ids when run id is missing", async () => {
  const calls = [];
  const fetchImpl = async (_url, init) => {
    calls.push(JSON.parse(init?.body ?? "{}"));
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => ({ ok: true }),
      text: async () => "",
    };
  };

  await main({
    argv: [
      "--event=progress",
      "--phase=execution",
      "--source_client=openclaw",
      `--outbox=${await createOutboxPath()}`,
    ],
    env: {
      ORGX_HOOK_TOKEN: "hook_test",
      ORGX_RUNTIME_HOOK_URL: "http://127.0.0.1:18789/orgx/api/hooks/runtime",
      ORGX_INITIATIVE_ID: "aa6d16dc-d450-417f-8a17-fd89bd597195",
    },
    fetchImpl,
  });

  assert.equal(calls.length, 1);
  assert.equal("correlation_id" in calls[0], false);
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
      `--outbox=${await createOutboxPath()}`,
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
