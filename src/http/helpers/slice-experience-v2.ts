import type { LiveActivityItem, SessionTreeNode } from "../../types.js";
import type { SliceRunProjection } from "./slice-run-projections.js";
import type { RuntimeInstanceRecord } from "../../runtime-instance-store.js";

export type SliceKind = "work_slice" | "runtime_reporting" | "system_maintenance";
export type SliceLifecycleStateV2 =
  | "queued"
  | "dispatching"
  | "running"
  | "awaiting_input"
  | "completed"
  | "failed"
  | "archived";
export type OutcomeState =
  | "succeeded_with_artifacts"
  | "succeeded_without_artifacts"
  | "failed_actionable"
  | "failed_non_actionable"
  | "needs_input";
export type ActorType = "agent" | "user" | "orgx" | "system";
export type SliceActionType =
  | "approve"
  | "reject"
  | "retry"
  | "resume"
  | "open_artifact"
  | "provide_context";

export type ActorProvenance = {
  actorType: ActorType;
  actorId: string;
  displayName: string;
  avatarKey: string;
};

export type LineageRef = {
  initiativeIds: string[];
  initiativeTitles: string[];
  workstreamIds: string[];
  workstreamTitles: string[];
  taskIds: string[];
  milestoneIds: string[];
  iwmtIds: string[];
  sliceRunId: string;
  sessionId: string | null;
};

export type ArtifactEnvelope = {
  artifactId: string;
  sliceRunId: string;
  type: string;
  title: string;
  url: string | null;
  preview: string | null;
  validation: "present" | "missing" | "invalid";
  confidence: number;
  producedAt: string | null;
  producer: "agent" | "system" | "user";
};

export type ActionContract = {
  actionType: SliceActionType;
  label: string;
  payloadSchema: Record<string, unknown>;
  primary: boolean;
};

export type WorkSliceProjectionV2 = {
  projectionVersion: number;
  lastEventId: string | null;
  consistencyFlags: string[];
  sliceRunId: string;
  runId: string | null;
  sliceKind: SliceKind;
  lifecycleState: SliceLifecycleStateV2;
  outcomeState: OutcomeState;
  statusExplainer: string;
  actorProvenance: ActorProvenance;
  lineage: LineageRef;
  artifacts: ArtifactEnvelope[];
  artifactCount: number;
  hasArtifact: boolean;
  actionContract: ActionContract | null;
  updatedAt: string | null;
  completedAt: string | null;
  failedAt: string | null;
  archivedAt: string | null;
  runtimeState: string | null;
  sourceClient: string | null;
  confidence: "low" | "medium" | "high";
};

export type TimelineNarrativeProjection = {
  projectionVersion: number;
  sliceRunId: string;
  title: string;
  occurredAt: string | null;
  actorProvenance: ActorProvenance;
  intent: string;
  dispatch: string;
  highlights: string[];
  outcome: {
    state: OutcomeState;
    summary: string;
    artifactCount: number;
  };
  nextAction: ActionContract | null;
  technicalTrace: {
    eventCount: number;
    eventIds: string[];
  };
};

export type SnapshotV2Payload = {
  generatedAt: string;
  runningWorkSlices: number;
  needsInput: number;
  failedActionable: number;
  completedToday: number;
  inProgress: WorkSliceProjectionV2[];
  needsInputItems: WorkSliceProjectionV2[];
  failedItems: WorkSliceProjectionV2[];
  nextUpByInitiative: Array<{
    initiativeId: string | null;
    initiativeTitle: string;
    pendingCount: number;
    queue: Array<{
      workstreamId: string | null;
      workstreamTitle: string;
      queueState: string;
      priorityNum: number | null;
      dependencySummary: string | null;
      tasksRemaining: number | null;
    }>;
  }>;
  timelineNarrative: TimelineNarrativeProjection[];
  consistencyFlags: string[];
  dataHealth: {
    status: "healthy" | "degraded";
    totals: {
      slices: number;
      missingTerminal: number;
      lineageGap: number;
      artifactMismatch: number;
      invalidActor: number;
    };
  };
};

type BuildSliceExperienceV2Input = {
  generatedAt: string;
  sliceRuns: SliceRunProjection[];
  sessions: SessionTreeNode[];
  activity: LiveActivityItem[];
  runtimeInstances: RuntimeInstanceRecord[];
  nextUpItems: Array<Record<string, unknown>>;
};

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const GENERIC_ACTOR_IDS = new Set(["main", "unknown", "system", "openclaw", "orgx"]);

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function normalizeText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeTextArray(values: unknown, fallback?: string | null): string[] {
  const out: string[] = [];
  const push = (value: unknown) => {
    const normalized = normalizeText(value);
    if (!normalized) return;
    if (out.some((entry) => entry.toLowerCase() === normalized.toLowerCase())) return;
    out.push(normalized);
  };
  if (Array.isArray(values)) {
    for (const value of values) push(value);
  } else if (typeof values === "string") {
    for (const value of values.split(/[\n,;]+/g)) push(value);
  }
  if (fallback) push(fallback);
  return out;
}

function toEpoch(value: string | null | undefined): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function isGenericActorValue(value: string | null | undefined): boolean {
  const normalized = normalizeText(value);
  if (!normalized) return true;
  const lower = normalized.toLowerCase();
  if (GENERIC_ACTOR_IDS.has(lower)) return true;
  return UUID_RE.test(normalized);
}

function isReportingLike(text: string | null | undefined): boolean {
  const normalized = (text ?? "").trim().toLowerCase();
  if (!normalized) return false;
  return normalized.startsWith("reporting") || normalized.includes("telemetry");
}

function metadataString(metadata: Record<string, unknown> | null, keys: string[]): string | null {
  if (!metadata) return null;
  for (const key of keys) {
    const value = normalizeText(metadata[key]);
    if (value) return value;
  }
  return null;
}

function resolveActivitySliceRunId(item: LiveActivityItem): string | null {
  if (normalizeText(item.runId)) return normalizeText(item.runId);
  const metadata = asRecord(item.metadata);
  return metadataString(metadata, [
    "slice_run_id",
    "sliceRunId",
    "active_run_id",
    "activeRunId",
    "run_id",
    "runId",
    "correlation_id",
    "correlationId",
  ]);
}

function canonicalLifecycle(state: string): SliceLifecycleStateV2 {
  const normalized = state.trim().toLowerCase();
  if (normalized === "needs_review") return "completed";
  if (normalized === "queued") return "queued";
  if (normalized === "dispatching") return "dispatching";
  if (normalized === "running") return "running";
  if (normalized === "awaiting_input") return "awaiting_input";
  if (normalized === "completed") return "completed";
  if (normalized === "failed") return "failed";
  if (normalized === "archived") return "archived";
  return "queued";
}

function deriveSliceKind(slice: SliceRunProjection, linkedSession: SessionTreeNode | null): SliceKind {
  const initiativeIds = normalizeTextArray(slice.initiativeIds, slice.initiativeId);
  const workstreamIds = normalizeTextArray(slice.workstreamIds, slice.workstreamId);
  const hasStructuredScope =
    initiativeIds.length > 0 ||
    workstreamIds.length > 0 ||
    (Array.isArray(slice.taskIds) && slice.taskIds.length > 0) ||
    (Array.isArray(slice.milestoneIds) && slice.milestoneIds.length > 0);

  if (hasStructuredScope) return "work_slice";
  if (isReportingLike(linkedSession?.title) || isReportingLike(slice.lastEventSummary)) {
    return "runtime_reporting";
  }
  if ((slice.sourceClient ?? "").toLowerCase() === "openclaw") {
    return "runtime_reporting";
  }
  return "system_maintenance";
}

function deriveOutcomeState(
  lifecycleState: SliceLifecycleStateV2,
  hasArtifact: boolean,
  decisionCount: number
): OutcomeState {
  if (lifecycleState === "awaiting_input") return "needs_input";
  if (lifecycleState === "failed") {
    return decisionCount > 0 ? "failed_actionable" : "failed_non_actionable";
  }
  if (lifecycleState === "completed") {
    return hasArtifact ? "succeeded_with_artifacts" : "succeeded_without_artifacts";
  }
  return hasArtifact ? "succeeded_with_artifacts" : "needs_input";
}

function defaultStatusExplainer(state: SliceLifecycleStateV2): string {
  switch (state) {
    case "queued":
      return "Queued and waiting to dispatch.";
    case "dispatching":
      return "Dispatch acknowledged and waiting for execution.";
    case "running":
      return "Slice execution is in progress.";
    case "awaiting_input":
      return "Needs your input to continue.";
    case "completed":
      return "Execution completed successfully.";
    case "failed":
      return "Execution failed before completion.";
    case "archived":
      return "Session was archived.";
    default:
      return "Status unavailable.";
  }
}

function deriveActionContract(slice: SliceRunProjection, outcomeState: OutcomeState): ActionContract | null {
  if (outcomeState === "succeeded_with_artifacts" && slice.artifactCount > 0) {
    return {
      actionType: "open_artifact",
      label: "Open artifact",
      payloadSchema: { requires: ["sliceRunId"], optional: ["artifactId"] },
      primary: true,
    };
  }
  if (outcomeState === "needs_input") {
    const hasExplicitOptions =
      Array.isArray(slice.decisionOptions) && slice.decisionOptions.length > 0;
    return {
      actionType: hasExplicitOptions ? "approve" : "provide_context",
      label: hasExplicitOptions ? "Choose decision" : "Provide context",
      payloadSchema: hasExplicitOptions
        ? { requires: ["decisionId"], optional: ["optionId", "note"] }
        : { requires: ["note"] },
      primary: true,
    };
  }
  if (outcomeState === "failed_actionable" || outcomeState === "failed_non_actionable") {
    return {
      actionType: "retry",
      label: "Retry slice",
      payloadSchema: { requires: ["sliceRunId"], optional: ["note"] },
      primary: true,
    };
  }
  if (outcomeState === "succeeded_without_artifacts") {
    return {
      actionType: "provide_context",
      label: "Add evidence",
      payloadSchema: { requires: ["note"] },
      primary: true,
    };
  }
  return null;
}

function deriveActorProvenance(
  slice: SliceRunProjection,
  linkedSession: SessionTreeNode | null
): ActorProvenance {
  const sessionAgentId = normalizeText(linkedSession?.agentId) ?? null;
  const sessionAgentName = normalizeText(linkedSession?.agentName) ?? null;
  if (!isGenericActorValue(sessionAgentName) || !isGenericActorValue(sessionAgentId)) {
    const actorId = sessionAgentId ?? sessionAgentName ?? "unknown-agent";
    const displayName = sessionAgentName ?? "Agent";
    return {
      actorType: "agent",
      actorId,
      displayName,
      avatarKey: `agent:${actorId}`,
    };
  }

  const source = (slice.sourceClient ?? "").trim().toLowerCase();
  if (source === "codex" || source === "claude-code" || source === "openclaw") {
    const displayName =
      source === "codex" ? "Codex Agent" : source === "claude-code" ? "Claude Code Agent" : "OpenClaw Agent";
    return {
      actorType: "system",
      actorId: source,
      displayName,
      avatarKey: source === "openclaw" ? "openclaw-system" : `agent:${source}`,
    };
  }

  return {
    actorType: "orgx",
    actorId: "orgx",
    displayName: "OrgX System",
    avatarKey: "orgx",
  };
}

function deriveActorProvenanceFromSession(session: SessionTreeNode): ActorProvenance {
  const agentId = normalizeText(session.agentId);
  const agentName = normalizeText(session.agentName);
  if (!isGenericActorValue(agentName) || !isGenericActorValue(agentId)) {
    const actorId = agentId ?? agentName ?? "unknown-agent";
    return {
      actorType: "agent",
      actorId,
      displayName: agentName ?? "Agent",
      avatarKey: `agent:${actorId}`,
    };
  }

  const runtimeClient = (normalizeText(session.runtimeClient) ?? "").toLowerCase();
  if (runtimeClient === "codex" || runtimeClient === "claude-code" || runtimeClient === "openclaw") {
    const displayName =
      runtimeClient === "codex"
        ? "Codex Agent"
        : runtimeClient === "claude-code"
          ? "Claude Code Agent"
          : "OpenClaw Agent";
    return {
      actorType: "system",
      actorId: runtimeClient,
      displayName,
      avatarKey: runtimeClient === "openclaw" ? "openclaw-system" : `agent:${runtimeClient}`,
    };
  }

  return {
    actorType: "orgx",
    actorId: "orgx",
    displayName: "OrgX System",
    avatarKey: "orgx",
  };
}

function asArtifactEnvelope(
  sliceRunId: string,
  item: SliceRunProjection["artifacts"][number]
): ArtifactEnvelope {
  return {
    artifactId: normalizeText(item.id) ?? `${sliceRunId}:${normalizeText(item.title) ?? "artifact"}`,
    sliceRunId,
    type: normalizeText(item.type) ?? "other",
    title: normalizeText(item.title) ?? "Artifact",
    url: normalizeText(item.url) ?? null,
    preview: null,
    validation: normalizeText(item.url) ? "present" : "missing",
    confidence: 1,
    producedAt: item.createdAt ?? null,
    producer: "agent",
  };
}

function consistencyFlagsForSlice(
  sliceKind: SliceKind,
  slice: SliceRunProjection,
  lifecycleState: SliceLifecycleStateV2
): string[] {
  const flags: string[] = [];
  const hasLineage =
    normalizeTextArray(slice.initiativeIds, slice.initiativeId).length > 0 ||
    normalizeTextArray(slice.workstreamIds, slice.workstreamId).length > 0 ||
    (Array.isArray(slice.taskIds) && slice.taskIds.length > 0);
  if (sliceKind === "work_slice" && !hasLineage) flags.push("lineage_gap");
  if (lifecycleState === "completed" && !slice.hasArtifact) flags.push("artifact_mismatch");
  if (!slice.completedAt && !slice.failedAt && !slice.archivedAt) {
    if (lifecycleState === "completed" || lifecycleState === "failed" || lifecycleState === "archived") {
      flags.push("missing_terminal");
    }
  }
  if (isGenericActorValue(slice.sourceClient)) {
    flags.push("invalid_actor");
  }
  return flags;
}

function selectLinkedSession(
  slice: SliceRunProjection,
  sessionsByRunId: Map<string, SessionTreeNode>
): SessionTreeNode | null {
  const runId = normalizeText(slice.runId) ?? normalizeText(slice.sliceRunId);
  if (!runId) return null;
  return sessionsByRunId.get(runId) ?? null;
}

function buildTimelineNarrative(
  projections: WorkSliceProjectionV2[],
  activity: LiveActivityItem[]
): TimelineNarrativeProjection[] {
  const bySliceRunId = new Map<string, LiveActivityItem[]>();
  for (const item of activity) {
    const sliceRunId = resolveActivitySliceRunId(item);
    if (!sliceRunId) continue;
    const list = bySliceRunId.get(sliceRunId) ?? [];
    list.push(item);
    bySliceRunId.set(sliceRunId, list);
  }

  const out: TimelineNarrativeProjection[] = [];
  for (const projection of projections) {
    const events = (bySliceRunId.get(projection.sliceRunId) ?? []).sort(
      (a, b) => toEpoch(a.timestamp) - toEpoch(b.timestamp)
    );
    const meaningful = events.filter((event) => {
      const metadata = asRecord(event.metadata);
      const eventName = (metadataString(metadata, ["event"]) ?? "").toLowerCase();
      return eventName !== "autopilot_slice_heartbeat";
    });
    const dispatch = meaningful.find((event) => {
      const metadata = asRecord(event.metadata);
      const eventName = (metadataString(metadata, ["event"]) ?? "").toLowerCase();
      return eventName.includes("dispatch");
    });

    const title =
      projection.lineage.workstreamTitles[0] ??
      projection.lineage.workstreamIds[0] ??
      `Slice ${projection.sliceRunId.slice(0, 8)}`;
    const intent =
      projection.lineage.taskIds.length > 0
        ? `Execute ${projection.lineage.taskIds.length} task(s) in this slice.`
        : "Execute scoped work for this slice.";
    const highlights = meaningful
      .map((event) => normalizeText(event.summary) ?? normalizeText(event.description) ?? normalizeText(event.title))
      .filter((entry): entry is string => Boolean(entry))
      .slice(-4);
    const outcomeSummary =
      projection.outcomeState === "succeeded_with_artifacts"
        ? `Completed with ${projection.artifactCount} artifact${projection.artifactCount === 1 ? "" : "s"}.`
        : projection.outcomeState === "succeeded_without_artifacts"
        ? "Completed without artifact evidence."
        : projection.outcomeState === "needs_input"
        ? "Waiting for input before continuing."
        : "Execution failed before completion.";

    out.push({
      projectionVersion: 1,
      sliceRunId: projection.sliceRunId,
      title,
      occurredAt: projection.updatedAt ?? projection.completedAt ?? projection.failedAt ?? null,
      actorProvenance: projection.actorProvenance,
      intent,
      dispatch:
        normalizeText(dispatch?.summary) ??
        normalizeText(dispatch?.description) ??
        (dispatch ? dispatch.title : "Dispatch details unavailable."),
      highlights,
      outcome: {
        state: projection.outcomeState,
        summary: outcomeSummary,
        artifactCount: projection.artifactCount,
      },
      nextAction: projection.actionContract,
      technicalTrace: {
        eventCount: events.length,
        eventIds: events.map((event) => event.id).slice(-10),
      },
    });
  }

  out.sort((a, b) => toEpoch(b.occurredAt) - toEpoch(a.occurredAt));
  return out;
}

export function buildSliceExperienceSnapshotV2(
  input: BuildSliceExperienceV2Input
): SnapshotV2Payload & {
  projections: WorkSliceProjectionV2[];
} {
  const sessionsByRunId = new Map<string, SessionTreeNode>();
  for (const session of input.sessions) {
    const runId = normalizeText(session.runId);
    if (!runId || sessionsByRunId.has(runId)) continue;
    sessionsByRunId.set(runId, session);
  }

  const projections: WorkSliceProjectionV2[] = input.sliceRuns.map((slice) => {
    const linkedSession = selectLinkedSession(slice, sessionsByRunId);
    const lifecycleState = canonicalLifecycle(slice.status);
    const sliceKind = deriveSliceKind(slice, linkedSession);
    const outcomeState = deriveOutcomeState(
      lifecycleState,
      Boolean(slice.hasArtifact || slice.artifactCount > 0),
      slice.blockingDecisionCount ?? slice.decisionCount ?? 0
    );
    const actionContract = deriveActionContract(slice, outcomeState);
    const lineage: LineageRef = {
      initiativeIds: normalizeTextArray(slice.initiativeIds, slice.initiativeId),
      initiativeTitles: [],
      workstreamIds: normalizeTextArray(slice.workstreamIds, slice.workstreamId),
      workstreamTitles: normalizeTextArray(slice.workstreamTitle),
      taskIds: Array.isArray(slice.taskIds) ? normalizeTextArray(slice.taskIds) : [],
      milestoneIds: Array.isArray(slice.milestoneIds)
        ? normalizeTextArray(slice.milestoneIds)
        : [],
      iwmtIds: normalizeTextArray(slice.iwmtIds, slice.iwmtId),
      sliceRunId: slice.sliceRunId,
      sessionId: linkedSession?.id ?? null,
    };
    const artifacts = (Array.isArray(slice.artifacts) ? slice.artifacts : []).map((item) =>
      asArtifactEnvelope(slice.sliceRunId, item)
    );
    const consistencyFlags = consistencyFlagsForSlice(sliceKind, slice, lifecycleState);
    return {
      projectionVersion: 1,
      lastEventId: null,
      consistencyFlags,
      sliceRunId: slice.sliceRunId,
      runId: slice.runId ?? null,
      sliceKind,
      lifecycleState,
      outcomeState,
      statusExplainer: slice.statusExplainer,
      actorProvenance: deriveActorProvenance(slice, linkedSession),
      lineage,
      artifacts,
      artifactCount: slice.artifactCount,
      hasArtifact: Boolean(slice.hasArtifact || slice.artifactCount > 0),
      actionContract,
      updatedAt: slice.updatedAt ?? slice.lastEventAt ?? null,
      completedAt: slice.completedAt ?? null,
      failedAt: slice.failedAt ?? null,
      archivedAt: slice.archivedAt ?? null,
      runtimeState: slice.runtimeState ?? null,
      sourceClient: slice.sourceClient ?? null,
      confidence: slice.confidence,
    };
  });

  const projectionByRunId = new Set<string>();
  for (const projection of projections) {
    const runId = normalizeText(projection.runId);
    if (runId) projectionByRunId.add(runId);
    projectionByRunId.add(projection.sliceRunId);
  }

  for (const session of input.sessions) {
    const runId = normalizeText(session.runId);
    if (!runId || projectionByRunId.has(runId)) continue;

    const title = normalizeText(session.title) ?? null;
    const lifecycleState = canonicalLifecycle(normalizeText(session.status) ?? "queued");
    const hasScope =
      Boolean(normalizeText(session.initiativeId)) ||
      Boolean(normalizeText(session.workstreamId));
    const sliceKind: SliceKind = hasScope
      ? "work_slice"
      : isReportingLike(title)
        ? "runtime_reporting"
        : "system_maintenance";
    const outcomeState = deriveOutcomeState(
      lifecycleState,
      false,
      Array.isArray(session.blockers) ? session.blockers.length : 0
    );
    const hasLineage = hasScope;
    const consistencyFlags: string[] = [];
    if (sliceKind === "work_slice" && !hasLineage) consistencyFlags.push("lineage_gap");
    if (isGenericActorValue(normalizeText(session.agentName) ?? normalizeText(session.agentId))) {
      consistencyFlags.push("invalid_actor");
    }

    projections.push({
      projectionVersion: 1,
      lastEventId: null,
      consistencyFlags,
      sliceRunId: runId,
      runId,
      sliceKind,
      lifecycleState,
      outcomeState,
      statusExplainer:
        normalizeText(session.lastEventSummary) ??
        defaultStatusExplainer(lifecycleState),
      actorProvenance: deriveActorProvenanceFromSession(session),
      lineage: {
        initiativeIds: normalizeTextArray(session.initiativeId),
        initiativeTitles: normalizeTextArray(session.groupLabel),
        workstreamIds: normalizeTextArray(session.workstreamId),
        workstreamTitles: normalizeTextArray(title),
        taskIds: [],
        milestoneIds: [],
        iwmtIds: [],
        sliceRunId: runId,
        sessionId: normalizeText(session.id) ?? null,
      },
      artifacts: [],
      artifactCount: 0,
      hasArtifact: false,
      actionContract:
        outcomeState === "needs_input"
          ? {
              actionType: "provide_context",
              label: "Provide context",
              payloadSchema: { requires: ["note"] },
              primary: true,
            }
          : outcomeState === "failed_actionable" || outcomeState === "failed_non_actionable"
            ? {
                actionType: "retry",
                label: "Retry slice",
                payloadSchema: { requires: ["sliceRunId"], optional: ["note"] },
                primary: true,
              }
            : null,
      updatedAt: session.updatedAt ?? session.lastEventAt ?? session.startedAt ?? null,
      completedAt: lifecycleState === "completed" ? session.updatedAt ?? session.lastEventAt ?? null : null,
      failedAt: lifecycleState === "failed" ? session.updatedAt ?? session.lastEventAt ?? null : null,
      archivedAt: lifecycleState === "archived" ? session.updatedAt ?? session.lastEventAt ?? null : null,
      runtimeState: normalizeText(session.state),
      sourceClient: normalizeText(session.runtimeClient),
      confidence: "low",
    });
    projectionByRunId.add(runId);
  }

  for (const instance of input.runtimeInstances) {
    const runId = normalizeText(instance.runId) ?? normalizeText(instance.correlationId);
    if (!runId || projectionByRunId.has(runId)) continue;

    const hasScope =
      Boolean(normalizeText(instance.initiativeId)) ||
      Boolean(normalizeText(instance.workstreamId)) ||
      Boolean(normalizeText(instance.taskId));
    const lifecycleState: SliceLifecycleStateV2 =
      instance.state === "stopped" || (instance.event ?? "").toLowerCase() === "session_stop"
        ? "completed"
        : instance.state === "error" || (instance.event ?? "").toLowerCase() === "error"
          ? "failed"
          : instance.state === "stale"
            ? "archived"
            : "running";
    const outcomeState = deriveOutcomeState(lifecycleState, false, 0);
    const sliceKind: SliceKind = hasScope ? "work_slice" : "runtime_reporting";

    const sourceClient = normalizeText(instance.sourceClient) ?? "unknown";
    const displayName =
      sourceClient === "codex"
        ? "Codex Agent"
        : sourceClient === "claude-code"
          ? "Claude Code Agent"
          : sourceClient === "openclaw"
            ? "OpenClaw Agent"
            : sourceClient === "api"
              ? "OrgX API"
              : "OrgX System";
    const actorType: ActorType =
      sourceClient === "codex" ||
      sourceClient === "claude-code" ||
      sourceClient === "openclaw"
        ? "system"
        : sourceClient === "api"
          ? "orgx"
          : "orgx";

    projections.push({
      projectionVersion: 1,
      lastEventId: null,
      consistencyFlags: [],
      sliceRunId: runId,
      runId,
      sliceKind,
      lifecycleState,
      outcomeState,
      statusExplainer:
        normalizeText(instance.lastMessage) ??
        defaultStatusExplainer(lifecycleState),
      actorProvenance: {
        actorType,
        actorId: sourceClient,
        displayName,
        avatarKey: sourceClient === "openclaw" ? "openclaw-system" : `agent:${sourceClient}`,
      },
      lineage: {
        initiativeIds: normalizeTextArray(instance.initiativeId),
        initiativeTitles: [],
        workstreamIds: normalizeTextArray(instance.workstreamId),
        workstreamTitles: [],
        taskIds: normalizeTextArray(instance.taskId),
        milestoneIds: [],
        iwmtIds: [],
        sliceRunId: runId,
        sessionId: null,
      },
      artifacts: [],
      artifactCount: 0,
      hasArtifact: false,
      actionContract: null,
      updatedAt: instance.updatedAt ?? instance.lastEventAt ?? null,
      completedAt:
        lifecycleState === "completed" ? instance.updatedAt ?? instance.lastEventAt ?? null : null,
      failedAt:
        lifecycleState === "failed" ? instance.updatedAt ?? instance.lastEventAt ?? null : null,
      archivedAt:
        lifecycleState === "archived" ? instance.updatedAt ?? instance.lastEventAt ?? null : null,
      runtimeState: normalizeText(instance.state),
      sourceClient,
      confidence: "low",
    });
    projectionByRunId.add(runId);
  }

  projections.sort((a, b) => toEpoch(b.updatedAt) - toEpoch(a.updatedAt));

  const inProgress = projections.filter(
    (slice) => slice.sliceKind === "work_slice" && slice.lifecycleState === "running"
  );
  const needsInputItems = projections.filter((slice) => slice.outcomeState === "needs_input");
  const failedItems = projections.filter(
    (slice) =>
      slice.outcomeState === "failed_actionable" ||
      slice.outcomeState === "failed_non_actionable"
  );
  const completedToday = projections.filter((slice) => {
    if (slice.lifecycleState !== "completed") return false;
    const epoch = toEpoch(slice.completedAt ?? slice.updatedAt);
    if (!epoch) return false;
    const now = new Date();
    const then = new Date(epoch);
    return (
      now.getUTCFullYear() === then.getUTCFullYear() &&
      now.getUTCMonth() === then.getUTCMonth() &&
      now.getUTCDate() === then.getUTCDate()
    );
  }).length;

  const nextUpByInitiativeMap = new Map<
    string,
    {
      initiativeId: string | null;
      initiativeTitle: string;
      queue: SnapshotV2Payload["nextUpByInitiative"][number]["queue"];
    }
  >();

  for (const rawItem of input.nextUpItems) {
    const initiativeId = normalizeText(rawItem.initiativeId) ?? null;
    const initiativeTitle =
      normalizeText(rawItem.initiativeTitle) ??
      normalizeText(rawItem.groupLabel) ??
      (initiativeId ?? "Unscoped initiative");
    const key = initiativeId ?? "unscoped";
    const existing = nextUpByInitiativeMap.get(key) ?? {
      initiativeId,
      initiativeTitle,
      queue: [],
    };
    existing.queue.push({
      workstreamId: normalizeText(rawItem.workstreamId) ?? null,
      workstreamTitle:
        normalizeText(rawItem.workstreamTitle) ??
        normalizeText(rawItem.title) ??
        "Work slice",
      queueState: normalizeText(rawItem.queueState) ?? "queued",
      priorityNum:
        typeof rawItem.priorityNum === "number" && Number.isFinite(rawItem.priorityNum)
          ? rawItem.priorityNum
          : null,
      dependencySummary:
        normalizeText(rawItem.dependencySummary) ?? normalizeText(rawItem.waitingOn) ?? null,
      tasksRemaining:
        typeof rawItem.tasksRemaining === "number" && Number.isFinite(rawItem.tasksRemaining)
          ? rawItem.tasksRemaining
          : null,
    });
    nextUpByInitiativeMap.set(key, existing);
  }

  const nextUpByInitiative = Array.from(nextUpByInitiativeMap.values())
    .map((entry) => ({
      initiativeId: entry.initiativeId,
      initiativeTitle: entry.initiativeTitle,
      pendingCount: entry.queue.length,
      queue: entry.queue.sort((a, b) => {
        const aPriority = typeof a.priorityNum === "number" ? a.priorityNum : Number.MAX_SAFE_INTEGER;
        const bPriority = typeof b.priorityNum === "number" ? b.priorityNum : Number.MAX_SAFE_INTEGER;
        return aPriority - bPriority;
      }),
    }))
    .sort((a, b) => b.pendingCount - a.pendingCount);

  const timelineNarrative = buildTimelineNarrative(projections, input.activity);

  const allConsistencyFlags = new Set<string>();
  let missingTerminal = 0;
  let lineageGap = 0;
  let artifactMismatch = 0;
  let invalidActor = 0;
  for (const projection of projections) {
    for (const flag of projection.consistencyFlags) allConsistencyFlags.add(flag);
    if (projection.consistencyFlags.includes("missing_terminal")) missingTerminal += 1;
    if (projection.consistencyFlags.includes("lineage_gap")) lineageGap += 1;
    if (projection.consistencyFlags.includes("artifact_mismatch")) artifactMismatch += 1;
    if (projection.consistencyFlags.includes("invalid_actor")) invalidActor += 1;
  }

  const consistencyFlags = Array.from(allConsistencyFlags.values());
  const degraded = consistencyFlags.length > 0;

  return {
    generatedAt: input.generatedAt,
    runningWorkSlices: inProgress.length,
    needsInput: needsInputItems.length,
    failedActionable: failedItems.length,
    completedToday,
    inProgress,
    needsInputItems,
    failedItems,
    nextUpByInitiative,
    timelineNarrative,
    consistencyFlags,
    dataHealth: {
      status: degraded ? "degraded" : "healthy",
      totals: {
        slices: projections.length,
        missingTerminal,
        lineageGap,
        artifactMismatch,
        invalidActor,
      },
    },
    projections,
  };
}

export function findSliceNarrative(
  timelineNarrative: TimelineNarrativeProjection[],
  sliceRunId: string
): TimelineNarrativeProjection | null {
  const normalized = sliceRunId.trim();
  if (!normalized) return null;
  return timelineNarrative.find((entry) => entry.sliceRunId === normalized) ?? null;
}

export function findSessionDetailProjection(
  projections: WorkSliceProjectionV2[],
  sessionId: string
): WorkSliceProjectionV2 | null {
  const normalized = sessionId.trim();
  if (!normalized) return null;
  return projections.find((entry) => entry.lineage.sessionId === normalized) ?? null;
}
