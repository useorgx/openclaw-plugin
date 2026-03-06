import type { LiveActivityItem, SessionTreeResponse } from "../../types.js";
import type { RuntimeInstanceRecord } from "../../runtime-instance-store.js";
import type {
  AgentLaunchContext,
  RunLaunchContext,
} from "../../agent-context-store.js";
import { resolveWorkspaceScope } from "../helpers/workspace-scope.js";
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

type RegisterLiveLegacyRoutesDeps<TReq extends RouteReqLike, TRes extends RouteResLike> = {
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
  summarizeActivityHeadline: (input: {
    text: string;
    title: string | null;
    type: string | null;
  }) => Promise<{ headline: string; source: string; model: string | null }>;
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
  resolveAutopilotLogCandidates?: (runId: string) => string[];
  openPathInTerminal?: (path: string) => Promise<void>;
  securityHeaders: Record<string, string>;
  corsHeaders: Record<string, string>;

  config: {
    baseUrl: string;
    apiKey: string;
    userId: string;
  };
  isUserScopedApiKey: (apiKey: string) => boolean;
  streamIdleTimeoutMs: number;
  renderLiveStreamV2?: (input: {
    path: string;
    query: URLSearchParams;
    req: TReq;
    res: TRes;
  }) => Promise<void>;
};

export function registerLiveLegacyRoutes<
  TReq extends RouteReqLike,
  TRes extends RouteResLike,
>(
  router: Router<Record<string, never>, TReq, TRes>,
  deps: RegisterLiveLegacyRoutesDeps<TReq, TRes>
): void {
  function toContextBundle(value: AgentContextBundle): {
    agents: Record<string, AgentLaunchContext>;
    runs: Record<string, RunLaunchContext>;
  } {
    return {
      agents: value.agents ?? {},
      runs: value.runs ?? {},
    };
  }

  const sendDeprecated = (
    res: TRes,
    endpoint: string,
    replacement: string
  ) => {
    deps.sendJson(res, 410, {
      error: `${endpoint} is deprecated`,
      replacement,
      required_scope: "workspace_id",
    });
  };

  async function renderLiveSessions(query: URLSearchParams, res: TRes): Promise<void> {
    sendDeprecated(res, "/orgx/api/live/sessions", "/orgx/api/live/snapshot");
    void query;
    return;
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
    const cursor = query.get("cursor");
    const projectId =
      resolveWorkspaceScope(query, null, { allowProjectScope: true }).workspaceId ??
      null;
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
    {
      const ctx = toContextBundle(deps.readAgentContexts());
      page = {
        ...page,
        activities: deps.applyAgentContextsToActivity(page.activities, ctx),
      };
    }

    const warmKey = `${projectId ?? ""}::${run ?? ""}::${since ?? ""}::${until ?? ""}`;
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
          const withContexts = deps.applyAgentContextsToActivity(remote, ctx);
          deps.appendActivityItems(withContexts);
        }
        page = deps.listActivityPage({
          limit,
          runId: run,
          since,
          until,
          cursor,
        });
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
    sendDeprecated(res, "/orgx/api/live/activity", "/orgx/api/live/snapshot");
    void query;
    return;
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
    try {
      const turnId = (query.get("turnId") ?? "").trim();
      if (!turnId) {
        deps.sendJson(res, 400, { error: "turnId is required" });
        return;
      }

      const sessionKey = (query.get("sessionKey") ?? "").trim() || null;
      const runId = (query.get("run") ?? query.get("runId") ?? "").trim() || null;
      const detail = await deps.loadLocalTurnDetail({ turnId, sessionKey, runId });
      if (!detail) {
        deps.sendJson(res, 404, { error: "activity detail not found" });
        return;
      }

      const summary =
        typeof detail.summary === "string" && detail.summary.trim().length > 0
          ? detail.summary.trim()
          : null;
      if (!summary) {
        deps.sendJson(res, 200, { detail, headline: null, headlineSource: null, headlineModel: null });
        return;
      }

      const headline = await deps.summarizeActivityHeadline({
        text: summary,
        title: null,
        type: "activity",
      });

      deps.sendJson(res, 200, {
        detail,
        headline: headline.headline,
        headlineSource: headline.source,
        headlineModel: headline.model,
      });
    } catch (err: unknown) {
      deps.sendJson(res, 500, { error: deps.safeErrorMessage(err) });
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

  router.add(
    "POST",
    "live/terminal/open",
    async ({ body, res }) => {
      const payload =
        body && typeof body === "object" && !Array.isArray(body)
          ? (body as Record<string, unknown>)
          : {};
      const runId =
        typeof payload.runId === "string" ? payload.runId.trim() : "";
      const rawPath =
        typeof payload.path === "string" ? payload.path.trim() : "";

      if (!runId && !rawPath) {
        deps.sendJson(res, 400, {
          ok: false,
          error: "runId or path is required",
        });
        return;
      }

      let resolvedPath = "";
      if (rawPath) {
        resolvedPath = deps.resolveFilesystemOpenPath(rawPath);
      } else if (runId) {
        const candidates = deps.resolveAutopilotLogCandidates
          ? deps.resolveAutopilotLogCandidates(runId)
          : [];
        resolvedPath =
          candidates.find((candidate) => deps.existsSync(candidate)) ?? "";
      }

      if (!resolvedPath || !deps.existsSync(resolvedPath)) {
        deps.sendJson(res, 404, {
          ok: false,
          error: "Terminal target not found",
        });
        return;
      }

      if (!deps.openPathInTerminal) {
        deps.sendJson(res, 501, {
          ok: false,
          error: "Terminal open is unavailable in this runtime.",
        });
        return;
      }

      try {
        await deps.openPathInTerminal(resolvedPath);
        deps.sendJson(res, 200, {
          ok: true,
          path: resolvedPath,
        });
      } catch (err: unknown) {
        deps.sendJson(res, 500, {
          ok: false,
          error: deps.safeErrorMessage(err),
        });
      }
    },
    "Open run logs in local terminal"
  );
  router.add(
    "*",
    "live/terminal/open",
    ({ res }) => {
      deps.sendJson(res, 405, {
        ok: false,
        error: "Use POST /orgx/api/live/terminal/open",
      });
    },
    "Reject unsupported methods for live/terminal/open"
  );

  async function renderLiveStream(query: URLSearchParams, req: TReq, res: TRes): Promise<void> {
    if (typeof deps.renderLiveStreamV2 === "function") {
      await deps.renderLiveStreamV2({
        path: "live/stream",
        query,
        req,
        res,
      });
      return;
    }
    const suffix = query.toString();
    const location = suffix
      ? `/orgx/api/live/stream-v2?${suffix}`
      : "/orgx/api/live/stream-v2";
    res.writeHead(307, {
      Location: location,
      Deprecation: "true",
      Link: `</orgx/api/live/stream-v2>; rel="successor-version"`,
    });
    res.end();
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

  router.add(
    "POST",
    "live/terminal/open",
    async ({ body, res }) => {
      try {
        const payload = (typeof body === "string" ? JSON.parse(body) : body) as { runId?: string };
        const runId = payload?.runId;
        if (!runId) {
          deps.sendJson(res, 400, { error: "runId is required" });
          return;
        }

        const os = await import("os");
        const cp = await import("child_process");
        const path = await import("path");
        const homedir = os.homedir();
        const logPath = path.join(homedir, ".config", "useorgx", "openclaw-plugin", "autopilot-logs", `${runId}.log`);
        
        if (!deps.existsSync(logPath)) {
          deps.sendJson(res, 404, { error: `Log file not found: ${logPath}` });
          return;
        }

        const shellPath = logPath.replaceAll("'", "'\\''");
        let command = "";
        if (os.platform() === "darwin") {
          command = `osascript -e 'tell app "Terminal" to do script "tail -f \\"${shellPath}\\""'`;
        } else if (os.platform() === "win32") {
          command = `start cmd.exe /k "tail -f \\"${shellPath}\\""`;
        } else {
          command = `gnome-terminal -- bash -c "tail -f \\"${shellPath}\\"; exec bash"`;
        }

        cp.exec(command, (error) => {
          if (error) {
            console.error("Failed to open terminal:", error);
          }
        });

        deps.sendJson(res, 200, { success: true });
      } catch (err: unknown) {
        deps.sendJson(res, 500, { error: deps.safeErrorMessage(err) });
      }
    },
    "Open run session in native terminal"
  );
}
