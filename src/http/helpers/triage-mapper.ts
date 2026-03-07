/**
 * Deterministic failure → triage item mapper.
 *
 * Takes raw activity/blocker/decision events and produces canonical
 * `LiveTriageItem` objects with proof bundles and recommended actions.
 */

import type {
  LiveTriageItem,
  TriageAction,
  TriageItemKind,
  TriageSeverity,
  ProofBundle,
  TriageImpact,
  LiveDecision,
  TriageInterventionContext,
} from "../../contracts/shared-types.js";
import { callLlmJson } from "./llm-client.js";

// ---------------------------------------------------------------------------
// Failure type → triage mapping table
// ---------------------------------------------------------------------------

interface TriageMapping {
  kind: TriageItemKind;
  severity: TriageSeverity;
  recommendedAction: string;
  defaultTitle: (ctx: MappingContext) => string;
  defaultSummary: (ctx: MappingContext) => string;
  actions: (ctx: MappingContext) => TriageAction[];
}

interface MappingContext {
  failureType: string;
  reason?: string | null;
  provider?: string | null;
  workstreamTitle?: string | null;
  workstreamId?: string | null;
  initiativeTitle?: string | null;
  initiativeId?: string | null;
  taskTitle?: string | null;
  taskId?: string | null;
  agentId?: string | null;
  domain?: string | null;
  sourceSystem?: string | null;
  metadata?: Record<string, unknown>;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function pickString(record: Record<string, unknown> | null, keys: string[]): string | null {
  if (!record) return null;
  for (const key of keys) {
    const value = record[key];
    if (typeof value !== "string") continue;
    const normalized = value.trim();
    if (normalized.length > 0) return normalized;
  }
  return null;
}

function pickStringArray(record: Record<string, unknown> | null, keys: string[]): string[] {
  if (!record) return [];
  const values: string[] = [];
  for (const key of keys) {
    const candidate = record[key];
    if (!Array.isArray(candidate)) continue;
    for (const entry of candidate) {
      if (typeof entry !== "string") continue;
      const normalized = entry.trim();
      if (normalized.length > 0) values.push(normalized);
    }
    if (values.length > 0) break;
  }
  return values;
}

function countArray(record: Record<string, unknown> | null, keys: string[]): number {
  if (!record) return 0;
  for (const key of keys) {
    const candidate = record[key];
    if (Array.isArray(candidate)) return candidate.length;
  }
  return 0;
}

function deriveInterventionContext(input: {
  reason?: string | null;
  metadata?: Record<string, unknown>;
}): TriageInterventionContext | null {
  const metadata = asRecord(input.metadata);
  const result = asRecord(metadata?.result);
  const blocker = asRecord(metadata?.blocker) ?? asRecord(result?.blocker);
  const blockerReason =
    pickString(blocker, ["description", "summary"]) ??
    pickString(result, ["blocked_reason", "blockedReason", "error"]) ??
    pickString(metadata, ["blocked_reason", "blockedReason", "error", "reason"]) ??
    (typeof input.reason === "string" && input.reason.trim().length > 0 ? input.reason.trim() : null);
  const waitingOn =
    pickString(blocker, ["waiting_on", "required_actor", "requiredActor"]) ??
    pickString(result, ["waiting_on", "required_actor", "requiredActor"]) ??
    pickString(metadata, ["waiting_on", "required_actor", "requiredActor"]);
  const nextActions = [
    ...pickStringArray(result, ["next_actions", "nextActions"]),
    ...pickStringArray(metadata, ["next_actions", "nextActions"]),
  ];
  const requiredAction =
    pickString(blocker, ["required_action", "requiredAction"]) ??
    pickString(result, ["required_action", "requiredAction"]) ??
    pickString(metadata, ["required_action", "requiredAction"]) ??
    (nextActions[0] ?? null);
  const requiredActor =
    pickString(blocker, ["required_actor", "requiredActor"]) ??
    pickString(result, ["required_actor", "requiredActor"]) ??
    pickString(metadata, ["required_actor", "requiredActor"]);
  const suggestedActions = [
    ...pickStringArray(blocker, ["suggested_actions", "suggestedActions"]),
    ...pickStringArray(result, ["suggested_actions", "suggestedActions"]),
    ...pickStringArray(metadata, ["suggested_actions", "suggestedActions"]),
  ];
  const decisionIds = [
    ...pickStringArray(result, ["decision_ids", "decisionIds"]),
    ...pickStringArray(metadata, ["decision_ids", "decisionIds"]),
  ];
  const retryable =
    typeof blocker?.retryable === "boolean"
      ? blocker.retryable
      : typeof result?.retryable === "boolean"
        ? result.retryable
        : typeof metadata?.retryable === "boolean"
          ? metadata.retryable
          : null;
  const errorCode =
    pickString(blocker, ["error_code", "errorCode"]) ??
    pickString(result, ["error_code", "errorCode"]) ??
    pickString(metadata, ["error_code", "errorCode"]);
  const errorCategory =
    pickString(blocker, ["error_category", "errorCategory"]) ??
    pickString(result, ["error_category", "errorCategory"]) ??
    pickString(metadata, ["error_category", "errorCategory"]);
  const taskUpdateCount =
    countArray(result, ["task_updates", "taskUpdates"]) ||
    countArray(metadata, ["task_updates", "taskUpdates"]);
  const milestoneUpdateCount =
    countArray(result, ["milestone_updates", "milestoneUpdates"]) ||
    countArray(metadata, ["milestone_updates", "milestoneUpdates"]);
  const context: TriageInterventionContext = {
    blockerReason,
    waitingOn,
    requiredAction,
    requiredActor,
    retryable,
    errorCode,
    errorCategory,
    suggestedActions: suggestedActions.length > 0 ? Array.from(new Set(suggestedActions)) : [],
    nextActions: nextActions.length > 0 ? Array.from(new Set(nextActions)) : [],
    decisionIds: decisionIds.length > 0 ? Array.from(new Set(decisionIds)) : [],
    taskUpdateCount: taskUpdateCount > 0 ? taskUpdateCount : undefined,
    milestoneUpdateCount: milestoneUpdateCount > 0 ? milestoneUpdateCount : undefined,
  };
  const hasValue = [
    context.blockerReason,
    context.waitingOn,
    context.requiredAction,
    context.requiredActor,
    context.errorCode,
    context.errorCategory,
    context.retryable,
    context.taskUpdateCount,
    context.milestoneUpdateCount,
    context.suggestedActions?.length,
    context.nextActions?.length,
    context.decisionIds?.length,
  ].some((entry) => {
    if (typeof entry === "number") return entry > 0;
    return entry != null && String(entry).trim().length > 0;
  });
  return hasValue ? context : null;
}

const FAILURE_MAPPINGS: Record<string, TriageMapping> = {
  credential_missing: {
    kind: "blocked_intervention",
    severity: "high",
    recommendedAction: "Configure credentials for the required provider",
    defaultTitle: (ctx) =>
      `Credential required${ctx.provider ? ` for ${ctx.provider}` : ""}`,
    defaultSummary: (ctx) =>
      `${ctx.workstreamTitle ?? "A workstream"} is blocked because ${ctx.provider ?? "a provider"} credentials are missing or expired.`,
    actions: (ctx) => [
      {
        action: "autofix",
        label: "Configure credentials",
        description: `Open credential settings for ${ctx.provider ?? "the provider"}`,
        consequences: "Will open credential configuration. Autopilot resumes after setup.",
        requiresNote: false,
        available: true,
      },
      {
        action: "snooze",
        label: "Snooze 1 hour",
        description: "Hide for 1 hour",
        consequences: "Item reappears if credentials still missing after snooze period.",
        requiresNote: false,
        available: true,
      },
      {
        action: "dismiss",
        label: "Dismiss",
        description: "Do not re-raise until root cause changes",
        consequences: "Will not reappear unless a new credential failure occurs.",
        requiresNote: true,
        available: true,
      },
    ],
  },

  spawn_guard_blocked: {
    kind: "blocked_intervention",
    severity: "high",
    recommendedAction: "Review quality gate or adjust domain limits",
    defaultTitle: (ctx) =>
      `Spawn guard blocked${ctx.workstreamTitle ? `: ${ctx.workstreamTitle}` : ""}`,
    defaultSummary: (ctx) =>
      `${ctx.workstreamTitle ?? "A workstream"} failed spawn guard checks. ${ctx.reason ?? "Quality gate threshold not met."}`,
    actions: () => [
      {
        action: "approve",
        label: "Approve exception",
        description: "Allow this dispatch to proceed",
        consequences: "Will re-dispatch to the agent, bypassing the quality gate for this run.",
        requiresNote: false,
        available: true,
      },
      {
        action: "reject",
        label: "Reassign",
        description: "Reassign to a different agent or domain",
        consequences: "Task returns to the queue for reassignment.",
        requiresNote: false,
        available: true,
      },
      {
        action: "snooze",
        label: "Pause and investigate",
        description: "Snooze while investigating quality gate",
        consequences: "Item reappears after snooze period.",
        requiresNote: false,
        available: true,
      },
    ],
  },

  spawn_guard_rate_limited: {
    kind: "blocked_intervention",
    severity: "medium",
    recommendedAction: "Wait for rate limit recovery or override",
    defaultTitle: (ctx) =>
      `Rate limited${ctx.workstreamTitle ? `: ${ctx.workstreamTitle}` : ""}`,
    defaultSummary: (ctx) =>
      `${ctx.workstreamTitle ?? "A workstream"} is rate-limited by spawn guard. ${ctx.reason ?? "Will auto-recover."}`,
    actions: () => [
      {
        action: "retry",
        label: "Override and retry",
        description: "Bypass rate limit for this dispatch",
        consequences: "Will attempt dispatch immediately, ignoring rate limit.",
        requiresNote: false,
        available: true,
      },
      {
        action: "snooze",
        label: "Wait for recovery",
        description: "Let rate limit recover naturally",
        consequences: "Item reappears when rate limit window resets.",
        requiresNote: false,
        available: true,
      },
    ],
  },

  mcp_handshake_failure: {
    kind: "failure_diagnostic",
    severity: "high",
    recommendedAction: "Check MCP server connectivity",
    defaultTitle: () => "MCP connection failed",
    defaultSummary: (ctx) =>
      `The agent connection handshake failed. ${ctx.reason ?? "Check server connectivity and retry."}`,
    actions: () => [
      {
        action: "retry",
        label: "Retry connection",
        description: "Attempt to reconnect to MCP server",
        consequences: "Will retry the MCP handshake. Autopilot resumes if successful.",
        requiresNote: false,
        available: true,
      },
      {
        action: "dismiss",
        label: "Pause autopilot",
        description: "Stop autopilot until connectivity is restored",
        consequences: "Autopilot will stop. Manual restart required.",
        requiresNote: false,
        available: true,
      },
    ],
  },

  worker_exit_no_output: {
    kind: "failure_diagnostic",
    severity: "medium",
    recommendedAction: "Review agent logs for crash cause",
    defaultTitle: (ctx) =>
      `Agent exited without output${ctx.workstreamTitle ? `: ${ctx.workstreamTitle}` : ""}`,
    defaultSummary: (ctx) =>
      `An agent run ended before returning a structured result. ${ctx.reason ?? "Check logs for the underlying cause."}`,
    actions: () => [
      {
        action: "retry",
        label: "Retry",
        description: "Re-dispatch the task to the agent",
        consequences: "Will re-dispatch to the engineering agent.",
        requiresNote: false,
        available: true,
      },
      {
        action: "reject",
        label: "Reassign",
        description: "Reassign to a different agent",
        consequences: "Task returns to the queue for reassignment.",
        requiresNote: false,
        available: true,
      },
      {
        action: "dismiss",
        label: "Dismiss",
        description: "Mark as non-actionable",
        consequences: "Will not reappear unless a new failure occurs.",
        requiresNote: true,
        available: true,
      },
    ],
  },

  workspace_conflict: {
    kind: "decision_required",
    severity: "high",
    recommendedAction: "Resolve workspace conflict",
    defaultTitle: () => "Workspace conflict detected",
    defaultSummary: (ctx) =>
      `A workspace conflict requires human resolution. ${ctx.reason ?? "Review and choose the correct workspace scope."}`,
    actions: () => [
      {
        action: "approve",
        label: "Resolve conflict",
        description: "Choose the correct workspace and continue",
        consequences: "Will apply workspace resolution and resume.",
        requiresNote: true,
        available: true,
      },
      {
        action: "snooze",
        label: "Snooze",
        description: "Defer resolution",
        consequences: "Item reappears after snooze period.",
        requiresNote: false,
        available: true,
      },
    ],
  },

  budget_exhausted: {
    kind: "blocked_intervention",
    severity: "critical",
    recommendedAction: "Increase token budget or stop autopilot",
    defaultTitle: () => "Token budget exhausted",
    defaultSummary: (ctx) =>
      `Autopilot has used the entire token budget. ${ctx.reason ?? "Increase budget or stop autopilot."}`,
    actions: () => [
      {
        action: "autofix",
        label: "Increase budget",
        description: "Double the current token budget",
        consequences: "Will increase budget and resume autopilot.",
        requiresNote: false,
        available: true,
      },
      {
        action: "dismiss",
        label: "Stop autopilot",
        description: "Stop autopilot permanently",
        consequences: "Autopilot will stop. Manual restart required.",
        requiresNote: false,
        available: true,
      },
    ],
  },

  stale_blocked_workstream: {
    kind: "review_required",
    severity: "medium",
    recommendedAction: "Unblock or reassign workstream",
    defaultTitle: (ctx) =>
      `Stale blocked workstream${ctx.workstreamTitle ? `: ${ctx.workstreamTitle}` : ""}`,
    defaultSummary: (ctx) =>
      `${ctx.workstreamTitle ?? "A workstream"} has been blocked for an extended period. ${ctx.reason ?? "Review and unblock or reassign."}`,
    actions: () => [
      {
        action: "retry",
        label: "Unblock and retry",
        description: "Clear block status and re-dispatch",
        consequences: "Will clear the block and re-dispatch to the agent.",
        requiresNote: false,
        available: true,
      },
      {
        action: "reject",
        label: "Reassign",
        description: "Reassign to a different workstream or agent",
        consequences: "Task returns to the queue for reassignment.",
        requiresNote: false,
        available: true,
      },
      {
        action: "dismiss",
        label: "Archive",
        description: "Archive this workstream",
        consequences: "Workstream will be archived and removed from the queue.",
        requiresNote: true,
        available: true,
      },
    ],
  },
};

// ---------------------------------------------------------------------------
// LLM fallback for unknown failure types
// ---------------------------------------------------------------------------

interface LlmTriageClassification {
  kind: TriageItemKind;
  severity: TriageSeverity;
  title: string;
  summary: string;
  recommendedAction: string;
}

const VALID_KINDS = new Set<string>([
  "blocked_intervention",
  "decision_required",
  "failure_diagnostic",
  "review_required",
]);
const VALID_SEVERITIES = new Set<string>(["critical", "high", "medium", "low"]);

function parseLlmClassification(raw: string): LlmTriageClassification | null {
  try {
    const obj = JSON.parse(raw) as Record<string, unknown>;
    if (
      typeof obj.kind !== "string" ||
      typeof obj.severity !== "string" ||
      typeof obj.title !== "string" ||
      typeof obj.summary !== "string" ||
      typeof obj.recommendedAction !== "string"
    )
      return null;
    if (!VALID_KINDS.has(obj.kind) || !VALID_SEVERITIES.has(obj.severity)) return null;
    return obj as unknown as LlmTriageClassification;
  } catch {
    return null;
  }
}

const LLM_CACHE_TTL_MS = 6 * 60 * 60_000; // 6 hours

/**
 * Map a raw failure event to a LiveTriageItem.
 *
 * Known failure types are mapped deterministically. Unknown types are
 * classified via LLM with a safe heuristic fallback.
 */
export async function mapFailureToTriageItem(input: {
  id: string;
  failureType: string;
  reason?: string | null;
  provider?: string | null;
  initiativeId?: string | null;
  initiativeTitle?: string | null;
  workstreamId?: string | null;
  workstreamTitle?: string | null;
  taskId?: string | null;
  taskTitle?: string | null;
  agentId?: string | null;
  domain?: string | null;
  sourceSystem?: string | null;
  runId?: string | null;
  logPath?: string | null;
  outputPath?: string | null;
  metadata?: Record<string, unknown>;
  timestamp?: string;
}): Promise<LiveTriageItem> {
  const mapping = FAILURE_MAPPINGS[input.failureType];

  const ctx: MappingContext = {
    failureType: input.failureType,
    reason: input.reason,
    provider: input.provider,
    workstreamTitle: input.workstreamTitle,
    workstreamId: input.workstreamId,
    initiativeTitle: input.initiativeTitle,
    initiativeId: input.initiativeId,
    taskTitle: input.taskTitle,
    taskId: input.taskId,
    agentId: input.agentId,
    domain: input.domain,
    sourceSystem: input.sourceSystem,
    metadata: input.metadata,
  };

  const now = input.timestamp ?? new Date().toISOString();
  const intervention = deriveInterventionContext({
    reason: input.reason ?? null,
    metadata: input.metadata,
  });

  const proofBundle: ProofBundle = {
    artifactRefs: [],
    fileChanges: [],
    prRefs: [],
    logRefs: input.logPath ? [input.logPath] : [],
    decisionRefs: intervention?.decisionIds ?? [],
  };

  if (input.outputPath) {
    proofBundle.artifactRefs.push(input.outputPath);
  }

  const impact: TriageImpact = {
    initiativeCount: input.initiativeId ? 1 : 0,
    workstreamCount: input.workstreamId ? 1 : 0,
    downstreamBlockedCount: 0,
  };

  // --- Resolve kind / severity / title / summary / recommendedAction / actions ---
  let kind: TriageItemKind;
  let severity: TriageSeverity;
  let title: string;
  let summary: string;
  let recommendedAction: string;
  let actionContract: TriageAction[];

  if (mapping) {
    // Deterministic path for known failure types
    kind = mapping.kind;
    severity = mapping.severity;
    title = mapping.defaultTitle(ctx);
    summary = mapping.defaultSummary(ctx);
    recommendedAction = mapping.recommendedAction;
    actionContract = mapping.actions(ctx);
  } else {
    // LLM classification for unknown failure types
    const genericFallback = (): LlmTriageClassification => ({
      kind: "review_required",
      severity: "medium",
      title: "Unclassified issue",
      summary:
        input.reason || "An issue occurred that requires review.",
      recommendedAction: "Review the failure details and take appropriate action",
    });

    const llmResult = await callLlmJson<LlmTriageClassification>(
      {
        taskId: "triage_unknown",
        systemPrompt:
          'Classify this operational failure for a triage queue. Return JSON: {"kind": "blocked_intervention" | "decision_required" | "review_required" | "failure_diagnostic", "severity": "critical" | "high" | "medium" | "low", "title": "...", "summary": "...", "recommendedAction": "..."}. Be concise and actionable.',
        userPrompt: [
          `Failure type: ${input.failureType}`,
          input.reason ? `Reason: ${input.reason}` : null,
          input.workstreamTitle
            ? `Workstream: ${input.workstreamTitle}`
            : null,
          input.agentId ? `Agent: ${input.agentId}` : null,
          input.domain ? `Domain: ${input.domain}` : null,
        ]
          .filter(Boolean)
          .join("\n"),
        model: "openai/gpt-4.1-mini",
        maxTokens: 256,
        cacheTtlMs: LLM_CACHE_TTL_MS,
      },
      parseLlmClassification,
      genericFallback,
    );

    const classified = llmResult.result;
    kind = classified.kind;
    severity = classified.severity;
    title = classified.title;
    summary = classified.summary;
    recommendedAction = classified.recommendedAction;

    // Generic action set for LLM-classified items
    actionContract = [
      {
        action: "retry",
        label: "Retry",
        description: "Retry the failed operation",
        consequences: "Will re-attempt the operation.",
        requiresNote: false,
        available: true,
      },
      {
        action: "snooze",
        label: "Snooze",
        description: "Defer for later review",
        consequences: "Item reappears after snooze period.",
        requiresNote: false,
        available: true,
      },
      {
        action: "dismiss",
        label: "Dismiss",
        description: "Dismiss this item",
        consequences: "Will not reappear unless a new failure occurs.",
        requiresNote: true,
        available: true,
      },
    ];
  }

  const summaryDetails: string[] = [];
  if (intervention?.waitingOn) summaryDetails.push(`Waiting on ${intervention.waitingOn}.`);
  if (intervention?.requiredAction) summaryDetails.push(`Required action: ${intervention.requiredAction}.`);
  if (intervention?.errorCode) summaryDetails.push(`Error code: ${intervention.errorCode}.`);
  if (intervention?.taskUpdateCount && intervention.taskUpdateCount > 0) {
    summaryDetails.push(
      `${intervention.taskUpdateCount} task update${intervention.taskUpdateCount === 1 ? "" : "s"} pending apply.`
    );
  }
  if (intervention?.milestoneUpdateCount && intervention.milestoneUpdateCount > 0) {
    summaryDetails.push(
      `${intervention.milestoneUpdateCount} milestone update${intervention.milestoneUpdateCount === 1 ? "" : "s"} pending apply.`
    );
  }
  if (summaryDetails.length > 0) {
    summary = `${summary} ${summaryDetails.join(" ")}`.trim();
  }
  if (intervention?.requiredAction) {
    recommendedAction = intervention.requiredAction;
  }

  return {
    id: input.id,
    kind,
    status: "open",
    title,
    summary,
    initiativeId: input.initiativeId ?? null,
    initiativeTitle: input.initiativeTitle ?? null,
    workstreamId: input.workstreamId ?? null,
    workstreamTitle: input.workstreamTitle ?? null,
    taskId: input.taskId ?? null,
    taskTitle: input.taskTitle ?? null,
    sourceSystem: input.sourceSystem ?? "openclaw",
    conflictSource: input.failureType,
    dedupeKey: [
      input.initiativeId ?? "",
      input.failureType,
      input.provider ?? "",
      input.workstreamId ?? "",
    ]
      .filter(Boolean)
      .join(":"),
    occurrenceCount: 1,
    severity,
    blocking: kind === "blocked_intervention" || kind === "decision_required",
    recommendedAction,
    agentId: input.agentId ?? null,
    intervention,
    impact,
    proofBundle,
    actionContract,
    createdAt: now,
    updatedAt: now,
    firstSeenAt: now,
    lastSeenAt: now,
    snoozedUntil: null,
    sourceDecisionId: null,
    sourceActivityId: null,
  };
}

/**
 * Map an existing LiveDecision to a LiveTriageItem for unified display.
 */
export function mapDecisionToTriageItem(decision: LiveDecision): LiveTriageItem {
  const now = new Date().toISOString();
  const decisionType = decision.decisionType ?? "decision_required";
  const mapping = FAILURE_MAPPINGS[decisionType];
  const metadata =
    decision.metadata && typeof decision.metadata === "object" && !Array.isArray(decision.metadata)
      ? (decision.metadata as Record<string, unknown>)
      : null;
  const intervention = deriveInterventionContext({
    reason: decision.context ?? null,
    metadata: metadata ?? undefined,
  });
  const blocking = metadata?.blocking !== false;
  const options = Array.isArray(decision.options) ? decision.options : [];
  const optionActions: TriageAction[] = options
    .map((option) => {
      const implied = (option.impliedStatus ?? "").toLowerCase();
      const action: TriageAction["action"] =
        implied === "declined" || implied === "cancelled" ? "reject" : "approve";
      const optionConsequences =
        typeof option.consequences === "string" && option.consequences.trim().length > 0
          ? option.consequences.trim()
          : null;
      const consequences =
        optionConsequences ??
        (action === "approve"
          ? "Will continue execution using this option."
          : "Will decline this direction and keep the run blocked.");
      return {
        action,
        label: option.label,
        description: option.description ?? (action === "approve" ? "Approve this option" : "Reject with this rationale"),
        consequences,
        requiresNote: option.requiresNote === true,
        available: true,
        optionId: option.id,
      };
    })
    .slice(0, 4);

  const fallbackActions: TriageAction[] = [
    {
      action: "approve",
      label: "Approve",
      description: decision.recommendedAction ?? "Approve this decision",
      consequences: "Will proceed with the recommended action.",
      requiresNote: false,
      available: true,
      optionId: null,
    },
    {
      action: "reject",
      label: "Reject",
      description: "Reject and provide alternative direction",
      consequences: "Agent will pause and await new instructions.",
      requiresNote: true,
      available: true,
      optionId: null,
    },
  ];

  const optionActionsWithCoverage = [...optionActions];
  if (optionActionsWithCoverage.length > 0) {
    if (!optionActionsWithCoverage.some((action) => action.action === "approve")) {
      optionActionsWithCoverage.unshift(fallbackActions[0]);
    }
    if (!optionActionsWithCoverage.some((action) => action.action === "reject")) {
      optionActionsWithCoverage.push(fallbackActions[1]);
    }
  }

  const actions: TriageAction[] = [
    ...(optionActionsWithCoverage.length > 0 ? optionActionsWithCoverage.slice(0, 4) : fallbackActions),
    {
      action: "snooze",
      label: "Snooze",
      description: "Defer this decision",
      consequences: "Item reappears after snooze period.",
      requiresNote: false,
      available: true,
      optionId: null,
    },
  ];

  const proofBundle: ProofBundle = {
    artifactRefs: [],
    fileChanges: [],
    prRefs: [],
    logRefs: [],
    decisionRefs: Array.from(
      new Set([decision.id, ...(intervention?.decisionIds ?? [])].filter(Boolean))
    ),
  };

  if (decision.evidenceRefs) {
    for (const ref of decision.evidenceRefs) {
      if (ref.sourceUrl) proofBundle.artifactRefs.push(ref.sourceUrl);
      if (ref.sourcePointer) proofBundle.logRefs.push(ref.sourcePointer);
    }
  }
  const summaryBase =
    (typeof decision.context === "string" && decision.context.trim()) ||
    intervention?.blockerReason ||
    decision.title;
  const summarySuffix = [
    intervention?.waitingOn ? `Waiting on ${intervention.waitingOn}.` : null,
    intervention?.requiredAction ? `Required action: ${intervention.requiredAction}.` : null,
  ]
    .filter((entry): entry is string => Boolean(entry))
    .join(" ");
  const summary = summarySuffix.length > 0 ? `${summaryBase} ${summarySuffix}` : summaryBase;
  const recommendedAction = decision.recommendedAction ?? intervention?.requiredAction ?? null;

  return {
    id: `triage-decision-${decision.id}`,
    kind: mapping?.kind ?? "decision_required",
    status: decision.status === "pending" ? "open" : decision.status === "resolved" ? "resolved" : "open",
    title: decision.title,
    summary,
    initiativeId: decision.initiativeId ?? null,
    initiativeTitle: null,
    workstreamId: decision.workstreamId ?? null,
    workstreamTitle: null,
    taskId: null,
    taskTitle: null,
    sourceSystem: decision.sourceSystem ?? null,
    conflictSource: decision.conflictSource ?? null,
    dedupeKey: decision.dedupeKey ?? null,
    occurrenceCount: decision.occurrenceCount ?? 1,
    severity: decision.priority === "urgent" ? "critical" : decision.priority === "high" ? "high" : "medium",
    blocking,
    recommendedAction,
    agentId: decision.agentId ?? null,
    intervention,
    impact: {
      initiativeCount: decision.initiativeId ? 1 : 0,
      workstreamCount: decision.workstreamId ? 1 : 0,
      downstreamBlockedCount: 0,
    },
    proofBundle,
    actionContract: actions,
    createdAt: decision.requestedAt ?? now,
    updatedAt: decision.updatedAt ?? now,
    firstSeenAt: decision.firstSeenAt ?? decision.requestedAt ?? now,
    lastSeenAt: decision.lastSeenAt ?? decision.updatedAt ?? now,
    snoozedUntil: null,
    sourceDecisionId: decision.id,
    sourceActivityId: null,
  };
}

/**
 * Deduplicate triage items by dedupeKey, merging occurrence counts.
 */
export function deduplicateTriageItems(items: LiveTriageItem[]): LiveTriageItem[] {
  const byKey = new Map<string, LiveTriageItem>();

  for (const item of items) {
    const key = item.dedupeKey;
    if (!key) {
      byKey.set(item.id, item);
      continue;
    }

    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, { ...item });
      continue;
    }

    // Merge: increment count, update lastSeenAt, combine impacts
    existing.occurrenceCount += item.occurrenceCount;
    if (item.lastSeenAt > existing.lastSeenAt) {
      existing.lastSeenAt = item.lastSeenAt;
      existing.updatedAt = item.updatedAt;
    }
    if (item.firstSeenAt < existing.firstSeenAt) {
      existing.firstSeenAt = item.firstSeenAt;
    }
    existing.impact = {
      initiativeCount: Math.max(existing.impact.initiativeCount, item.impact.initiativeCount),
      workstreamCount: existing.impact.workstreamCount + item.impact.workstreamCount,
      downstreamBlockedCount: existing.impact.downstreamBlockedCount + item.impact.downstreamBlockedCount,
    };
    // Merge proof bundles
    for (const ref of item.proofBundle.logRefs) {
      if (!existing.proofBundle.logRefs.includes(ref)) {
        existing.proofBundle.logRefs.push(ref);
      }
    }
    for (const ref of item.proofBundle.decisionRefs) {
      if (!existing.proofBundle.decisionRefs.includes(ref)) {
        existing.proofBundle.decisionRefs.push(ref);
      }
    }
  }

  return Array.from(byKey.values());
}

/** Supported failure types for triage mapping. */
export const SUPPORTED_FAILURE_TYPES = Object.keys(FAILURE_MAPPINGS);
