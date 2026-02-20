import type { Router } from "../router.js";

type JsonRecord = Record<string, unknown>;

type AutoContinueRunRecord = Record<string, any> & {
  activeRunId?: string | null;
  stopReason?: string | null;
  status?: string;
  stopRequested?: boolean;
  updatedAt?: string;
};

type NextUpQueue = {
  items: Array<{
    initiativeId: string;
    workstreamId: string;
    queueState: "queued" | "running" | "blocked" | "idle";
    runnerAgentId?: string | null;
    runnerAgentName?: string | null;
    runnerSource?: string | null;
    initiativeTitle?: string | null;
    workstreamTitle?: string | null;
    nextTaskId?: string | null;
    nextTaskTitle?: string | null;
    autoContinue?: {
      status?: string | null;
      stopReason?: string | null;
    } | null;
  }>;
  degraded: string[];
};

type NextUpQueuePlacement = "top" | "bottom";

type RegisterMissionControlActionsRoutesDeps<TReq, TRes> = {
  parseJsonRequest: (req: TReq) => Promise<JsonRecord>;
  pickString: (input: Record<string, unknown>, keys: string[]) => string | null;
  pickNumber: (input: Record<string, unknown>, keys: string[]) => number | null;
  parseBooleanQuery: (value: string | null) => boolean | null;
  pickStringArray: (input: Record<string, unknown>, keys: string[]) => string[];
  dedupeStrings: (values: string[]) => string[];
  resolveAgentDisplayName: (
    agentId: string,
    fallbackName: string | null
  ) => Promise<string | null>;
  buildNextUpQueue: (input: { initiativeId?: string | null }) => Promise<NextUpQueue>;
  startAutoContinueRun: (input: any) => Promise<AutoContinueRunRecord>;
  autoContinueRuns: Map<string, any>;
  autoContinueSliceRuns: Map<string, any>;
  dispatchFallbackWorkstreamTurn: (input: any) => Promise<{
    sessionId: string | null;
    pid: number | null;
    blockedReason: string | null;
    retryable: boolean;
    executionPolicy: { domain: string; requiredSkills: string[] };
    spawnGuardResult: unknown | null;
  }>;
  tickAutoContinueRun: (run: any) => Promise<void>;
  stopAutoContinueRun: (input: any) => Promise<void>;
  updateInitiativeAutoContinueState: (input: any) => Promise<void>;
  tickAllAutoContinue: () => Promise<void>;
  scheduleAutoFixForWorkstream: (input: {
    initiativeId: string;
    workstreamId: string;
    runId?: string | null;
    event?: string | null;
    requestedByAgentId?: string | null;
    requestedByAgentName?: string | null;
    graceMs?: number | null;
  }) => Promise<{
    requestId: string;
    initiativeId: string;
    workstreamId: string;
    runId: string | null;
    sourceEvent: string | null;
    graceMs: number;
    scheduledAt: string;
    dueAt: string;
  }>;
  upsertNextUpQueuePin: (input: {
    initiativeId: string;
    workstreamId: string;
    preferredTaskId: string | null;
    preferredMilestoneId: string | null;
  }) => { pins: unknown[]; updatedAt: string };
  removeNextUpQueuePin: (input: {
    initiativeId: string;
    workstreamId: string;
  }) => { pins: unknown[]; updatedAt: string };
  suppressNextUpQueueItem: (input: {
    initiativeId: string;
    workstreamId: string;
  }) => { suppressions: unknown[]; updatedAt: string };
  setNextUpQueuePinOrder: (input: {
    order: Array<{ initiativeId: string; workstreamId: string }>;
  }) => { pins: unknown[]; updatedAt: string };
  clearNextUpQueueCache: (initiativeId?: string | null) => void;
  resolveAutoAssignments: (input: any) => Promise<unknown>;
  client: any;
  sendJson: (res: TRes, status: number, payload: unknown) => void;
  safeErrorMessage: (err: unknown) => string;
};

const PLAY_QUEUE_LOOKUP_TIMEOUT_MS = (() => {
  const raw = process.env.ORGX_PLAY_QUEUE_LOOKUP_TIMEOUT_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return 350;
  return Math.max(200, Math.floor(parsed));
})();

const IN_PROGRESS_TASK_STATUSES = new Set([
  "in_progress",
  "inprogress",
  "active",
  "running",
  "working",
  "planning",
  "dispatching",
  "pending",
]);

const BLOCKED_TASK_STATUSES = new Set(["blocked", "stalled", "failed", "error"]);

async function withSoftTimeout<T>(
  work: Promise<T>,
  timeoutMs: number
): Promise<T> {
  let timer: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      work,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function normalizeStatusValue(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.trim().toLowerCase().replace(/[\s-]+/g, "_");
}

function normalizePlacement(
  value: unknown,
  fallback: NextUpQueuePlacement = "bottom"
): NextUpQueuePlacement {
  if (typeof value !== "string") return fallback;
  const normalized = value.trim().toLowerCase();
  if (normalized === "top") return "top";
  if (normalized === "bottom") return "bottom";
  return fallback;
}

function parseQueueOrder(input: unknown, deps: Pick<RegisterMissionControlActionsRoutesDeps<any, any>, "pickString">): Array<{
  initiativeId: string;
  workstreamId: string;
}> {
  const rawOrder = Array.isArray(input) ? input : [];
  const order: Array<{ initiativeId: string; workstreamId: string }> = [];

  for (const entry of rawOrder) {
    if (!entry) continue;
    if (typeof entry === "string") {
      const [initiativeId, workstreamId] = entry.split(":", 2).map((s) => s.trim());
      if (initiativeId && workstreamId) order.push({ initiativeId, workstreamId });
      continue;
    }
    if (typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const initiativeId = (deps.pickString(record, ["initiativeId", "initiative_id"]) ?? "").trim();
    const workstreamId = (deps.pickString(record, ["workstreamId", "workstream_id"]) ?? "").trim();
    if (initiativeId && workstreamId) order.push({ initiativeId, workstreamId });
  }

  return order;
}

function dedupeQueueOrder(
  order: Array<{ initiativeId: string; workstreamId: string }>
): Array<{ initiativeId: string; workstreamId: string }> {
  const next: Array<{ initiativeId: string; workstreamId: string }> = [];
  const seen = new Set<string>();
  for (const entry of order) {
    const initiativeId = (entry.initiativeId ?? "").trim();
    const workstreamId = (entry.workstreamId ?? "").trim();
    if (!initiativeId || !workstreamId) continue;
    const key = `${initiativeId}:${workstreamId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    next.push({ initiativeId, workstreamId });
  }
  return next;
}

function buildPlacedOrder(input: {
  order: Array<{ initiativeId: string; workstreamId: string }>;
  targets: Set<string>;
  placement: NextUpQueuePlacement;
}): Array<{ initiativeId: string; workstreamId: string }> {
  if (input.targets.size === 0) return input.order;
  const selected: Array<{ initiativeId: string; workstreamId: string }> = [];
  const remaining: Array<{ initiativeId: string; workstreamId: string }> = [];
  for (const entry of input.order) {
    const key = `${entry.initiativeId}:${entry.workstreamId}`;
    if (input.targets.has(key)) selected.push(entry);
    else remaining.push(entry);
  }
  if (selected.length === 0) return input.order;
  return input.placement === "top"
    ? [...selected, ...remaining]
    : [...remaining, ...selected];
}

function shouldResetTaskStatus(
  status: unknown,
  states: Set<string>
): boolean {
  const normalized = normalizeStatusValue(status);
  if (!normalized) return false;
  if (normalized === "todo" || normalized === "done" || normalized === "completed") {
    return false;
  }
  if (states.has("running") && IN_PROGRESS_TASK_STATUSES.has(normalized)) {
    return true;
  }
  if (states.has("blocked") && BLOCKED_TASK_STATUSES.has(normalized)) {
    return true;
  }
  return false;
}

export function registerMissionControlActionsRoutes<TReq, TRes>(
  router: Router<Record<string, never>, TReq, TRes>,
  deps: RegisterMissionControlActionsRoutesDeps<TReq, TRes>
): void {
  const sendRouteError = (
    res: TRes,
    status: number,
    location: string,
    error: string,
    extra: Record<string, unknown> = {}
  ) => {
    deps.sendJson(res, status, {
      ok: false,
      error,
      error_location: location,
      ...extra,
    });
  };

  const sendRouteException = (
    res: TRes,
    location: string,
    err: unknown,
    extra: Record<string, unknown> = {}
  ) => {
    sendRouteError(res, 500, location, deps.safeErrorMessage(err), extra);
  };

  router.add(
    "POST",
    "mission-control/next-up/play",
    async ({ req, query, res }) => {
      try {
        const payload = await deps.parseJsonRequest(req);
        const initiativeId =
          (deps.pickString(payload, ["initiativeId", "initiative_id"]) ??
            query.get("initiativeId") ??
            query.get("initiative_id") ??
            "")
            .trim();
        const workstreamId =
          (deps.pickString(payload, ["workstreamId", "workstream_id"]) ??
            query.get("workstreamId") ??
            query.get("workstream_id") ??
            "")
            .trim();

        if (!initiativeId || !workstreamId) {
          sendRouteError(
            res,
            400,
            "mission-control.next-up.play.validation",
            "initiativeId and workstreamId are required"
          );
          return;
        }

        let agentIdRaw =
          (deps.pickString(payload, ["agentId", "agent_id"]) ??
            query.get("agentId") ??
            query.get("agent_id") ??
            "")
            .trim();

        const fastAckRaw =
          (payload as Record<string, unknown>).fastAck ??
          (payload as Record<string, unknown>).fast_ack ??
          query.get("fastAck") ??
          query.get("fast_ack") ??
          null;
        const fastAck =
          typeof fastAckRaw === "boolean"
            ? fastAckRaw
            : deps.parseBooleanQuery(typeof fastAckRaw === "string" ? fastAckRaw : null);

        let matchedQueueItem: NextUpQueue["items"][number] | null = null;
        const shouldLookupQueue = !fastAck || !agentIdRaw;
        if (shouldLookupQueue) {
          try {
            const queue = fastAck
              ? await withSoftTimeout(
                  deps.buildNextUpQueue({ initiativeId }),
                  PLAY_QUEUE_LOOKUP_TIMEOUT_MS
                )
              : await deps.buildNextUpQueue({ initiativeId });
            matchedQueueItem =
              queue.items.find((item) => item.workstreamId === workstreamId) ?? null;
          } catch {
            // Best effort: Play/Autopilot dispatch should still proceed even if queue refresh is slow.
          }
        }

        if (!agentIdRaw && matchedQueueItem?.runnerAgentId) {
          agentIdRaw = matchedQueueItem.runnerAgentId;
        }

        const agentId = agentIdRaw || "main";
        if (!/^[a-zA-Z0-9_-]+$/.test(agentId)) {
          sendRouteError(
            res,
            400,
            "mission-control.next-up.play.validation",
            "agentId must be a simple identifier (letters, numbers, _ or -)."
          );
          return;
        }

        const requestedAgentName = await deps.resolveAgentDisplayName(
          agentId,
          matchedQueueItem?.runnerAgentId === agentId
            ? matchedQueueItem.runnerAgentName ?? null
            : null
        );

        const tokenBudget =
          deps.pickNumber(payload, [
            "tokenBudget",
            "token_budget",
            "tokenBudgetTokens",
            "token_budget_tokens",
            "maxTokens",
            "max_tokens",
          ]) ??
          query.get("tokenBudget") ??
          query.get("token_budget") ??
          query.get("tokenBudgetTokens") ??
          query.get("token_budget_tokens") ??
          query.get("maxTokens") ??
          query.get("max_tokens") ??
          null;

        const includeVerificationRaw =
          payload.includeVerification ??
          (payload as Record<string, unknown>).include_verification ??
          query.get("includeVerification") ??
          query.get("include_verification") ??
          null;
        const includeVerification =
          typeof includeVerificationRaw === "boolean"
            ? includeVerificationRaw
            : deps.parseBooleanQuery(
                typeof includeVerificationRaw === "string"
                  ? includeVerificationRaw
                  : null
              );
        const ignoreSpawnGuardRateLimitRaw =
          (payload as Record<string, unknown>).ignoreSpawnGuardRateLimit ??
          (payload as Record<string, unknown>).ignore_spawn_guard_rate_limit ??
          query.get("ignoreSpawnGuardRateLimit") ??
          query.get("ignore_spawn_guard_rate_limit") ??
          null;
        const ignoreSpawnGuardRateLimit =
          typeof ignoreSpawnGuardRateLimitRaw === "boolean"
            ? ignoreSpawnGuardRateLimitRaw
            : deps.parseBooleanQuery(
                typeof ignoreSpawnGuardRateLimitRaw === "string"
                  ? ignoreSpawnGuardRateLimitRaw
                  : null
              );

        const scopeRaw =
          deps.pickString(payload, ["scope", "sliceScope", "slice_scope"]) ??
          query.get("scope") ??
          query.get("sliceScope") ??
          query.get("slice_scope") ??
          null;
        const scope =
          scopeRaw === "milestone" || scopeRaw === "workstream" ? scopeRaw : "task";

        const existingRun = deps.autoContinueRuns.get(initiativeId) ?? null;
        const existingActiveRunIds = Array.isArray(existingRun?.activeSliceRunIds)
          ? (existingRun?.activeSliceRunIds as Array<unknown>)
              .filter((id): id is string => typeof id === "string" && id.trim().length > 0)
              .map((id) => id.trim())
          : typeof existingRun?.activeRunId === "string" && existingRun.activeRunId.trim().length > 0
            ? [existingRun.activeRunId.trim()]
            : [];
        if (
          existingRun &&
          (existingRun.status === "running" || existingRun.status === "stopping") &&
          existingActiveRunIds.length > 0
        ) {
          const activeSlice = deps.autoContinueSliceRuns.get(existingActiveRunIds[0]) ?? null;
          const activeWorkstreamId = activeSlice?.workstreamId ?? null;
          const activeWorkstreamTitle = activeSlice?.workstreamTitle ?? null;
          deps.sendJson(res, 409, {
            ok: false,
            code: "auto_continue_already_running",
            error:
              activeWorkstreamId || activeWorkstreamTitle
                ? `Auto-continue is already running for ${activeWorkstreamTitle ?? activeWorkstreamId}. Stop it before launching another Play run.`
                : "Auto-continue is already running for this initiative. Stop it before launching another Play run.",
            run: existingRun,
            activeRunIds: existingActiveRunIds,
            activeWorkstreamId,
            activeWorkstreamTitle,
            error_location: "mission-control.next-up.play.concurrent_run",
          });
          return;
        }

        const run = await deps.startAutoContinueRun({
          initiativeId,
          agentId,
          agentName: requestedAgentName,
          tokenBudget,
          includeVerification,
          allowedWorkstreamIds: [workstreamId],
          maxParallelSlices: 1,
          parallelMode: "iwmt",
          stopAfterSlice: true,
          ignoreSpawnGuardRateLimit: ignoreSpawnGuardRateLimit === true,
          scope,
        });

        let fallbackDispatch:
          | {
              sessionId: string | null;
              pid: number | null;
              blockedReason: string | null;
              retryable: boolean;
              executionPolicy: { domain: string; requiredSkills: string[] };
              spawnGuardResult: unknown | null;
            }
          | null = null;
        const maybeDispatchFallback = async () => {
          if (
            !run.activeRunId &&
            matchedQueueItem &&
            matchedQueueItem.runnerSource === "fallback"
          ) {
            return await deps.dispatchFallbackWorkstreamTurn({
              initiativeId,
              initiativeTitle: matchedQueueItem.initiativeTitle,
              workstreamId,
              workstreamTitle: matchedQueueItem.workstreamTitle,
              agentId,
              agentName: requestedAgentName,
              taskId: matchedQueueItem.nextTaskId ?? null,
              taskTitle: matchedQueueItem.nextTaskTitle ?? null,
            });
          }
          return null;
        };

        if (!fastAck) {
          await deps.tickAutoContinueRun(run);
          // Give short-lived workers a brief window to flush output so Play can resolve
          // in one request/response cycle without requiring extra manual ticks.
          if (run.activeRunId) {
            await new Promise<void>((resolve) => setTimeout(resolve, 140));
            await deps.tickAutoContinueRun(run);
          }
          fallbackDispatch = await maybeDispatchFallback();
        } else {
          const tickPromise = deps.tickAutoContinueRun(run);
          const tickCompleted = await Promise.race([
            tickPromise.then(() => true),
            new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 1100)),
          ]);

          if (!tickCompleted) {
            await new Promise<void>((resolve) => setTimeout(resolve, 80));
            const settledImmediately =
              Boolean(run.activeRunId) ||
              Boolean(run.lastRunId) ||
              Boolean(run.stopReason) ||
              run.status !== "running";
            if (settledImmediately) {
              await tickPromise.catch(() => null);
              fallbackDispatch = await maybeDispatchFallback();
            } else {
              void tickPromise
                .then(async () => {
                  await maybeDispatchFallback().catch(() => null);
                })
                .catch(() => {
                  // best effort
                });

              deps.sendJson(res, 202, {
                ok: true,
                run,
                initiativeId,
                workstreamId,
                agentId,
                dispatchMode: "pending",
                sessionId: null,
              });
              return;
            }
          } else {
            await tickPromise;
            fallbackDispatch = await maybeDispatchFallback();
          }
        }

        const fallbackStarted = Boolean(fallbackDispatch?.sessionId);
        const dispatchMode = run.activeRunId
          ? "slice"
          : fallbackStarted
            ? "fallback"
            : "none";
        if (
          dispatchMode === "none" &&
          run.lastRunId &&
          (run.stopReason === "completed" ||
            run.stopReason === "blocked" ||
            run.stopReason === "error")
        ) {
          const finalizedDispatchMode =
            run.stopReason === "completed"
              ? "slice_completed"
              : run.stopReason === "blocked"
                ? "slice_blocked"
                : "slice_error";
          deps.sendJson(res, 200, {
            ok: true,
            run,
            initiativeId,
            workstreamId,
            agentId,
            dispatchMode: finalizedDispatchMode,
            sessionId: run.lastRunId,
          });
          return;
        }
        if (dispatchMode === "none" && run.status === "running" && !run.stopReason) {
          deps.sendJson(res, 202, {
            ok: true,
            run,
            initiativeId,
            workstreamId,
            agentId,
            dispatchMode: "pending",
            sessionId: null,
          });
          return;
        }
        if (dispatchMode === "none") {
          const fallbackBlockedReason = fallbackDispatch?.blockedReason ?? null;
          const reason =
            fallbackBlockedReason ??
            (run.stopReason === "blocked"
              ? "No dispatchable task is ready for this workstream yet."
              : run.stopReason === "completed"
                ? "No queued task is available for this workstream."
                : "Unable to dispatch this workstream right now.");
          deps.sendJson(res, fallbackDispatch?.retryable ? 429 : 409, {
            ok: false,
            code: fallbackBlockedReason
              ? fallbackDispatch?.retryable
                ? "spawn_guard_rate_limited"
                : "spawn_guard_blocked"
              : undefined,
            error: reason,
            run,
            initiativeId,
            workstreamId,
            agentId,
            fallbackDispatch,
            error_location: "mission-control.next-up.play.dispatch",
          });
          return;
        }

        deps.sendJson(res, 200, {
          ok: true,
          run,
          initiativeId,
          workstreamId,
          agentId,
          dispatchMode,
          sessionId: run.activeRunId ?? fallbackDispatch?.sessionId ?? null,
        });
      } catch (err: unknown) {
        sendRouteException(res, "mission-control.next-up.play.handler", err);
      }
    },
    "Mission-control next-up play"
  );

  router.add(
    "POST",
    "mission-control/next-up/pin",
    async ({ req, query, res }) => {
      try {
        const payload = await deps.parseJsonRequest(req);
        const initiativeId =
          (deps.pickString(payload, ["initiativeId", "initiative_id"]) ??
            query.get("initiativeId") ??
            query.get("initiative_id") ??
            "")
            .trim();
        const workstreamId =
          (deps.pickString(payload, ["workstreamId", "workstream_id"]) ??
            query.get("workstreamId") ??
            query.get("workstream_id") ??
            "")
            .trim();
        const preferredTaskId =
          (deps.pickString(payload, [
            "taskId",
            "task_id",
            "preferredTaskId",
            "preferred_task_id",
          ]) ?? "")
            .trim() || null;
        const preferredMilestoneId =
          (deps.pickString(payload, [
            "milestoneId",
            "milestone_id",
            "preferredMilestoneId",
            "preferred_milestone_id",
          ]) ?? "")
            .trim() || null;

        if (!initiativeId || !workstreamId) {
          sendRouteError(
            res,
            400,
            "mission-control.next-up.pin.validation",
            "initiativeId and workstreamId are required"
          );
          return;
        }

        const next = deps.upsertNextUpQueuePin({
          initiativeId,
          workstreamId,
          preferredTaskId,
          preferredMilestoneId,
        });
        deps.clearNextUpQueueCache(initiativeId);

        deps.sendJson(res, 200, { ok: true, pins: next.pins, updatedAt: next.updatedAt });
      } catch (err: unknown) {
        sendRouteException(res, "mission-control.next-up.pin.handler", err);
      }
    },
    "Mission-control next-up pin"
  );

  router.add(
    "POST",
    "mission-control/next-up/unpin",
    async ({ req, query, res }) => {
      try {
        const payload = await deps.parseJsonRequest(req);
        const initiativeId =
          (deps.pickString(payload, ["initiativeId", "initiative_id"]) ??
            query.get("initiativeId") ??
            query.get("initiative_id") ??
            "")
            .trim();
        const workstreamId =
          (deps.pickString(payload, ["workstreamId", "workstream_id"]) ??
            query.get("workstreamId") ??
            query.get("workstream_id") ??
            "")
            .trim();

        if (!initiativeId || !workstreamId) {
          sendRouteError(
            res,
            400,
            "mission-control.next-up.unpin.validation",
            "initiativeId and workstreamId are required"
          );
          return;
        }

        const next = deps.removeNextUpQueuePin({ initiativeId, workstreamId });
        deps.clearNextUpQueueCache(initiativeId);
        deps.sendJson(res, 200, { ok: true, pins: next.pins, updatedAt: next.updatedAt });
      } catch (err: unknown) {
        sendRouteException(res, "mission-control.next-up.unpin.handler", err);
      }
    },
    "Mission-control next-up unpin"
  );

  router.add(
    "POST",
    "mission-control/next-up/reorder",
    async ({ req, res }) => {
      try {
        const payload = await deps.parseJsonRequest(req);
        const order = dedupeQueueOrder(parseQueueOrder((payload as any)?.order, deps));

        const next = deps.setNextUpQueuePinOrder({ order });
        deps.clearNextUpQueueCache(null);
        deps.sendJson(res, 200, { ok: true, pins: next.pins, updatedAt: next.updatedAt });
      } catch (err: unknown) {
        sendRouteException(res, "mission-control.next-up.reorder.handler", err);
      }
    },
    "Mission-control next-up reorder"
  );

  router.add(
    "POST",
    "mission-control/next-up/move",
    async ({ req, query, res }) => {
      try {
        const payload = await deps.parseJsonRequest(req);
        const initiativeId =
          (deps.pickString(payload, ["initiativeId", "initiative_id"]) ??
            query.get("initiativeId") ??
            query.get("initiative_id") ??
            "")
            .trim();
        const workstreamId =
          (deps.pickString(payload, ["workstreamId", "workstream_id"]) ??
            query.get("workstreamId") ??
            query.get("workstream_id") ??
            "")
            .trim();
        const placement = normalizePlacement(
          deps.pickString(payload, ["placement", "queuePlacement", "queue_placement"]) ??
            query.get("placement") ??
            query.get("queuePlacement") ??
            query.get("queue_placement"),
          "bottom"
        );

        if (!initiativeId || !workstreamId) {
          sendRouteError(
            res,
            400,
            "mission-control.next-up.move.validation",
            "initiativeId and workstreamId are required"
          );
          return;
        }

        const queue = await deps.buildNextUpQueue({ initiativeId });
        const order = dedupeQueueOrder(
          queue.items.map((item) => ({
            initiativeId: item.initiativeId,
            workstreamId: item.workstreamId,
          }))
        );
        const key = `${initiativeId}:${workstreamId}`;
        const current = order.filter(
          (entry) => `${entry.initiativeId}:${entry.workstreamId}` !== key
        );
        const nextOrder =
          placement === "top"
            ? [{ initiativeId, workstreamId }, ...current]
            : [...current, { initiativeId, workstreamId }];

        const next = deps.setNextUpQueuePinOrder({ order: nextOrder });
        deps.clearNextUpQueueCache(initiativeId);
        deps.sendJson(res, 200, {
          ok: true,
          placement,
          orderApplied: nextOrder.length,
          pins: next.pins,
          updatedAt: next.updatedAt,
        });
      } catch (err: unknown) {
        sendRouteException(res, "mission-control.next-up.move.handler", err);
      }
    },
    "Mission-control next-up move"
  );

  router.add(
    "POST",
    "mission-control/next-up/triage/stop",
    async ({ req, query, res }) => {
      try {
        const payload = await deps.parseJsonRequest(req);
        const initiativeId =
          (deps.pickString(payload, ["initiativeId", "initiative_id"]) ??
            query.get("initiativeId") ??
            query.get("initiative_id") ??
            "")
            .trim();
        const workstreamId =
          (deps.pickString(payload, ["workstreamId", "workstream_id"]) ??
            query.get("workstreamId") ??
            query.get("workstream_id") ??
            "")
            .trim();
        const placement = normalizePlacement(
          deps.pickString(payload, ["placement", "queuePlacement", "queue_placement"]) ??
            query.get("placement") ??
            query.get("queuePlacement") ??
            query.get("queue_placement"),
          "bottom"
        );
        const resetToTodoRaw =
          (payload as Record<string, unknown>).resetToTodo ??
          (payload as Record<string, unknown>).reset_to_todo ??
          query.get("resetToTodo") ??
          query.get("reset_to_todo") ??
          null;
        const resetToTodo =
          typeof resetToTodoRaw === "boolean"
            ? resetToTodoRaw
            : deps.parseBooleanQuery(
                typeof resetToTodoRaw === "string" ? resetToTodoRaw : null
              ) ?? false;

        if (!initiativeId || !workstreamId) {
          sendRouteError(
            res,
            400,
            "mission-control.next-up.triage.stop.validation",
            "initiativeId and workstreamId are required"
          );
          return;
        }

        const run = deps.autoContinueRuns.get(initiativeId) ?? null;
        let stoppedAutoContinue = false;
        if (run) {
          const now = new Date().toISOString();
          const activeRunIds = Array.isArray((run as Record<string, unknown>).activeSliceRunIds)
            ? ((run as Record<string, unknown>).activeSliceRunIds as Array<unknown>).filter(
                (id): id is string => typeof id === "string" && id.trim().length > 0
              )
            : typeof run.activeRunId === "string" && run.activeRunId.trim().length > 0
              ? [run.activeRunId]
              : [];
          run.stopRequested = true;
          run.status = activeRunIds.length > 0 ? "stopping" : "stopped";
          run.updatedAt = now;

          if (activeRunIds.length === 0) {
            await deps.stopAutoContinueRun({ run, reason: "stopped" });
          } else {
            try {
              await deps.updateInitiativeAutoContinueState({ initiativeId, run });
            } catch {
              // best effort
            }
          }
          stoppedAutoContinue = true;
        }

        let resetTaskCount = 0;
        if (resetToTodo) {
          const taskResult = await deps.client.listEntities("task", {
            initiative_id: initiativeId,
            workstream_id: workstreamId,
            limit: 1000,
          });
          const tasks = Array.isArray(taskResult?.data) ? taskResult.data : [];
          const statesToReset = new Set(["running", "blocked"]);
          for (const task of tasks) {
            if (!task || typeof task !== "object") continue;
            const record = task as Record<string, unknown>;
            const taskId = deps.pickString(record, ["id"]);
            if (!taskId) continue;
            if (!shouldResetTaskStatus(record.status, statesToReset)) continue;
            await deps.client.updateEntity("task", taskId, { status: "todo" });
            resetTaskCount += 1;
          }
        }

        const queue = await deps.buildNextUpQueue({ initiativeId });
        const order = dedupeQueueOrder(
          queue.items.map((item) => ({
            initiativeId: item.initiativeId,
            workstreamId: item.workstreamId,
          }))
        );
        const targetKey = `${initiativeId}:${workstreamId}`;
        const nextOrder = buildPlacedOrder({
          order,
          targets: new Set([targetKey]),
          placement,
        });
        const next = deps.setNextUpQueuePinOrder({
          order:
            nextOrder.length > 0
              ? nextOrder
              : [{ initiativeId, workstreamId }],
        });
        deps.clearNextUpQueueCache(initiativeId);

        deps.sendJson(res, 200, {
          ok: true,
          placement,
          stoppedAutoContinue,
          resetToTodo,
          resetTaskCount,
          run,
          pins: next.pins,
          updatedAt: next.updatedAt,
        });
      } catch (err: unknown) {
        sendRouteException(res, "mission-control.next-up.triage.stop.handler", err);
      }
    },
    "Mission-control next-up triage stop"
  );

  router.add(
    "POST",
    "mission-control/next-up/remove",
    async ({ req, query, res }) => {
      try {
        const payload = await deps.parseJsonRequest(req);
        const initiativeId =
          (deps.pickString(payload, ["initiativeId", "initiative_id"]) ??
            query.get("initiativeId") ??
            query.get("initiative_id") ??
            "")
            .trim();
        const workstreamId =
          (deps.pickString(payload, ["workstreamId", "workstream_id"]) ??
            query.get("workstreamId") ??
            query.get("workstream_id") ??
            "")
            .trim();

        if (!initiativeId || !workstreamId) {
          sendRouteError(
            res,
            400,
            "mission-control.next-up.remove.validation",
            "initiativeId and workstreamId are required"
          );
          return;
        }

        deps.removeNextUpQueuePin({ initiativeId, workstreamId });
        const next = deps.suppressNextUpQueueItem({ initiativeId, workstreamId });
        deps.clearNextUpQueueCache(initiativeId);
        deps.sendJson(res, 200, {
          ok: true,
          removed: { initiativeId, workstreamId },
          suppressions: next.suppressions,
          updatedAt: next.updatedAt,
        });
      } catch (err: unknown) {
        sendRouteException(res, "mission-control.next-up.remove.handler", err);
      }
    },
    "Mission-control next-up remove"
  );

  router.add(
    "POST",
    "mission-control/next-up/bulk",
    async ({ req, query, res }) => {
      try {
        const payload = await deps.parseJsonRequest(req);
        const actionRaw =
          deps.pickString(payload, ["action"]) ??
          query.get("action") ??
          "";
        const action = actionRaw.trim().toLowerCase();
        const initiativeScopeRaw =
          deps.pickString(payload, ["initiativeId", "initiative_id"]) ??
          query.get("initiativeId") ??
          query.get("initiative_id") ??
          "";
        const initiativeScope = initiativeScopeRaw.trim() || null;
        const items = dedupeQueueOrder(
          parseQueueOrder((payload as Record<string, unknown>).items, deps)
        );

        if (!["move_top", "move_bottom", "remove"].includes(action)) {
          sendRouteError(
            res,
            400,
            "mission-control.next-up.bulk.validation",
            "action must be one of: move_top, move_bottom, remove"
          );
          return;
        }

        if (items.length === 0) {
          sendRouteError(
            res,
            400,
            "mission-control.next-up.bulk.validation",
            "items must include at least one initiativeId/workstreamId pair"
          );
          return;
        }

        const queue = await deps.buildNextUpQueue({ initiativeId: initiativeScope });
        const baseOrder = dedupeQueueOrder(
          queue.items.map((item) => ({
            initiativeId: item.initiativeId,
            workstreamId: item.workstreamId,
          }))
        );
        const knownKeys = new Set(
          baseOrder.map((entry) => `${entry.initiativeId}:${entry.workstreamId}`)
        );
        const results = items.map((entry) => {
          const key = `${entry.initiativeId}:${entry.workstreamId}`;
          if (knownKeys.has(key)) {
            return { ...entry, ok: true as const };
          }
          return {
            ...entry,
            ok: false as const,
            error: "Queue item is not currently available in this scope",
          };
        });
        const targetKeys = new Set(
          results
            .filter((entry) => entry.ok)
            .map((entry) => `${entry.initiativeId}:${entry.workstreamId}`)
        );

        let nextOrder = baseOrder;
        if (targetKeys.size > 0) {
          if (action === "remove") {
            for (const entry of results) {
              if (!entry.ok) continue;
              deps.removeNextUpQueuePin({
                initiativeId: entry.initiativeId,
                workstreamId: entry.workstreamId,
              });
              deps.suppressNextUpQueueItem({
                initiativeId: entry.initiativeId,
                workstreamId: entry.workstreamId,
              });
            }
            nextOrder = baseOrder.filter((entry) => {
              const key = `${entry.initiativeId}:${entry.workstreamId}`;
              return !targetKeys.has(key);
            });
          } else {
            nextOrder = buildPlacedOrder({
              order: baseOrder,
              targets: targetKeys,
              placement: action === "move_top" ? "top" : "bottom",
            });
            deps.setNextUpQueuePinOrder({ order: nextOrder });
          }
          deps.clearNextUpQueueCache(initiativeScope);
        }

        const updated = results.filter((entry) => entry.ok).length;
        const failed = results.length - updated;

        deps.sendJson(res, 200, {
          ok: true,
          action,
          requested: results.length,
          updated,
          failed,
          results: results.map((entry) => ({
            initiativeId: entry.initiativeId,
            workstreamId: entry.workstreamId,
            ok: entry.ok,
            error: entry.ok ? null : entry.error,
          })),
          orderSize: nextOrder.length,
          updatedAt: new Date().toISOString(),
        });
      } catch (err: unknown) {
        sendRouteException(res, "mission-control.next-up.bulk.handler", err);
      }
    },
    "Mission-control next-up bulk"
  );

  router.add(
    "POST",
    "mission-control/next-up/clear",
    async ({ req, query, res }) => {
      try {
        const payload = await deps.parseJsonRequest(req);
        const initiativeIdRaw =
          deps.pickString(payload, ["initiativeId", "initiative_id"]) ??
          query.get("initiativeId") ??
          query.get("initiative_id") ??
          "";
        const initiativeId = initiativeIdRaw.trim() || null;
        const workstreamIdRaw =
          deps.pickString(payload, ["workstreamId", "workstream_id"]) ??
          query.get("workstreamId") ??
          query.get("workstream_id") ??
          "";
        const workstreamId = workstreamIdRaw.trim() || null;
        const placement = normalizePlacement(
          deps.pickString(payload, ["placement", "queuePlacement", "queue_placement"]) ??
            query.get("placement") ??
            query.get("queuePlacement") ??
            query.get("queue_placement"),
          "bottom"
        );

        const requestedStates = deps.dedupeStrings([
          ...deps.pickStringArray(payload, ["states", "queueStates", "queue_states"]),
          ...(query.get("states") ?? query.get("queueStates") ?? query.get("queue_states") ?? "")
            .split(",")
            .map((entry) => entry.trim())
            .filter(Boolean),
        ])
          .map((entry) => entry.trim().toLowerCase())
          .filter((entry) => entry === "running" || entry === "blocked");
        const states = new Set(requestedStates.length > 0 ? requestedStates : ["running", "blocked"]);

        const queue = await deps.buildNextUpQueue({ initiativeId });
        const scopedItems = queue.items.filter((item) => {
          if (initiativeId && item.initiativeId !== initiativeId) return false;
          if (workstreamId && item.workstreamId !== workstreamId) return false;
          if (states.has(item.queueState)) return true;
          if (
            states.has("running") &&
            item.autoContinue?.status === "running" &&
            !item.autoContinue?.stopReason
          ) {
            return true;
          }
          return false;
        });

        const updatedTaskIds = new Set<string>();
        let failedUpdates = 0;
        for (const item of scopedItems) {
          let taskRows: unknown[] = [];
          try {
            const response = await deps.client.listEntities("task", {
              initiative_id: item.initiativeId,
              workstream_id: item.workstreamId,
              limit: 1000,
            });
            taskRows = Array.isArray(response?.data) ? response.data : [];
          } catch {
            // best effort: keep progressing through queue
            continue;
          }

          for (const row of taskRows) {
            if (!row || typeof row !== "object") continue;
            const record = row as Record<string, unknown>;
            const taskId = deps.pickString(record, ["id"]);
            if (!taskId || updatedTaskIds.has(taskId)) continue;
            if (!shouldResetTaskStatus(record.status, states)) continue;
            try {
              await deps.client.updateEntity("task", taskId, { status: "todo" });
              updatedTaskIds.add(taskId);
            } catch {
              failedUpdates += 1;
            }
          }
        }

        const baseOrder = dedupeQueueOrder(
          queue.items.map((item) => ({
            initiativeId: item.initiativeId,
            workstreamId: item.workstreamId,
          }))
        );
        const targetKeys = new Set(
          scopedItems.map((item) => `${item.initiativeId}:${item.workstreamId}`)
        );
        const nextOrder = buildPlacedOrder({
          order: baseOrder,
          targets: targetKeys,
          placement,
        });
        const next = deps.setNextUpQueuePinOrder({ order: nextOrder });
        deps.clearNextUpQueueCache(initiativeId);

        deps.sendJson(res, 200, {
          ok: true,
          placement,
          states: Array.from(states),
          queueItemsCleared: scopedItems.length,
          tasksReset: updatedTaskIds.size,
          taskResetFailures: failedUpdates,
          pins: next.pins,
          updatedAt: next.updatedAt,
        });
      } catch (err: unknown) {
        sendRouteException(res, "mission-control.next-up.clear.handler", err);
      }
    },
    "Mission-control next-up clear"
  );

  router.add(
    "POST",
    "mission-control/activity/auto-fix",
    async ({ req, query, res }) => {
      try {
        const payload = await deps.parseJsonRequest(req);
        const initiativeId =
          (deps.pickString(payload, ["initiativeId", "initiative_id"]) ??
            query.get("initiativeId") ??
            query.get("initiative_id") ??
            "")
            .trim();
        const workstreamId =
          (deps.pickString(payload, ["workstreamId", "workstream_id"]) ??
            query.get("workstreamId") ??
            query.get("workstream_id") ??
            "")
            .trim();

        if (!initiativeId || !workstreamId) {
          sendRouteError(
            res,
            400,
            "mission-control.activity.auto-fix.validation",
            "initiativeId and workstreamId are required"
          );
          return;
        }

        const runId =
          (deps.pickString(payload, ["runId", "run_id", "sessionId", "session_id"]) ??
            query.get("runId") ??
            query.get("run_id") ??
            query.get("sessionId") ??
            query.get("session_id") ??
            "")
            .trim() || null;
        const event =
          (deps.pickString(payload, ["event", "eventName", "event_name"]) ??
            query.get("event") ??
            query.get("eventName") ??
            query.get("event_name") ??
            "")
            .trim() || null;
        const requestedByAgentId =
          (deps.pickString(payload, ["requestedByAgentId", "requested_by_agent_id"]) ??
            query.get("requestedByAgentId") ??
            query.get("requested_by_agent_id") ??
            "")
            .trim() || null;
        const requestedByAgentName =
          (deps.pickString(payload, ["requestedByAgentName", "requested_by_agent_name"]) ??
            query.get("requestedByAgentName") ??
            query.get("requested_by_agent_name") ??
            "")
            .trim() || null;

        const graceMsFromQueryRaw =
          query.get("graceMs") ??
          query.get("grace_ms") ??
          query.get("delayMs") ??
          query.get("delay_ms") ??
          null;
        const graceMsFromQuery =
          typeof graceMsFromQueryRaw === "string" && graceMsFromQueryRaw.trim().length > 0
            ? Number(graceMsFromQueryRaw)
            : null;
        const graceMs =
          deps.pickNumber(payload, ["graceMs", "grace_ms", "delayMs", "delay_ms"]) ??
          (Number.isFinite(graceMsFromQuery) ? graceMsFromQuery : null);

        const schedule = await deps.scheduleAutoFixForWorkstream({
          initiativeId,
          workstreamId,
          runId,
          event,
          requestedByAgentId,
          requestedByAgentName,
          graceMs,
        });

        deps.sendJson(res, 202, {
          ok: true,
          scheduled: schedule,
        });
      } catch (err: unknown) {
        sendRouteException(res, "mission-control.activity.auto-fix.handler", err);
      }
    },
    "Mission-control activity auto-fix"
  );

  router.add(
    "POST",
    "mission-control/auto-continue/start",
    async ({ req, query, res }) => {
      try {
        const payload = await deps.parseJsonRequest(req);
        const initiativeId =
          (deps.pickString(payload, ["initiativeId", "initiative_id"]) ??
            query.get("initiativeId") ??
            query.get("initiative_id") ??
            "")
            .trim();

        if (!initiativeId) {
          sendRouteError(
            res,
            400,
            "mission-control.auto-continue.start.validation",
            "initiativeId is required"
          );
          return;
        }

        const agentIdRaw =
          (deps.pickString(payload, ["agentId", "agent_id"]) ??
            query.get("agentId") ??
            query.get("agent_id") ??
            "main")
            .trim();
        const agentId = agentIdRaw || "main";
        if (!/^[a-zA-Z0-9_-]+$/.test(agentId)) {
          sendRouteError(
            res,
            400,
            "mission-control.auto-continue.start.validation",
            "agentId must be a simple identifier (letters, numbers, _ or -)."
          );
          return;
        }

        const tokenBudget =
          deps.pickNumber(payload, [
            "tokenBudget",
            "token_budget",
            "tokenBudgetTokens",
            "token_budget_tokens",
            "maxTokens",
            "max_tokens",
          ]) ??
          query.get("tokenBudget") ??
          query.get("token_budget") ??
          query.get("tokenBudgetTokens") ??
          query.get("token_budget_tokens") ??
          query.get("maxTokens") ??
          query.get("max_tokens") ??
          null;

        const includeVerificationRaw =
          payload.includeVerification ??
          (payload as Record<string, unknown>).include_verification ??
          query.get("includeVerification") ??
          query.get("include_verification") ??
          null;
        const includeVerification =
          typeof includeVerificationRaw === "boolean"
            ? includeVerificationRaw
            : deps.parseBooleanQuery(
                typeof includeVerificationRaw === "string"
                  ? includeVerificationRaw
                  : null
              );
        const ignoreSpawnGuardRateLimitRaw =
          (payload as Record<string, unknown>).ignoreSpawnGuardRateLimit ??
          (payload as Record<string, unknown>).ignore_spawn_guard_rate_limit ??
          query.get("ignoreSpawnGuardRateLimit") ??
          query.get("ignore_spawn_guard_rate_limit") ??
          null;
        const ignoreSpawnGuardRateLimit =
          typeof ignoreSpawnGuardRateLimitRaw === "boolean"
            ? ignoreSpawnGuardRateLimitRaw
            : deps.parseBooleanQuery(
                typeof ignoreSpawnGuardRateLimitRaw === "string"
                  ? ignoreSpawnGuardRateLimitRaw
                  : null
              );

        const workstreamFilter = deps.dedupeStrings([
          ...deps.pickStringArray(payload, [
            "workstreamIds",
            "workstream_ids",
            "workstreamId",
            "workstream_id",
          ]),
          ...(query.get("workstreamIds") ??
          query.get("workstream_ids") ??
          query.get("workstreamId") ??
          query.get("workstream_id") ??
          "")
            .split(",")
            .map((entry) => entry.trim())
            .filter(Boolean),
        ]);
        const allowedWorkstreamIds =
          workstreamFilter.length > 0 ? workstreamFilter : null;
        const maxParallelRaw =
          deps.pickNumber(payload, [
            "maxParallelSlices",
            "max_parallel_slices",
            "maxParallel",
            "max_parallel",
          ]) ??
          query.get("maxParallelSlices") ??
          query.get("max_parallel_slices") ??
          query.get("maxParallel") ??
          query.get("max_parallel") ??
          null;
        const parallelModeRaw =
          (deps.pickString(payload, ["parallelMode", "parallel_mode"]) ??
            query.get("parallelMode") ??
            query.get("parallel_mode") ??
            "iwmt")
            .trim()
            .toLowerCase();
        const parallelMode = parallelModeRaw === "iwmt" ? "iwmt" : "iwmt";

        const startScopeRaw =
          deps.pickString(payload, ["scope", "sliceScope", "slice_scope"]) ??
          query.get("scope") ??
          query.get("sliceScope") ??
          query.get("slice_scope") ??
          null;
        const startScope =
          startScopeRaw === "milestone" || startScopeRaw === "workstream"
            ? startScopeRaw
            : "task";

        const run = await deps.startAutoContinueRun({
          initiativeId,
          agentId,
          agentName: await deps.resolveAgentDisplayName(agentId, null),
          tokenBudget,
          includeVerification,
          allowedWorkstreamIds,
          maxParallelSlices: maxParallelRaw,
          parallelMode,
          ignoreSpawnGuardRateLimit: ignoreSpawnGuardRateLimit === true,
          scope: startScope,
        });

        deps.sendJson(res, 200, { ok: true, run });
      } catch (err: unknown) {
        sendRouteException(res, "mission-control.auto-continue.start.handler", err);
      }
    },
    "Mission-control auto-continue start"
  );

  router.add(
    "POST",
    "mission-control/auto-continue/stop",
    async ({ req, query, res }) => {
      try {
        const payload = await deps.parseJsonRequest(req);
        const initiativeId =
          (deps.pickString(payload, ["initiativeId", "initiative_id"]) ??
            query.get("initiativeId") ??
            query.get("initiative_id") ??
            "")
            .trim();

        if (!initiativeId) {
          sendRouteError(
            res,
            400,
            "mission-control.auto-continue.stop.validation",
            "initiativeId is required"
          );
          return;
        }

        const run = deps.autoContinueRuns.get(initiativeId) ?? null;
        if (!run) {
          sendRouteError(
            res,
            404,
            "mission-control.auto-continue.stop.lookup",
            "No auto-continue run found"
          );
          return;
        }

        const now = new Date().toISOString();
        const activeRunIds = Array.isArray((run as Record<string, unknown>).activeSliceRunIds)
          ? ((run as Record<string, unknown>).activeSliceRunIds as Array<unknown>).filter(
              (id): id is string => typeof id === "string" && id.trim().length > 0
            )
          : typeof run.activeRunId === "string" && run.activeRunId.trim().length > 0
            ? [run.activeRunId]
            : [];
        run.stopRequested = true;
        run.status = activeRunIds.length > 0 ? "stopping" : "stopped";
        run.updatedAt = now;

        if (activeRunIds.length === 0) {
          await deps.stopAutoContinueRun({ run, reason: "stopped" });
        } else {
          try {
            await deps.updateInitiativeAutoContinueState({ initiativeId, run });
          } catch {
            // best effort
          }
        }

        deps.sendJson(res, 200, { ok: true, run });
      } catch (err: unknown) {
        sendRouteException(res, "mission-control.auto-continue.stop.handler", err);
      }
    },
    "Mission-control auto-continue stop"
  );

  router.add(
    "POST",
    "mission-control/auto-continue/tick",
    async ({ req, query, res }) => {
      try {
        const payload = await deps.parseJsonRequest(req);
        const initiativeId =
          (deps.pickString(payload, ["initiativeId", "initiative_id"]) ??
            query.get("initiativeId") ??
            query.get("initiative_id") ??
            "")
            .trim();

        if (initiativeId) {
          const run = deps.autoContinueRuns.get(initiativeId) ?? null;
          if (!run) {
            sendRouteError(
              res,
              404,
              "mission-control.auto-continue.tick.lookup",
              "No auto-continue run found"
            );
            return;
          }
          await deps.tickAutoContinueRun(run);
          deps.sendJson(res, 200, { ok: true, initiativeId, run });
          return;
        }

        await deps.tickAllAutoContinue();
        deps.sendJson(res, 200, { ok: true });
      } catch (err: unknown) {
        sendRouteException(res, "mission-control.auto-continue.tick.handler", err);
      }
    },
    "Mission-control auto-continue tick"
  );

  router.add(
    "POST",
    "mission-control/assignments/auto",
    async ({ req, res }) => {
      try {
        const payload = await deps.parseJsonRequest(req);
        const entityId = deps.pickString(payload, ["entity_id", "entityId"]);
        const entityType = deps.pickString(payload, ["entity_type", "entityType"]);
        const initiativeId =
          deps.pickString(payload, ["initiative_id", "initiativeId"]) ?? null;
        const title = deps.pickString(payload, ["title", "name"]) ?? "Untitled";
        const summary =
          deps.pickString(payload, ["summary", "description", "context"]) ?? null;

        if (!entityId || !entityType) {
          sendRouteError(
            res,
            400,
            "mission-control.assignments.auto.validation",
            "entity_id and entity_type are required."
          );
          return;
        }

        const assignment = await deps.resolveAutoAssignments({
          client: deps.client,
          entityId,
          entityType,
          initiativeId,
          title,
          summary,
        });

        deps.sendJson(res, 200, assignment);
      } catch (err: unknown) {
        sendRouteException(res, "mission-control.assignments.auto.handler", err);
      }
    },
    "Mission-control auto assignment"
  );
}
