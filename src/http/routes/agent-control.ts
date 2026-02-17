import type { Router } from "../router.js";

type JsonRecord = Record<string, unknown>;

type SpawnGuardResult = {
  allowed: boolean;
  retryable: boolean;
  blockedReason: string | null;
  spawnGuardResult: unknown | null;
};

type DispatchExecutionPolicy = {
  domain: string | null;
  requiredSkills: string[];
};

type DispatchResolution = {
  executionPolicy: DispatchExecutionPolicy;
  taskTitle: string | null;
  workstreamTitle: string | null;
};

type BillingStatus = {
  plan?: string;
};

type AgentRunRecord = {
  runId: string;
  agentId: string;
  pid: number | null;
  message: string | null;
  provider: string | null;
  model: string | null;
  initiativeId: string | null;
  initiativeTitle: string | null;
  workstreamId: string | null;
  taskId: string | null;
};

type RegisterAgentControlRoutesDeps<TReq, TRes> = {
  parseJsonRequest: (req: TReq) => Promise<JsonRecord>;
  pickString: (record: Record<string, unknown>, keys: string[]) => string | null;
  parseBooleanQuery: (value: string | null) => boolean | null;
  randomUUID: () => string;
  normalizeOpenClawProvider: (value: string | null) => string | null;
  resolveAutoOpenClawProvider: () => string | null;
  modelImpliesByok: (model: string | null) => boolean;
  listAgents: () => Promise<Array<Record<string, unknown>>>;
  fetchBillingStatusSafe: (client: any) => Promise<BillingStatus | null>;
  client: any;
  resolveDispatchExecutionPolicy: (input: any) => Promise<DispatchResolution>;
  fetchKickoffContextSafe: (client: any, payload: any) => Promise<unknown>;
  renderKickoffMessage: (input: any) => { message: string; contextHash: string | null };
  posthogCapture: (input: any) => Promise<void>;
  telemetryDistinctId: string;
  pluginVersion: string | null;
  enforceSpawnGuardForDispatch: (input: any) => Promise<SpawnGuardResult>;
  extractSpawnGuardModelTier: (value: any) => string | null;
  buildPolicyEnforcedMessage: (input: any) => string;
  syncParentRollupsForTask: (input: any) => Promise<void>;
  emitActivitySafe: (input: any) => Promise<void>;
  configureOpenClawProviderRouting: (input: any) => Promise<{ provider: string; model: string }>;
  upsertAgentContext: (input: any) => unknown;
  upsertRunContext: (input: any) => unknown;
  spawnAgentTurn: (input: any) => { pid: number | null };
  upsertAgentRun: (input: any) => unknown;
  getAgentRun: (runId: string) => AgentRunRecord | null | any;
  stopProcess: (pid: number) => Promise<{ stopped: boolean; wasRunning: boolean }>;
  markAgentRunStopped: (runId: string) => unknown;
  writeRuntimeEvent: (input: any) => void;
  sendJson: (res: TRes, status: number, payload: unknown) => void;
  safeErrorMessage: (err: unknown) => string;
};

export function registerAgentControlRoutes<TReq, TRes>(
  router: Router<Record<string, never>, TReq, TRes>,
  deps: RegisterAgentControlRoutesDeps<TReq, TRes>
): void {
  router.add(
    "POST",
    "agents/launch",
    async ({ req, query, res }) => {
      try {
        const payload = await deps.parseJsonRequest(req);
        const agentId =
          (deps.pickString(payload, ["agentId", "agent_id", "id"]) ??
            query.get("agentId") ??
            query.get("agent_id") ??
            query.get("id") ??
            "")
            .trim();
        if (!agentId) {
          deps.sendJson(res, 400, { ok: false, error: "agentId is required" });
          return;
        }
        if (!/^[a-zA-Z0-9_-]+$/.test(agentId)) {
          deps.sendJson(res, 400, {
            ok: false,
            error: "agentId must be a simple identifier (letters, numbers, _ or -).",
          });
          return;
        }

        const sessionId =
          (deps.pickString(payload, ["sessionId", "session_id"]) ??
            query.get("sessionId") ??
            query.get("session_id") ??
            "")
            .trim() ||
          deps.randomUUID();
        const initiativeId =
          deps.pickString(payload, ["initiativeId", "initiative_id"]) ??
          query.get("initiativeId") ??
          query.get("initiative_id") ??
          null;
        const initiativeTitle =
          deps.pickString(payload, [
            "initiativeTitle",
            "initiative_title",
            "initiativeName",
            "initiative_name",
          ]) ??
          query.get("initiativeTitle") ??
          query.get("initiative_title") ??
          query.get("initiativeName") ??
          query.get("initiative_name") ??
          null;
        const workstreamId =
          deps.pickString(payload, ["workstreamId", "workstream_id"]) ??
          query.get("workstreamId") ??
          query.get("workstream_id") ??
          null;
        const taskId =
          deps.pickString(payload, ["taskId", "task_id"]) ??
          query.get("taskId") ??
          query.get("task_id") ??
          null;
        const thinking =
          (deps.pickString(payload, ["thinking"]) ??
            query.get("thinking") ??
            "")
            .trim() || null;
        const provider = deps.normalizeOpenClawProvider(
          deps.pickString(payload, ["provider", "modelProvider", "model_provider"]) ??
            query.get("provider") ??
            query.get("modelProvider") ??
            query.get("model_provider") ??
            null
        );
        const requestedModel =
          (deps.pickString(payload, ["model", "modelId", "model_id"]) ??
            query.get("model") ??
            query.get("modelId") ??
            query.get("model_id") ??
            "")
            .trim() || null;
        const routingProvider =
          provider ?? (!provider && !requestedModel ? deps.resolveAutoOpenClawProvider() : null);
        const dryRunRaw =
          payload.dryRun ??
          (payload as Record<string, unknown>).dry_run ??
          query.get("dryRun") ??
          query.get("dry_run") ??
          null;
        const dryRun =
          typeof dryRunRaw === "boolean"
            ? dryRunRaw
            : deps.parseBooleanQuery(typeof dryRunRaw === "string" ? dryRunRaw : null);

        let requiresPremiumLaunch =
          Boolean(routingProvider) || deps.modelImpliesByok(requestedModel);
        if (!requiresPremiumLaunch) {
          try {
            const agents = await deps.listAgents();
            const agentEntry =
              agents.find((entry) => String(entry.id ?? "").trim() === agentId) ??
              null;
            const agentModel =
              agentEntry && typeof agentEntry.model === "string"
                ? agentEntry.model
                : null;
            requiresPremiumLaunch = deps.modelImpliesByok(agentModel);
          } catch {
            // ignore
          }
        }

        if (requiresPremiumLaunch) {
          const billingStatus = await deps.fetchBillingStatusSafe(deps.client);
          if (billingStatus && billingStatus.plan === "free") {
            const pricingUrl = `${deps.client.getBaseUrl().replace(/\/+$/, "")}/pricing`;
            deps.sendJson(res, 402, {
              ok: false,
              code: "upgrade_required",
              error:
                "BYOK agent launch requires a paid OrgX plan. Upgrade, then retry.",
              currentPlan: billingStatus.plan,
              requiredPlan: "starter",
              actions: {
                checkout: "/orgx/api/billing/checkout",
                portal: "/orgx/api/billing/portal",
                pricing: pricingUrl,
              },
            });
            return;
          }
        }

        const messageInput =
          (deps.pickString(payload, ["message", "prompt", "text"]) ??
            query.get("message") ??
            query.get("prompt") ??
            query.get("text") ??
            "")
            .trim();
        const baseMessage =
          messageInput ||
          (initiativeTitle
            ? `Kick off: ${initiativeTitle}`
            : initiativeId
              ? `Kick off initiative ${initiativeId}`
              : `Kick off agent ${agentId}`);
        const policyResolution = await deps.resolveDispatchExecutionPolicy({
          initiativeId,
          initiativeTitle,
          workstreamId,
          taskId,
          message: baseMessage,
        });
        const executionPolicy = policyResolution.executionPolicy;
        const resolvedTaskTitle = policyResolution.taskTitle;
        const resolvedWorkstreamTitle =
          policyResolution.workstreamTitle ??
          (workstreamId ? `Workstream ${workstreamId}` : null);

        const kickoff = await deps.fetchKickoffContextSafe(deps.client, {
          initiative_id: initiativeId,
          workstream_id: workstreamId,
          task_id: taskId,
          agent_id: agentId,
          domain: executionPolicy.domain,
          required_skills: executionPolicy.requiredSkills,
          message: baseMessage,
        });
        const kickoffRendered = deps.renderKickoffMessage({
          baseMessage,
          kickoff,
          domain: executionPolicy.domain,
          requiredSkills: executionPolicy.requiredSkills,
        });
        const kickoffMessage = kickoffRendered.message;
        const kickoffContextHash = kickoffRendered.contextHash;

        void deps
          .posthogCapture({
            event: "openclaw_agent_launch_requested",
            distinctId: deps.telemetryDistinctId,
            properties: {
              plugin_version: deps.pluginVersion,
              agent_id: agentId,
              initiative_present: Boolean(initiativeId),
              workstream_present: Boolean(workstreamId),
              task_present: Boolean(taskId),
              domain: executionPolicy.domain,
              required_skills_count: executionPolicy.requiredSkills.length,
              provider: routingProvider,
              model: requestedModel,
              dry_run: Boolean(dryRun),
            },
          })
          .catch(() => {
            // best effort
          });

        if (dryRun) {
          deps.sendJson(res, 200, {
            ok: true,
            dryRun: true,
            agentId,
            initiativeId,
            workstreamId,
            taskId,
            requiresPremiumLaunch,
            provider: routingProvider,
            model: requestedModel,
            startedAt: new Date().toISOString(),
            message: kickoffMessage,
            kickoffContextHash,
            domain: executionPolicy.domain,
            requiredSkills: executionPolicy.requiredSkills,
          });
          return;
        }

        const guard = await deps.enforceSpawnGuardForDispatch({
          sourceEventPrefix: "agent_launch",
          initiativeId,
          correlationId: sessionId,
          runId: sessionId,
          executionPolicy,
          agentId,
          taskId,
          taskTitle: resolvedTaskTitle,
          workstreamId,
          workstreamTitle: resolvedWorkstreamTitle,
        });
        if (!guard.allowed) {
          void deps
            .posthogCapture({
              event: "openclaw_agent_launch_blocked",
              distinctId: deps.telemetryDistinctId,
              properties: {
                plugin_version: deps.pluginVersion,
                agent_id: agentId,
                initiative_present: Boolean(initiativeId),
                workstream_present: Boolean(workstreamId),
                task_present: Boolean(taskId),
                domain: executionPolicy.domain,
                required_skills_count: executionPolicy.requiredSkills.length,
                retryable: Boolean(guard.retryable),
                blocked_reason: guard.blockedReason ?? null,
                model_tier: deps.extractSpawnGuardModelTier(
                  guard.spawnGuardResult ?? null
                ),
              },
            })
            .catch(() => {
              // best effort
            });
          deps.sendJson(res, guard.retryable ? 429 : 409, {
            ok: false,
            code: guard.retryable
              ? "spawn_guard_rate_limited"
              : "spawn_guard_blocked",
            error:
              guard.blockedReason ??
              "Spawn guard denied this agent launch.",
            retryable: guard.retryable,
            initiativeId,
            workstreamId,
            taskId,
            domain: executionPolicy.domain,
            requiredSkills: executionPolicy.requiredSkills,
          });
          return;
        }
        const message = deps.buildPolicyEnforcedMessage({
          baseMessage: kickoffMessage,
          executionPolicy,
          spawnGuardResult: guard.spawnGuardResult,
        });

        if (initiativeId) {
          try {
            await deps.client.updateEntity("initiative", initiativeId, { status: "active" });
          } catch {
            // best effort
          }
        }

        if (taskId) {
          try {
            await deps.client.updateEntity("task", taskId, { status: "in_progress" });
          } catch {
            // best effort
          }

          await deps.syncParentRollupsForTask({
            initiativeId,
            taskId,
            workstreamId,
            correlationId: sessionId,
          });
        }

        await deps.emitActivitySafe({
          initiativeId,
          runId: sessionId,
          correlationId: sessionId,
          phase: "execution",
          message: taskId
            ? `Launched agent ${agentId} for task ${taskId}.`
            : `Launched agent ${agentId}.`,
          level: "info",
          metadata: {
            event: "agent_launch",
            agent_id: agentId,
            session_id: sessionId,
            workstream_id: workstreamId,
            task_id: taskId,
            provider: routingProvider,
            model: requestedModel,
            domain: executionPolicy.domain,
            required_skills: executionPolicy.requiredSkills,
            kickoff_context_hash: kickoffContextHash,
            kickoff_context_source: kickoff ? "orgx" : "fallback",
            orgx_plugin_version: deps.pluginVersion,
            spawn_guard_model_tier: deps.extractSpawnGuardModelTier(
              guard.spawnGuardResult
            ),
          },
        });

        let routedProvider: string | null = null;
        let routedModel: string | null = null;
        if (routingProvider) {
          const routed = await deps.configureOpenClawProviderRouting({
            agentId,
            provider: routingProvider,
            requestedModel,
          });
          routedProvider = routed.provider;
          routedModel = routed.model;
        }

        deps.upsertAgentContext({
          agentId,
          initiativeId,
          initiativeTitle,
          workstreamId,
          taskId,
        });
        deps.upsertRunContext({
          runId: sessionId,
          agentId,
          initiativeId,
          initiativeTitle,
          workstreamId,
          taskId,
        });

        const spawned = deps.spawnAgentTurn({
          agentId,
          sessionId,
          message,
          thinking,
        });

        deps.upsertAgentRun({
          runId: sessionId,
          agentId,
          pid: spawned.pid,
          message,
          provider: routedProvider,
          model: routedModel,
          initiativeId,
          initiativeTitle,
          workstreamId,
          taskId,
          startedAt: new Date().toISOString(),
          status: "running",
        });

        void deps
          .posthogCapture({
            event: "openclaw_agent_launch_started",
            distinctId: deps.telemetryDistinctId,
            properties: {
              plugin_version: deps.pluginVersion,
              agent_id: agentId,
              initiative_present: Boolean(initiativeId),
              workstream_present: Boolean(workstreamId),
              task_present: Boolean(taskId),
              domain: executionPolicy.domain,
              required_skills_count: executionPolicy.requiredSkills.length,
              provider: routedProvider,
              model: routedModel,
              model_tier: deps.extractSpawnGuardModelTier(guard.spawnGuardResult ?? null),
              kickoff_context_hash_prefix:
                typeof kickoffContextHash === "string" && kickoffContextHash.length >= 12
                  ? kickoffContextHash.slice(0, 12)
                  : kickoffContextHash ?? null,
            },
          })
          .catch(() => {
            // best effort
          });

        deps.sendJson(res, 202, {
          ok: true,
          agentId,
          sessionId,
          pid: spawned.pid,
          provider: routedProvider,
          model: routedModel,
          initiativeId,
          workstreamId,
          taskId,
          startedAt: new Date().toISOString(),
          domain: executionPolicy.domain,
          requiredSkills: executionPolicy.requiredSkills,
          kickoffContextHash,
        });
      } catch (err: unknown) {
        void deps
          .posthogCapture({
            event: "openclaw_agent_launch_failed",
            distinctId: deps.telemetryDistinctId,
            properties: {
              plugin_version: deps.pluginVersion,
              error: deps.safeErrorMessage(err),
            },
          })
          .catch(() => {
            // best effort
          });
        deps.sendJson(res, 500, {
          ok: false,
          error: deps.safeErrorMessage(err),
        });
      }
    },
    "Launch local agent run"
  );

  router.add(
    "POST",
    "agents/stop",
    async ({ req, query, res }) => {
      try {
        const payload = await deps.parseJsonRequest(req);
        const runId =
          (deps.pickString(payload, ["runId", "run_id", "sessionId", "session_id"]) ??
            query.get("runId") ??
            query.get("run_id") ??
            query.get("sessionId") ??
            query.get("session_id") ??
            "")
            .trim();
        if (!runId) {
          deps.sendJson(res, 400, { ok: false, error: "runId is required" });
          return;
        }

        const record = deps.getAgentRun(runId);
        if (!record) {
          deps.sendJson(res, 404, { ok: false, error: "Run not found" });
          return;
        }
        if (!record.pid) {
          deps.sendJson(res, 409, { ok: false, error: "Run has no tracked pid" });
          return;
        }

        const result = await deps.stopProcess(record.pid);
        const updated = deps.markAgentRunStopped(runId);

        try {
          deps.writeRuntimeEvent({
            sourceClient: "codex",
            event: "session_stop",
            runId,
            initiativeId: record.initiativeId ?? "",
            workstreamId: record.workstreamId ?? null,
            taskId: record.taskId ?? null,
            agentId: record.agentId ?? null,
            agentName: null,
            phase: "stopped",
            message: `Agent ${record.agentId ?? "unknown"} stopped.`,
          });
        } catch {
          // best effort
        }

        void deps
          .posthogCapture({
            event: "openclaw_agent_stop",
            distinctId: deps.telemetryDistinctId,
            properties: {
              plugin_version: deps.pluginVersion,
              agent_id: record.agentId,
              had_pid: Boolean(record.pid),
              stopped: Boolean(result.stopped),
              was_running: Boolean(result.wasRunning),
            },
          })
          .catch(() => {
            // best effort
          });

        deps.sendJson(res, 200, {
          ok: true,
          runId,
          agentId: record.agentId,
          pid: record.pid,
          stopped: result.stopped,
          wasRunning: result.wasRunning,
          record: updated,
        });
      } catch (err: unknown) {
        void deps
          .posthogCapture({
            event: "openclaw_agent_stop_failed",
            distinctId: deps.telemetryDistinctId,
            properties: {
              plugin_version: deps.pluginVersion,
              error: deps.safeErrorMessage(err),
            },
          })
          .catch(() => {
            // best effort
          });
        deps.sendJson(res, 500, { ok: false, error: deps.safeErrorMessage(err) });
      }
    },
    "Stop local agent run"
  );

  router.add(
    "POST",
    "agents/restart",
    async ({ req, query, res }) => {
      try {
        const payload = await deps.parseJsonRequest(req);
        const previousRunId =
          (deps.pickString(payload, ["runId", "run_id", "sessionId", "session_id"]) ??
            query.get("runId") ??
            query.get("run_id") ??
            query.get("sessionId") ??
            query.get("session_id") ??
            "")
            .trim();
        if (!previousRunId) {
          deps.sendJson(res, 400, { ok: false, error: "runId is required" });
          return;
        }

        const record = deps.getAgentRun(previousRunId);
        if (!record) {
          deps.sendJson(res, 404, { ok: false, error: "Run not found" });
          return;
        }

        if (record.pid) {
          try {
            await deps.stopProcess(record.pid);
          } catch {
            // best effort
          }
          deps.markAgentRunStopped(previousRunId);
        }

        const messageOverride =
          (deps.pickString(payload, ["message", "prompt", "text"]) ??
            query.get("message") ??
            query.get("prompt") ??
            query.get("text") ??
            "")
            .trim() || null;

        const providerOverride = deps.normalizeOpenClawProvider(
          deps.pickString(payload, ["provider", "modelProvider", "model_provider"]) ??
            query.get("provider") ??
            query.get("modelProvider") ??
            query.get("model_provider") ??
            record.provider ??
            null
        );
        const requestedModel =
          (deps.pickString(payload, ["model", "modelId", "model_id"]) ??
            query.get("model") ??
            query.get("modelId") ??
            query.get("model_id") ??
            record.model ??
            "")
            .trim() || null;
        const routingProvider =
          providerOverride ??
          (!providerOverride && !requestedModel ? deps.resolveAutoOpenClawProvider() : null);

        let requiresPremiumRestart =
          Boolean(routingProvider) ||
          deps.modelImpliesByok(requestedModel) ||
          deps.modelImpliesByok(record.model ?? null);
        if (!requiresPremiumRestart) {
          try {
            const agents = await deps.listAgents();
            const agentEntry =
              agents.find(
                (entry) => String(entry.id ?? "").trim() === record.agentId
              ) ?? null;
            const agentModel =
              agentEntry && typeof agentEntry.model === "string"
                ? agentEntry.model
                : null;
            requiresPremiumRestart = deps.modelImpliesByok(agentModel);
          } catch {
            // ignore
          }
        }

        if (requiresPremiumRestart) {
          const billingStatus = await deps.fetchBillingStatusSafe(deps.client);
          if (billingStatus && billingStatus.plan === "free") {
            const pricingUrl = `${deps.client.getBaseUrl().replace(/\/+$/, "")}/pricing`;
            deps.sendJson(res, 402, {
              ok: false,
              code: "upgrade_required",
              error:
                "BYOK agent launch requires a paid OrgX plan. Upgrade, then retry.",
              currentPlan: billingStatus.plan,
              requiredPlan: "starter",
              actions: {
                checkout: "/orgx/api/billing/checkout",
                portal: "/orgx/api/billing/portal",
                pricing: pricingUrl,
              },
            });
            return;
          }
        }

        const sessionId = deps.randomUUID();
        const baseMessage =
          messageOverride ?? record.message ?? `Restart agent ${record.agentId}`;
        const policyResolution = await deps.resolveDispatchExecutionPolicy({
          initiativeId: record.initiativeId,
          initiativeTitle: record.initiativeTitle,
          workstreamId: record.workstreamId,
          taskId: record.taskId,
          message: baseMessage,
        });
        const executionPolicy = policyResolution.executionPolicy;
        const guard = await deps.enforceSpawnGuardForDispatch({
          sourceEventPrefix: "agent_restart",
          initiativeId: record.initiativeId,
          correlationId: sessionId,
          runId: sessionId,
          executionPolicy,
          agentId: record.agentId,
          taskId: record.taskId,
          taskTitle: policyResolution.taskTitle,
          workstreamId: record.workstreamId,
          workstreamTitle: policyResolution.workstreamTitle,
        });
        if (!guard.allowed) {
          deps.sendJson(res, guard.retryable ? 429 : 409, {
            ok: false,
            code: guard.retryable
              ? "spawn_guard_rate_limited"
              : "spawn_guard_blocked",
            error:
              guard.blockedReason ??
              "Spawn guard denied this restart.",
            retryable: guard.retryable,
            previousRunId,
            domain: executionPolicy.domain,
            requiredSkills: executionPolicy.requiredSkills,
          });
          return;
        }
        const message = deps.buildPolicyEnforcedMessage({
          baseMessage,
          executionPolicy,
          spawnGuardResult: guard.spawnGuardResult,
        });

        let routedProvider: string | null = routingProvider ?? null;
        let routedModel: string | null = requestedModel ?? null;
        if (routingProvider) {
          const routed = await deps.configureOpenClawProviderRouting({
            agentId: record.agentId,
            provider: routingProvider,
            requestedModel,
          });
          routedProvider = routed.provider;
          routedModel = routed.model;
        }

        deps.upsertAgentContext({
          agentId: record.agentId,
          initiativeId: record.initiativeId,
          initiativeTitle: record.initiativeTitle,
          workstreamId: record.workstreamId,
          taskId: record.taskId,
        });

        const spawned = deps.spawnAgentTurn({
          agentId: record.agentId,
          sessionId,
          message,
        });

        deps.upsertAgentRun({
          runId: sessionId,
          agentId: record.agentId,
          pid: spawned.pid,
          message,
          provider: routedProvider,
          model: routedModel,
          initiativeId: record.initiativeId,
          initiativeTitle: record.initiativeTitle,
          workstreamId: record.workstreamId,
          taskId: record.taskId,
          startedAt: new Date().toISOString(),
          status: "running",
        });

        void deps
          .posthogCapture({
            event: "openclaw_agent_restart_started",
            distinctId: deps.telemetryDistinctId,
            properties: {
              plugin_version: deps.pluginVersion,
              agent_id: record.agentId,
              provider: routedProvider,
              model: routedModel,
              domain: executionPolicy.domain,
              required_skills_count: executionPolicy.requiredSkills.length,
              model_tier: deps.extractSpawnGuardModelTier(guard.spawnGuardResult ?? null),
            },
          })
          .catch(() => {
            // best effort
          });

        deps.sendJson(res, 202, {
          ok: true,
          previousRunId,
          sessionId,
          agentId: record.agentId,
          pid: spawned.pid,
          provider: routedProvider,
          model: routedModel,
          domain: executionPolicy.domain,
          requiredSkills: executionPolicy.requiredSkills,
        });
      } catch (err: unknown) {
        void deps
          .posthogCapture({
            event: "openclaw_agent_restart_failed",
            distinctId: deps.telemetryDistinctId,
            properties: {
              plugin_version: deps.pluginVersion,
              error: deps.safeErrorMessage(err),
            },
          })
          .catch(() => {
            // best effort
          });
        deps.sendJson(res, 500, { ok: false, error: deps.safeErrorMessage(err) });
      }
    },
    "Restart local agent run"
  );
}
