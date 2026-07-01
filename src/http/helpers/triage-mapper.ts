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

function pickBoolean(record: Record<string, unknown> | null, keys: string[]): boolean | null {
  if (!record) return null;
  for (const key of keys) {
    const candidate = record[key];
    if (typeof candidate === "boolean") return candidate;
    if (typeof candidate === "string") {
      const normalized = candidate.trim().toLowerCase();
      if (normalized === "true" || normalized === "yes" || normalized === "1") return true;
      if (normalized === "false" || normalized === "no" || normalized === "0") return false;
    }
  }
  return null;
}

function normalizeDecisionOptionsFromUnknown(
  ...values: Array<unknown>
): Array<{
  id?: string | null;
  label: string;
  description?: string | null;
  consequences?: string | null;
  actionType?: string | null;
  impliedStatus?: string | null;
  requiresNote?: boolean;
  recommended?: boolean;
}> {
  const options: Array<{
    id?: string | null;
    label: string;
    description?: string | null;
    consequences?: string | null;
    actionType?: string | null;
    impliedStatus?: string | null;
    requiresNote?: boolean;
    recommended?: boolean;
  }> = [];
  const seen = new Set<string>();

  for (const value of values) {
    if (!Array.isArray(value)) continue;
    for (const entry of value) {
      if (typeof entry === "string") {
        const label = entry.trim();
        if (!label) continue;
        const key = label.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        options.push({ label });
        continue;
      }
      const record = asRecord(entry);
      if (!record) continue;
      const label =
        pickString(record, ["label", "title", "name", "question"]) ??
        pickString(record, ["action", "action_type", "actionType"]);
      if (!label) continue;
      const id = pickString(record, ["id", "option_id", "optionId"]);
      const description = pickString(record, ["description", "summary"]);
      const consequences = pickString(record, ["consequences", "impact"]);
      const actionType = pickString(record, ["action_type", "actionType", "action"]);
      const impliedStatus = pickString(record, ["implied_status", "impliedStatus", "status"]);
      const requiresNote = pickBoolean(record, ["requires_note", "requiresNote", "note_required"]);
      const recommended = pickBoolean(record, ["recommended", "is_recommended", "isRecommended"]);
      const key = `${(id ?? "").toLowerCase()}|${label.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      options.push({
        ...(id ? { id } : {}),
        label,
        ...(description ? { description } : {}),
        ...(consequences ? { consequences } : {}),
        ...(actionType ? { actionType } : {}),
        ...(impliedStatus ? { impliedStatus } : {}),
        ...(typeof requiresNote === "boolean" ? { requiresNote } : {}),
        ...(typeof recommended === "boolean" ? { recommended } : {}),
      });
    }
  }

  return options.slice(0, 8);
}

function normalizeEvidenceFromUnknown(
  ...values: Array<unknown>
): Array<{
  title: string;
  summary?: string | null;
  url?: string | null;
  pointer?: string | null;
  evidenceType?: string | null;
  confidence?: number | null;
}> {
  const evidence: Array<{
    title: string;
    summary?: string | null;
    url?: string | null;
    pointer?: string | null;
    evidenceType?: string | null;
    confidence?: number | null;
  }> = [];
  const seen = new Set<string>();

  for (const value of values) {
    if (!Array.isArray(value)) continue;
    for (const entry of value) {
      const record = asRecord(entry);
      if (!record) continue;
      const title =
        pickString(record, ["title", "label", "name"]) ??
        pickString(record, ["source_pointer", "sourcePointer", "source_url", "sourceUrl"]) ??
        "Evidence";
      const summary = pickString(record, ["summary", "description"]);
      const url = pickString(record, ["source_url", "sourceUrl", "url"]);
      const pointer = pickString(record, ["source_pointer", "sourcePointer", "path"]);
      const evidenceType = pickString(record, ["evidence_type", "evidenceType", "type"]);
      const confidenceRaw = record.confidence ?? record.confidence_score;
      const confidence =
        typeof confidenceRaw === "number" && Number.isFinite(confidenceRaw)
          ? Math.max(0, Math.min(1, confidenceRaw))
          : null;
      const key = `${title.toLowerCase()}|${url ?? ""}|${pointer ?? ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      evidence.push({
        title,
        ...(summary ? { summary } : {}),
        ...(url ? { url } : {}),
        ...(pointer ? { pointer } : {}),
        ...(evidenceType ? { evidenceType } : {}),
        ...(confidence !== null ? { confidence } : {}),
      });
    }
  }

  return evidence.slice(0, 8);
}

function pickHierarchy(record: Record<string, unknown> | null, keys: string[]): string[] {
  if (!record) return [];
  for (const key of keys) {
    const candidate = record[key];
    if (!Array.isArray(candidate)) continue;
    const normalized = candidate
      .filter((entry): entry is string => typeof entry === "string")
      .map((entry) => entry.trim())
      .filter(Boolean);
    if (normalized.length > 0) return normalized;
  }
  return [];
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
  const decisionPrompt =
    pickString(metadata, ["decision_prompt", "decisionPrompt", "question", "decision_title", "decisionTitle"]) ??
    pickString(result, ["decision_prompt", "decisionPrompt", "question"]);
  const decisionSummary =
    pickString(metadata, ["decision_summary", "decisionSummary", "summary", "context"]) ??
    pickString(result, ["decision_summary", "decisionSummary", "summary"]);
  const decisionOptions = normalizeDecisionOptionsFromUnknown(
    metadata?.decision_options,
    metadata?.decisionOptions,
    metadata?.options,
    result?.decision_options,
    result?.decisionOptions,
    result?.options
  );
  const recommendedAction =
    pickString(metadata, ["recommended_action", "recommendedAction"]) ??
    pickString(result, ["recommended_action", "recommendedAction"]) ??
    requiredAction;
  const scopeHierarchy = [
    ...pickHierarchy(metadata, ["scope_hierarchy", "scopeHierarchy"]),
    ...pickHierarchy(result, ["scope_hierarchy", "scopeHierarchy"]),
  ].filter((entry, index, source) => source.indexOf(entry) === index);
  const currentRunState =
    pickString(metadata, ["current_run_state", "currentRunState", "runtime_state", "runtimeState", "status"]) ??
    pickString(result, ["current_run_state", "currentRunState", "runtime_state", "runtimeState", "status"]);
  const impactIfDelayed =
    pickString(metadata, ["impact_if_delayed", "impactIfDelayed"]) ??
    pickString(result, ["impact_if_delayed", "impactIfDelayed"]);
  const evidence = normalizeEvidenceFromUnknown(
    metadata?.evidence_refs,
    metadata?.evidenceRefs,
    result?.evidence_refs,
    result?.evidenceRefs
  );
  const artifacts = pickStringArray(metadata, ["artifacts_created", "artifact_titles", "artifactTitles"]);
  const updatesApplied = [
    ...pickStringArray(metadata, ["updates_applied", "updatesApplied"]),
    ...pickStringArray(result, ["updates_applied", "updatesApplied"]),
  ];
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
    decisionPrompt,
    decisionSummary,
    decisionOptions: decisionOptions.length > 0 ? decisionOptions : undefined,
    recommendedAction,
    scopeHierarchy: scopeHierarchy.length > 0 ? scopeHierarchy : undefined,
    currentRunState,
    impactIfDelayed,
    artifacts: artifacts.length > 0 ? Array.from(new Set(artifacts)) : undefined,
    evidence: evidence.length > 0 ? evidence : undefined,
    updatesApplied: updatesApplied.length > 0 ? Array.from(new Set(updatesApplied)) : undefined,
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
    context.decisionPrompt,
    context.decisionSummary,
    context.recommendedAction,
    context.currentRunState,
    context.impactIfDelayed,
    context.suggestedActions?.length,
    context.nextActions?.length,
    context.decisionIds?.length,
    context.decisionOptions?.length,
    context.scopeHierarchy?.length,
    context.artifacts?.length,
    context.evidence?.length,
    context.updatesApplied?.length,
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

  decision_required: {
    kind: "decision_required",
    severity: "high",
    recommendedAction: "Review the options and choose the next move",
    defaultTitle: (ctx) =>
      `Decision required${ctx.workstreamTitle ? `: ${ctx.workstreamTitle}` : ""}`,
    defaultSummary: (ctx) =>
      `${ctx.workstreamTitle ?? "This workstream"} cannot continue until a decision is made. ${ctx.reason ?? "Review the recommendation and choose a direction."}`,
    actions: () => [
      {
        action: "approve",
        label: "Approve path",
        description: "Accept the recommended option and continue",
        consequences: "Autopilot will continue with the approved direction.",
        requiresNote: false,
        available: true,
      },
      {
        action: "reject",
        label: "Reject path",
        description: "Decline this path and provide direction",
        consequences: "The run stays paused until new direction is provided.",
        requiresNote: true,
        available: true,
      },
      {
        action: "snooze",
        label: "Snooze",
        description: "Defer this intervention",
        consequences: "This decision returns to the queue later.",
        requiresNote: false,
        available: true,
      },
    ],
  },

  review_required: {
    kind: "review_required",
    severity: "medium",
    recommendedAction: "Review the update and confirm the next step",
    defaultTitle: (ctx) =>
      `Review required${ctx.workstreamTitle ? `: ${ctx.workstreamTitle}` : ""}`,
    defaultSummary: (ctx) =>
      `${ctx.workstreamTitle ?? "This workstream"} surfaced something that needs judgment before it proceeds. ${ctx.reason ?? "Review the evidence and confirm what should happen next."}`,
    actions: () => [
      {
        action: "approve",
        label: "Approve",
        description: "Confirm the proposed next step",
        consequences: "The run continues with the reviewed direction.",
        requiresNote: false,
        available: true,
      },
      {
        action: "reject",
        label: "Send back",
        description: "Request a different approach",
        consequences: "The run pauses until new direction is provided.",
        requiresNote: true,
        available: true,
      },
      {
        action: "snooze",
        label: "Snooze",
        description: "Return to this later",
        consequences: "The review request will surface again later.",
        requiresNote: false,
        available: true,
      },
    ],
  },

  status_updates_buffered: {
    kind: "review_required",
    severity: "medium",
    recommendedAction: "Review buffered status updates and retry persistence",
    defaultTitle: (ctx) =>
      `Status updates need review${ctx.workstreamTitle ? `: ${ctx.workstreamTitle}` : ""}`,
    defaultSummary: (ctx) =>
      `${ctx.workstreamTitle ?? "A workstream"} completed, but status updates could not be applied automatically. ${ctx.reason ?? "Review the buffered updates and retry persistence."}`,
    actions: () => [
      {
        action: "retry",
        label: "Retry updates",
        description: "Retry applying the buffered task and milestone updates",
        consequences: "Will attempt to persist the buffered status updates again.",
        requiresNote: false,
        available: true,
      },
      {
        action: "snooze",
        label: "Review later",
        description: "Leave the buffered updates in the review queue",
        consequences: "The item remains available for manual recovery.",
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
  for (const artifact of intervention?.artifacts ?? []) {
    if (!proofBundle.artifactRefs.includes(artifact)) {
      proofBundle.artifactRefs.push(artifact);
    }
  }
  for (const evidence of intervention?.evidence ?? []) {
    if (evidence.url && !proofBundle.artifactRefs.includes(evidence.url)) {
      proofBundle.artifactRefs.push(evidence.url);
    }
    if (evidence.pointer && !proofBundle.logRefs.includes(evidence.pointer)) {
      proofBundle.logRefs.push(evidence.pointer);
    }
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
  const enrichedIntervention: TriageInterventionContext | null =
    intervention || options.length > 0 || decision.context || decision.recommendedAction || decision.evidenceRefs?.length
      ? {
          ...(intervention ?? {}),
          decisionPrompt:
            intervention?.decisionPrompt ??
            decision.title,
          decisionSummary:
            intervention?.decisionSummary ??
            decision.context ??
            null,
          decisionOptions:
            intervention?.decisionOptions && intervention.decisionOptions.length > 0
              ? intervention.decisionOptions
              : options.map((option) => ({
                  id: option.id,
                  label: option.label,
                  description: option.description ?? null,
                  consequences: option.consequences ?? null,
                  actionType: option.actionType ?? null,
                  impliedStatus: option.impliedStatus ?? null,
                  requiresNote: option.requiresNote,
                  recommended:
                    decision.selectedOptionId != null ? decision.selectedOptionId === option.id : false,
                })),
          recommendedAction:
            intervention?.recommendedAction ??
            decision.recommendedAction ??
            null,
          evidence:
            intervention?.evidence && intervention.evidence.length > 0
              ? intervention.evidence
              : (decision.evidenceRefs ?? []).map((ref) => ({
                  title: ref.title ?? ref.sourcePointer ?? ref.sourceUrl ?? "Evidence",
                  summary: ref.summary ?? null,
                  url: ref.sourceUrl ?? null,
                  pointer: ref.sourcePointer ?? null,
                  evidenceType: ref.evidenceType ?? null,
                  confidence: ref.confidence ?? null,
                })),
        }
      : null;
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
      new Set([decision.id, ...(enrichedIntervention?.decisionIds ?? [])].filter(Boolean))
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
    enrichedIntervention?.blockerReason ||
    decision.title;
  const summarySuffix = [
    enrichedIntervention?.waitingOn ? `Waiting on ${enrichedIntervention.waitingOn}.` : null,
    enrichedIntervention?.requiredAction ? `Required action: ${enrichedIntervention.requiredAction}.` : null,
  ]
    .filter((entry): entry is string => Boolean(entry))
    .join(" ");
  const summary = summarySuffix.length > 0 ? `${summaryBase} ${summarySuffix}` : summaryBase;
  const recommendedAction =
    decision.recommendedAction ??
    enrichedIntervention?.recommendedAction ??
    enrichedIntervention?.requiredAction ??
    null;

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
    intervention: enrichedIntervention,
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
