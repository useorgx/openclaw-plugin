/**
 * OpenClaw gateway: emit the execution graph (the WEG keystone) on run
 * completion.
 *
 * PR #288 added `OrgXClient.emitExecutionGraph` but nothing CALLED it, so the
 * gateway proved completed runs via receipts/outcomes without ever emitting the
 * execution graph the brain reconciles. This wires that seam from the
 * run-completed reconcile path: build a deterministic graph for the finished run
 * and post it through the existing client method.
 *
 * The run is the real signal — one `task` node carrying the run's status and
 * economy (model/cost/tokens/duration). Nothing is synthesized; we do not invent
 * per-step nodes or depends_on edges the gateway can't substantiate at this
 * layer (a fabricated dependency would make the backend derive a false
 * dependency_violation).
 *
 * OPT-IN: maybeEmitRunExecutionGraph() no-ops unless ORGX_EMIT_EXECUTION_GRAPH
 * is truthy. Best-effort: it never throws into the run lifecycle.
 */

import type { OrgXClient } from "./contracts/client.js";
import type {
  EmitExecutionGraphRequest,
  ExecutionGraphNode,
} from "./contracts/types.js";

export interface RunExecutionGraphInput {
  initiativeId: string;
  runId?: string;
  correlationId?: string;
  success: boolean;
  hadError?: boolean;
  summary?: string;
  model?: string;
  provider?: string;
  costUsd?: number;
  tokens?: number;
  durationMs?: number;
}

const clampStr = (value: string | undefined, max: number): string | undefined =>
  typeof value === "string" ? value.slice(0, max) : undefined;

const isTruthy = (value: string | undefined): boolean =>
  typeof value === "string" && ["1", "true", "yes", "on"].includes(value.toLowerCase());

/** Whether the run-completed execution-graph emit is enabled (opt-in). */
export function executionGraphEmitEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return isTruthy(env.ORGX_EMIT_EXECUTION_GRAPH);
}

/**
 * Build the execution-graph event for a finished run. Pure. Returns null if no
 * initiative is known (nothing to attribute the run to).
 */
export function buildRunExecutionGraphEvent(
  input: RunExecutionGraphInput,
): EmitExecutionGraphRequest | null {
  if (!input.initiativeId) return null;

  const status: ExecutionGraphNode["status"] =
    input.success && !input.hadError ? "completed" : "failed";

  const economy: ExecutionGraphNode["economy"] = {};
  if (input.model) economy.model = input.model;
  if (typeof input.costUsd === "number") economy.cost_usd = input.costUsd;
  if (typeof input.tokens === "number") economy.tokens = input.tokens;
  if (typeof input.durationMs === "number") economy.duration_ms = input.durationMs;

  const node: ExecutionGraphNode = {
    id: "run",
    type: "task",
    title: clampStr(input.summary, 500) || "OpenClaw agent run",
    status,
    requires_evidence: false,
    ...(Object.keys(economy).length > 0 ? { economy } : {}),
  };

  const event: EmitExecutionGraphRequest = {
    initiative_id: input.initiativeId,
    source_client: "openclaw",
    summary: clampStr(input.summary, 2000) || `OpenClaw run ${status}`,
    nodes: [node],
    edges: [],
    trust_events: [],
    metadata: {
      emitter: "orgx-openclaw-plugin",
      via: "run-completed",
      ...(input.provider ? { provider: input.provider } : {}),
    },
  };

  if (input.runId) {
    event.run_id = input.runId;
  } else {
    event.correlation_id = clampStr(
      input.correlationId || `openclaw-${input.initiativeId}`,
      120,
    );
  }

  return event;
}

/**
 * Best-effort, OPT-IN emit from the run-completed path. Never throws into the
 * run lifecycle; returns a small status object.
 */
export async function maybeEmitRunExecutionGraph(
  client: Pick<OrgXClient, "emitExecutionGraph">,
  input: RunExecutionGraphInput,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ emitted: boolean; skipped?: string }> {
  if (!executionGraphEmitEnabled(env)) return { emitted: false, skipped: "not_enabled" };

  const event = buildRunExecutionGraphEvent(input);
  if (!event) return { emitted: false, skipped: "no_event" };

  try {
    await client.emitExecutionGraph(event);
    return { emitted: true };
  } catch {
    return { emitted: false, skipped: "emit_failed" };
  }
}
