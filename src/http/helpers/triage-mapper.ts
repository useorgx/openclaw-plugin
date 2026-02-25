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

  const proofBundle: ProofBundle = {
    artifactRefs: [],
    fileChanges: [],
    prRefs: [],
    logRefs: input.logPath ? [input.logPath] : [],
    decisionRefs: [],
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

  const actions: TriageAction[] = [
    {
      action: "approve",
      label: "Approve",
      description: decision.recommendedAction ?? "Approve this decision",
      consequences: "Will proceed with the recommended action.",
      requiresNote: false,
      available: true,
    },
    {
      action: "reject",
      label: "Reject",
      description: "Reject and provide alternative direction",
      consequences: "Agent will pause and await new instructions.",
      requiresNote: true,
      available: true,
    },
    {
      action: "snooze",
      label: "Snooze",
      description: "Defer this decision",
      consequences: "Item reappears after snooze period.",
      requiresNote: false,
      available: true,
    },
  ];

  const proofBundle: ProofBundle = {
    artifactRefs: [],
    fileChanges: [],
    prRefs: [],
    logRefs: [],
    decisionRefs: [decision.id],
  };

  if (decision.evidenceRefs) {
    for (const ref of decision.evidenceRefs) {
      if (ref.sourceUrl) proofBundle.artifactRefs.push(ref.sourceUrl);
    }
  }

  return {
    id: `triage-decision-${decision.id}`,
    kind: mapping?.kind ?? "decision_required",
    status: decision.status === "pending" ? "open" : decision.status === "resolved" ? "resolved" : "open",
    title: decision.title,
    summary: decision.context ?? decision.title,
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
    blocking: true,
    recommendedAction: decision.recommendedAction ?? null,
    agentId: decision.agentId ?? null,
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
