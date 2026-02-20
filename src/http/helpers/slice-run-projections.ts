import type { LiveActivityItem, SessionTreeNode } from "../../types.js";
import type { RuntimeInstanceRecord } from "../../runtime-instance-store.js";

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
};

const TERMINAL_STATES = new Set<SliceRunLifecycleState>([
  "completed",
  "needs_review",
  "failed",
  "archived",
]);

const RUN_LIKE_STATUS = new Set<SliceRunLifecycleState>(["dispatching", "running"]);

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

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

function resolveRelevantActivity(
  item: LiveActivityItem,
  event: string,
  metadata: Record<string, unknown> | null,
  knownSliceIds: Set<string>
): boolean {
  if (event.startsWith("autopilot_slice_")) return true;
  if (event.startsWith("auto_continue_spawn_guard_")) return true;
  if (event === "next_up_manual_dispatch_started") return true;
  if (event === "auto_continue_stopped") return true;

  if (item.type === "artifact_created") {
    const source = metadataString(metadata, ["source"]);
    if ((source ?? "").toLowerCase() === "autopilot_slice") return true;
    const runId = resolveSliceRunId(item, metadata);
    return Boolean(runId && knownSliceIds.has(runId));
  }

  if (item.type === "decision_requested" || item.type === "decision_resolved") {
    const runId = resolveSliceRunId(item, metadata);
    return Boolean(runId && knownSliceIds.has(runId));
  }

  return false;
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
      requiresNote: Boolean(record.requiresNote ?? record.requires_note),
    });
  }
  if (next.length === 0) return;
  const merged = new Map<string, SliceRunDecisionOption>();
  for (const option of projection.decisionOptions) merged.set(option.id, option);
  for (const option of next) merged.set(option.id, option);
  projection.decisionOptions = Array.from(merged.values()).slice(0, 8);
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

    if (item.type === "run_started" || item.type === "delegation") {
      setStatus({
        projection,
        status: "running",
        atIso,
        explainer: item.summary ?? item.description ?? defaultExplainer("running"),
      });
      projection.startedAt = projection.startedAt ?? atIso;
    }
  }

  for (const decision of input.decisions) {
    const decisionRecord = asRecord(decision);
    const metadata = asRecord(decisionRecord?.metadata);
    const sliceRunId = metadataString(metadata, ["slice_run_id", "sliceRunId", "run_id", "runId", "correlation_id", "correlationId"]);
    if (!sliceRunId) continue;
    const projection = projections.get(sliceRunId);
    if (!projection) continue;

    const status = (normalizeText(decisionRecord?.status) ?? "pending").toLowerCase();
    if (status === "approved" || status === "declined" || status === "cancelled" || status === "resolved") {
      continue;
    }

    projection.decisionCount += 1;
    const isBlocking = metadataBoolean(metadata, ["blocking"]) !== false;
    if (isBlocking) projection.blockingDecisionCount += 1;
    mergeDecisionOptions(projection, decisionRecord?.options ?? null);

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
    if (projection.status === "completed" && !projection.hasArtifact) {
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
