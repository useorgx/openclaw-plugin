import type { LiveActivityItem, LiveActivityType, SessionTreeNode } from "../../types.js";
import type { RuntimeInstanceRecord } from "../../runtime-instance-store.js";
import { asRecord } from "../../lib/type-coercion.js";

export type SliceRunLifecycleState =
  | "queued"
  | "dispatching"
  | "running"
  | "awaiting_input"
  | "completed"
  | "needs_review"
  | "failed"
  | "archived";

export type SliceRunPrimaryAction =
  | "none"
  | "open_artifact"
  | "resolve_decision"
  | "retry_slice"
  | "review_output";

export type SliceRunArtifactSummary = {
  id: string | null;
  type: string | null;
  title: string;
  url: string | null;
  createdAt: string | null;
};

export type SliceRunDecisionOption = {
  id: string;
  label: string;
  description: string | null;
  impliedStatus: string | null;
  requiresNote: boolean;
};

export type SliceRunPendingDecision = {
  id: string;
  title: string;
  summary: string | null;
  status: string;
  blocking: boolean;
  decisionType: string | null;
  recommendedAction: string | null;
  updatedAt: string | null;
  sourceRunId: string | null;
  sourceClient: string | null;
  evidenceCount: number;
  options: SliceRunDecisionOption[];
};

export type SliceRunBlockerSummary = {
  id: string;
  reason: string;
  waitingOn: string | null;
  requiredAction: string | null;
  source: string | null;
  eventType: string | null;
  eventAt: string | null;
  severity: "info" | "warn" | "error";
  decisionIds: string[];
};

export type SliceRunProjection = {
  id: string;
  sliceRunId: string;
  runId: string | null;
  initiativeId: string | null;
  initiativeIds?: string[];
  workstreamId: string | null;
  workstreamIds?: string[];
  iwmtId: string | null;
  iwmtIds?: string[];
  workstreamTitle: string | null;
  taskIds: string[];
  milestoneIds: string[];
  status: SliceRunLifecycleState;
  statusExplainer: string;
  primaryAction: SliceRunPrimaryAction;
  hasArtifact: boolean;
  artifactCount: number;
  artifacts: SliceRunArtifactSummary[];
  decisionCount: number;
  blockingDecisionCount: number;
  decisionOptions: SliceRunDecisionOption[];
  pendingDecisions: SliceRunPendingDecision[];
  blockers: SliceRunBlockerSummary[];
  sourceClient: string | null;
  runtimeState: string | null;
  startedAt: string | null;
  updatedAt: string | null;
  completedAt: string | null;
  failedAt: string | null;
  archivedAt: string | null;
  lastEventAt: string | null;
  lastEventSummary: string | null;
  correlationId: string | null;
  confidence: "low" | "medium" | "high";
  scope?: "task" | "milestone" | "workstream";
  scopeMilestoneIds?: string[];
  scopeProgress?: {
    totalTasks: number;
    completedTasks: number;
    milestones?: Array<{ id: string; title: string; total: number; done: number }>;
  };
};

type BuildSliceRunProjectionsInput = {
  activity: LiveActivityItem[];
  sessions: SessionTreeNode[];
  decisions: Array<Record<string, unknown>>;
  runtimeInstances: RuntimeInstanceRecord[];
};

type MutableSliceRunProjection = SliceRunProjection & {
  _terminal: boolean;
  _statusUpdatedEpoch: number;
  _updatedEpoch: number;
  _artifactIds: Set<string>;
  _hasExplicitCompletion: boolean;
  _peakReportedArtifacts: number;
  _pendingDecisionById: Map<string, SliceRunPendingDecision>;
  _blockerByKey: Map<string, SliceRunBlockerSummary>;
};

const TERMINAL_STATES = new Set<SliceRunLifecycleState>([
  "completed",
  "needs_review",
  "failed",
  "archived",
]);

const RUN_LIKE_STATUS = new Set<SliceRunLifecycleState>(["dispatching", "running"]);

// asRecord imported from ../../lib/type-coercion.js

function normalizeText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function toIso(value: string | null | undefined): string | null {
  if (!value) return null;
  const epoch = Date.parse(value);
  if (!Number.isFinite(epoch)) return null;
  return new Date(epoch).toISOString();
}

function toEpoch(value: string | null | undefined): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function metadataString(
  metadata: Record<string, unknown> | null,
  keys: string[]
): string | null {
  if (!metadata) return null;
  for (const key of keys) {
    const value = normalizeText(metadata[key]);
    if (value) return value;
  }
  return null;
}

function metadataNumber(
  metadata: Record<string, unknown> | null,
  keys: string[]
): number | null {
  if (!metadata) return null;
  for (const key of keys) {
    const raw = metadata[key];
    if (typeof raw === "number" && Number.isFinite(raw)) return raw;
    if (typeof raw === "string") {
      const parsed = Number(raw);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return null;
}

function metadataBoolean(
  metadata: Record<string, unknown> | null,
  keys: string[]
): boolean | null {
  if (!metadata) return null;
  for (const key of keys) {
    const raw = metadata[key];
    if (typeof raw === "boolean") return raw;
    if (typeof raw === "string") {
      const normalized = raw.trim().toLowerCase();
      if (normalized === "true") return true;
      if (normalized === "false") return false;
    }
  }
  return null;
}

function metadataStringArray(
  metadata: Record<string, unknown> | null,
  keys: string[]
): string[] {
  if (!metadata) return [];
  for (const key of keys) {
    const raw = metadata[key];
    if (Array.isArray(raw)) {
      return dedupeStrings(
        raw
          .map((entry) => normalizeText(entry))
          .filter((entry): entry is string => Boolean(entry))
      );
    }
    if (typeof raw === "string") {
      return dedupeStrings(
        raw
          .split(/[\n,;]+/g)
          .map((entry) => entry.trim())
          .filter(Boolean)
      );
    }
  }
  return [];
}

function dedupeStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const value of values) {
    const normalized = value.trim();
    if (!normalized) continue;
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(normalized);
  }
  return output;
}

function mergeScopedIds(
  existing: string[] | undefined,
  scalar: string | null | undefined,
  additions: string[]
): string[] {
  const merged = dedupeStrings([
    ...(Array.isArray(existing) ? existing : []),
    ...(scalar ? [scalar] : []),
    ...additions,
  ]);
  return merged;
}

function resolveEventName(metadata: Record<string, unknown> | null): string {
  const fromMeta = metadataString(metadata, ["event"]);
  if (fromMeta) return fromMeta.toLowerCase();
  return "";
}

function resolveSliceRunId(item: LiveActivityItem, metadata: Record<string, unknown> | null): string | null {
  const direct = metadataString(metadata, [
    "slice_run_id",
    "sliceRunId",
    "active_run_id",
    "activeRunId",
    "run_id",
    "runId",
    "correlation_id",
    "correlationId",
  ]);
  if (direct) return direct;
  if (item.runId && item.runId.trim().length > 0) return item.runId.trim();
  return null;
}

function resolveDecisionSliceRunId(
  decision: Record<string, unknown>,
  metadata: Record<string, unknown> | null
): string | null {
  return (
    metadataString(metadata, ["slice_run_id", "sliceRunId", "run_id", "runId", "correlation_id", "correlationId"]) ??
    normalizeText(decision.runId) ??
    normalizeText(decision.run_id) ??
    normalizeText(decision.correlationId) ??
    normalizeText(decision.correlation_id) ??
    null
  );
}

function resolveCorrelationId(
  item: LiveActivityItem,
  metadata: Record<string, unknown> | null
): string | null {
  return (
    metadataString(metadata, ["correlation_id", "correlationId"]) ??
    metadataString(metadata, ["run_id", "runId"]) ??
    item.runId ??
    null
  );
}

/**
 * Determines whether an activity item is relevant to slice run projections.
 * Every LiveActivityType variant MUST be handled explicitly to prevent
 * silent gaps (like the run_completed bug where accepts were ignored).
 */
function resolveRelevantActivity(
  item: LiveActivityItem,
  event: string,
  metadata: Record<string, unknown> | null,
  knownSliceIds: Set<string>
): boolean {
  // Event-name based relevance (metadata.event prefix matches)
  if (event.startsWith("autopilot_slice_")) return true;
  if (event.startsWith("auto_continue_spawn_guard_")) return true;
  if (event === "next_up_manual_dispatch_started") return true;
  if (event === "auto_continue_stopped") return true;

  // Type-based relevance — exhaustive over LiveActivityType
  const type: LiveActivityType = item.type;
  switch (type) {
    case "artifact_created": {
      const source = metadataString(metadata, ["source"]);
      if ((source ?? "").toLowerCase() === "autopilot_slice") return true;
      const runId = resolveSliceRunId(item, metadata);
      return Boolean(runId && knownSliceIds.has(runId));
    }
    case "decision_requested":
    case "decision_resolved":
    case "run_completed":
    case "run_failed":
    case "run_started":
    case "delegation":
    case "milestone_completed":
    case "blocker_created": {
      const runId = resolveSliceRunId(item, metadata);
      return Boolean(runId && knownSliceIds.has(runId));
    }
    case "handoff_requested":
    case "handoff_claimed":
    case "handoff_fulfilled":
      // Handoff types are not relevant to slice projections today
      return false;
    default: {
      // Exhaustiveness guard: if a new LiveActivityType is added and not
      // handled above, this will be a compile error.
      const _exhaustive: never = type;
      void _exhaustive;
      return false;
    }
  }
}

function defaultExplainer(status: SliceRunLifecycleState): string {
  switch (status) {
    case "queued":
      return "Queued and waiting to dispatch.";
    case "dispatching":
      return "Dispatch acknowledged. Waiting for runtime start.";
    case "running":
      return "Work is actively executing.";
    case "awaiting_input":
      return "Needs your input to proceed.";
    case "completed":
      return "Completed with verified output artifacts.";
    case "needs_review":
      return "Completed signal received without verifiable output.";
    case "failed":
      return "Execution failed before producing a valid result.";
    case "archived":
      return "Archived due to missing execution evidence.";
    default:
      return "Status unavailable.";
  }
}

function defaultPrimaryAction(status: SliceRunLifecycleState): SliceRunPrimaryAction {
  switch (status) {
    case "completed":
      return "open_artifact";
    case "awaiting_input":
      return "resolve_decision";
    case "needs_review":
      return "review_output";
    case "failed":
      return "retry_slice";
    default:
      return "none";
  }
}

function createProjection(sliceRunId: string): MutableSliceRunProjection {
  return {
    id: sliceRunId,
    sliceRunId,
    runId: sliceRunId,
    initiativeId: null,
    initiativeIds: [],
    workstreamId: null,
    workstreamIds: [],
    iwmtId: null,
    iwmtIds: [],
    workstreamTitle: null,
    taskIds: [],
    milestoneIds: [],
    status: "queued",
    statusExplainer: defaultExplainer("queued"),
    primaryAction: defaultPrimaryAction("queued"),
    hasArtifact: false,
    artifactCount: 0,
    artifacts: [],
    decisionCount: 0,
    blockingDecisionCount: 0,
    decisionOptions: [],
    pendingDecisions: [],
    blockers: [],
    sourceClient: null,
    runtimeState: null,
    startedAt: null,
    updatedAt: null,
    completedAt: null,
    failedAt: null,
    archivedAt: null,
    lastEventAt: null,
    lastEventSummary: null,
    correlationId: null,
    confidence: "low",
    _terminal: false,
    _statusUpdatedEpoch: 0,
    _updatedEpoch: 0,
    _artifactIds: new Set<string>(),
    _hasExplicitCompletion: false,
    _peakReportedArtifacts: 0,
    _pendingDecisionById: new Map<string, SliceRunPendingDecision>(),
    _blockerByKey: new Map<string, SliceRunBlockerSummary>(),
  };
}

function upsertProjection(
  map: Map<string, MutableSliceRunProjection>,
  sliceRunId: string
): MutableSliceRunProjection {
  const existing = map.get(sliceRunId);
  if (existing) return existing;
  const created = createProjection(sliceRunId);
  map.set(sliceRunId, created);
  return created;
}

function setStatus(input: {
  projection: MutableSliceRunProjection;
  status: SliceRunLifecycleState;
  atIso: string | null;
  explainer?: string | null;
  force?: boolean;
}): void {
  const atEpoch = toEpoch(input.atIso);
  const nextTerminal = TERMINAL_STATES.has(input.status);
  const currentTerminal = input.projection._terminal;

  if (currentTerminal && !nextTerminal && !input.force) {
    return;
  }
  if (!input.force && atEpoch > 0 && atEpoch < input.projection._statusUpdatedEpoch) {
    return;
  }

  input.projection.status = input.status;
  input.projection._statusUpdatedEpoch = atEpoch;
  input.projection._terminal = nextTerminal;

  if (input.explainer && input.explainer.trim().length > 0) {
    input.projection.statusExplainer = input.explainer.trim();
  } else if (!input.projection.statusExplainer || input.projection.statusExplainer.trim().length === 0) {
    input.projection.statusExplainer = defaultExplainer(input.status);
  }

  input.projection.primaryAction = defaultPrimaryAction(input.status);

  if (input.status === "completed") {
    input.projection.completedAt = input.atIso ?? input.projection.completedAt;
    input.projection.failedAt = null;
    input.projection.archivedAt = null;
  }
  if (input.status === "failed") {
    input.projection.failedAt = input.atIso ?? input.projection.failedAt;
  }
  if (input.status === "archived") {
    input.projection.archivedAt = input.atIso ?? input.projection.archivedAt;
  }
}

function updateProjectionContext(
  projection: MutableSliceRunProjection,
  item: LiveActivityItem,
  metadata: Record<string, unknown> | null
): void {
  const initiativeIdFromMetadata = metadataString(metadata, [
    "initiative_id",
    "initiativeId",
  ]);
  const initiativeIds = mergeScopedIds(
    projection.initiativeIds,
    projection.initiativeId,
    [
      ...(item.initiativeId ? [item.initiativeId] : []),
      ...metadataStringArray(metadata, ["initiative_ids", "initiativeIds"]),
      ...(initiativeIdFromMetadata ? [initiativeIdFromMetadata] : []),
    ].filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
  );
  projection.initiativeIds = initiativeIds;
  projection.initiativeId = projection.initiativeId ?? initiativeIds[0] ?? null;

  const workstreamIdFromMetadata = metadataString(metadata, [
    "workstream_id",
    "workstreamId",
  ]);
  const workstreamIds = mergeScopedIds(
    projection.workstreamIds,
    projection.workstreamId,
    [
      ...metadataStringArray(metadata, ["workstream_ids", "workstreamIds"]),
      ...(workstreamIdFromMetadata ? [workstreamIdFromMetadata] : []),
    ].filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
  );
  projection.workstreamIds = workstreamIds;
  projection.workstreamId = projection.workstreamId ?? workstreamIds[0] ?? null;

  const iwmtIdFromMetadata = metadataString(metadata, ["iwmt_id", "iwmtId"]);
  const iwmtIds = mergeScopedIds(
    projection.iwmtIds,
    projection.iwmtId,
    [
      ...metadataStringArray(metadata, ["iwmt_ids", "iwmtIds"]),
      ...(iwmtIdFromMetadata ? [iwmtIdFromMetadata] : []),
    ].filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
  );
  projection.iwmtIds = iwmtIds;
  projection.iwmtId = projection.iwmtId ?? iwmtIds[0] ?? null;

  projection.workstreamTitle =
    projection.workstreamTitle ??
    metadataString(metadata, ["workstream_title", "workstreamTitle"]);

  const taskIds = metadataStringArray(metadata, ["task_ids", "taskIds", "active_task_ids", "activeTaskIds"]);
  if (taskIds.length > 0) {
    projection.taskIds = dedupeStrings([...projection.taskIds, ...taskIds]);
  }
  const milestoneIds = metadataStringArray(metadata, ["milestone_ids", "milestoneIds"]);
  if (milestoneIds.length > 0) {
    projection.milestoneIds = dedupeStrings([...projection.milestoneIds, ...milestoneIds]);
  }

  projection.correlationId = projection.correlationId ?? resolveCorrelationId(item, metadata);
  projection.sourceClient =
    projection.sourceClient ??
    metadataString(metadata, ["source_client", "sourceClient", "runtime_source"]);

  const eventAt = toIso(item.timestamp);
  const eventEpoch = toEpoch(eventAt);
  if (eventEpoch >= projection._updatedEpoch) {
    projection._updatedEpoch = eventEpoch;
    projection.updatedAt = eventAt;
    projection.lastEventAt = eventAt;
    projection.lastEventSummary =
      (item.summary && item.summary.trim().length > 0
        ? item.summary.trim()
        : item.description && item.description.trim().length > 0
          ? item.description.trim()
          : item.title) ?? projection.lastEventSummary;
  }
}

function maybeAddArtifact(
  projection: MutableSliceRunProjection,
  item: LiveActivityItem,
  metadata: Record<string, unknown> | null
): void {
  const artifactId = metadataString(metadata, ["artifact_id", "artifactId"]);
  const dedupeKey = artifactId ?? `${item.id}:artifact`;
  if (projection._artifactIds.has(dedupeKey)) return;
  projection._artifactIds.add(dedupeKey);

  const artifact: SliceRunArtifactSummary = {
    id: artifactId,
    type: metadataString(metadata, ["artifact_type", "artifactType"]),
    title: (item.title ?? "Artifact").trim() || "Artifact",
    url: metadataString(metadata, ["url", "artifact_url", "artifactUrl"]),
    createdAt: toIso(item.timestamp),
  };
  projection.artifacts = projection.artifacts.concat(artifact).slice(-20);
  projection.artifactCount = projection._artifactIds.size;
  projection.hasArtifact = projection.artifactCount > 0;
  if (projection.status === "needs_review") {
    setStatus({
      projection,
      status: "completed",
      atIso: artifact.createdAt,
      explainer: "Artifact evidence was recorded after completion.",
      force: true,
    });
  }
}

function mergeDecisionOptions(
  projection: MutableSliceRunProjection,
  optionsRaw: unknown
): void {
  if (!Array.isArray(optionsRaw)) return;
  const next = parseDecisionOptions(optionsRaw);
  if (next.length === 0) return;
  const merged = new Map<string, SliceRunDecisionOption>();
  for (const option of projection.decisionOptions) merged.set(option.id, option);
  for (const option of next) merged.set(option.id, option);
  projection.decisionOptions = Array.from(merged.values()).slice(0, 8);
}

function parseDecisionOptions(optionsRaw: unknown): SliceRunDecisionOption[] {
  if (!Array.isArray(optionsRaw)) return [];
  const next: SliceRunDecisionOption[] = [];
  for (const option of optionsRaw) {
    const record = asRecord(option);
    if (!record) continue;
    const id = normalizeText(record.id) ?? normalizeText(record.option_id) ?? null;
    const label = normalizeText(record.label);
    if (!id || !label) continue;
    next.push({
      id,
      label,
      description: normalizeText(record.description),
      impliedStatus: normalizeText(record.impliedStatus ?? record.implied_status),
      requiresNote: metadataBoolean(record, ["requiresNote", "requires_note"]) ?? false,
    });
  }
  return next;
}

function extractDecisionIdsFromMetadata(metadata: Record<string, unknown> | null): string[] {
  if (!metadata) return [];
  const ids = new Set<string>();
  for (const id of metadataStringArray(metadata, [
    "decision_id",
    "decisionId",
    "decision_ids",
    "decisionIds",
    "blocking_decision_ids",
    "blockingDecisionIds",
    "non_blocking_decision_ids",
    "nonBlockingDecisionIds",
  ])) {
    ids.add(id);
  }
  const decisionsNeededRaw = metadata.decisions_needed ?? metadata.decisionsNeeded;
  if (Array.isArray(decisionsNeededRaw)) {
    for (const item of decisionsNeededRaw) {
      const record = asRecord(item);
      if (!record) continue;
      const directId =
        normalizeText(record.id) ??
        normalizeText(record.decision_id) ??
        normalizeText(record.decisionId);
      if (directId) ids.add(directId);
    }
  }
  return Array.from(ids);
}

function normalizePendingDecisionStatus(value: string | null): string {
  return (value ?? "pending").trim().toLowerCase() || "pending";
}

function isDecisionResolvedStatus(status: string): boolean {
  return (
    status === "approved" ||
    status === "declined" ||
    status === "cancelled" ||
    status === "resolved" ||
    status === "closed"
  );
}

function upsertPendingDecision(
  projection: MutableSliceRunProjection,
  decisionRecord: Record<string, unknown>,
  metadata: Record<string, unknown> | null
): void {
  const decisionId =
    normalizeText(decisionRecord.id) ??
    normalizeText(decisionRecord.decision_id) ??
    normalizeText(decisionRecord.entity_id);
  if (!decisionId) return;

  const status = normalizePendingDecisionStatus(normalizeText(decisionRecord.status));
  if (isDecisionResolvedStatus(status)) {
    projection._pendingDecisionById.delete(decisionId);
    return;
  }

  const options = parseDecisionOptions(
    decisionRecord.options ??
      decisionRecord.decision_options ??
      metadata?.options ??
      metadata?.decision_options
  );
  if (options.length > 0) {
    mergeDecisionOptions(projection, options);
  }

  const evidenceGroup =
    decisionRecord.evidenceRefs ??
    decisionRecord.evidence_refs ??
    metadata?.evidence_refs ??
    metadata?.decision_evidence;
  const evidenceCount = Array.isArray(evidenceGroup) ? evidenceGroup.length : 0;

  const updatedAt =
    toIso(normalizeText(decisionRecord.updatedAt)) ??
    toIso(normalizeText(decisionRecord.updated_at)) ??
    toIso(normalizeText(decisionRecord.requestedAt)) ??
    toIso(normalizeText(decisionRecord.requested_at)) ??
    projection.updatedAt;

  projection._pendingDecisionById.set(decisionId, {
    id: decisionId,
    title:
      normalizeText(decisionRecord.title) ??
      normalizeText(decisionRecord.name) ??
      "Pending decision",
    summary:
      normalizeText(decisionRecord.context) ??
      normalizeText(decisionRecord.summary) ??
      normalizeText(decisionRecord.description) ??
      normalizeText(metadata?.summary) ??
      null,
    status,
    blocking: metadataBoolean(metadata, ["blocking"]) !== false,
    decisionType:
      normalizeText(decisionRecord.decisionType) ??
      normalizeText(decisionRecord.decision_type) ??
      normalizeText(metadata?.decision_type) ??
      null,
    recommendedAction:
      normalizeText(decisionRecord.recommendedAction) ??
      normalizeText(decisionRecord.recommended_action) ??
      normalizeText(metadata?.recommended_action) ??
      null,
    updatedAt,
    sourceRunId:
      normalizeText(decisionRecord.sourceRunId) ??
      normalizeText(decisionRecord.source_run_id) ??
      normalizeText(metadata?.source_run_id) ??
      normalizeText(metadata?.run_id) ??
      normalizeText(metadata?.correlation_id) ??
      null,
    sourceClient:
      normalizeText(decisionRecord.sourceClient) ??
      normalizeText(decisionRecord.source_client) ??
      normalizeText(metadata?.source_client) ??
      null,
    evidenceCount,
    options: options.slice(0, 4),
  });
}

function inferBlockerFromActivity(
  item: LiveActivityItem,
  metadata: Record<string, unknown> | null,
  event: string,
  atIso: string | null
): SliceRunBlockerSummary | null {
  const blocker = asRecord(metadata?.blocker);
  const reason =
    normalizeText(blocker?.description) ??
    normalizeText(blocker?.summary) ??
    metadataString(metadata, ["error", "reason", "blocked_reason", "blockedReason", "last_error", "lastError"]) ??
    normalizeText(item.summary) ??
    normalizeText(item.description) ??
    null;
  if (!reason) return null;

  const waitingOn =
    normalizeText(blocker?.waiting_on) ??
    normalizeText(blocker?.required_actor) ??
    metadataString(metadata, ["waiting_on", "required_actor", "requiredActor"]) ??
    null;
  const requiredAction =
    normalizeText(blocker?.required_action) ??
    normalizeText(blocker?.requiredAction) ??
    metadataString(metadata, ["next_step", "nextStep", "recommended_action", "recommendedAction"]) ??
    null;
  const source =
    metadataString(metadata, ["source", "source_system", "sourceSystem"]) ??
    null;
  const severity: "info" | "warn" | "error" =
    item.type === "run_failed" || event.includes("failed") || event.includes("error")
      ? "error"
      : item.type === "blocker_created" || event.includes("blocked")
        ? "warn"
        : "info";
  const decisionIds = extractDecisionIdsFromMetadata(metadata);

  return {
    id: normalizeText(item.id) ?? `${event || item.type}:${atIso ?? "unknown"}`,
    reason,
    waitingOn,
    requiredAction,
    source,
    eventType: event || item.type,
    eventAt: atIso,
    severity,
    decisionIds,
  };
}

function upsertBlocker(
  projection: MutableSliceRunProjection,
  blocker: SliceRunBlockerSummary
): void {
  const key = [
    blocker.reason.trim().toLowerCase(),
    blocker.waitingOn?.trim().toLowerCase() ?? "",
    blocker.requiredAction?.trim().toLowerCase() ?? "",
  ].join("|");
  const existing = projection._blockerByKey.get(key);
  if (!existing) {
    projection._blockerByKey.set(key, blocker);
    return;
  }
  const existingEpoch = toEpoch(existing.eventAt);
  const nextEpoch = toEpoch(blocker.eventAt);
  const keep = nextEpoch >= existingEpoch ? blocker : existing;
  keep.decisionIds = dedupeStrings([
    ...(existing.decisionIds ?? []),
    ...(blocker.decisionIds ?? []),
  ]);
  projection._blockerByKey.set(key, keep);
}

function applySessionFallback(
  projection: MutableSliceRunProjection,
  session: SessionTreeNode
): void {
  const status = (session.status ?? "").trim().toLowerCase();
  const updatedAt = toIso(session.updatedAt ?? session.lastEventAt ?? session.startedAt);
  projection.initiativeIds = mergeScopedIds(
    projection.initiativeIds,
    projection.initiativeId,
    session.initiativeId ? [session.initiativeId] : []
  );
  projection.workstreamIds = mergeScopedIds(
    projection.workstreamIds,
    projection.workstreamId,
    session.workstreamId ? [session.workstreamId] : []
  );
  projection.initiativeId = projection.initiativeId ?? projection.initiativeIds[0] ?? null;
  projection.workstreamId = projection.workstreamId ?? projection.workstreamIds[0] ?? null;

  if (RUN_LIKE_STATUS.has(projection.status)) {
    if (!projection.workstreamId && session.workstreamId) projection.workstreamId = session.workstreamId;
    if (!projection.workstreamTitle && session.title) projection.workstreamTitle = session.title;
    if (!projection.initiativeId && session.initiativeId) projection.initiativeId = session.initiativeId;
  }

  if (status === "failed") {
    setStatus({
      projection,
      status: "failed",
      atIso: updatedAt,
      explainer: session.lastEventSummary ?? null,
      force: true,
    });
    return;
  }
  if (status === "blocked") {
    setStatus({
      projection,
      status: "awaiting_input",
      atIso: updatedAt,
      explainer: session.blockerReason ?? session.lastEventSummary ?? null,
      force: projection.status !== "completed",
    });
    return;
  }
  if (status === "completed" && projection.status !== "completed" && projection.hasArtifact) {
    setStatus({
      projection,
      status: "completed",
      atIso: updatedAt,
      explainer: session.lastEventSummary ?? null,
      force: true,
    });
  }
}

export function buildSliceRunProjections(
  input: BuildSliceRunProjectionsInput
): SliceRunProjection[] {
  const projections = new Map<string, MutableSliceRunProjection>();

  const knownSliceIds = new Set<string>();
  for (const item of input.activity) {
    const metadata = asRecord(item.metadata);
    const event = resolveEventName(metadata);
    const sliceRunId = resolveSliceRunId(item, metadata);
    if (!sliceRunId) continue;
    if (event.startsWith("autopilot_slice_") || event.startsWith("auto_continue_spawn_guard_") || event === "next_up_manual_dispatch_started") {
      knownSliceIds.add(sliceRunId);
    }
  }

  const ordered = [...input.activity].sort(
    (a, b) => toEpoch(a.timestamp) - toEpoch(b.timestamp)
  );

  for (const item of ordered) {
    const metadata = asRecord(item.metadata);
    const event = resolveEventName(metadata);
    const sliceRunId = resolveSliceRunId(item, metadata);
    if (!sliceRunId) continue;

    if (!resolveRelevantActivity(item, event, metadata, knownSliceIds)) {
      continue;
    }

    const projection = upsertProjection(projections, sliceRunId);
    updateProjectionContext(projection, item, metadata);

    const atIso = toIso(item.timestamp);
    const blockerFromEvent = inferBlockerFromActivity(item, metadata, event, atIso);
    if (blockerFromEvent) {
      upsertBlocker(projection, blockerFromEvent);
    }

    if (item.type === "artifact_created") {
      maybeAddArtifact(projection, item, metadata);
      if (projection.status !== "failed" && projection.status !== "archived") {
        setStatus({
          projection,
          status: "completed",
          atIso,
          explainer: "Artifact generated and attached.",
          force: projection.status !== "completed",
        });
      }
      continue;
    }

    if (event === "autopilot_slice_dispatched" || event === "next_up_manual_dispatch_started") {
      setStatus({ projection, status: "dispatching", atIso, explainer: item.summary ?? null });
      projection.startedAt = projection.startedAt ?? atIso;
      continue;
    }

    if (event === "autopilot_slice_started" || event === "autopilot_slice_heartbeat") {
      setStatus({ projection, status: "running", atIso, explainer: item.summary ?? null });
      projection.startedAt = projection.startedAt ?? atIso;
      continue;
    }

    if (
      event === "autopilot_slice_mcp_handshake_failed" ||
      event === "autopilot_slice_timeout" ||
      event === "autopilot_slice_log_stall" ||
      event === "auto_continue_spawn_guard_blocked"
    ) {
      setStatus({
        projection,
        status: "awaiting_input",
        atIso,
        explainer: item.summary ?? item.description ?? "Needs intervention to continue.",
        force: true,
      });
      continue;
    }

    if (event === "autopilot_slice_finished" || event === "autopilot_slice_result") {
      const parsedStatus = (
        metadataString(metadata, ["parsed_status", "status"]) ?? ""
      ).toLowerCase();
      const reportedArtifacts = Math.max(
        0,
        Math.floor(metadataNumber(metadata, ["artifacts"]) ?? 0)
      );
      projection._peakReportedArtifacts = Math.max(
        projection._peakReportedArtifacts,
        reportedArtifacts,
      );
      projection.decisionCount = Math.max(
        projection.decisionCount,
        Math.max(0, Math.floor(metadataNumber(metadata, ["decisions"]) ?? 0))
      );
      projection.blockingDecisionCount = Math.max(
        projection.blockingDecisionCount,
        Math.max(0, Math.floor(metadataNumber(metadata, ["blocking_decisions"]) ?? 0))
      );

      if (parsedStatus === "error") {
        setStatus({
          projection,
          status: "failed",
          atIso,
          explainer: item.summary ?? item.description ?? item.title,
          force: true,
        });
        continue;
      }

      if (parsedStatus === "blocked" || parsedStatus === "needs_decision") {
        setStatus({
          projection,
          status: "awaiting_input",
          atIso,
          explainer: item.summary ?? item.description ?? "Needs decision before it can continue.",
          force: true,
        });
        continue;
      }

      const effectiveArtifactCount = Math.max(projection.artifactCount, reportedArtifacts);
      if (effectiveArtifactCount > 0) {
        projection.artifactCount = effectiveArtifactCount;
        projection.hasArtifact = true;
        setStatus({
          projection,
          status: "completed",
          atIso,
          explainer: item.summary ?? defaultExplainer("completed"),
          force: true,
        });
      } else {
        setStatus({
          projection,
          status: "needs_review",
          atIso,
          explainer:
            item.summary ??
            "Reported completion without artifact evidence. Review output before closing.",
          force: true,
        });
      }
      continue;
    }

    if (event === "auto_continue_stopped") {
      const stopReason = (metadataString(metadata, ["stop_reason", "stopReason"]) ?? "").toLowerCase();
      if (stopReason === "error") {
        setStatus({
          projection,
          status: "failed",
          atIso,
          explainer: item.summary ?? item.description ?? defaultExplainer("failed"),
          force: true,
        });
      } else if (stopReason === "blocked" || stopReason === "budget_exhausted") {
        setStatus({
          projection,
          status: "awaiting_input",
          atIso,
          explainer: item.summary ?? item.description ?? defaultExplainer("awaiting_input"),
          force: true,
        });
      } else if (stopReason === "completed") {
        if (projection.hasArtifact) {
          setStatus({
            projection,
            status: "completed",
            atIso,
            explainer: item.summary ?? defaultExplainer("completed"),
            force: true,
          });
        } else {
          setStatus({
            projection,
            status: "needs_review",
            atIso,
            explainer: item.summary ?? defaultExplainer("needs_review"),
            force: true,
          });
        }
      }
      continue;
    }

    if (item.type === "run_completed") {
      projection._hasExplicitCompletion = true;
      setStatus({
        projection,
        status: "completed",
        atIso,
        explainer: item.summary ?? item.description ?? "Accepted and marked complete.",
        force: true,
      });
      continue;
    }

    if (item.type === "run_failed") {
      setStatus({
        projection,
        status: "failed",
        atIso,
        explainer: item.summary ?? item.description ?? item.title,
        force: true,
      });
      continue;
    }

    if (item.type === "decision_requested") {
      setStatus({
        projection,
        status: "awaiting_input",
        atIso,
        explainer: item.summary ?? item.description ?? "Awaiting decision.",
      });
      continue;
    }

    if (item.type === "decision_resolved") {
      // Decision resolved may unblock a slice — revert to running if currently awaiting
      if (projection.status === "awaiting_input") {
        setStatus({
          projection,
          status: "running",
          atIso,
          explainer: item.summary ?? "Decision resolved. Resuming.",
        });
      }
      continue;
    }

    if (item.type === "milestone_completed") {
      // Milestone completions update context but don't change slice status
      continue;
    }

    if (item.type === "blocker_created") {
      setStatus({
        projection,
        status: "awaiting_input",
        atIso,
        explainer: item.summary ?? item.description ?? "Blocker raised.",
      });
      continue;
    }

    if (item.type === "run_started" || item.type === "delegation") {
      setStatus({
        projection,
        status: "running",
        atIso,
        explainer: item.summary ?? item.description ?? defaultExplainer("running"),
      });
      projection.startedAt = projection.startedAt ?? atIso;
      continue;
    }

    // Handoff types — no slice status change
    if (
      item.type === "handoff_requested" ||
      item.type === "handoff_claimed" ||
      item.type === "handoff_fulfilled"
    ) {
      continue;
    }

    // Exhaustiveness guard: compile error if a new LiveActivityType is
    // added without being handled in this loop.
    const _exhaustiveType: never = item.type;
    void _exhaustiveType;
  }

  for (const decision of input.decisions) {
    const decisionRecord = asRecord(decision);
    const metadata = asRecord(decisionRecord?.metadata);
    const sliceRunId = decisionRecord
      ? resolveDecisionSliceRunId(decisionRecord, metadata)
      : null;
    if (!sliceRunId) continue;
    const projection = projections.get(sliceRunId);
    if (!projection) continue;

    const status = (normalizeText(decisionRecord?.status) ?? "pending").toLowerCase();
    if (decisionRecord) {
      upsertPendingDecision(projection, decisionRecord, metadata);
    }
    if (isDecisionResolvedStatus(status)) continue;

    projection.decisionCount += 1;
    const isBlocking = metadataBoolean(metadata, ["blocking"]) !== false;
    if (isBlocking) projection.blockingDecisionCount += 1;
    mergeDecisionOptions(
      projection,
      decisionRecord?.options ??
        decisionRecord?.decision_options ??
        metadata?.options ??
        metadata?.decision_options ??
        null
    );

    const updatedAt =
      toIso(normalizeText(decisionRecord?.updatedAt)) ??
      toIso(normalizeText(decisionRecord?.requestedAt)) ??
      projection.updatedAt;

    setStatus({
      projection,
      status: "awaiting_input",
      atIso: updatedAt,
      explainer: normalizeText(decisionRecord?.title) ?? "Pending decision requires input.",
      force: projection.status !== "failed",
    });
  }

  for (const session of input.sessions) {
    const runId = normalizeText(session.runId);
    if (!runId) continue;
    const projection = projections.get(runId);
    if (!projection) continue;
    applySessionFallback(projection, session);
  }

  for (const runtime of input.runtimeInstances) {
    const runId = normalizeText(runtime.runId ?? runtime.correlationId);
    if (!runId) continue;
    const projection = projections.get(runId);
    if (!projection) continue;

    projection.initiativeIds = mergeScopedIds(
      projection.initiativeIds,
      projection.initiativeId,
      runtime.initiativeId ? [runtime.initiativeId] : []
    );
    projection.workstreamIds = mergeScopedIds(
      projection.workstreamIds,
      projection.workstreamId,
      runtime.workstreamId ? [runtime.workstreamId] : []
    );
    projection.initiativeId = projection.initiativeId ?? projection.initiativeIds[0] ?? null;
    projection.workstreamId = projection.workstreamId ?? projection.workstreamIds[0] ?? null;

    projection.runtimeState = runtime.state;
    if (runtime.state === "error" && projection.status !== "failed") {
      setStatus({
        projection,
        status: "failed",
        atIso: runtime.lastEventAt,
        explainer: runtime.lastMessage ?? defaultExplainer("failed"),
        force: true,
      });
    }
    if (runtime.state === "active" && (projection.status === "dispatching" || projection.status === "queued")) {
      setStatus({
        projection,
        status: "running",
        atIso: runtime.lastHeartbeatAt ?? runtime.lastEventAt,
        explainer: projection.lastEventSummary ?? defaultExplainer("running"),
      });
      projection.startedAt = projection.startedAt ?? toIso(runtime.lastEventAt);
    }
  }

  const nowEpoch = Date.now();
  const output: SliceRunProjection[] = [];

  for (const projection of projections.values()) {
    if (
      projection.status === "completed" &&
      !projection.hasArtifact &&
      !projection._hasExplicitCompletion &&
      projection._peakReportedArtifacts === 0
    ) {
      setStatus({
        projection,
        status: "needs_review",
        atIso: projection.updatedAt,
        explainer: "Completed without artifacts; review before closing.",
        force: true,
      });
    }

    if (
      (projection.status === "queued" || projection.status === "dispatching" || projection.status === "running") &&
      projection.runtimeState === "stale" &&
      projection.artifactCount === 0
    ) {
      const ageMs = nowEpoch - toEpoch(projection.lastEventAt ?? projection.updatedAt);
      if (ageMs >= 6 * 60 * 60 * 1000) {
        setStatus({
          projection,
          status: "archived",
          atIso: projection.updatedAt,
          explainer: "No execution evidence found recently. Archived automatically.",
          force: true,
        });
      } else if (projection.status === "running") {
        projection.confidence = "medium";
      }
    }

    if (!projection.statusExplainer) {
      projection.statusExplainer = defaultExplainer(projection.status);
    }

    if (projection.status === "completed" && projection.hasArtifact) {
      projection.primaryAction = "open_artifact";
      projection.confidence = "high";
    } else if (projection.status === "awaiting_input") {
      projection.primaryAction = "resolve_decision";
      projection.confidence = "high";
    } else if (projection.status === "failed") {
      projection.primaryAction = "retry_slice";
      projection.confidence = "high";
    } else if (projection.status === "needs_review") {
      projection.primaryAction = "review_output";
      projection.confidence = projection.hasArtifact ? "high" : "medium";
    } else if (projection.status === "running" || projection.status === "dispatching") {
      projection.confidence = projection.runtimeState === "active" ? "high" : "medium";
    }

    output.push({
      id: projection.id,
      sliceRunId: projection.sliceRunId,
      runId: projection.runId,
      initiativeId: projection.initiativeId,
      initiativeIds: projection.initiativeIds,
      workstreamId: projection.workstreamId,
      workstreamIds: projection.workstreamIds,
      iwmtId: projection.iwmtId,
      iwmtIds: projection.iwmtIds,
      workstreamTitle: projection.workstreamTitle,
      taskIds: projection.taskIds,
      milestoneIds: projection.milestoneIds,
      status: projection.status,
      statusExplainer: projection.statusExplainer,
      primaryAction: projection.primaryAction,
      hasArtifact: projection.hasArtifact,
      artifactCount: projection.artifactCount,
      artifacts: projection.artifacts,
      decisionCount: projection.decisionCount,
      blockingDecisionCount: projection.blockingDecisionCount,
      decisionOptions: projection.decisionOptions,
      pendingDecisions: Array.from(projection._pendingDecisionById.values())
        .sort((a, b) => toEpoch(b.updatedAt) - toEpoch(a.updatedAt))
        .slice(0, 8),
      blockers: Array.from(projection._blockerByKey.values())
        .sort((a, b) => toEpoch(b.eventAt) - toEpoch(a.eventAt))
        .slice(0, 6),
      sourceClient: projection.sourceClient,
      runtimeState: projection.runtimeState,
      startedAt: projection.startedAt,
      updatedAt: projection.updatedAt,
      completedAt: projection.completedAt,
      failedAt: projection.failedAt,
      archivedAt: projection.archivedAt,
      lastEventAt: projection.lastEventAt,
      lastEventSummary: projection.lastEventSummary,
      correlationId: projection.correlationId,
      confidence: projection.confidence,
    });
  }

  output.sort((a, b) => {
    const updatedDelta = toEpoch(b.updatedAt ?? b.lastEventAt) - toEpoch(a.updatedAt ?? a.lastEventAt);
    if (updatedDelta !== 0) return updatedDelta;
    return a.sliceRunId.localeCompare(b.sliceRunId);
  });

  return output;
}
