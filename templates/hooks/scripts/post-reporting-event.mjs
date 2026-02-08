#!/usr/bin/env node

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
      raw_args: args,
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
} = {}) {
  const args = parseArgs(argv);

  const apiKey = pickString(env.ORGX_API_KEY);
  if (!apiKey) {
    return { ok: true, skipped: "missing_api_key" };
  }

  const baseUrl = pickString(env.ORGX_BASE_URL, "https://www.useorgx.com")
    .replace(/\/+$/, "");
  const initiativeId = pickString(args.initiative, env.ORGX_INITIATIVE_ID);
  if (!initiativeId) {
    return { ok: true, skipped: "missing_initiative_id" };
  }

  const sourceClient = pickString(
    args.source_client,
    env.ORGX_SOURCE_CLIENT,
    "openclaw"
  );
  const runId = pickString(args.run_id, env.ORGX_RUN_ID);
  const correlationId = runId
    ? undefined
    : pickString(
        args.correlation_id,
        env.ORGX_CORRELATION_ID,
        `hook-${now()}`
      );

  const event = pickString(args.event, "hook_event");
  const phase = pickString(args.phase, "execution");
  const message = pickString(
    args.message,
    `Hook event: ${event}`
  );

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
    return { ok: true, skipped: "activity_post_failed" };
  }

  const shouldApplyCompletion =
    args.apply_completion === "true" || args.apply_completion === "1";
  const taskId = pickString(args.task_id, env.ORGX_TASK_ID);
  if (!shouldApplyCompletion || !taskId) {
    return { ok: true, activity_posted: true, changeset_posted: false };
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
      activity_posted: true,
      changeset_posted: false,
      skipped: "changeset_post_failed",
    };
  }

  return { ok: true, activity_posted: true, changeset_posted: true };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .then(() => {
      process.exit(0);
    })
    .catch(() => {
      process.exit(0);
    });
}
