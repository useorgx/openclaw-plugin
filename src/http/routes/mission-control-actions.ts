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
    workstreamId: string;
    runnerAgentId?: string | null;
    runnerAgentName?: string | null;
    runnerSource?: string | null;
    initiativeTitle?: string | null;
    workstreamTitle?: string | null;
    nextTaskId?: string | null;
    nextTaskTitle?: string | null;
  }>;
  degraded: string[];
};

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
  buildNextUpQueue: (input: { initiativeId: string }) => Promise<NextUpQueue>;
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
  setNextUpQueuePinOrder: (input: {
    order: Array<{ initiativeId: string; workstreamId: string }>;
  }) => { pins: unknown[]; updatedAt: string };
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

export function registerMissionControlActionsRoutes<TReq, TRes>(
  router: Router<Record<string, never>, TReq, TRes>,
  deps: RegisterMissionControlActionsRoutesDeps<TReq, TRes>
): void {
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
          deps.sendJson(res, 400, {
            ok: false,
            error: "initiativeId and workstreamId are required",
          });
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
          deps.sendJson(res, 400, {
            ok: false,
            error: "agentId must be a simple identifier (letters, numbers, _ or -).",
          });
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

        const existingRun = deps.autoContinueRuns.get(initiativeId) ?? null;
        if (
          existingRun &&
          (existingRun.status === "running" || existingRun.status === "stopping") &&
          existingRun.activeRunId
        ) {
          const activeSlice = deps.autoContinueSliceRuns.get(existingRun.activeRunId) ?? null;
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
            activeWorkstreamId,
            activeWorkstreamTitle,
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
          stopAfterSlice: true,
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

          await tickPromise;
          fallbackDispatch = await maybeDispatchFallback();
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
        deps.sendJson(res, 500, { ok: false, error: deps.safeErrorMessage(err) });
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
          deps.sendJson(res, 400, {
            ok: false,
            error: "initiativeId and workstreamId are required",
          });
          return;
        }

        const next = deps.upsertNextUpQueuePin({
          initiativeId,
          workstreamId,
          preferredTaskId,
          preferredMilestoneId,
        });

        deps.sendJson(res, 200, { ok: true, pins: next.pins, updatedAt: next.updatedAt });
      } catch (err: unknown) {
        deps.sendJson(res, 500, { ok: false, error: deps.safeErrorMessage(err) });
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
          deps.sendJson(res, 400, {
            ok: false,
            error: "initiativeId and workstreamId are required",
          });
          return;
        }

        const next = deps.removeNextUpQueuePin({ initiativeId, workstreamId });
        deps.sendJson(res, 200, { ok: true, pins: next.pins, updatedAt: next.updatedAt });
      } catch (err: unknown) {
        deps.sendJson(res, 500, { ok: false, error: deps.safeErrorMessage(err) });
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
        const rawOrder = Array.isArray((payload as any)?.order)
          ? ((payload as any).order as unknown[])
          : [];
        const order: Array<{ initiativeId: string; workstreamId: string }> = [];

        for (const entry of rawOrder) {
          if (!entry) continue;
          if (typeof entry === "string") {
            const [initiativeId, workstreamId] = entry.split(":", 2).map((s) => s.trim());
            if (initiativeId && workstreamId) order.push({ initiativeId, workstreamId });
            continue;
          }
          if (typeof entry === "object") {
            const record = entry as Record<string, unknown>;
            const initiativeId = (
              deps.pickString(record, ["initiativeId", "initiative_id"]) ?? ""
            ).trim();
            const workstreamId = (
              deps.pickString(record, ["workstreamId", "workstream_id"]) ?? ""
            ).trim();
            if (initiativeId && workstreamId) order.push({ initiativeId, workstreamId });
          }
        }

        const next = deps.setNextUpQueuePinOrder({ order });
        deps.sendJson(res, 200, { ok: true, pins: next.pins, updatedAt: next.updatedAt });
      } catch (err: unknown) {
        deps.sendJson(res, 500, { ok: false, error: deps.safeErrorMessage(err) });
      }
    },
    "Mission-control next-up reorder"
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
          deps.sendJson(res, 400, { ok: false, error: "initiativeId is required" });
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
          deps.sendJson(res, 400, {
            ok: false,
            error: "agentId must be a simple identifier (letters, numbers, _ or -).",
          });
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

        const run = await deps.startAutoContinueRun({
          initiativeId,
          agentId,
          agentName: await deps.resolveAgentDisplayName(agentId, null),
          tokenBudget,
          includeVerification,
          allowedWorkstreamIds,
        });

        deps.sendJson(res, 200, { ok: true, run });
      } catch (err: unknown) {
        deps.sendJson(res, 500, { ok: false, error: deps.safeErrorMessage(err) });
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
          deps.sendJson(res, 400, { ok: false, error: "initiativeId is required" });
          return;
        }

        const run = deps.autoContinueRuns.get(initiativeId) ?? null;
        if (!run) {
          deps.sendJson(res, 404, { ok: false, error: "No auto-continue run found" });
          return;
        }

        const now = new Date().toISOString();
        run.stopRequested = true;
        run.status = run.activeRunId ? "stopping" : "stopped";
        run.updatedAt = now;

        if (!run.activeRunId) {
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
        deps.sendJson(res, 500, { ok: false, error: deps.safeErrorMessage(err) });
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
            deps.sendJson(res, 404, { ok: false, error: "No auto-continue run found" });
            return;
          }
          await deps.tickAutoContinueRun(run);
          deps.sendJson(res, 200, { ok: true, initiativeId, run });
          return;
        }

        await deps.tickAllAutoContinue();
        deps.sendJson(res, 200, { ok: true });
      } catch (err: unknown) {
        deps.sendJson(res, 500, { ok: false, error: deps.safeErrorMessage(err) });
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
          deps.sendJson(res, 400, {
            ok: false,
            error: "entity_id and entity_type are required.",
          });
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
        deps.sendJson(res, 500, {
          ok: false,
          error: deps.safeErrorMessage(err),
        });
      }
    },
    "Mission-control auto assignment"
  );
}
