import type { HandoffSummary, LiveActivityItem, SessionTreeResponse } from "../../types.js";
import type { RuntimeInstanceRecord } from "../../runtime-instance-store.js";
import type { OutboxSummary } from "../../outbox.js";
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

type LiveSnapshotRoutesDeps<TRes> = {
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
    limit: number;
  }) => Promise<SessionTreeResponse>;
  getLiveActivity: (input: {
    run: string | null;
    since: string | null;
    limit: number;
  }) => Promise<{ activities: LiveActivityItem[] }>;
  getHandoffs: () => Promise<{ handoffs: HandoffSummary[] }>;
  getLiveDecisions: (input: {
    status: string;
    limit: number;
  }) => Promise<{ decisions: unknown[] }>;
  getLiveAgents: (input: {
    initiative: string | null;
    includeIdle: boolean | undefined;
  }) => Promise<{ agents?: unknown[] }>;

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

  sendJson: (res: TRes, status: number, payload: unknown) => void;
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

export function registerLiveSnapshotRoutes<TReq, TRes>(
  router: Router<Record<string, never>, TReq, TRes>,
  deps: LiveSnapshotRoutesDeps<TRes>
): void {
  async function renderSnapshot(
    path: string,
    query: URLSearchParams,
    res: TRes
  ): Promise<void> {
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
    const run = query.get("run");
    const since = query.get("since");
    const decisionStatus = query.get("status") ?? "pending";
    const includeIdleRaw = query.get("include_idle");
    const includeIdle = includeIdleRaw === null ? undefined : includeIdleRaw !== "false";
    const snapshotCacheKey = `${path}?${query.toString()}`;
    const cachedSnapshot = deps.readSnapshotResponseCache(snapshotCacheKey);
    if (cachedSnapshot) {
      deps.sendJson(res, 200, cachedSnapshot);
      return;
    }

    const degraded: string[] = [];
    const contextStore = deps.readAgentContexts();
    const agentContexts = contextStore.agents;
    const runContexts = contextStore.runs ?? {};
    const scopedAgentIds = deps.getScopedAgentIds(agentContexts);

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
      deps.getLiveSessions({
        initiative,
        limit: sessionsLimit,
      }),
      deps.getLiveActivity({
        run,
        since,
        limit: activityLimit,
      }),
      deps.getHandoffs(),
      deps.getLiveDecisions({
        status: decisionStatus,
        limit: decisionsLimit,
      }),
      deps.getLiveAgents({
        initiative,
        includeIdle,
      }),
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
    sessions = deps.injectRuntimeInstancesAsSessions(sessions, runtimeInstances);
    sessions = deps.enrichSessionsWithRuntime(sessions, runtimeInstances);
    activity = deps.enrichActivityWithRuntime(activity, runtimeInstances);
    activity = deps.applyAgentContextsToActivity(activity, {
      agents: agentContexts,
      runs: runContexts,
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
      agents,
      runtimeInstances,
      outbox: outboxStatus,
      generatedAt: new Date().toISOString(),
      degraded: degraded.length > 0 ? degraded : undefined,
    } as Record<string, unknown>;
    deps.writeSnapshotResponseCache(snapshotCacheKey, payload);
    deps.sendJson(res, 200, payload);
  }

  router.add(
    "GET",
    "dashboard-bundle",
    async ({ path, query, res }) => renderSnapshot(path, query, res),
    "Live dashboard bundle"
  );
  router.add(
    "HEAD",
    "dashboard-bundle",
    async ({ path, query, res }) => renderSnapshot(path, query, res),
    "Live dashboard bundle (HEAD)"
  );
  router.add(
    "GET",
    "live/snapshot",
    async ({ path, query, res }) => renderSnapshot(path, query, res),
    "Live snapshot"
  );
  router.add(
    "HEAD",
    "live/snapshot",
    async ({ path, query, res }) => renderSnapshot(path, query, res),
    "Live snapshot (HEAD)"
  );
}
