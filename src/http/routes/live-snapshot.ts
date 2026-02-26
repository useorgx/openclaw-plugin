import type { HandoffSummary, LiveActivityItem, SessionTreeResponse } from "../../types.js";
import type { RuntimeInstanceRecord } from "../../runtime-instance-store.js";
import type { OutboxSummary } from "../../outbox.js";
import type { ChatThreadSummary } from "../../chat-store.js";
import { normalizeReportingBlockedSessions } from "../helpers/session-classification.js";
import { buildSliceRunProjections } from "../helpers/slice-run-projections.js";
import {
  buildSliceExperienceSnapshotV2,
  findSessionDetailProjection,
  findSliceNarrative,
  type SnapshotV2Payload,
  type WorkSliceProjectionV2,
} from "../helpers/slice-experience-v2.js";
import { shouldHideActivityItem } from "../../event-sanitization.js";
import {
  KNOWN_DECISION_ACTION_TYPES,
  normalizeDecisionActionType,
} from "../../contracts/shared-types.js";
import {
  resolveWorkspaceScope,
  workspaceScopeFromHeaders,
} from "../helpers/workspace-scope.js";
import type {
  AgentLaunchContext,
  RunLaunchContext,
} from "../../agent-context-store.js";
import type { Router } from "../router.js";

type LocalSnapshot = Awaited<
  ReturnType<typeof import("../../local-openclaw.js").loadLocalOpenClawSnapshot>
>;

type AgentContextState = {
  agents: Record<string, AgentLaunchContext>;
  runs?: Record<string, RunLaunchContext>;
};

type SnapshotPersistState = {
  lastFingerprint: string;
  lastPersistAt: number;
};

const LIVE_SNAPSHOT_UPSTREAM_TIMEOUT_MS = (() => {
  const raw = Number(process.env.ORGX_LIVE_SNAPSHOT_UPSTREAM_TIMEOUT_MS ?? "");
  if (!Number.isFinite(raw)) return 3_500;
  return Math.max(500, Math.min(60_000, Math.floor(raw)));
})();

const LIVE_SNAPSHOT_NEXT_UP_TIMEOUT_MS = (() => {
  const raw = Number(process.env.ORGX_LIVE_SNAPSHOT_NEXT_UP_TIMEOUT_MS ?? "");
  if (!Number.isFinite(raw)) return 1_200;
  return Math.max(250, Math.min(15_000, Math.floor(raw)));
})();

async function withSoftTimeout<T>(
  work: Promise<T>,
  timeoutMs: number,
  label: string
): Promise<T> {
  let timer: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      work,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`${label} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

type LiveSnapshotRoutesDeps<TReq, TRes> = {
  parsePositiveInt: (raw: string | null, fallback: number) => number;
  readSnapshotResponseCache: (key: string) => Record<string, unknown> | null;
  writeSnapshotResponseCache: (key: string, payload: Record<string, unknown>) => void;
  safeErrorMessage: (err: unknown) => string;
  readAgentContexts: () => AgentContextState;
  getScopedAgentIds: (contexts: Record<string, AgentLaunchContext>) => Set<string>;

  readDiagnosticsOutboxStatus: () => Promise<Record<string, unknown> | null>;
  readOutboxSummary: () => Promise<OutboxSummary>;
  readOutboxItems: () => Promise<LiveActivityItem[]>;

  loadLocalOpenClawSnapshot: (limit: number) => Promise<LocalSnapshot>;
  toLocalSessionTree: (snapshot: LocalSnapshot, limit?: number) => SessionTreeResponse;
  toLocalLiveActivity: (
    snapshot: LocalSnapshot,
    limit?: number
  ) => Promise<{ activities: LiveActivityItem[]; total: number }>;
  toLocalLiveAgents: (snapshot: LocalSnapshot) => {
    agents: Array<{ initiativeId: string | null; status: string } & Record<string, unknown>>;
  };

  getLiveSessions: (input: {
    initiative: string | null;
    projectId: string | null;
    limit: number;
  }) => Promise<SessionTreeResponse>;
  getLiveActivity: (input: {
    run: string | null;
    since: string | null;
    projectId: string | null;
    limit: number;
  }) => Promise<{ activities: LiveActivityItem[] }>;
  getHandoffs: () => Promise<{ handoffs: HandoffSummary[] }>;
  getLiveDecisions: (input: {
    status: string;
    projectId: string | null;
    limit: number;
  }) => Promise<{ decisions: unknown[] }>;
  getLiveAgents: (input: {
    initiative: string | null;
    projectId: string | null;
    includeIdle: boolean | undefined;
  }) => Promise<{ agents?: unknown[] }>;
  listInitiativeIdsForProject: (input: { projectId: string }) => Promise<string[]>;

  mapDecisionEntity: (
    entry: unknown
  ) => Record<string, unknown> & { waitingMinutes: number };
  applyAgentContextsToSessionTree: (
    input: SessionTreeResponse,
    contexts: {
      agents: Record<string, AgentLaunchContext>;
      runs: Record<string, RunLaunchContext>;
    }
  ) => SessionTreeResponse;
  applyAgentContextsToActivity: (
    input: LiveActivityItem[],
    contexts: {
      agents: Record<string, AgentLaunchContext>;
      runs: Record<string, RunLaunchContext>;
    }
  ) => LiveActivityItem[];
  mergeSessionTrees: (
    base: SessionTreeResponse,
    extra: SessionTreeResponse
  ) => SessionTreeResponse;
  mergeActivities: (
    base: LiveActivityItem[],
    extra: LiveActivityItem[],
    limit: number
  ) => LiveActivityItem[];

  listRuntimeInstances: (input: { limit: number }) => RuntimeInstanceRecord[];
  injectRuntimeInstancesAsSessions: (
    input: SessionTreeResponse,
    instances: RuntimeInstanceRecord[]
  ) => SessionTreeResponse;
  enrichSessionsWithRuntime: (
    input: SessionTreeResponse,
    instances: RuntimeInstanceRecord[]
  ) => SessionTreeResponse;
  enrichActivityWithRuntime: (
    input: LiveActivityItem[],
    instances: RuntimeInstanceRecord[]
  ) => LiveActivityItem[];

  snapshotActivityFingerprint: (items: LiveActivityItem[]) => string;
  appendActivityItems: (items: LiveActivityItem[]) => void;
  snapshotActivityPersistMinIntervalMs: number;
  readSnapshotPersistState: () => SnapshotPersistState;
  writeSnapshotPersistState: (state: SnapshotPersistState) => void;
  parseJsonRequest?: (req: TReq) => Promise<Record<string, unknown>>;
  buildNextUpQueue?: (input: {
    initiativeId?: string | null;
    projectId?: string | null;
  }) => Promise<{ items: Array<Record<string, unknown>>; degraded: string[] }>;
  bulkDecideDecisions?: (
    ids: string[],
    action: "approve" | "reject",
    input?: { note?: string; optionId?: string }
  ) => Promise<Array<{ id?: string; ok?: boolean; error?: string }>>;
  emitDecisionResolvedActivity?: (input: {
    ids: string[];
    action: "approve" | "reject";
    note?: string | null;
    optionId?: string | null;
    sliceRunId?: string | null;
    initiativeId?: string | null;
  }) => Promise<void>;
  runAction?: (
    runId: string,
    action: "pause" | "resume" | "cancel" | "rollback",
    input?: { checkpointId?: string; reason?: string }
  ) => Promise<unknown>;
  listChatThreads?: (input: {
    commandCenterId?: string | null;
    initiativeId?: string | null;
    limit?: number;
    offset?: number;
  }) => {
    threads: ChatThreadSummary[];
    total: number;
    updatedAt: string;
  };

  sendJson: (res: TRes, status: number, payload: unknown) => void;
};

type ChatSnapshotPayload = {
  threads: ChatThreadSummary[];
  total: number;
  updatedAt: string;
};

type LegacySnapshotPayload = {
  sessions: SessionTreeResponse;
  activity: LiveActivityItem[];
  handoffs: HandoffSummary[];
  decisions: Array<Record<string, unknown>>;
  sliceRuns: ReturnType<typeof buildSliceRunProjections>;
  agents: Array<Record<string, unknown>>;
  runtimeInstances: RuntimeInstanceRecord[];
  outbox: Record<string, unknown>;
  chat?: ChatSnapshotPayload;
  generatedAt: string;
  projectId?: string | null;
  degraded?: string[];
};

type SnapshotBundle = {
  payload: LegacySnapshotPayload;
  v2: SnapshotV2Payload & { projections: WorkSliceProjectionV2[] };
  decisionsRaw: Array<Record<string, unknown>>;
};

function outboxStatusFromSummary(summary: OutboxSummary): Record<string, unknown> {
  return {
    pendingTotal: summary.pendingTotal,
    pendingByQueue: summary.pendingByQueue,
    oldestEventAt: summary.oldestEventAt,
    newestEventAt: summary.newestEventAt,
    replayStatus: "idle",
    lastReplayAttemptAt: null,
    lastReplaySuccessAt: null,
    lastReplayFailureAt: null,
    lastReplayError: null,
  };
}

function emptyOutboxStatus(): Record<string, unknown> {
  return {
    pendingTotal: 0,
    pendingByQueue: {},
    oldestEventAt: null,
    newestEventAt: null,
    replayStatus: "idle",
    lastReplayAttemptAt: null,
    lastReplaySuccessAt: null,
    lastReplayFailureAt: null,
    lastReplayError: null,
  };
}

function filterSessionsByInitiative(
  sessions: SessionTreeResponse,
  initiative: string | null
): SessionTreeResponse {
  if (!initiative || initiative.trim().length === 0) return sessions;
  const filteredNodes = sessions.nodes.filter(
    (node) => node.initiativeId === initiative || node.groupId === initiative
  );
  const filteredIds = new Set(filteredNodes.map((node) => node.id));
  const filteredGroupIds = new Set(filteredNodes.map((node) => node.groupId));

  return {
    nodes: filteredNodes,
    edges: sessions.edges.filter(
      (edge) => filteredIds.has(edge.parentId) && filteredIds.has(edge.childId)
    ),
    groups: sessions.groups.filter((group) => filteredGroupIds.has(group.id)),
  };
}

function maybeFilterActivity(
  items: LiveActivityItem[],
  input: { run: string | null; since: string | null }
): LiveActivityItem[] {
  let filtered = items;
  if (input.run && input.run.trim().length > 0) {
    filtered = filtered.filter((item) => item.runId === input.run);
  }

  if (input.since && input.since.trim().length > 0) {
    const sinceEpoch = Date.parse(input.since);
    if (Number.isFinite(sinceEpoch)) {
      filtered = filtered.filter((item) => Date.parse(item.timestamp) >= sinceEpoch);
    }
  }
  return filtered;
}

function filterSessionsByInitiativeSet(
  sessions: SessionTreeResponse,
  initiativeIds: Set<string>
): SessionTreeResponse {
  if (initiativeIds.size === 0) {
    return {
      nodes: [],
      edges: [],
      groups: [],
    };
  }
  const filteredNodes = sessions.nodes.filter((node) => {
    const initiativeId = node.initiativeId?.trim() ?? "";
    return initiativeId.length > 0 && initiativeIds.has(initiativeId);
  });
  const filteredNodeIds = new Set(filteredNodes.map((node) => node.id));
  const filteredGroupIds = new Set(filteredNodes.map((node) => node.groupId));
  return {
    nodes: filteredNodes,
    edges: sessions.edges.filter(
      (edge) => filteredNodeIds.has(edge.parentId) && filteredNodeIds.has(edge.childId)
    ),
    groups: sessions.groups.filter((group) => filteredGroupIds.has(group.id)),
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function pickString(input: Record<string, unknown> | null, keys: string[]): string | null {
  if (!input) return null;
  for (const key of keys) {
    const value = input[key];
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return null;
}

function resolveActivitySliceRunId(item: LiveActivityItem): string | null {
  if (item.runId && item.runId.trim().length > 0) return item.runId.trim();
  const metadata = asRecord(item.metadata);
  return pickString(metadata, [
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

function resolveDecisionIdsForSlice(
  decisions: Array<Record<string, unknown>>,
  sliceRunId: string
): string[] {
  const target = sliceRunId.trim();
  if (!target) return [];
  const matched: string[] = [];
  for (const decision of decisions) {
    const decisionId = pickString(decision, ["id"]);
    if (!decisionId) continue;
    const metadata = asRecord(decision.metadata);
    const linkedSliceRunId = pickString(metadata, [
      "slice_run_id",
      "sliceRunId",
      "run_id",
      "runId",
      "correlation_id",
      "correlationId",
    ]);
    if (!linkedSliceRunId || linkedSliceRunId !== target) continue;
    const status = (pickString(decision, ["status"]) ?? "pending").toLowerCase();
    if (status === "approved" || status === "declined" || status === "resolved" || status === "cancelled") {
      continue;
    }
    if (matched.includes(decisionId)) continue;
    matched.push(decisionId);
  }
  return matched;
}

function resolveInitiativeIdFromActivity(item: LiveActivityItem): string | null {
  if (item.initiativeId && item.initiativeId.trim().length > 0) {
    return item.initiativeId.trim();
  }
  const metadata = asRecord(item.metadata);
  return pickString(metadata, ["initiative_id", "initiativeId"]);
}

function filterActivityByInitiativeSet(
  items: LiveActivityItem[],
  initiativeIds: Set<string>
): LiveActivityItem[] {
  if (initiativeIds.size === 0) return [];
  return items.filter((item) => {
    const initiativeId = resolveInitiativeIdFromActivity(item);
    return initiativeId ? initiativeIds.has(initiativeId) : false;
  });
}

function resolveInitiativeIdFromRecord(entry: Record<string, unknown>): string | null {
  const direct = pickString(entry, ["initiative_id", "initiativeId", "initiative"]);
  if (direct) return direct;
  const metadata = asRecord(entry.metadata);
  return pickString(metadata, ["initiative_id", "initiativeId"]);
}

function filterRecordsByInitiativeSet(
  rows: Array<Record<string, unknown>>,
  initiativeIds: Set<string>
): Array<Record<string, unknown>> {
  if (initiativeIds.size === 0) return [];
  return rows.filter((row) => {
    const initiativeId = resolveInitiativeIdFromRecord(row);
    return initiativeId ? initiativeIds.has(initiativeId) : false;
  });
}

function filterRuntimeInstancesByInitiativeSet(
  rows: RuntimeInstanceRecord[],
  initiativeIds: Set<string>
): RuntimeInstanceRecord[] {
  if (initiativeIds.size === 0) return [];
  return rows.filter((row) => {
    const initiativeId = row.initiativeId?.trim() ?? "";
    return initiativeId.length > 0 && initiativeIds.has(initiativeId);
  });
}

function filterHandoffsByInitiativeSet(
  rows: HandoffSummary[],
  initiativeIds: Set<string>
): HandoffSummary[] {
  if (initiativeIds.size === 0) return [];
  return rows.filter((entry) => {
    const record = asRecord(entry);
    const initiativeId = pickString(record, [
      "initiative_id",
      "initiativeId",
      "initiative",
    ]);
    if (initiativeId && initiativeIds.has(initiativeId)) return true;
    const metadata = asRecord(record?.metadata);
    const metadataInitiativeId = pickString(metadata, ["initiative_id", "initiativeId"]);
    return metadataInitiativeId ? initiativeIds.has(metadataInitiativeId) : false;
  });
}

export function registerLiveSnapshotRoutes<TReq, TRes>(
  router: Router<Record<string, never>, TReq, TRes>,
  deps: LiveSnapshotRoutesDeps<TReq, TRes>
): void {
  type SnapshotQuery = {
    sessionsLimit: number;
    activityLimit: number;
    decisionsLimit: number;
    initiative: string | null;
    projectId: string | null;
    run: string | null;
    since: string | null;
    decisionStatus: string;
    includeIdle: boolean | undefined;
    scopeError: string | null;
  };

  const headerScopeFromRequest = (
    req: TReq
  ): Record<string, unknown> | null =>
    workspaceScopeFromHeaders(
      (req as { headers?: Record<string, unknown> } | null)?.headers
    );

  function parseSnapshotQuery(
    query: URLSearchParams,
    headerScope: Record<string, unknown> | null
  ): SnapshotQuery {
    const sessionsLimit = deps.parsePositiveInt(
      query.get("sessionsLimit") ?? query.get("sessions_limit"),
      320
    );
    const activityLimit = deps.parsePositiveInt(
      query.get("activityLimit") ?? query.get("activity_limit"),
      600
    );
    const decisionsLimit = deps.parsePositiveInt(
      query.get("decisionsLimit") ?? query.get("decisions_limit"),
      120
    );
    const initiative = query.get("initiative");
    const scope = resolveWorkspaceScope(query, headerScope, {
      allowProjectScope: false,
    });
    const projectId = scope.workspaceId;
    const run = query.get("run");
    const since = query.get("since");
    const decisionStatus = query.get("status") ?? "pending";
    const includeIdleRaw = query.get("include_idle");
    const includeIdle = includeIdleRaw === null ? undefined : includeIdleRaw !== "false";
    return {
      sessionsLimit,
      activityLimit,
      decisionsLimit,
      initiative,
      projectId,
      run,
      since,
      decisionStatus,
      includeIdle,
      scopeError: scope.error ?? null,
    };
  }

  const validateWorkspaceScope = (
    query: URLSearchParams,
    res: TRes,
    location: string,
    headerScope: Record<string, unknown> | null
  ): boolean => {
    const scope = resolveWorkspaceScope(query, headerScope, {
      allowProjectScope: false,
    });
    if (!scope.error) return true;
    deps.sendJson(res, 400, {
      error: scope.error,
      error_location: location,
    });
    return false;
  };

  async function buildSnapshotBundle(
    query: URLSearchParams,
    headerScope: Record<string, unknown> | null
  ): Promise<SnapshotBundle> {
    const parsed = parseSnapshotQuery(query, headerScope);
    const {
      sessionsLimit,
      activityLimit,
      decisionsLimit,
      initiative,
      projectId,
      run,
      since,
      decisionStatus,
      includeIdle,
      scopeError,
    } = parsed;
    if (scopeError) {
      throw new Error(scopeError);
    }

    const degraded: string[] = [];
    const contextStore = deps.readAgentContexts();
    const agentContexts = contextStore.agents;
    const runContexts = contextStore.runs ?? {};
    const scopedAgentIds = deps.getScopedAgentIds(agentContexts);
    const scopedProjectInitiativeIds =
      projectId && projectId.trim().length > 0
        ? new Set(await deps.listInitiativeIdsForProject({ projectId: projectId.trim() }))
        : null;

    let outboxStatus: Record<string, unknown>;
    try {
      const diagnosticsOutbox = await deps.readDiagnosticsOutboxStatus();
      if (diagnosticsOutbox) {
        outboxStatus = diagnosticsOutbox;
      } else {
        outboxStatus = outboxStatusFromSummary(await deps.readOutboxSummary());
      }
    } catch (err: unknown) {
      degraded.push(`outbox status unavailable (${deps.safeErrorMessage(err)})`);
      outboxStatus = emptyOutboxStatus();
    }

    let localSnapshot: LocalSnapshot | null = null;
    const ensureLocalSnapshot = async (minimumLimit: number) => {
      if (!localSnapshot || localSnapshot.sessions.length < minimumLimit) {
        localSnapshot = await deps.loadLocalOpenClawSnapshot(minimumLimit);
      }
      return localSnapshot;
    };

    const settled = await Promise.allSettled([
      withSoftTimeout(
        deps.getLiveSessions({
          initiative,
          projectId,
          limit: sessionsLimit,
        }),
        LIVE_SNAPSHOT_UPSTREAM_TIMEOUT_MS,
        "live sessions"
      ),
      withSoftTimeout(
        deps.getLiveActivity({
          run,
          since,
          projectId,
          limit: activityLimit,
        }),
        LIVE_SNAPSHOT_UPSTREAM_TIMEOUT_MS,
        "live activity"
      ),
      withSoftTimeout(
        deps.getHandoffs(),
        LIVE_SNAPSHOT_UPSTREAM_TIMEOUT_MS,
        "handoffs"
      ),
      withSoftTimeout(
        deps.getLiveDecisions({
          status: decisionStatus,
          projectId,
          limit: decisionsLimit,
        }),
        LIVE_SNAPSHOT_UPSTREAM_TIMEOUT_MS,
        "live decisions"
      ),
      withSoftTimeout(
        deps.getLiveAgents({
          initiative,
          projectId,
          includeIdle,
        }),
        LIVE_SNAPSHOT_UPSTREAM_TIMEOUT_MS,
        "live agents"
      ),
    ]);

    let sessions: SessionTreeResponse = {
      nodes: [],
      edges: [],
      groups: [],
    };
    const sessionsResult = settled[0];
    if (sessionsResult.status === "fulfilled") {
      sessions = sessionsResult.value;
    } else {
      degraded.push(`sessions unavailable (${deps.safeErrorMessage(sessionsResult.reason)})`);
      try {
        let local = deps.toLocalSessionTree(
          await ensureLocalSnapshot(Math.max(sessionsLimit, 200)),
          sessionsLimit
        );
        local = deps.applyAgentContextsToSessionTree(local, {
          agents: agentContexts,
          runs: runContexts,
        });
        sessions = filterSessionsByInitiative(local, initiative);
      } catch (localErr: unknown) {
        degraded.push(`sessions local fallback failed (${deps.safeErrorMessage(localErr)})`);
      }
    }

    let activity: LiveActivityItem[] = [];
    const activityResult = settled[1];
    if (activityResult.status === "fulfilled") {
      activity = Array.isArray(activityResult.value.activities)
        ? activityResult.value.activities
        : [];
    } else {
      degraded.push(`activity unavailable (${deps.safeErrorMessage(activityResult.reason)})`);
      try {
        const local = await deps.toLocalLiveActivity(
          await ensureLocalSnapshot(Math.max(activityLimit, 240)),
          Math.max(activityLimit, 240)
        );
        const filtered = maybeFilterActivity(local.activities, { run, since });
        const withContexts = deps.applyAgentContextsToActivity(filtered, {
          agents: agentContexts,
          runs: runContexts,
        });
        activity = withContexts.slice(0, activityLimit);
      } catch (localErr: unknown) {
        degraded.push(`activity local fallback failed (${deps.safeErrorMessage(localErr)})`);
      }
    }

    let handoffs: HandoffSummary[] = [];
    const handoffsResult = settled[2];
    if (handoffsResult.status === "fulfilled") {
      handoffs = Array.isArray(handoffsResult.value.handoffs)
        ? handoffsResult.value.handoffs
        : [];
    } else {
      degraded.push(`handoffs unavailable (${deps.safeErrorMessage(handoffsResult.reason)})`);
    }

    let decisions: Array<Record<string, unknown>> = [];
    const decisionsResult = settled[3];
    if (decisionsResult.status === "fulfilled") {
      decisions = decisionsResult.value.decisions
        .map(deps.mapDecisionEntity)
        .sort((a, b) => b.waitingMinutes - a.waitingMinutes) as Array<
        Record<string, unknown>
      >;
    } else {
      degraded.push(`decisions unavailable (${deps.safeErrorMessage(decisionsResult.reason)})`);
    }

    let agents: Array<Record<string, unknown>> = [];
    const agentsResult = settled[4];
    if (agentsResult.status === "fulfilled") {
      agents = Array.isArray(agentsResult.value.agents)
        ? (agentsResult.value.agents as Array<Record<string, unknown>>)
        : [];
    } else {
      degraded.push(`agents unavailable (${deps.safeErrorMessage(agentsResult.reason)})`);
      try {
        const local = deps.toLocalLiveAgents(await ensureLocalSnapshot(Math.max(sessionsLimit, 240)));
        let localAgents = local.agents;
        if (initiative && initiative.trim().length > 0) {
          localAgents = localAgents.filter((agent) => agent.initiativeId === initiative);
        }
        if (includeIdle === false) {
          localAgents = localAgents.filter((agent) => agent.status !== "idle");
        }
        agents = localAgents;
      } catch (localErr: unknown) {
        degraded.push(`agents local fallback failed (${deps.safeErrorMessage(localErr)})`);
      }
    }

    if (scopedAgentIds.size > 0) {
      try {
        const minimum = Math.max(Math.max(sessionsLimit, activityLimit), 240);
        const snapshot = await ensureLocalSnapshot(minimum);
        const scopedSnapshot = {
          ...snapshot,
          sessions: snapshot.sessions.filter(
            (session) => Boolean(session.agentId && scopedAgentIds.has(session.agentId))
          ),
          agents: snapshot.agents.filter((agent) => scopedAgentIds.has(agent.id)),
        };

        let localSessions = deps.applyAgentContextsToSessionTree(
          deps.toLocalSessionTree(scopedSnapshot, sessionsLimit),
          { agents: agentContexts, runs: runContexts }
        );
        localSessions = filterSessionsByInitiative(localSessions, initiative);
        sessions = deps.mergeSessionTrees(sessions, localSessions);

        const localActivity = await deps.toLocalLiveActivity(
          scopedSnapshot,
          Math.max(activityLimit, 240)
        );
        let localItems = deps.applyAgentContextsToActivity(localActivity.activities, {
          agents: agentContexts,
          runs: runContexts,
        });
        localItems = maybeFilterActivity(localItems, { run, since });
        activity = deps.mergeActivities(activity, localItems, activityLimit);
      } catch (err: unknown) {
        degraded.push(`local agent merge failed (${deps.safeErrorMessage(err)})`);
      }
    }

    try {
      const buffered = await deps.readOutboxItems();
      if (buffered.length > 0) {
        const merged = [...activity, ...buffered]
          .sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp))
          .slice(0, activityLimit);
        const deduped: LiveActivityItem[] = [];
        const seen = new Set<string>();
        for (const item of merged) {
          if (seen.has(item.id)) continue;
          seen.add(item.id);
          deduped.push(item);
        }
        activity = deduped;
      }
    } catch (err: unknown) {
      degraded.push(`outbox unavailable (${deps.safeErrorMessage(err)})`);
    }

    let runtimeInstances = deps.listRuntimeInstances({ limit: 320 });
    if (initiative && initiative.trim().length > 0) {
      runtimeInstances = runtimeInstances.filter((instance) => instance.initiativeId === initiative);
    }
    if (run && run.trim().length > 0) {
      runtimeInstances = runtimeInstances.filter(
        (instance) => instance.runId === run || instance.correlationId === run
      );
    }
    if (scopedProjectInitiativeIds) {
      sessions = filterSessionsByInitiativeSet(sessions, scopedProjectInitiativeIds);
      activity = filterActivityByInitiativeSet(activity, scopedProjectInitiativeIds);
      decisions = filterRecordsByInitiativeSet(decisions, scopedProjectInitiativeIds);
      agents = filterRecordsByInitiativeSet(agents, scopedProjectInitiativeIds);
      handoffs = filterHandoffsByInitiativeSet(handoffs, scopedProjectInitiativeIds);
      runtimeInstances = filterRuntimeInstancesByInitiativeSet(
        runtimeInstances,
        scopedProjectInitiativeIds
      );
    }
    sessions = deps.injectRuntimeInstancesAsSessions(sessions, runtimeInstances);
    sessions = deps.enrichSessionsWithRuntime(sessions, runtimeInstances);
    activity = deps.enrichActivityWithRuntime(activity, runtimeInstances);
    activity = deps.applyAgentContextsToActivity(activity, {
      agents: agentContexts,
      runs: runContexts,
    });
    activity = activity.filter((item) => !shouldHideActivityItem(item));
    sessions = normalizeReportingBlockedSessions({
      sessions,
      activity,
      runtimeInstances,
    });
    const sliceRuns = buildSliceRunProjections({
      activity,
      sessions: sessions.nodes,
      decisions,
      runtimeInstances,
    });

    try {
      const fingerprint = deps.snapshotActivityFingerprint(activity);
      const now = Date.now();
      const persistState = deps.readSnapshotPersistState();
      const shouldPersist =
        fingerprint !== persistState.lastFingerprint ||
        now - persistState.lastPersistAt >= deps.snapshotActivityPersistMinIntervalMs;
      if (shouldPersist) {
        deps.appendActivityItems(activity);
        deps.writeSnapshotPersistState({
          lastFingerprint: fingerprint,
          lastPersistAt: now,
        });
      }
    } catch {
      // best effort
    }

    const payload = {
      sessions,
      activity,
      handoffs,
      decisions,
      sliceRuns,
      agents,
      runtimeInstances,
      outbox: outboxStatus,
      generatedAt: new Date().toISOString(),
      projectId,
      degraded: degraded.length > 0 ? degraded : undefined,
    } as LegacySnapshotPayload;

    if (typeof deps.listChatThreads === "function") {
      try {
        const listed = deps.listChatThreads({
          commandCenterId: projectId,
          initiativeId: initiative,
          limit: 120,
          offset: 0,
        });
        payload.chat = {
          threads: listed.threads,
          total: listed.total,
          updatedAt: listed.updatedAt,
        };
      } catch (err: unknown) {
        degraded.push(`chat unavailable (${deps.safeErrorMessage(err)})`);
      }
    }

    let nextUpItems: Array<Record<string, unknown>> = [];
    if (typeof deps.buildNextUpQueue === "function") {
      try {
        const nextUp = await withSoftTimeout(
          deps.buildNextUpQueue({ initiativeId: initiative, projectId }),
          LIVE_SNAPSHOT_NEXT_UP_TIMEOUT_MS,
          "next-up queue"
        );
        nextUpItems = Array.isArray(nextUp.items)
          ? nextUp.items.filter((item): item is Record<string, unknown> => Boolean(item))
          : [];
        for (const warning of nextUp.degraded ?? []) {
          if (typeof warning !== "string" || warning.trim().length === 0) continue;
          degraded.push(`next-up ${warning}`);
        }
      } catch (err: unknown) {
        degraded.push(`next-up unavailable (${deps.safeErrorMessage(err)})`);
      }
    }

    const v2 = buildSliceExperienceSnapshotV2({
      generatedAt: payload.generatedAt,
      sliceRuns: payload.sliceRuns,
      sessions: payload.sessions.nodes,
      activity: payload.activity,
      runtimeInstances: payload.runtimeInstances,
      nextUpItems,
    });

    return {
      payload: {
        ...payload,
        degraded: degraded.length > 0 ? degraded : undefined,
      },
      v2,
      decisionsRaw: decisions,
    };
  }

  async function renderSnapshot(
    path: string,
    query: URLSearchParams,
    res: TRes,
    headerScope: Record<string, unknown> | null
  ): Promise<void> {
    if (!validateWorkspaceScope(query, res, "live.snapshot.validation", headerScope)) return;
    const snapshotCacheKey = `${path}?${query.toString()}`;
    const cachedSnapshot = deps.readSnapshotResponseCache(snapshotCacheKey);
    if (cachedSnapshot) {
      deps.sendJson(res, 200, cachedSnapshot);
      return;
    }
    const bundle = await buildSnapshotBundle(query, headerScope);
    deps.writeSnapshotResponseCache(snapshotCacheKey, bundle.payload as Record<string, unknown>);
    deps.sendJson(res, 200, bundle.payload);
  }

  async function renderSnapshotV2(
    path: string,
    query: URLSearchParams,
    res: TRes,
    headerScope: Record<string, unknown> | null
  ): Promise<void> {
    if (!validateWorkspaceScope(query, res, "live.snapshot-v2.validation", headerScope)) return;
    const snapshotCacheKey = `${path}?${query.toString()}`;
    const cachedSnapshot = deps.readSnapshotResponseCache(snapshotCacheKey);
    if (cachedSnapshot) {
      deps.sendJson(res, 200, cachedSnapshot);
      return;
    }

    const bundle = await buildSnapshotBundle(query, headerScope);
    const payload = {
      ...bundle.v2,
      sessions: bundle.payload.sessions,
      activity: bundle.payload.activity,
      handoffs: bundle.payload.handoffs,
      decisions: bundle.payload.decisions,
      sliceRuns: bundle.payload.sliceRuns,
      agents: bundle.payload.agents,
      runtimeInstances: bundle.payload.runtimeInstances,
      outbox: bundle.payload.outbox,
      chat: bundle.payload.chat,
      degraded: bundle.payload.degraded,
    } as Record<string, unknown>;
    deps.writeSnapshotResponseCache(snapshotCacheKey, payload);
    deps.sendJson(res, 200, payload);
  }

  async function renderSliceNarrative(
    path: string,
    query: URLSearchParams,
    res: TRes,
    headerScope: Record<string, unknown> | null
  ): Promise<void> {
    if (!validateWorkspaceScope(query, res, "live.snapshot.slice-narrative.validation", headerScope)) return;
    const narrativeMatch = path.match(/^slices\/([^/]+)\/narrative$/);
    const timelineMatch = path.match(/^slices\/([^/]+)\/timeline$/);
    const match = narrativeMatch ?? timelineMatch;
    if (!match) {
      deps.sendJson(res, 404, { error: "Unknown API endpoint" });
      return;
    }

    const sliceRunId = decodeURIComponent(match[1]).trim();
    if (!sliceRunId) {
      deps.sendJson(res, 400, { error: "sliceRunId is required." });
      return;
    }

    const bundle = await buildSnapshotBundle(query, headerScope);
    const narrative = findSliceNarrative(bundle.v2.timelineNarrative, sliceRunId);
    const projection =
      bundle.v2.projections.find((entry) => entry.sliceRunId === sliceRunId) ?? null;
    if (!narrative || !projection) {
      deps.sendJson(res, 404, { error: "Slice narrative not found." });
      return;
    }

    const chronology = bundle.payload.activity
      .filter((item) => {
        const activitySliceRunId = resolveActivitySliceRunId(item);
        if (activitySliceRunId === sliceRunId) return true;
        if (projection.runId && item.runId === projection.runId) return true;
        return false;
      })
      .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp))
      .map((item) => ({
        id: item.id,
        timestamp: item.timestamp,
        type: item.type,
        title: item.title,
        summary: item.summary ?? item.description ?? null,
        metadata: item.metadata ?? null,
      }));

    deps.sendJson(res, 200, {
      ok: true,
      sliceRunId,
      narrative,
      projection,
      chronology,
    });
  }

  async function renderSessionDetailV2(
    path: string,
    query: URLSearchParams,
    res: TRes,
    headerScope: Record<string, unknown> | null
  ): Promise<void> {
    if (!validateWorkspaceScope(query, res, "live.snapshot.session-detail.validation", headerScope)) return;
    const detailMatch = path.match(/^sessions\/([^/]+)\/detail-v2$/);
    if (!detailMatch) {
      deps.sendJson(res, 404, { error: "Unknown API endpoint" });
      return;
    }

    const sessionId = decodeURIComponent(detailMatch[1]).trim();
    if (!sessionId) {
      deps.sendJson(res, 400, { error: "sessionId is required." });
      return;
    }

    const bundle = await buildSnapshotBundle(query, headerScope);
    const projection = findSessionDetailProjection(bundle.v2.projections, sessionId);
    if (!projection) {
      deps.sendJson(res, 404, { error: "Session detail not found." });
      return;
    }

    const narrative = findSliceNarrative(bundle.v2.timelineNarrative, projection.sliceRunId);
    const chronology = bundle.payload.activity
      .filter((item) => {
        const activitySliceRunId = resolveActivitySliceRunId(item);
        if (activitySliceRunId === projection.sliceRunId) return true;
        if (projection.runId && item.runId === projection.runId) return true;
        if (item.runId && item.runId === sessionId) return true;
        return false;
      })
      .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp))
      .map((item) => ({
        id: item.id,
        timestamp: item.timestamp,
        type: item.type,
        title: item.title,
        summary: item.summary ?? item.description ?? null,
        metadata: item.metadata ?? null,
      }));

    deps.sendJson(res, 200, {
      ok: true,
      sessionId,
      activeSliceSummary: projection,
      initiativeBreakdown: {
        initiativeIds: projection.lineage.initiativeIds,
        initiativeTitles: projection.lineage.initiativeTitles,
        workstreamIds: projection.lineage.workstreamIds,
        workstreamTitles: projection.lineage.workstreamTitles,
        taskIds: projection.lineage.taskIds,
        milestoneIds: projection.lineage.milestoneIds,
        iwmtIds: projection.lineage.iwmtIds,
      },
      progressModel: {
        lifecycleState: projection.lifecycleState,
        outcomeState: projection.outcomeState,
        confidence: projection.confidence,
        statusExplainer: projection.statusExplainer,
      },
      artifactBundle: projection.artifacts,
      decisionAction: projection.actionContract,
      chronology,
      narrative,
    });
  }

  async function executeSliceAction(
    path: string,
    query: URLSearchParams,
    req: TReq,
    res: TRes,
    headerScope: Record<string, unknown> | null
  ): Promise<void> {
    if (!validateWorkspaceScope(query, res, "live.snapshot.slice-action.validation", headerScope)) return;
    const actionMatch = path.match(/^slices\/([^/]+)\/actions\/([^/]+)$/);
    if (!actionMatch) {
      deps.sendJson(res, 404, { error: "Unknown API endpoint" });
      return;
    }
    const sliceRunId = decodeURIComponent(actionMatch[1]).trim();
    const requestedAction = decodeURIComponent(actionMatch[2]).trim();
    const actionType = normalizeDecisionActionType(requestedAction);
    if (!sliceRunId) {
      deps.sendJson(res, 400, { error: "sliceRunId is required." });
      return;
    }
    if (!actionType) {
      deps.sendJson(res, 400, {
        error: "Action type is required.",
      });
      return;
    }

    const payload =
      typeof deps.parseJsonRequest === "function"
        ? await deps.parseJsonRequest(req)
        : {};
    const note = pickString(payload, ["note", "context", "reason"]);
    const optionId = pickString(payload, ["option_id", "optionId"]);

    const bundle = await buildSnapshotBundle(query, headerScope);
    const projection =
      bundle.v2.projections.find((entry) => entry.sliceRunId === sliceRunId) ?? null;
    if (!projection) {
      deps.sendJson(res, 404, { error: "Slice projection not found." });
      return;
    }

    const declaredAction = normalizeDecisionActionType(
      projection.actionContract?.actionType ?? null
    );
    if (declaredAction && declaredAction !== actionType && !(declaredAction === "open_artifact" && actionType === "open_artifact")) {
      deps.sendJson(res, 409, {
        error: "Action does not match current slice state.",
        expectedAction: declaredAction,
        requestedAction: actionType,
      });
      return;
    }

    if (actionType === "open_artifact") {
      const artifact = projection.artifacts[0] ?? null;
      if (!artifact) {
        deps.sendJson(res, 409, { error: "No artifact is available for this slice." });
        return;
      }
      deps.sendJson(res, 200, {
        ok: true,
        action: "open_artifact",
        sliceRunId,
        artifact,
      });
      return;
    }

    if (
      actionType === "retry" ||
      actionType === "resume" ||
      actionType === "start"
    ) {
      if (typeof deps.runAction !== "function") {
        deps.sendJson(res, 501, { error: "Run actions are not configured." });
        return;
      }
      const runId = projection.runId ?? projection.sliceRunId;
      const result = await deps.runAction(runId, "resume", {
        reason: note ?? `slice_action:${actionType}`,
      });
      deps.sendJson(res, 200, {
        ok: true,
        action: actionType,
        mappedAction: "resume",
        sliceRunId,
        runId,
        result,
      });
      return;
    }

    if (actionType === "approve" || actionType === "reject") {
      if (typeof deps.bulkDecideDecisions !== "function") {
        deps.sendJson(res, 501, { error: "Decision actions are not configured." });
        return;
      }
      const decisionAction: "approve" | "reject" =
        actionType === "approve" ? "approve" : "reject";
      const decisionIdsFromBody = Array.isArray(payload.decisionIds)
        ? payload.decisionIds
            .map((value) => (typeof value === "string" ? value.trim() : ""))
            .filter(Boolean)
        : [];
      const singleDecisionId = pickString(payload, ["decisionId", "decision_id"]);
      const decisionIds = Array.from(
        new Set([
          ...decisionIdsFromBody,
          ...(singleDecisionId ? [singleDecisionId] : []),
          ...resolveDecisionIdsForSlice(bundle.decisionsRaw, sliceRunId),
        ])
      );
      if (decisionIds.length === 0) {
        deps.sendJson(res, 400, {
          error: "No matching pending decision was found for this slice.",
        });
        return;
      }
      const results = await deps.bulkDecideDecisions(decisionIds, decisionAction, {
        note: note ?? undefined,
        optionId: optionId ?? undefined,
      });
      const updated = results.filter((entry) => entry.ok === true).length;
      const resolvedIds = results
        .map((entry, index) => {
          if (entry.ok !== true) return null;
          if (typeof entry.id === "string" && entry.id.trim().length > 0) {
            return entry.id.trim();
          }
          return decisionIds[index] ?? null;
        })
        .filter((id): id is string => typeof id === "string" && id.length > 0);
      if (updated > 0 && typeof deps.emitDecisionResolvedActivity === "function") {
        try {
          await deps.emitDecisionResolvedActivity({
            ids: resolvedIds.length > 0 ? resolvedIds : decisionIds,
            action: decisionAction,
            note: note ?? null,
            optionId: optionId ?? null,
            sliceRunId,
            initiativeId: projection.lineage.initiativeIds[0] ?? null,
          });
        } catch {
          // best effort; mutation already completed
        }
      }
      deps.sendJson(res, updated > 0 ? 200 : 207, {
        ok: updated > 0,
        action: decisionAction,
        sliceRunId,
        requested: decisionIds.length,
        updated,
        failed: decisionIds.length - updated,
        results,
      });
      return;
    }

    if (actionType === "provide_context") {
      deps.sendJson(res, 200, {
        ok: true,
        action: "provide_context",
        sliceRunId,
        note: note ?? null,
        message: note
          ? "Context captured for this slice."
          : "No note submitted. Provide a note to attach additional context.",
      });
      return;
    }

    deps.sendJson(res, 400, {
      error: "Unsupported action type.",
      actionType,
      supported: [
        "approve",
        "reject",
        "retry",
        "resume",
        "start",
        "open_artifact",
        "provide_context",
      ],
      knownActionTypes: KNOWN_DECISION_ACTION_TYPES,
    });
  }

  router.add(
    "GET",
    "dashboard-bundle",
    async ({ path, query, res, req }) =>
      renderSnapshot(path, query, res, headerScopeFromRequest(req)),
    "Live dashboard bundle"
  );
  router.add(
    "HEAD",
    "dashboard-bundle",
    async ({ path, query, res, req }) =>
      renderSnapshot(path, query, res, headerScopeFromRequest(req)),
    "Live dashboard bundle (HEAD)"
  );
  router.add(
    "GET",
    "live/snapshot",
    async ({ path, query, res, req }) =>
      renderSnapshot(path, query, res, headerScopeFromRequest(req)),
    "Live snapshot"
  );
  router.add(
    "HEAD",
    "live/snapshot",
    async ({ path, query, res, req }) =>
      renderSnapshot(path, query, res, headerScopeFromRequest(req)),
    "Live snapshot (HEAD)"
  );
  router.add(
    "GET",
    "live/snapshot-v2",
    async ({ path, query, res, req }) =>
      renderSnapshotV2(path, query, res, headerScopeFromRequest(req)),
    "Live snapshot (v2 projections)"
  );
  router.add(
    "HEAD",
    "live/snapshot-v2",
    async ({ path, query, res, req }) =>
      renderSnapshotV2(path, query, res, headerScopeFromRequest(req)),
    "Live snapshot (v2 projections, HEAD)"
  );
  router.add(
    "GET",
    "slices/*",
    async ({ path, query, res, req }) =>
      renderSliceNarrative(path, query, res, headerScopeFromRequest(req)),
    "Slice narrative/timeline projections"
  );
  router.add(
    "HEAD",
    "slices/*",
    async ({ path, query, res, req }) =>
      renderSliceNarrative(path, query, res, headerScopeFromRequest(req)),
    "Slice narrative/timeline projections (HEAD)"
  );
  router.add(
    "POST",
    "slices/*",
    async ({ path, query, req, res }) =>
      executeSliceAction(path, query, req, res, headerScopeFromRequest(req)),
    "Slice action contracts"
  );
  router.add(
    "GET",
    "sessions/*",
    async ({ path, query, res, req }) =>
      renderSessionDetailV2(path, query, res, headerScopeFromRequest(req)),
    "Session detail (v2 projections)"
  );
  router.add(
    "HEAD",
    "sessions/*",
    async ({ path, query, res, req }) =>
      renderSessionDetailV2(path, query, res, headerScopeFromRequest(req)),
    "Session detail (v2 projections, HEAD)"
  );
}
