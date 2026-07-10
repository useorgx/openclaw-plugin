export type HeartbeatBeforeToolCallEvent = {
  toolName: string;
  params?: Record<string, unknown>;
  runId?: string;
};

export type HeartbeatToolContext = {
  agentId?: string;
  sessionKey?: string;
  sessionId?: string;
  runId?: string;
};

export type HeartbeatToolCallResult = {
  block?: boolean;
  blockReason?: string;
};

type GuardState = {
  canonicalStatusSeen: boolean;
  canonicalRecommendationSeen: boolean;
  executionCalls: number;
};

const DISCOVERY_TOOLS = new Set([
  "orgx_status",
  "orgx_recommend_next_action",
]);

const TERMINAL_TOOLS = new Set([
  "heartbeat_respond",
  "orgx_emit_activity",
  "orgx_report_progress",
  "update_stream_progress",
  "orgx_register_artifact",
  "orgx_request_decision",
  "orgx_verify_completion",
  "orgx_update_entity",
  "orgx_record_outcome",
  "orgx_quality_score",
]);

const LIMIT_REACHED_REASON =
  "Managed heartbeat execution limit reached. Stop execution, report the bounded result, call heartbeat_respond with notify=false, and end this heartbeat.";

const DISCOVERY_REQUIRED_REASON =
  "Managed heartbeat discovery is incomplete. Call orgx_recommend_next_action with canonical_only=true before executing task tools.";

const BROAD_DISCOVERY_REASON =
  "Broad filesystem discovery is not allowed during a managed heartbeat. Use the task execution context and targeted file reads only.";

function isManagedAgent(agentId: string | undefined): boolean {
  return typeof agentId === "string" && agentId.startsWith("orgx-");
}

function isCanonicalCall(event: HeartbeatBeforeToolCallEvent): boolean {
  return event.params?.canonical_only === true;
}

function stateKey(
  event: { runId?: string },
  context: HeartbeatToolContext
): string | null {
  return (
    event.runId ??
    context.runId ??
    context.sessionId ??
    context.sessionKey ??
    null
  );
}

function commandFrom(event: HeartbeatBeforeToolCallEvent): string {
  const command = event.params?.command;
  return typeof command === "string" ? command : "";
}

export function isBroadHeartbeatDiscoveryCommand(command: string): boolean {
  if (!command.trim()) return false;
  if (/(^|[;&|]\s*)find\s+/i.test(command)) return true;
  if (/\bgrep\s+(?:-[^\s]*[rR][^\s]*\s+|--recursive\b)/i.test(command)) {
    return true;
  }
  return /(?:^|\s)(?:~|\/Users\/[^/]+)(?:\/|\s|$)/.test(command);
}

export function createManagedHeartbeatExecutionGuard(options?: {
  maxExecutionCalls?: number;
}) {
  const maxExecutionCalls = Math.max(1, options?.maxExecutionCalls ?? 5);
  const states = new Map<string, GuardState>();

  function beforeToolCall(
    event: HeartbeatBeforeToolCallEvent,
    context: HeartbeatToolContext
  ): HeartbeatToolCallResult | void {
    if (!isManagedAgent(context.agentId)) return;
    const key = stateKey(event, context);
    if (!key) return;

    if (event.toolName === "orgx_status" && isCanonicalCall(event)) {
      if (!states.has(key)) {
        states.set(key, {
          canonicalStatusSeen: true,
          canonicalRecommendationSeen: false,
          executionCalls: 0,
        });
      }
      return;
    }

    const state = states.get(key);
    if (!state?.canonicalStatusSeen) return;

    if (
      event.toolName === "orgx_recommend_next_action" &&
      isCanonicalCall(event)
    ) {
      state.canonicalRecommendationSeen = true;
      return;
    }

    if (DISCOVERY_TOOLS.has(event.toolName)) return;
    if (TERMINAL_TOOLS.has(event.toolName)) return;

    if (!state.canonicalRecommendationSeen) {
      return { block: true, blockReason: DISCOVERY_REQUIRED_REASON };
    }

    if (state.executionCalls >= maxExecutionCalls) {
      return { block: true, blockReason: LIMIT_REACHED_REASON };
    }

    state.executionCalls += 1;
    if (
      event.toolName === "exec" &&
      isBroadHeartbeatDiscoveryCommand(commandFrom(event))
    ) {
      return { block: true, blockReason: BROAD_DISCOVERY_REASON };
    }
  }

  function endRun(context: HeartbeatToolContext): void {
    const key = stateKey({}, context);
    if (key) states.delete(key);
  }

  return { beforeToolCall, endRun };
}
