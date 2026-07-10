export type HeartbeatBeforeToolCallEvent = {
  toolName: string;
  params?: Record<string, unknown>;
  runId?: string;
};

export type HeartbeatAfterToolCallEvent = HeartbeatBeforeToolCallEvent & {
  result?: unknown;
  error?: string;
  durationMs?: number;
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
  terminalReported: boolean;
  completionVerified: boolean;
};

const LIMIT_REACHED_REASON =
  "Managed heartbeat execution limit reached: the total tool-call budget is exhausted. Stop execution, report the bounded result, call heartbeat_respond with notify=false, and end this heartbeat.";

const DISCOVERY_REQUIRED_REASON =
  "Managed heartbeat discovery is incomplete. Call orgx_recommend_next_action with canonical_only=true before executing task tools.";

const CANONICAL_DISCOVERY_REQUIRED_REASON =
  "Managed heartbeat discovery tools require canonical_only=true. Retry the status or recommendation call with canonical_only=true.";

const STATUS_REQUIRED_REASON =
  "Managed OrgX agents must begin each turn with orgx_status using canonical_only=true. Do not act from prior chat context.";

const TERMINAL_REPORTED_REASON =
  "Managed heartbeat terminal status is already recorded. End this turn without calling additional tools.";

const COMPLETION_PROOF_REQUIRED_REASON =
  "Managed heartbeat completion is not verified. Call orgx_verify_completion for the selected task and report done only when it returns ready=true and verified=true; otherwise report progress or blocked.";

const BROAD_DISCOVERY_REASON =
  "Broad filesystem discovery is not allowed during a managed heartbeat. Use the task execution context and targeted file reads only.";

function isManagedContext(context: HeartbeatToolContext): boolean {
  if (
    typeof context.agentId === "string" &&
    context.agentId.startsWith("orgx-")
  ) {
    return true;
  }
  return (
    typeof context.sessionKey === "string" &&
    context.sessionKey.startsWith("agent:orgx-")
  );
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

function isCompletionSignal(event: HeartbeatBeforeToolCallEvent): boolean {
  const outcome = event.params?.outcome;
  if (
    event.toolName === "heartbeat_respond" &&
    typeof outcome === "string" &&
    ["done", "completed", "success"].includes(outcome.trim().toLowerCase())
  ) {
    return true;
  }

  const phase = event.params?.phase;
  if (
    event.toolName === "orgx_emit_activity" &&
    typeof phase === "string" &&
    phase.trim().toLowerCase() === "completed"
  ) {
    return true;
  }

  const status = event.params?.status;
  if (
    event.toolName === "orgx_update_entity" &&
    typeof status === "string" &&
    ["done", "completed"].includes(status.trim().toLowerCase())
  ) {
    return true;
  }

  return (
    event.toolName === "orgx_record_outcome" &&
    event.params?.success === true
  );
}

function completionVerificationPassed(result: unknown, error?: string): boolean {
  if (error || result === undefined || result === null) return false;
  const seen = new WeakSet<object>();
  const collect = (value: unknown, depth = 0): string => {
    if (depth > 6 || value === undefined || value === null) return "";
    if (typeof value === "string") return value;
    if (typeof value !== "object") return String(value);
    if (seen.has(value)) return "";
    seen.add(value);
    if (Array.isArray(value)) {
      return value.map((entry) => collect(entry, depth + 1)).join(" ");
    }
    return Object.values(value)
      .map((entry) => collect(entry, depth + 1))
      .join(" ");
  };
  const serialized = collect(result);
  return (
    /["']ready["']\s*:\s*true/i.test(serialized) &&
    /["']verified["']\s*:\s*true/i.test(serialized)
  );
}

export function isBroadHeartbeatDiscoveryCommand(command: string): boolean {
  if (!command.trim()) return false;
  if (/(^|[;&|]\s*)find\s+/i.test(command)) return true;
  if (/\bgrep\s+(?:-[^\s]*[rR][^\s]*\s+|--recursive\b)/i.test(command)) {
    return true;
  }
  return /(?:^|\s)(?:~|\/Users\/[^/\s]+)(?=\s|$)/.test(command);
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
    if (!isManagedContext(context)) return;
    const key = stateKey(event, context);
    if (!key) return;

    if (event.toolName === "orgx_status" && isCanonicalCall(event)) {
      const existing = states.get(key);
      if (!existing) {
        states.set(key, {
          canonicalStatusSeen: true,
          canonicalRecommendationSeen: false,
          executionCalls: 0,
          terminalReported: false,
          completionVerified: false,
        });
      } else if (existing.terminalReported) {
        return { block: true, blockReason: TERMINAL_REPORTED_REASON };
      }
      return;
    }

    const state = states.get(key);
    if (!state?.canonicalStatusSeen) {
      return { block: true, blockReason: STATUS_REQUIRED_REASON };
    }
    if (state.terminalReported) {
      return { block: true, blockReason: TERMINAL_REPORTED_REASON };
    }

    if (
      event.toolName === "orgx_recommend_next_action" &&
      isCanonicalCall(event)
    ) {
      state.canonicalRecommendationSeen = true;
      return;
    }

    if (
      event.toolName === "orgx_status" ||
      event.toolName === "orgx_recommend_next_action"
    ) {
      return { block: true, blockReason: CANONICAL_DISCOVERY_REQUIRED_REASON };
    }
    if (event.toolName === "heartbeat_respond") {
      if (isCompletionSignal(event) && !state.completionVerified) {
        return { block: true, blockReason: COMPLETION_PROOF_REQUIRED_REASON };
      }
      state.terminalReported = true;
      return;
    }

    if (!state.canonicalRecommendationSeen) {
      return { block: true, blockReason: DISCOVERY_REQUIRED_REASON };
    }

    if (state.executionCalls >= maxExecutionCalls) {
      return { block: true, blockReason: LIMIT_REACHED_REASON };
    }

    state.executionCalls += 1;
    if (isCompletionSignal(event) && !state.completionVerified) {
      return { block: true, blockReason: COMPLETION_PROOF_REQUIRED_REASON };
    }
    if (
      event.toolName === "exec" &&
      isBroadHeartbeatDiscoveryCommand(commandFrom(event))
    ) {
      return { block: true, blockReason: BROAD_DISCOVERY_REASON };
    }
  }

  function afterToolCall(
    event: HeartbeatAfterToolCallEvent,
    context: HeartbeatToolContext
  ): void {
    if (!isManagedContext(context) || event.toolName !== "orgx_verify_completion") {
      return;
    }
    const key = stateKey(event, context);
    if (!key) return;
    const state = states.get(key);
    if (!state) return;
    state.completionVerified = completionVerificationPassed(
      event.result,
      event.error
    );
  }

  function endRun(context: HeartbeatToolContext): void {
    const key = stateKey({}, context);
    if (key) states.delete(key);
  }

  return { beforeToolCall, afterToolCall, endRun };
}
