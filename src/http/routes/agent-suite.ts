import type { Router } from "../router.js";

type JsonRecord = Record<string, unknown>;
type ReadSkillPackStateFn = typeof import("../../skill-pack-state.js").readSkillPackState;
type UpdateSkillPackPolicyFn = typeof import("../../skill-pack-state.js").updateSkillPackPolicy;
type ComputeOrgxAgentSuitePlanFn = typeof import("../../agent-suite.js").computeOrgxAgentSuitePlan;
type ApplyOrgxAgentSuitePlanFn = typeof import("../../agent-suite.js").applyOrgxAgentSuitePlan;
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
        const pinnedChecksumRaw = payload.pinnedChecksum;
        const pinnedChecksum =
          typeof pinnedChecksumRaw === "string"
            ? pinnedChecksumRaw
            : pinnedChecksumRaw === null
              ? null
              : undefined;

        const state = deps.updateSkillPackPolicy({
          frozen,
          pinToCurrent,
          clearPin,
          pinnedChecksum,
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

        deps.sendJson(res, 200, { ok: true, data: state.policy });
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
