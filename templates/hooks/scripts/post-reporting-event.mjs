#!/usr/bin/env node

import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

export function parseArgs(argv) {
  const args = {};
  for (const arg of argv) {
    if (!arg.startsWith("--")) continue;
    const [rawKey, ...rest] = arg.slice(2).split("=");
    const key = rawKey.trim();
    if (!key) continue;
    args[key] = rest.length > 0 ? rest.join("=") : "true";
  }
  return args;
}

export function pickString(...values) {
  for (const value of values) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed.length > 0) {
      return trimmed;
    }
  }
  return undefined;
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

export function parseJsonRecord(value) {
  try {
    const parsed = JSON.parse(value || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : {};
  } catch {
    return {};
  }
}

export function sanitizeArgs(args) {
  const redacted = {};
  for (const [key, value] of Object.entries(args ?? {})) {
    if (/token|api[_-]?key|authorization|cookie|secret/i.test(key)) {
      redacted[key] = "[redacted]";
    } else {
      redacted[key] = value;
    }
  }
  return redacted;
}

async function postJson(url, payload, headers, fetchImpl = fetch) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...headers,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`HTTP ${response.status}: ${body || response.statusText}`);
    }
    return await response.json().catch(() => ({}));
  } finally {
    clearTimeout(timeout);
  }
}

export function buildWorkGraphHookRecord({
  args,
  payload,
  sourceClient,
  event,
  cwd = process.cwd(),
  timestamp = new Date().toISOString(),
}) {
  const toolName = pickString(
    payload.tool_name,
    payload.toolName,
    payload.tool?.name,
    payload.name
  );
  const prompt = pickString(payload.prompt, payload.user_prompt, payload.userPrompt);

  return {
    schema_version: "2026-05-07",
    source: "orgx_openclaw_plugin_runtime_hook",
    source_client: sourceClient,
    event,
    session_id: pickString(
      payload.session_id,
      payload.sessionId,
      payload.conversation_id,
      payload.conversationId,
      payload.thread_id,
      payload.threadId,
      args.session_id,
      args.sessionId,
      args.run_id
    ),
    turn_id: pickString(payload.turn_id, payload.turnId, args.turn_id, args.turnId),
    cwd: pickString(
      payload.cwd,
      payload.working_directory,
      payload.workspace,
      args.cwd,
      cwd
    ),
    transcript_path: pickString(payload.transcript_path, payload.transcriptPath),
    timestamp,
    summary: {
      tool_name: toolName,
      prompt_chars: prompt ? prompt.length : undefined,
      payload_keys: Object.keys(payload).slice(0, 40),
      initiative_id: pickString(args.initiative, args.initiative_id),
      workstream_id: pickString(args.workstream_id),
      task_id: pickString(args.task_id),
      run_id: pickString(args.run_id),
      correlation_id: pickString(args.correlation_id),
    },
  };
}

export function appendWorkGraphHookRecord(record, outbox) {
  try {
    mkdirSync(dirname(outbox), { recursive: true, mode: 0o700 });
    appendFileSync(outbox, `${JSON.stringify(record)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    return true;
  } catch {
    return false;
  }
}

export function buildRuntimePayload({
  initiativeId,
  runId,
  correlationId,
  sourceClient,
  event,
  phase,
  message,
  workstreamId,
  taskId,
  agentId,
  agentName,
  progressPct,
  args,
}) {
  return {
    source_client: sourceClient,
    event,
    run_id: runId,
    correlation_id: correlationId,
    initiative_id: initiativeId,
    workstream_id: workstreamId,
    task_id: taskId,
    agent_id: agentId,
    agent_name: agentName,
    phase,
    progress_pct: progressPct,
    message,
    metadata: {
      source: "hook_runtime_relay",
      raw_args: sanitizeArgs(args),
    },
    timestamp: new Date().toISOString(),
  };
}

export function buildActivityPayload({
  initiativeId,
  runId,
  correlationId,
  sourceClient,
  event,
  phase,
  message,
  args,
}) {
  return {
    initiative_id: initiativeId,
    run_id: runId,
    correlation_id: correlationId,
    source_client: sourceClient,
    message,
    phase,
    level: phase === "blocked" ? "warn" : "info",
    metadata: {
      source: "hook_backstop",
      hook_event: event,
      raw_args: sanitizeArgs(args),
    },
  };
}

export function buildCompletionChangesetPayload({
  initiativeId,
  runId,
  correlationId,
  sourceClient,
  event,
  taskId,
}) {
  return {
    initiative_id: initiativeId,
    run_id: runId,
    correlation_id: correlationId,
    source_client: sourceClient,
    idempotency_key: `hook:${event}:${taskId}`,
    operations: [
      {
        op: "task.update",
        task_id: taskId,
        status: "done",
      },
    ],
  };
}

export async function main({
  argv = process.argv.slice(2),
  env = process.env,
  fetchImpl = fetch,
  now = () => Date.now(),
  stdinText = "",
  cwd = process.cwd(),
} = {}) {
  const args = parseArgs(argv);
  const stdinPayload = parseJsonRecord(stdinText);

  const runtimeHookUrl = pickString(
    args.runtime_hook_url,
    args.hook_url,
    env.ORGX_RUNTIME_HOOK_URL,
    "http://127.0.0.1:18789/orgx/api/hooks/runtime"
  );
  const runtimeHookToken = pickString(
    args.hook_token,
    args.runtime_hook_token,
    env.ORGX_HOOK_TOKEN
  );

  const baseUrl = pickString(env.ORGX_BASE_URL, "https://www.useorgx.com")
    .replace(/\/+$/, "");
  const initiativeId = pickString(args.initiative, env.ORGX_INITIATIVE_ID);
  const apiKey = pickString(env.ORGX_API_KEY);

  const sourceClient = pickString(
    args.source_client,
    env.ORGX_SOURCE_CLIENT,
    "openclaw"
  );
  const runId = pickString(args.run_id, env.ORGX_RUN_ID);
  const correlationId = runId
    ? undefined
    : pickString(args.correlation_id, env.ORGX_CORRELATION_ID);

  const event = pickString(args.event, "hook_event");
  const phase = pickString(args.phase, "execution");
  const workstreamId = pickString(args.workstream_id, env.ORGX_WORKSTREAM_ID);
  const taskId = pickString(args.task_id, env.ORGX_TASK_ID);
  const agentId = pickString(args.agent_id, env.ORGX_AGENT_ID);
  const agentName = pickString(args.agent_name, env.ORGX_AGENT_NAME);
  const progressPctRaw = pickString(args.progress_pct, env.ORGX_PROGRESS_PCT);
  const progressPct = progressPctRaw ? Number(progressPctRaw) : undefined;
  const message = pickString(
    args.message,
    `Hook event: ${event}`
  );
  const outbox = pickString(
    args.outbox,
    env.ORGX_WIZARD_HOOK_OUTBOX,
    join(homedir(), ".config", "useorgx", "wizard", "hooks", "events.jsonl")
  );
  const workGraphSpooled = appendWorkGraphHookRecord(
    buildWorkGraphHookRecord({
      args,
      payload: stdinPayload,
      sourceClient,
      event,
      cwd,
      timestamp: new Date(now()).toISOString(),
    }),
    outbox
  );

  let runtimePosted = false;
  let runtimePostFailed = false;
  if (runtimeHookToken && runtimeHookUrl) {
    const runtimePayload = buildRuntimePayload({
      initiativeId,
      runId,
      correlationId,
      sourceClient,
      event,
      phase,
      message,
      workstreamId,
      taskId,
      agentId,
      agentName,
      progressPct: Number.isFinite(progressPct) ? progressPct : undefined,
      args,
    });
    try {
      await postJson(
        runtimeHookUrl,
        runtimePayload,
        { "X-OrgX-Hook-Token": runtimeHookToken },
        fetchImpl
      );
      runtimePosted = true;
    } catch {
      runtimePostFailed = true;
    }
  }

  if (!apiKey) {
    return {
      ok: true,
      runtime_posted: runtimePosted,
      work_graph_spooled: workGraphSpooled,
      skipped: "missing_api_key",
      ...(runtimePostFailed ? { runtime_skipped: "runtime_post_failed" } : {}),
    };
  }
  if (!initiativeId) {
    return {
      ok: true,
      runtime_posted: runtimePosted,
      work_graph_spooled: workGraphSpooled,
      skipped: "missing_initiative_id",
      ...(runtimePostFailed ? { runtime_skipped: "runtime_post_failed" } : {}),
    };
  }

  const headers = {
    Authorization: `Bearer ${apiKey}`,
  };

  const userId = pickString(env.ORGX_USER_ID);
  if (userId) {
    headers["X-Orgx-User-Id"] = userId;
  }

  const activityPayload = buildActivityPayload({
    initiativeId,
    runId,
    correlationId,
    sourceClient,
    event,
    phase,
    message,
    args,
  });

  try {
    await postJson(
      `${baseUrl}/api/client/live/activity`,
      activityPayload,
      headers,
      fetchImpl
    );
  } catch {
    return {
      ok: true,
      runtime_posted: runtimePosted,
      work_graph_spooled: workGraphSpooled,
      skipped: "activity_post_failed",
    };
  }

  const shouldApplyCompletion =
    args.apply_completion === "true" || args.apply_completion === "1";
  if (!shouldApplyCompletion || !taskId) {
    return {
      ok: true,
      runtime_posted: runtimePosted,
      work_graph_spooled: workGraphSpooled,
      activity_posted: true,
      changeset_posted: false,
    };
  }

  const changesetPayload = buildCompletionChangesetPayload({
    initiativeId,
    runId,
    correlationId,
    sourceClient,
    event,
    taskId,
  });

  try {
    await postJson(
      `${baseUrl}/api/client/live/changesets/apply`,
      changesetPayload,
      headers,
      fetchImpl
    );
  } catch {
    return {
      ok: true,
      runtime_posted: runtimePosted,
      work_graph_spooled: workGraphSpooled,
      activity_posted: true,
      changeset_posted: false,
      skipped: "changeset_post_failed",
    };
  }

  return {
    ok: true,
    runtime_posted: runtimePosted,
    work_graph_spooled: workGraphSpooled,
    activity_posted: true,
    changeset_posted: true,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  readStdin()
    .then((stdinText) => main({ stdinText }))
    .then(() => {
      process.exit(0);
    })
    .catch(() => {
      process.exit(0);
    });
}
