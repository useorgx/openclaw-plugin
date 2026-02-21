import type { LiveActivityItem, SessionTreeResponse } from "../../types.js";
import type { RuntimeInstanceRecord } from "../../runtime-instance-store.js";
import { normalizeReportingBlockedSessions } from "../helpers/session-classification.js";
import type {
  AgentLaunchContext,
  RunLaunchContext,
} from "../../agent-context-store.js";
import type { Router } from "../router.js";

type LocalSnapshot = Awaited<
  ReturnType<typeof import("../../local-openclaw.js").loadLocalOpenClawSnapshot>
>;

type AgentContextBundle = {
  agents: Record<string, AgentLaunchContext>;
  runs?: Record<string, RunLaunchContext>;
};

type LocalLiveActivity = {
  activities: LiveActivityItem[];
  total: number;
};

type LiveActivityPage = {
  activities: LiveActivityItem[];
  cursor?: string | null;
  nextCursor?: string | null;
  prevCursor?: string | null;
  hasMore?: boolean;
};

type LiveSessionsResponse = SessionTreeResponse;

type LiveActivityResponse = {
  activities: LiveActivityItem[];
  total?: number;
} & Record<string, unknown>;

type LiveDetail = {
  detail: Record<string, unknown>;
};

type RouteReqLike = {
  on?: (event: string, listener: () => void) => void;
};

type RouteResLike = {
  write?: (chunk: string | Buffer) => boolean | void;
  writeHead: (statusCode: number, headers?: Record<string, string>) => unknown;
  end: (chunk?: string | Buffer) => void;
  writableEnded?: boolean;
  on?: (event: string, listener: () => void) => void;
  once?: (event: string, listener: () => void) => void;
};

type RegisterLiveLegacyRoutesDeps<TRes extends RouteResLike> = {
  getLiveSessions: (input: {
    initiative: string | null;
    projectId: string | null;
    limit: number | undefined;
  }) => Promise<LiveSessionsResponse>;
  getLiveActivity: (input: {
    run: string | null;
    since: string | null;
    projectId: string | null;
    limit: number | undefined;
  }) => Promise<LiveActivityResponse>;
  listInitiativeIdsForProject: (input: { projectId: string }) => Promise<string[]>;
  listRuntimeInstances: (input: { limit: number }) => RuntimeInstanceRecord[];
  injectRuntimeInstancesAsSessions: (
    input: SessionTreeResponse,
    instances: RuntimeInstanceRecord[]
  ) => SessionTreeResponse;
  enrichSessionsWithRuntime: (
    input: SessionTreeResponse,
    instances: RuntimeInstanceRecord[]
  ) => SessionTreeResponse;
  loadLocalOpenClawSnapshot: (limit: number) => Promise<LocalSnapshot>;
  toLocalSessionTree: (snapshot: LocalSnapshot, limit?: number) => SessionTreeResponse;
  readAgentContexts: () => AgentContextBundle;
  applyAgentContextsToSessionTree: (
    input: SessionTreeResponse,
    contexts: {
      agents: Record<string, AgentLaunchContext>;
      runs: Record<string, RunLaunchContext>;
    }
  ) => SessionTreeResponse;
  listActivityPage: (input: {
    limit: number;
    runId: string | null;
    since: string | null;
    until: string | null;
    cursor: string | null;
  }) => LiveActivityPage;
  applyAgentContextsToActivity: (
    input: LiveActivityItem[],
    contexts: {
      agents: Record<string, AgentLaunchContext>;
      runs: Record<string, RunLaunchContext>;
    }
  ) => LiveActivityItem[];
  appendActivityItems: (items: LiveActivityItem[]) => void;
  activityWarmByKey: Map<string, number>;
  activityWarmThrottleMs: number;
  outboxReadAllItems: () => Promise<LiveActivityItem[]>;
  toLocalLiveActivity: (snapshot: LocalSnapshot, limit?: number) => Promise<LocalLiveActivity>;
  loadLocalTurnDetail: (input: {
    turnId: string;
    sessionKey: string | null;
    runId: string | null;
  }) => Promise<Record<string, unknown> | null>;
  sendJson: (res: TRes, status: number, payload: unknown) => void;
  safeErrorMessage: (err: unknown) => string;

  sendHtml: (res: TRes, status: number, html: string) => void;
  resolveFilesystemOpenPath: (rawPath: string) => string;
  escapeHtml: (value: string) => string;
  statSync: (path: string) => { isDirectory: () => boolean; isFile: () => boolean; size: number };
  readdirSync: (path: string) => string[];
  existsSync: (path: string) => boolean;
  resolvePath: (...segments: string[]) => string;
  readFilePreview: (
    path: string,
    totalBytes: number
  ) => { previewBuffer: Buffer; truncated: boolean };
  filePreviewMaxBytes: number;
  filePreviewMaxDirEntries: number;
  securityHeaders: Record<string, string>;
  corsHeaders: Record<string, string>;

  config: {
    baseUrl: string;
    apiKey: string;
    userId: string;
  };
  isUserScopedApiKey: (apiKey: string) => boolean;
  streamIdleTimeoutMs: number;
};

function toContextBundle(value: AgentContextBundle): {
  agents: Record<string, AgentLaunchContext>;
  runs: Record<string, RunLaunchContext>;
} {
  return {
    agents: value.agents ?? {},
    runs: value.runs ?? {},
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

function resolveInitiativeIdFromActivity(item: LiveActivityItem): string | null {
  if (item.initiativeId && item.initiativeId.trim().length > 0) {
    return item.initiativeId.trim();
  }
  const metadata = asRecord(item.metadata);
  return pickString(metadata, ["initiative_id", "initiativeId"]);
}

function filterActivitiesByInitiativeSet(
  items: LiveActivityItem[],
  initiativeIds: Set<string>
): LiveActivityItem[] {
  if (initiativeIds.size === 0) return [];
  return items.filter((item) => {
    const initiativeId = resolveInitiativeIdFromActivity(item);
    return initiativeId ? initiativeIds.has(initiativeId) : false;
  });
}

export function registerLiveLegacyRoutes<
  TReq extends RouteReqLike,
  TRes extends RouteResLike,
>(
  router: Router<Record<string, never>, TReq, TRes>,
  deps: RegisterLiveLegacyRoutesDeps<TRes>
): void {
  async function resolveProjectInitiativeSet(
    projectIdRaw: string | null
  ): Promise<Set<string> | null> {
    const projectId = projectIdRaw?.trim() ?? "";
    if (!projectId) return null;
    const ids = await deps.listInitiativeIdsForProject({ projectId });
    return new Set(ids);
  }

  async function renderLiveSessions(query: URLSearchParams, res: TRes): Promise<void> {
    try {
      const initiative = query.get("initiative");
      const projectId = query.get("project_id") ?? query.get("projectId");
      const limit = query.get("limit") ? Number(query.get("limit")) : undefined;
      let data = await deps.getLiveSessions({
        initiative,
        projectId,
        limit: Number.isFinite(limit) ? limit : undefined,
      });
      const projectInitiatives = await resolveProjectInitiativeSet(projectId);
      if (projectInitiatives) {
        const filteredNodes = data.nodes.filter((node) => {
          const initiativeId = node.initiativeId?.trim() ?? "";
          return initiativeId.length > 0 && projectInitiatives.has(initiativeId);
        });
        const filteredNodeIds = new Set(filteredNodes.map((node) => node.id));
        const filteredGroupIds = new Set(filteredNodes.map((node) => node.groupId));
        data = {
          nodes: filteredNodes,
          edges: data.edges.filter(
            (edge) => filteredNodeIds.has(edge.parentId) && filteredNodeIds.has(edge.childId)
          ),
          groups: data.groups.filter((group) => filteredGroupIds.has(group.id)),
        };
      }
      const runtimeInstances =
        initiative && initiative.trim().length > 0
          ? deps
              .listRuntimeInstances({ limit: 320 })
              .filter((instance) => instance.initiativeId === initiative)
          : deps.listRuntimeInstances({ limit: 320 });
      const scopedRuntimeInstances = projectInitiatives
        ? runtimeInstances.filter((instance) => {
            const initiativeId = instance.initiativeId?.trim() ?? "";
            return initiativeId.length > 0 && projectInitiatives.has(initiativeId);
          })
        : runtimeInstances;
      data = deps.injectRuntimeInstancesAsSessions(data, scopedRuntimeInstances);
      data = deps.enrichSessionsWithRuntime(data, scopedRuntimeInstances);
      const contextBundle = toContextBundle(deps.readAgentContexts());
      let activityForClassification = deps.listActivityPage({
          limit: 1200,
          runId: null,
          since: null,
          until: null,
          cursor: null,
        }).activities;
      if (projectInitiatives) {
        activityForClassification = filterActivitiesByInitiativeSet(
          activityForClassification,
          projectInitiatives
        );
      }
      activityForClassification = deps.applyAgentContextsToActivity(activityForClassification, contextBundle);
      data = normalizeReportingBlockedSessions({
        sessions: data,
        activity: activityForClassification,
        runtimeInstances: scopedRuntimeInstances,
      });
      deps.sendJson(res, 200, data);
    } catch (err: unknown) {
      try {
        const initiative = query.get("initiative");
        const projectId = query.get("project_id") ?? query.get("projectId");
        const limitRaw = query.get("limit") ? Number(query.get("limit")) : undefined;
        const limit = Number.isFinite(limitRaw) ? Math.max(1, Number(limitRaw)) : 100;

        let local = deps.toLocalSessionTree(
          await deps.loadLocalOpenClawSnapshot(Math.max(limit, 200)),
          limit
        );
        const contextBundle = toContextBundle(deps.readAgentContexts());
        local = deps.applyAgentContextsToSessionTree(local, contextBundle);

        if (initiative && initiative.trim().length > 0) {
          const filteredNodes = local.nodes.filter(
            (node) => node.initiativeId === initiative || node.groupId === initiative
          );
          const filteredIds = new Set(filteredNodes.map((node) => node.id));
          const filteredGroupIds = new Set(filteredNodes.map((node) => node.groupId));

          local = {
            nodes: filteredNodes,
            edges: local.edges.filter(
              (edge) => filteredIds.has(edge.parentId) && filteredIds.has(edge.childId)
            ),
            groups: local.groups.filter((group) => filteredGroupIds.has(group.id)),
          };
        }

        const projectInitiatives = await resolveProjectInitiativeSet(projectId);
        if (projectInitiatives) {
          const filteredNodes = local.nodes.filter((node) => {
            const initiativeId = node.initiativeId?.trim() ?? "";
            return initiativeId.length > 0 && projectInitiatives.has(initiativeId);
          });
          const filteredIds = new Set(filteredNodes.map((node) => node.id));
          const filteredGroupIds = new Set(filteredNodes.map((node) => node.groupId));
          local = {
            nodes: filteredNodes,
            edges: local.edges.filter(
              (edge) => filteredIds.has(edge.parentId) && filteredIds.has(edge.childId)
            ),
            groups: local.groups.filter((group) => filteredGroupIds.has(group.id)),
          };
        }

        const runtimeInstances =
          initiative && initiative.trim().length > 0
            ? deps
                .listRuntimeInstances({ limit: 320 })
                .filter((instance) => instance.initiativeId === initiative)
            : deps.listRuntimeInstances({ limit: 320 });
        const scopedRuntimeInstances = projectInitiatives
          ? runtimeInstances.filter((instance) => {
              const initiativeId = instance.initiativeId?.trim() ?? "";
              return initiativeId.length > 0 && projectInitiatives.has(initiativeId);
            })
          : runtimeInstances;
        let localActivityForClassification = deps.listActivityPage({
          limit: 1200,
          runId: null,
          since: null,
          until: null,
          cursor: null,
        }).activities;
        if (projectInitiatives) {
          localActivityForClassification = filterActivitiesByInitiativeSet(
            localActivityForClassification,
            projectInitiatives
          );
        }
        local = normalizeReportingBlockedSessions({
          sessions: local,
          activity: deps.applyAgentContextsToActivity(localActivityForClassification, contextBundle),
          runtimeInstances: scopedRuntimeInstances,
        });

        deps.sendJson(res, 200, local);
      } catch (localErr: unknown) {
        deps.sendJson(res, 500, {
          error: deps.safeErrorMessage(err),
          localFallbackError: deps.safeErrorMessage(localErr),
        });
      }
    }
  }

  router.add(
    "GET",
    "live/sessions",
    async ({ query, res }) => renderLiveSessions(query, res),
    "Legacy live sessions endpoint"
  );
  router.add(
    "HEAD",
    "live/sessions",
    async ({ query, res }) => renderLiveSessions(query, res),
    "Legacy live sessions endpoint (HEAD)"
  );

  async function renderLiveActivityPage(query: URLSearchParams, res: TRes): Promise<void> {
    const run = query.get("run");
    const since = query.get("since");
    const until = query.get("until");
    const projectId = query.get("project_id") ?? query.get("projectId");
    const cursor = query.get("cursor");
    const limitRaw = query.get("limit") ? Number(query.get("limit")) : undefined;
    const limit = Number.isFinite(limitRaw)
      ? Math.max(1, Math.floor(Number(limitRaw)))
      : 200;

    let page = deps.listActivityPage({
      limit,
      runId: run,
      since,
      until,
      cursor,
    });
    const projectInitiatives = await resolveProjectInitiativeSet(projectId);
    if (projectInitiatives) {
      page = {
        ...page,
        activities: filterActivitiesByInitiativeSet(page.activities, projectInitiatives),
      };
    }
    {
      const ctx = toContextBundle(deps.readAgentContexts());
      page = {
        ...page,
        activities: deps.applyAgentContextsToActivity(page.activities, ctx),
      };
    }

    const warmKey = `${run ?? ""}::${since ?? ""}::${until ?? ""}`;
    const lastWarmAt = deps.activityWarmByKey.get(warmKey) ?? 0;
    const shouldWarm =
      Date.now() - lastWarmAt > deps.activityWarmThrottleMs &&
      (cursor === null || cursor === "" || page.activities.length < limit);

    if (shouldWarm) {
      deps.activityWarmByKey.set(warmKey, Date.now());
      try {
        const warmLimit = Math.max(800, Math.min(6_000, limit * 10));
        const data = await deps.getLiveActivity({
          run,
          since,
          projectId,
          limit: warmLimit,
        });
        const remote = Array.isArray(data.activities) ? data.activities : [];
        {
          const ctx = toContextBundle(deps.readAgentContexts());
          const scopedRemote = projectInitiatives
            ? filterActivitiesByInitiativeSet(remote, projectInitiatives)
            : remote;
          const withContexts = deps.applyAgentContextsToActivity(scopedRemote, ctx);
          deps.appendActivityItems(withContexts);
        }
        page = deps.listActivityPage({
          limit,
          runId: run,
          since,
          until,
          cursor,
        });
        if (projectInitiatives) {
          page = {
            ...page,
            activities: filterActivitiesByInitiativeSet(page.activities, projectInitiatives),
          };
        }
        {
          const ctx = toContextBundle(deps.readAgentContexts());
          page = {
            ...page,
            activities: deps.applyAgentContextsToActivity(page.activities, ctx),
          };
        }
      } catch {
        // best effort
      }
    }

    deps.sendJson(res, 200, page);
  }

  router.add(
    "GET",
    "live/activity/page",
    async ({ query, res }) => renderLiveActivityPage(query, res),
    "Paginated live activity"
  );
  router.add(
    "HEAD",
    "live/activity/page",
    async ({ query, res }) => renderLiveActivityPage(query, res),
    "Paginated live activity (HEAD)"
  );

  async function renderLiveActivity(query: URLSearchParams, res: TRes): Promise<void> {
    try {
      const run = query.get("run");
      const projectId = query.get("project_id") ?? query.get("projectId");
      const limit = query.get("limit") ? Number(query.get("limit")) : undefined;
      const since = query.get("since");
      const projectInitiatives = await resolveProjectInitiativeSet(projectId);
      const data = await deps.getLiveActivity({
        run,
        since,
        projectId,
        limit: Number.isFinite(limit) ? limit : undefined,
      });
      let activities = Array.isArray(data.activities) ? data.activities : [];
      if (projectInitiatives) {
        activities = filterActivitiesByInitiativeSet(activities, projectInitiatives);
      }
      let total =
        typeof data.total === "number" && Number.isFinite(data.total)
          ? Number(data.total)
          : activities.length;

      try {
        const buffered = await deps.outboxReadAllItems();
        if (buffered.length > 0) {
          const scopedBuffered = projectInitiatives
            ? filterActivitiesByInitiativeSet(buffered, projectInitiatives)
            : buffered;
          let merged = [...activities, ...scopedBuffered];

          if (run && run.trim().length > 0) {
            merged = merged.filter((item) => item.runId === run);
          }
          if (since && since.trim().length > 0) {
            const sinceEpoch = Date.parse(since);
            if (Number.isFinite(sinceEpoch)) {
              merged = merged.filter((item) => Date.parse(item.timestamp) >= sinceEpoch);
            }
          }

          merged.sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));
          const deduped: LiveActivityItem[] = [];
          const seen = new Set<string>();
          for (const item of merged) {
            if (seen.has(item.id)) continue;
            seen.add(item.id);
            deduped.push(item);
          }

          total = deduped.length;
          if (Number.isFinite(limit)) {
            const cap = Math.max(1, Math.floor(Number(limit)));
            activities = deduped.slice(0, cap);
          } else {
            activities = deduped;
          }
        }
      } catch {
        // best effort
      }

      try {
        const ctx = toContextBundle(deps.readAgentContexts());
        const withContexts = deps.applyAgentContextsToActivity(activities, ctx);
        if (withContexts.length > 0) deps.appendActivityItems(withContexts);
        deps.sendJson(res, 200, { ...data, activities: withContexts, total });
      } catch {
        deps.sendJson(res, 200, { ...data, activities, total });
      }
    } catch (err: unknown) {
      try {
        const run = query.get("run");
        const projectId = query.get("project_id") ?? query.get("projectId");
        const limitRaw = query.get("limit") ? Number(query.get("limit")) : undefined;
        const since = query.get("since");
        const projectInitiatives = await resolveProjectInitiativeSet(projectId);
        const limit = Number.isFinite(limitRaw) ? Math.max(1, Number(limitRaw)) : 240;

        const localSnapshot = await deps.loadLocalOpenClawSnapshot(Math.max(limit, 240));
        let local = await deps.toLocalLiveActivity(localSnapshot, Math.max(limit, 240));

        if (run && run.trim().length > 0) {
          local = {
            activities: local.activities.filter((item) => item.runId === run),
            total: local.activities.filter((item) => item.runId === run).length,
          };
        }

        if (since && since.trim().length > 0) {
          const sinceEpoch = Date.parse(since);
          if (Number.isFinite(sinceEpoch)) {
            const filtered = local.activities.filter(
              (item) => Date.parse(item.timestamp) >= sinceEpoch
            );
            local = {
              activities: filtered,
              total: filtered.length,
            };
          }
        }
        if (projectInitiatives) {
          const projectFiltered = filterActivitiesByInitiativeSet(
            local.activities,
            projectInitiatives
          );
          local = {
            activities: projectFiltered,
            total: projectFiltered.length,
          };
        }

        const ctx = toContextBundle(deps.readAgentContexts());
        const activitiesWithContexts = deps.applyAgentContextsToActivity(local.activities, ctx);
        let merged = activitiesWithContexts;
        try {
          const buffered = await deps.outboxReadAllItems();
          if (buffered.length > 0) {
            const scopedBuffered = projectInitiatives
              ? filterActivitiesByInitiativeSet(buffered, projectInitiatives)
              : buffered;
            const byId = new Map<string, LiveActivityItem>();
            for (const item of [...merged, ...scopedBuffered]) {
              if (!item || typeof item.id !== "string") continue;
              byId.set(item.id, item);
            }
            merged = Array.from(byId.values()).sort(
              (a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp)
            );
          }
        } catch {
          // best effort
        }
        try {
          deps.appendActivityItems(merged);
        } catch {
          // best effort
        }
        deps.sendJson(res, 200, {
          activities: merged.slice(0, limit),
          total: merged.length,
        });
      } catch (localErr: unknown) {
        deps.sendJson(res, 500, {
          error: deps.safeErrorMessage(err),
          localFallbackError: deps.safeErrorMessage(localErr),
        });
      }
    }
  }

  router.add(
    "GET",
    "live/activity",
    async ({ query, res }) => renderLiveActivity(query, res),
    "Legacy live activity endpoint"
  );
  router.add(
    "HEAD",
    "live/activity",
    async ({ query, res }) => renderLiveActivity(query, res),
    "Legacy live activity endpoint (HEAD)"
  );

  async function renderLiveActivityDetail(query: URLSearchParams, res: TRes): Promise<void> {
    const turnId = query.get("turnId") ?? query.get("turn_id");
    const sessionKey = query.get("sessionKey") ?? query.get("session_key");
    const run = query.get("run");

    if (!turnId || turnId.trim().length === 0) {
      deps.sendJson(res, 400, { error: "turnId is required" });
      return;
    }

    try {
      const detail = await deps.loadLocalTurnDetail({
        turnId,
        sessionKey,
        runId: run,
      });
      if (!detail) {
        deps.sendJson(res, 404, {
          error: "Turn detail unavailable",
          turnId,
        });
        return;
      }
      deps.sendJson(res, 200, { detail } satisfies LiveDetail);
    } catch (err: unknown) {
      deps.sendJson(res, 500, { error: deps.safeErrorMessage(err), turnId });
    }
  }

  router.add(
    "GET",
    "live/activity/detail",
    async ({ query, res }) => renderLiveActivityDetail(query, res),
    "Detailed activity turn view"
  );
  router.add(
    "HEAD",
    "live/activity/detail",
    async ({ query, res }) => renderLiveActivityDetail(query, res),
    "Detailed activity turn view (HEAD)"
  );

  router.add(
    "GET",
    "live/filesystem/open",
    ({ query, res }) => {
      const rawPath = query.get("path") ?? "";
      if (!rawPath.trim()) {
        deps.sendJson(res, 400, { error: "path is required" });
        return;
      }

      const pathInput = rawPath.trim();
      if (/^https?:\/\//i.test(pathInput)) {
        res.writeHead(302, {
          Location: pathInput,
          ...deps.securityHeaders,
          ...deps.corsHeaders,
        });
        res.end();
        return;
      }

      const resolvedPath = deps.resolveFilesystemOpenPath(pathInput);
      const escapedInput = deps.escapeHtml(pathInput);
      const escapedResolved = deps.escapeHtml(resolvedPath);
      const shellPath = resolvedPath.replaceAll("'", "'\\''");

      if (!deps.existsSync(resolvedPath)) {
        deps.sendHtml(
          res,
          404,
          `<!doctype html><html><head><meta charset="utf-8"/><title>Path Not Found</title><style>body{margin:0;padding:24px;background:#080808;color:#e5e7eb;font:14px/1.5 ui-sans-serif,system-ui,-apple-system,Segoe UI,sans-serif}pre{background:#0f0f0f;border:1px solid rgba(255,255,255,.08);padding:12px;border-radius:10px;white-space:pre-wrap;word-break:break-word}a{color:#BFFF00}</style></head><body><h1 style="margin:0 0 8px;font-size:18px;">Path not found</h1><p style="margin:0 0 12px;color:#9ca3af;">The evidence path no longer exists.</p><pre>${escapedInput}</pre><p style="margin:12px 0 0;color:#9ca3af;">Resolved as:</p><pre>${escapedResolved}</pre></body></html>`
        );
        return;
      }

      try {
        const stats = deps.statSync(resolvedPath);
        if (stats.isDirectory()) {
          const entries = deps.readdirSync(resolvedPath);
          const visibleEntries = entries.slice(0, deps.filePreviewMaxDirEntries);
          const items = visibleEntries
            .map((name) => {
              const nextPath = deps.resolvePath(resolvedPath, name);
              const href = `/orgx/api/live/filesystem/open?path=${encodeURIComponent(nextPath)}`;
              return `<li style="margin:0 0 6px;"><a href="${href}" target="_blank" rel="noreferrer" style="color:#BFFF00;text-decoration:none;">${deps.escapeHtml(name)}</a></li>`;
            })
            .join("");
          const overflowNote =
            entries.length > visibleEntries.length
              ? `<p style="margin:12px 0 0;color:#9ca3af;">Showing ${visibleEntries.length} of ${entries.length} entries.</p>`
              : "";

          deps.sendHtml(
            res,
            200,
            `<!doctype html><html><head><meta charset="utf-8"/><title>Directory Preview</title><style>body{margin:0;padding:24px;background:#080808;color:#e5e7eb;font:14px/1.5 ui-sans-serif,system-ui,-apple-system,Segoe UI,sans-serif}pre,ul{background:#0f0f0f;border:1px solid rgba(255,255,255,.08);padding:12px;border-radius:10px}ul{list-style:none;margin:0;max-height:70vh;overflow:auto}pre{white-space:pre-wrap;word-break:break-word}code{color:#7dd3c0}</style></head><body><h1 style="margin:0 0 8px;font-size:18px;">Directory</h1><p style="margin:0 0 12px;color:#9ca3af;">${escapedResolved}</p><ul>${items || "<li style=\"color:#9ca3af;\">(empty)</li>"}</ul>${overflowNote}<p style="margin:12px 0 0;color:#9ca3af;">Tip: open in terminal with <code>ls -la '${deps.escapeHtml(shellPath)}'</code></p></body></html>`
          );
          return;
        }

        if (!stats.isFile()) {
          deps.sendHtml(
            res,
            200,
            `<!doctype html><html><head><meta charset="utf-8"/><title>Unsupported Path</title><style>body{margin:0;padding:24px;background:#080808;color:#e5e7eb;font:14px/1.5 ui-sans-serif,system-ui,-apple-system,Segoe UI,sans-serif}pre{background:#0f0f0f;border:1px solid rgba(255,255,255,.08);padding:12px;border-radius:10px;white-space:pre-wrap;word-break:break-word}</style></head><body><h1 style="margin:0 0 8px;font-size:18px;">Unsupported path type</h1><p style="margin:0 0 12px;color:#9ca3af;">Only files and directories are previewable.</p><pre>${escapedResolved}</pre></body></html>`
          );
          return;
        }

        const totalBytes = Number.isFinite(stats.size) ? Math.max(0, stats.size) : 0;
        const { previewBuffer, truncated } = deps.readFilePreview(resolvedPath, totalBytes);
        const isBinary = previewBuffer.includes(0);
        const sizeLabel = `${totalBytes.toLocaleString()} bytes`;

        if (isBinary) {
          deps.sendHtml(
            res,
            200,
            `<!doctype html><html><head><meta charset="utf-8"/><title>Binary File</title><style>body{margin:0;padding:24px;background:#080808;color:#e5e7eb;font:14px/1.5 ui-sans-serif,system-ui,-apple-system,Segoe UI,sans-serif}pre{background:#0f0f0f;border:1px solid rgba(255,255,255,.08);padding:12px;border-radius:10px;white-space:pre-wrap;word-break:break-word}code{color:#7dd3c0}</style></head><body><h1 style="margin:0 0 8px;font-size:18px;">Binary file</h1><p style="margin:0 0 12px;color:#9ca3af;">Cannot render binary content in browser preview.</p><pre>${escapedResolved}\n${deps.escapeHtml(sizeLabel)}</pre><p style="margin:12px 0 0;color:#9ca3af;">Inspect in terminal with <code>file '${deps.escapeHtml(shellPath)}'</code></p></body></html>`
          );
          return;
        }

        const previewText = previewBuffer.toString("utf8");
        const truncationNote = truncated
          ? `<p style="margin:12px 0 0;color:#9ca3af;">Preview truncated to first ${deps.filePreviewMaxBytes.toLocaleString()} bytes.</p>`
          : "";

        deps.sendHtml(
          res,
          200,
          `<!doctype html><html><head><meta charset="utf-8"/><title>File Preview</title><style>body{margin:0;padding:24px;background:#080808;color:#e5e7eb;font:14px/1.5 ui-sans-serif,system-ui,-apple-system,Segoe UI,sans-serif}pre{background:#0f0f0f;border:1px solid rgba(255,255,255,.08);padding:12px;border-radius:10px;white-space:pre;overflow:auto;max-height:75vh}code{color:#7dd3c0}</style></head><body><h1 style="margin:0 0 8px;font-size:18px;">File preview</h1><p style="margin:0 0 12px;color:#9ca3af;">${escapedResolved}</p><p style="margin:0 0 12px;color:#9ca3af;">${deps.escapeHtml(sizeLabel)}</p><pre>${deps.escapeHtml(previewText)}</pre>${truncationNote}<p style="margin:12px 0 0;color:#9ca3af;">Open in terminal with <code>cat '${deps.escapeHtml(shellPath)}'</code></p></body></html>`
        );
      } catch (err: unknown) {
        deps.sendHtml(
          res,
          500,
          `<!doctype html><html><head><meta charset="utf-8"/><title>Preview Error</title><style>body{margin:0;padding:24px;background:#080808;color:#e5e7eb;font:14px/1.5 ui-sans-serif,system-ui,-apple-system,Segoe UI,sans-serif}pre{background:#0f0f0f;border:1px solid rgba(255,255,255,.08);padding:12px;border-radius:10px;white-space:pre-wrap;word-break:break-word}</style></head><body><h1 style="margin:0 0 8px;font-size:18px;">Unable to preview path</h1><p style="margin:0 0 12px;color:#9ca3af;">${deps.escapeHtml(deps.safeErrorMessage(err))}</p><pre>${escapedResolved}</pre></body></html>`
        );
      }
    },
    "Open filesystem evidence path"
  );
  router.add(
    "*",
    "live/filesystem/open",
    ({ res }) => {
      deps.sendJson(res, 405, { error: "Use GET /orgx/api/live/filesystem/open?path=..." });
    },
    "Reject unsupported methods for live/filesystem/open"
  );

  async function renderLiveStream(query: URLSearchParams, req: TReq, res: TRes): Promise<void> {
    const write = res.write?.bind(res);
    if (!write) {
      deps.sendJson(res, 501, { error: "Streaming not supported" });
      return;
    }
    const queryString = query.toString();
    const target = `${deps.config.baseUrl.replace(/\/+$/, "")}/api/client/live/stream${
      queryString ? `?${queryString}` : ""
    }`;
    let upstreamAbortController: AbortController | null = null;
    let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
    let closed = false;
    let streamOpened = false;
    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
    let heartbeatBackpressure = false;
    const sseDecoder = new TextDecoder("utf-8");
    let sseBuffer = "";

    const consumeSseText = (chunk: string) => {
      if (!chunk) return;
      sseBuffer += chunk.replace(/\r\n/g, "\n");

      while (true) {
        const boundary = sseBuffer.indexOf("\n\n");
        if (boundary === -1) return;
        const rawEvent = sseBuffer.slice(0, boundary);
        sseBuffer = sseBuffer.slice(boundary + 2);

        const lines = rawEvent.split("\n").map((l) => l.replace(/\r$/, ""));
        let eventName: string | null = null;
        const dataLines: string[] = [];

        for (const line of lines) {
          if (!line) continue;
          if (line.startsWith(":")) continue;
          if (line.startsWith("event:")) {
            eventName = line.slice("event:".length).trim() || null;
            continue;
          }
          if (line.startsWith("data:")) {
            dataLines.push(line.slice("data:".length).trimStart());
            continue;
          }
        }

        if (!eventName || dataLines.length === 0) continue;

        const dataText = dataLines.join("\n").trim();
        if (!dataText) continue;

        try {
          if (eventName === "activity.appended") {
            const parsed = JSON.parse(dataText) as LiveActivityItem[];
            const list = Array.isArray(parsed) ? parsed : [];
            if (list.length > 0) {
              const ctx = toContextBundle(deps.readAgentContexts());
              deps.appendActivityItems(deps.applyAgentContextsToActivity(list, ctx));
            }
          } else if (eventName === "snapshot") {
            const parsed = JSON.parse(dataText) as { activity?: LiveActivityItem[] };
            const list = Array.isArray(parsed?.activity) ? parsed.activity : [];
            if (list.length > 0) {
              const ctx = toContextBundle(deps.readAgentContexts());
              deps.appendActivityItems(deps.applyAgentContextsToActivity(list, ctx));
            }
          }
        } catch {
          // ignore malformed payloads
        }
      }
    };

    const clearIdleTimer = () => {
      if (idleTimer) {
        clearTimeout(idleTimer);
        idleTimer = null;
      }
    };

    const clearHeartbeatTimer = () => {
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }
    };

    const abortUpstream = () => {
      try {
        upstreamAbortController?.abort();
      } catch {
        // best effort
      }
      upstreamAbortController = null;
    };

    const closeStream = () => {
      if (closed) return;
      closed = true;
      clearIdleTimer();
      clearHeartbeatTimer();
      abortUpstream();
      if (reader) {
        void reader.cancel().catch(() => undefined);
      }
      if (streamOpened && !res.writableEnded) {
        res.end();
      }
    };

    const resetIdleTimer = () => {
      clearIdleTimer();
      idleTimer = setTimeout(() => {
        closeStream();
      }, deps.streamIdleTimeoutMs);
    };

    try {
      const includeUserHeader =
        Boolean(deps.config.userId && deps.config.userId.trim().length > 0) &&
        !deps.isUserScopedApiKey(deps.config.apiKey);
      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        ...deps.securityHeaders,
        ...deps.corsHeaders,
      });
      streamOpened = true;

      heartbeatTimer = setInterval(() => {
        if (closed || heartbeatBackpressure) return;
        try {
          const accepted = write(Buffer.from(`: ping ${Date.now()}\n`, "utf8"));
          resetIdleTimer();
          if (accepted === false) {
            heartbeatBackpressure = true;
            if (typeof res.once === "function") {
              res.once("drain", () => {
                heartbeatBackpressure = false;
                if (!closed) resetIdleTimer();
              });
            }
          }
        } catch {
          closeStream();
        }
      }, 20_000);
      heartbeatTimer.unref?.();

      req.on?.("close", closeStream);
      req.on?.("aborted", closeStream);
      res.on?.("close", closeStream);
      res.on?.("finish", closeStream);

      const waitForDrain = async (): Promise<void> => {
        if (typeof res.once === "function") {
          await new Promise<void>((resolve) => {
            res.once?.("drain", () => resolve());
          });
        }
      };

      const sleep = async (ms: number): Promise<void> => {
        await new Promise<void>((resolve) => setTimeout(resolve, ms));
      };

      const connectAndPump = async () => {
        let attempt = 0;
        while (!closed) {
          abortUpstream();
          upstreamAbortController = new AbortController();

          let upstream: Response | null = null;
          try {
            upstream = await fetch(target, {
              method: "GET",
              headers: {
                Authorization: `Bearer ${deps.config.apiKey}`,
                Accept: "text/event-stream",
                ...(includeUserHeader ? { "X-Orgx-User-Id": deps.config.userId } : {}),
              },
              signal: upstreamAbortController.signal,
            });
          } catch {
            upstream = null;
          }

          const contentType = upstream?.headers.get("content-type")?.toLowerCase() ?? "";
          if (
            !upstream ||
            !upstream.ok ||
            !contentType.includes("text/event-stream") ||
            !upstream.body
          ) {
            const status = upstream?.status ?? null;
            const preview = upstream
              ? (await upstream.text().catch(() => ""))
                  .replace(/\s+/g, " ")
                  .slice(0, 200)
              : null;
            try {
              write(
                Buffer.from(
                  `: upstream unavailable status=${status ?? "error"} ${
                    preview ? `preview=${JSON.stringify(preview)}` : ""
                  }\n`,
                  "utf8"
                )
              );
            } catch {
              closeStream();
              return;
            }

            resetIdleTimer();
            attempt += 1;
            const backoffMs = Math.min(15_000, 750 * Math.pow(1.6, Math.min(attempt, 10)));
            await sleep(backoffMs);
            continue;
          }

          attempt = 0;
          reader = upstream.body.getReader();
          const streamReader = reader;
          resetIdleTimer();

          try {
            while (!closed) {
              const { done, value } = await streamReader.read();
              if (done) break;
              if (!value || value.byteLength === 0) continue;

              resetIdleTimer();
              try {
                consumeSseText(sseDecoder.decode(value, { stream: true }));
              } catch {
                // best effort
              }
              const accepted = write(Buffer.from(value));
              if (accepted === false) {
                await waitForDrain();
              }
            }
          } catch {
            // swallow; we'll reconnect unless the client is gone
          } finally {
            try {
              await streamReader.cancel();
            } catch {
              // ignore
            }
            if (reader === streamReader) {
              reader = null;
            }
          }

          if (!closed) {
            await sleep(300);
          }
        }
      };

      void connectAndPump();
    } catch (err: unknown) {
      closeStream();
      if (!streamOpened && !res.writableEnded) {
        deps.sendJson(res, 500, {
          error: deps.safeErrorMessage(err),
        });
      }
    }
  }

  router.add(
    "GET",
    "live/stream",
    async ({ query, req, res }) => renderLiveStream(query, req, res),
    "Proxy live SSE stream"
  );
  router.add(
    "HEAD",
    "live/stream",
    async ({ query, req, res }) => renderLiveStream(query, req, res),
    "Proxy live SSE stream (HEAD)"
  );
}
