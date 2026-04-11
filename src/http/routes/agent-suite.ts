import type { Router } from "../router.js";

type JsonRecord = Record<string, unknown>;
type ReadSkillPackStateFn = typeof import("../../skill-pack-state.js").readSkillPackState;
type UpdateSkillPackPolicyFn = typeof import("../../skill-pack-state.js").updateSkillPackPolicy;
type RollbackSkillPackPolicyFn = typeof import("../../skill-pack-state.js").rollbackSkillPackPolicy;
type ComputeOrgxAgentSuitePlanFn = typeof import("../../agent-suite.js").computeOrgxAgentSuitePlan;
type ApplyOrgxAgentSuitePlanFn = typeof import("../../agent-suite.js").applyOrgxAgentSuitePlan;
type ClientRuntimeSettingsResponse = import("../../contracts/types.js").ClientRuntimeSettingsResponse;
type ClientRuntimeSettingsUpdateRequest = import("../../contracts/types.js").ClientRuntimeSettingsUpdateRequest;
type SkillPackState = ReturnType<ReadSkillPackStateFn>;
type OrgxSkillPackOverrides = import("../../agent-suite.js").OrgxSkillPackOverrides;

type RegisterAgentSuiteRoutesDeps<TReq, TRes> = {
  pluginVersion: string | null | undefined;
  telemetryDistinctId: string;
  parseJsonRequest: (req: TReq) => Promise<JsonRecord>;
  resolveSkillPackOverrides: (input: {
    force?: boolean;
  }) => Promise<OrgxSkillPackOverrides | null>;
  readSkillPackState: ReadSkillPackStateFn;
  computeOrgxAgentSuitePlan: ComputeOrgxAgentSuitePlanFn;
  applyOrgxAgentSuitePlan: ApplyOrgxAgentSuitePlanFn;
  generateAgentSuiteOperationId: () => string;
  updateSkillPackPolicy: UpdateSkillPackPolicyFn;
  rollbackSkillPackPolicy: RollbackSkillPackPolicyFn;
  fetchAgentRuntimeSettings: (input?: {
    workspaceId?: string | null;
    projectId?: string | null;
  }) => Promise<ClientRuntimeSettingsResponse>;
  updateAgentRuntimeSettings: (
    payload: ClientRuntimeSettingsUpdateRequest
  ) => Promise<ClientRuntimeSettingsResponse>;
  posthogCapture: (input: {
    event: string;
    distinctId: string;
    properties: Record<string, unknown>;
  }) => Promise<unknown>;
  sendJson: (res: TRes, status: number, payload: unknown) => void;
  safeErrorMessage: (err: unknown) => string;
};

function getPluginVersion(pluginVersion: string | null | undefined): string | null {
  const normalized = (pluginVersion ?? "").trim();
  return normalized.length > 0 ? normalized : null;
}

function toRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : {};
}

function readBoolean(payload: JsonRecord, ...keys: string[]): boolean {
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === "boolean") {
      return value;
    }
  }
  return false;
}

function computeUpdateAvailable(state: SkillPackState): boolean {
  return Boolean(
    state.remote?.checksum &&
      state.pack?.checksum &&
      state.remote.checksum !== state.pack.checksum
  );
}

function toOptionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function toOptionalUuid(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return UUID_RE.test(trimmed) ? trimmed : undefined;
}

function readOptionalBoolean(payload: JsonRecord, ...keys: string[]): boolean | undefined {
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === "boolean") {
      return value;
    }
  }
  return undefined;
}

function readOptionalInteger(
  payload: JsonRecord,
  options: { min: number; max: number },
  ...keys: string[]
): number | undefined {
  for (const key of keys) {
    const raw = payload[key];
    let parsed = Number.NaN;
    if (typeof raw === "number") {
      parsed = raw;
    } else if (typeof raw === "string") {
      const trimmed = raw.trim();
      if (/^[+-]?\d+$/.test(trimmed)) {
        parsed = Number.parseInt(trimmed, 10);
      }
    }
    if (!Number.isFinite(parsed)) continue;
    const normalized = Math.max(options.min, Math.min(options.max, Math.floor(parsed)));
    return normalized;
  }
  return undefined;
}

function readOptionalAction(
  payload: JsonRecord,
  ...keys: string[]
): "approve" | "reject" | undefined {
  for (const key of keys) {
    const raw = payload[key];
    if (typeof raw !== "string") continue;
    const normalized = raw.trim().toLowerCase();
    if (normalized === "approve" || normalized === "reject") {
      return normalized;
    }
  }
  return undefined;
}

function readOptionalPolicy(
  payload: JsonRecord,
  ...keys: string[]
): "contextual" | "approve_non_blocking" | "defer_non_blocking" | undefined {
  for (const key of keys) {
    const raw = payload[key];
    if (typeof raw !== "string") continue;
    const normalized = raw.trim().toLowerCase();
    if (
      normalized === "contextual" ||
      normalized === "approve_non_blocking" ||
      normalized === "defer_non_blocking"
    ) {
      return normalized;
    }
  }
  return undefined;
}

function readOptionalBlockingBehavior(
  payload: JsonRecord,
  ...keys: string[]
): "require_human" | "guarded_auto_resolve_then_human" | undefined {
  for (const key of keys) {
    const raw = payload[key];
    if (typeof raw !== "string") continue;
    const normalized = raw.trim().toLowerCase();
    if (
      normalized === "require_human" ||
      normalized === "guarded_auto_resolve_then_human"
    ) {
      return normalized;
    }
  }
  return undefined;
}

function readOptionalEnum<T extends string>(
  payload: JsonRecord,
  allowed: readonly T[],
  ...keys: string[]
): T | undefined {
  for (const key of keys) {
    const raw = payload[key];
    if (typeof raw !== "string") continue;
    const normalized = raw.trim().toLowerCase();
    const match = allowed.find((value) => value === normalized);
    if (match) return match;
  }
  return undefined;
}

function normalizeRuntimeSettingsPatch(payload: JsonRecord): JsonRecord {
  const runtime = toRecord(payload.runtime_settings ?? payload.runtimeSettings);
  const patch: JsonRecord = {};

  const decisionV2Enabled = readOptionalBoolean(
    runtime,
    "decision_v2_enabled",
    "decisionV2Enabled"
  );
  if (typeof decisionV2Enabled === "boolean") {
    patch.decision_v2_enabled = decisionV2Enabled;
  }

  const decisionDedupeEnabled = readOptionalBoolean(
    runtime,
    "decision_dedupe_enabled",
    "decisionDedupeEnabled"
  );
  if (typeof decisionDedupeEnabled === "boolean") {
    patch.decision_dedupe_enabled = decisionDedupeEnabled;
  }

  const decisionEvidenceRequiredForBlocking = readOptionalBoolean(
    runtime,
    "decision_evidence_required_for_blocking",
    "decisionEvidenceRequiredForBlocking"
  );
  if (typeof decisionEvidenceRequiredForBlocking === "boolean") {
    patch.decision_evidence_required_for_blocking =
      decisionEvidenceRequiredForBlocking;
  }

  const decisionAutoResolveGuardedEnabled = readOptionalBoolean(
    runtime,
    "decision_auto_resolve_guarded_enabled",
    "decisionAutoResolveGuardedEnabled"
  );
  if (typeof decisionAutoResolveGuardedEnabled === "boolean") {
    patch.decision_auto_resolve_guarded_enabled =
      decisionAutoResolveGuardedEnabled;
  }

  const executionLayer = readOptionalEnum(
    runtime,
    ["orgx-managed-agents", "local-openclaw"],
    "execution_layer",
    "executionLayer"
  );
  if (executionLayer) {
    patch.execution_layer = executionLayer;
  }

  const managedAgentProfile = toOptionalString(
    runtime.managed_agent_profile ?? runtime.managedAgentProfile
  )?.trim();
  if (managedAgentProfile) {
    patch.managed_agent_profile = managedAgentProfile.slice(0, 120);
  }

  const personaAlias = toOptionalString(
    runtime.persona_alias ?? runtime.personaAlias
  )?.trim();
  if (personaAlias) {
    patch.persona_alias = personaAlias.slice(0, 80);
  }

  const environmentProfile = readOptionalEnum(
    runtime,
    ["restricted", "coding", "integration"],
    "environment_profile",
    "environmentProfile"
  );
  if (environmentProfile) {
    patch.environment_profile = environmentProfile;
  }

  const toolPolicyProfile = readOptionalEnum(
    runtime,
    ["repo_readwrite", "workspace_operator", "go_to_market"],
    "tool_policy_profile",
    "toolPolicyProfile"
  );
  if (toolPolicyProfile) {
    patch.tool_policy_profile = toolPolicyProfile;
  }

  const rolloutStage = readOptionalEnum(
    runtime,
    ["shadow", "canary", "ga"],
    "rollout_stage",
    "rolloutStage"
  );
  if (rolloutStage) {
    patch.rollout_stage = rolloutStage;
  }

  const runtimeProvider = readOptionalEnum(
    runtime,
    ["anthropic", "openai", "google", "cursor", "orgx"],
    "runtime_provider",
    "runtimeProvider"
  );
  if (runtimeProvider) {
    patch.runtime_provider = runtimeProvider;
  }

  const questionAutoAnswerEnabled = readOptionalBoolean(
    runtime,
    "question_auto_answer_enabled",
    "questionAutoAnswerEnabled"
  );
  if (typeof questionAutoAnswerEnabled === "boolean") {
    patch.question_auto_answer_enabled = questionAutoAnswerEnabled;
  }

  const questionAutoAnswerDelaySeconds = readOptionalInteger(
    runtime,
    { min: 1, max: 900 },
    "question_auto_answer_delay_seconds",
    "questionAutoAnswerDelaySeconds"
  );
  if (typeof questionAutoAnswerDelaySeconds === "number") {
    patch.question_auto_answer_delay_seconds = questionAutoAnswerDelaySeconds;
  }

  const questionAutoAnswerAction = readOptionalAction(
    runtime,
    "question_auto_answer_action",
    "questionAutoAnswerAction"
  );
  if (questionAutoAnswerAction) {
    patch.question_auto_answer_action = questionAutoAnswerAction;
  }

  const questionAutoAnswerTimeoutSec = readOptionalInteger(
    runtime,
    { min: 10, max: 3600 },
    "question_auto_answer_timeout_sec",
    "questionAutoAnswerTimeoutSec"
  );
  if (typeof questionAutoAnswerTimeoutSec === "number") {
    patch.question_auto_answer_timeout_sec = questionAutoAnswerTimeoutSec;
  }

  const questionAutoAnswerPolicy = readOptionalPolicy(
    runtime,
    "question_auto_answer_policy",
    "questionAutoAnswerPolicy"
  );
  if (questionAutoAnswerPolicy) {
    patch.question_auto_answer_policy = questionAutoAnswerPolicy;
  }

  const questionBlockingBehavior = readOptionalBlockingBehavior(
    runtime,
    "question_blocking_behavior",
    "questionBlockingBehavior"
  );
  if (questionBlockingBehavior) {
    patch.question_blocking_behavior = questionBlockingBehavior;
  }

  const questionPolicyVersion = readOptionalInteger(
    runtime,
    { min: 1, max: 10 },
    "question_policy_version",
    "questionPolicyVersion"
  );
  if (typeof questionPolicyVersion === "number") {
    patch.question_policy_version = questionPolicyVersion;
  }

  const customRunInstructions = toOptionalString(
    runtime.custom_run_instructions ?? runtime.customRunInstructions
  );
  if (typeof customRunInstructions === "string") {
    patch.custom_run_instructions = customRunInstructions.slice(0, 4000);
  }

  return patch;
}

function buildRuntimeSettingsFallbackEnvelope(workspaceId?: string | null): {
  ok: true;
  workspace_id: string | null;
  command_center_id: string | null;
  project_id: string | null;
  agents: [];
} {
  const normalizedWorkspaceId =
    typeof workspaceId === "string" && workspaceId.trim().length > 0
      ? workspaceId.trim()
      : null;
  return {
    ok: true,
    workspace_id: normalizedWorkspaceId,
    command_center_id: normalizedWorkspaceId,
    project_id: normalizedWorkspaceId,
    agents: [],
  };
}

export function registerAgentSuiteRoutes<TReq, TRes>(
  router: Router<Record<string, never>, TReq, TRes>,
  deps: RegisterAgentSuiteRoutesDeps<TReq, TRes>
): void {
  async function renderStatus(res: TRes): Promise<void> {
    try {
      // Resolve skill pack overrides opportunistically; fallback to builtins.
      let skillPack: OrgxSkillPackOverrides | null = null;
      try {
        skillPack = await deps.resolveSkillPackOverrides({});
      } catch {
        // Ignore resolver errors and use local defaults.
      }
      const state = deps.readSkillPackState();
      const plan = deps.computeOrgxAgentSuitePlan({
        packVersion: deps.pluginVersion || "0.0.0",
        skillPack,
        skillPackRemote: state.remote,
        skillPackPolicy: state.policy,
        skillPackUpdateAvailable: computeUpdateAvailable(state),
      });
      deps.sendJson(res, 200, {
        ok: true,
        data: plan,
      });
    } catch (err: unknown) {
      deps.sendJson(res, 500, {
        ok: false,
        error: deps.safeErrorMessage(err),
      });
    }
  }

  router.add(
    "GET",
    "agent-suite/status",
    async ({ res }) => renderStatus(res),
    "Agent suite installation status"
  );
  router.add(
    "HEAD",
    "agent-suite/status",
    async ({ res }) => renderStatus(res),
    "Agent suite installation status (HEAD)"
  );

  router.add(
    "GET",
    "agent-suite/runtime-settings",
    async ({ req, res }) => {
      const requestUrl = new URL(String((req as any).url ?? "/"), "http://localhost");
      const workspaceId = toOptionalUuid(
        requestUrl.searchParams.get("workspace_id") ??
          requestUrl.searchParams.get("workspaceId") ??
          requestUrl.searchParams.get("command_center_id") ??
          requestUrl.searchParams.get("commandCenterId") ??
          requestUrl.searchParams.get("project_id")
      );
      try {
        const response = await deps.fetchAgentRuntimeSettings({
          workspaceId: workspaceId ?? null,
        });
        if (!response?.ok) {
          deps.sendJson(res, 200, {
            ok: true,
            data: {
              ...buildRuntimeSettingsFallbackEnvelope(workspaceId ?? null),
              warning:
                response?.error ?? "Failed to load agent runtime settings",
            },
          });
          return;
        }
        deps.sendJson(res, 200, {
          ok: true,
          data: response,
        });
      } catch (err: unknown) {
        deps.sendJson(res, 200, {
          ok: true,
          data: {
            ...buildRuntimeSettingsFallbackEnvelope(workspaceId ?? null),
            warning: deps.safeErrorMessage(err),
          },
        });
      }
    },
    "List agent runtime settings"
  );

  router.add(
    "PATCH",
    "agent-suite/runtime-settings",
    async ({ req, res }) => {
      try {
        const payload = toRecord(await deps.parseJsonRequest(req));
        const agentId = toOptionalString(payload.agent_id ?? payload.agentId)?.trim();
        if (!agentId) {
          deps.sendJson(res, 400, {
            ok: false,
            error: "agent_id is required",
          });
          return;
        }

        const runtimeSettingsPatch = normalizeRuntimeSettingsPatch(payload);
        if (Object.keys(runtimeSettingsPatch).length === 0) {
          deps.sendJson(res, 400, {
            ok: false,
            error: "runtime_settings must include at least one mutable field",
          });
          return;
        }

        const workspaceId = toOptionalUuid(
          payload.workspace_id ??
            payload.workspaceId ??
            payload.command_center_id ??
            payload.commandCenterId ??
            payload.project_id ??
            payload.projectId
        );
        const response = await deps.updateAgentRuntimeSettings({
          agent_id: agentId,
          ...(workspaceId
            ? {
                workspace_id: workspaceId,
                command_center_id: workspaceId,
              }
            : {}),
          runtime_settings:
            runtimeSettingsPatch as ClientRuntimeSettingsUpdateRequest["runtime_settings"],
        });

        if (!response?.ok) {
          deps.sendJson(res, 502, {
            ok: false,
            error: response?.error ?? "Failed to update agent runtime settings",
          });
          return;
        }

        deps.sendJson(res, 200, {
          ok: true,
          data: response,
        });
      } catch (err: unknown) {
        deps.sendJson(res, 500, {
          ok: false,
          error: deps.safeErrorMessage(err),
        });
      }
    },
    "Update agent runtime settings"
  );

  router.add(
    "*",
    "agent-suite/runtime-settings",
    ({ res }) => {
      deps.sendJson(res, 405, {
        ok: false,
        error: "Use GET/PATCH /orgx/api/agent-suite/runtime-settings",
      });
    },
    "Reject unsupported methods for agent-suite/runtime-settings"
  );

  router.add(
    "POST",
    "agent-suite/install",
    async ({ req, res }) => {
      try {
        const payload = toRecord(await deps.parseJsonRequest(req));
        const dryRun = readBoolean(payload, "dryRun", "dry_run");
        const forceSkillPack = readBoolean(payload, "forceSkillPack", "force_skill_pack");
        const skillPack = await deps.resolveSkillPackOverrides({ force: forceSkillPack });
        const state = deps.readSkillPackState();
        const plan = deps.computeOrgxAgentSuitePlan({
          packVersion: deps.pluginVersion || "0.0.0",
          skillPack,
          skillPackRemote: state.remote,
          skillPackPolicy: state.policy,
          skillPackUpdateAvailable: computeUpdateAvailable(state),
        });
        const result = deps.applyOrgxAgentSuitePlan({ plan, dryRun, skillPack });

        const counts: Record<"create" | "update" | "noop" | "conflict", number> = {
          create: 0,
          update: 0,
          noop: 0,
          conflict: 0,
        };
        for (const entry of result.plan.workspaceFiles ?? []) {
          if (entry.action in counts) {
            counts[entry.action as keyof typeof counts] += 1;
          }
        }

        void deps
          .posthogCapture({
            event: "openclaw_agent_suite_install",
            distinctId: deps.telemetryDistinctId,
            properties: {
              plugin_version: getPluginVersion(deps.pluginVersion),
              dry_run: Boolean(dryRun),
              applied: Boolean(result.applied),
              openclaw_config_updated: Boolean(result.plan.openclawConfigWouldUpdate),
              added_agents_count: result.plan.openclawConfigAddedAgents.length,
              files_create: counts.create,
              files_update: counts.update,
              files_noop: counts.noop,
              files_conflict: counts.conflict,
              skill_pack_source: result.plan.skillPack?.source ?? null,
              skill_pack_checksum: result.plan.skillPack?.checksum ?? null,
              skill_pack_version: result.plan.skillPack?.version ?? null,
            },
          })
          .catch(() => {
            // best effort
          });

        deps.sendJson(res, 200, {
          ok: true,
          operationId: deps.generateAgentSuiteOperationId(),
          dryRun,
          applied: result.applied,
          data: result.plan,
        });
      } catch (err: unknown) {
        void deps
          .posthogCapture({
            event: "openclaw_agent_suite_install_failed",
            distinctId: deps.telemetryDistinctId,
            properties: {
              plugin_version: getPluginVersion(deps.pluginVersion),
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
    "Install managed OrgX agent suite"
  );
  router.add(
    "*",
    "agent-suite/install",
    ({ res }) => {
      deps.sendJson(res, 405, {
        ok: false,
        error: "Use POST /orgx/api/agent-suite/install",
      });
    },
    "Reject unsupported methods for agent-suite/install"
  );

  router.add(
    "GET",
    "skill-pack/policy",
    ({ res }) => {
      const state = deps.readSkillPackState();
      deps.sendJson(res, 200, {
        ok: true,
        data: {
          policy: state.policy,
          audit: state.audit,
          pack: state.pack,
          remote: state.remote,
          updateAvailable: computeUpdateAvailable(state),
          lastCheckedAt: state.lastCheckedAt,
          lastError: state.lastError,
        },
      });
    },
    "Read skill-pack policy"
  );

  router.add(
    "POST",
    "skill-pack/policy",
    async ({ req, res }) => {
      try {
        const payload = toRecord(await deps.parseJsonRequest(req));
        const frozenRaw = payload.frozen;
        const frozen = typeof frozenRaw === "boolean" ? frozenRaw : undefined;
        const pinToCurrent = readBoolean(payload, "pinToCurrent", "pin_to_current");
        const clearPin = readBoolean(payload, "clearPin", "clear_pin");
        const changedByRaw = payload.changedBy ?? payload.changed_by;
        const changedBy = typeof changedByRaw === "string" ? changedByRaw : undefined;
        const reasonRaw = payload.reason;
        const reason = typeof reasonRaw === "string" ? reasonRaw : undefined;
        const actionRaw = payload.action;
        const action = typeof actionRaw === "string" ? actionRaw.trim().toLowerCase() : "";
        const rollbackToAuditIdRaw = payload.rollbackToAuditId ?? payload.rollback_to_audit_id;
        const rollbackToAuditId = toOptionalString(rollbackToAuditIdRaw)?.trim() || undefined;
        const pinnedChecksumRaw = payload.pinnedChecksum ?? payload.pinned_checksum;
        const pinnedChecksum =
          typeof pinnedChecksumRaw === "string"
            ? pinnedChecksumRaw
            : pinnedChecksumRaw === null
              ? null
              : undefined;
        const hasFrozen = typeof frozen === "boolean";
        const hasPinnedChecksum = typeof pinnedChecksum === "string" || pinnedChecksum === null;
        const hasPinToCurrent = pinToCurrent === true;
        const hasClearPin = clearPin === true;
        const isRollback = action === "rollback" || typeof rollbackToAuditId === "string";

        if (action.length > 0 && action !== "rollback") {
          throw new Error("action must be 'rollback' when provided.");
        }
        if (hasPinToCurrent && hasClearPin) {
          throw new Error("pinToCurrent and clearPin cannot both be true.");
        }
        if (typeof pinnedChecksum === "string" && !pinnedChecksum.trim()) {
          throw new Error("pinnedChecksum must be a non-empty string when provided.");
        }
        if (isRollback) {
          if (hasFrozen || hasPinnedChecksum || hasPinToCurrent || hasClearPin) {
            throw new Error(
              "Rollback requests cannot include update fields (frozen, pinnedChecksum, pinToCurrent, clearPin)."
            );
          }
        } else if (!hasFrozen && !hasPinnedChecksum && !hasPinToCurrent && !hasClearPin) {
          throw new Error(
            "Include at least one mutable field: frozen, pinnedChecksum, pinToCurrent, or clearPin."
          );
        }

        const state =
          isRollback
            ? deps.rollbackSkillPackPolicy({
                auditId: rollbackToAuditId,
                changedBy,
                reason,
              })
            : deps.updateSkillPackPolicy({
                frozen,
                pinToCurrent,
                clearPin,
                pinnedChecksum: typeof pinnedChecksum === "string" ? pinnedChecksum.trim() : pinnedChecksum,
                changedBy,
                reason,
              });

        void deps
          .posthogCapture({
            event: "openclaw_skill_pack_policy_updated",
            distinctId: deps.telemetryDistinctId,
            properties: {
              plugin_version: getPluginVersion(deps.pluginVersion),
              frozen: state.policy.frozen,
              pinned_checksum_prefix: state.policy.pinnedChecksum
                ? state.policy.pinnedChecksum.slice(0, 12)
                : null,
            },
          })
          .catch(() => {
            // best effort
          });

        deps.sendJson(res, 200, {
          ok: true,
          data: {
            policy: state.policy,
            audit: state.audit,
          },
        });
      } catch (err: unknown) {
        deps.sendJson(res, 400, { ok: false, error: deps.safeErrorMessage(err) });
      }
    },
    "Update skill-pack policy"
  );
  router.add(
    "*",
    "skill-pack/policy",
    ({ res }) => {
      deps.sendJson(res, 405, {
        ok: false,
        error: "Use GET/POST /orgx/api/skill-pack/policy",
      });
    },
    "Reject unsupported methods for skill-pack/policy"
  );
}
