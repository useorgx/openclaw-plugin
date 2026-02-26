import test from "node:test";
import assert from "node:assert/strict";

import { registerCoreTools } from "../../dist/tools/core-tools.js";

function createDeps(overrides = {}) {
  const calls = [];
  const state = {
    version: 1,
    updatedAt: "2026-02-20T00:00:00.000Z",
    lastCheckedAt: "2026-02-20T00:00:00.000Z",
    lastError: null,
    etag: "etag-1",
    policy: { frozen: false, pinnedChecksum: "sha-old" },
    pack: {
      name: "orgx-agent-suite",
      version: "1.0.0",
      checksum: "sha-old",
      updated_at: "2026-02-20T00:00:00.000Z",
    },
    remote: {
      name: "orgx-agent-suite",
      version: "1.0.1",
      checksum: "sha-new",
      updated_at: "2026-02-20T00:05:00.000Z",
    },
    overrides: null,
  };

  const deps = {
    registerTool: () => {},
    client: {
      syncMemory: async () => ({}),
      checkSpawnGuard: async () => ({ ok: true, allowed: true, modelTier: "sonnet", checks: {} }),
      createEntity: async () => ({}),
      updateEntity: async () => ({}),
      updateEntityDetailed: async () => ({ entity: {} }),
      listEntities: async () => ({ data: [] }),
      emitActivity: async () => ({}),
      applyChangeset: async () => ({ applied_count: 1, replayed: false, run_id: "run" }),
    },
    config: { syncIntervalMs: 10_000, pluginVersion: "test" },
    getCachedSnapshot: () => null,
    getLastSnapshotAt: () => 0,
    doSync: async () => {},
    text: (value) => ({ content: [{ type: "text", text: value }] }),
    json: (label, data) => ({ content: [{ type: "text", text: `${label}\n${JSON.stringify(data)}` }] }),
    formatSnapshot: () => "snapshot",
    autoAssignEntityForCreate: async () => ({ assignmentSource: "manual", assignedAgents: [], warnings: [] }),
    toReportingPhase: () => "execution",
    inferReportingInitiativeId: () => undefined,
    isUuid: () => true,
    pickNonEmptyString: (...values) => {
      for (const value of values) {
        if (typeof value === "string" && value.trim()) return value.trim();
      }
      return undefined;
    },
    resolveReportingContext: () => ({
      ok: true,
      value: { initiativeId: "11111111-1111-4111-8111-111111111111", sourceClient: "codex" },
    }),
    readSkillPackState: () => ({ ...state }),
    updateSkillPackPolicy: (input) => {
      calls.push(input);
      if (Object.prototype.hasOwnProperty.call(input, "frozen")) {
        state.policy.frozen = Boolean(input.frozen);
      }
      if (input.clearPin) {
        state.policy.pinnedChecksum = null;
      } else if (input.pinToCurrent) {
        state.policy.pinnedChecksum = state.pack?.checksum ?? state.remote?.checksum ?? null;
      } else if (typeof input.pinnedChecksum === "string") {
        state.policy.pinnedChecksum = input.pinnedChecksum;
      } else if (input.pinnedChecksum === null) {
        state.policy.pinnedChecksum = null;
      }
      state.updatedAt = "2026-02-20T00:10:00.000Z";
      return {
        updatedAt: state.updatedAt,
        lastCheckedAt: state.lastCheckedAt,
        lastError: state.lastError,
        policy: { ...state.policy },
        pack: state.pack ? { ...state.pack } : null,
        remote: state.remote ? { ...state.remote } : null,
      };
    },
    rollbackSkillPackPolicy: (input = {}) => {
      calls.push({ rollback: true, ...input });
      state.policy.frozen = false;
      state.policy.pinnedChecksum = "sha-old";
      state.updatedAt = "2026-02-20T00:11:00.000Z";
      return {
        updatedAt: state.updatedAt,
        lastCheckedAt: state.lastCheckedAt,
        lastError: state.lastError,
        policy: { ...state.policy },
        pack: state.pack ? { ...state.pack } : null,
        remote: state.remote ? { ...state.remote } : null,
      };
    },
    randomUUID: () => "uuid-test",
    ...overrides,
  };

  return { deps, calls, state };
}

test("agent config MCP tools expose strict schemas", () => {
  const { deps } = createDeps();
  const tools = registerCoreTools(deps);

  assert.equal(tools.get("list_agent_configs")?.parameters.additionalProperties, false);
  assert.equal(tools.get("get_agent_config")?.parameters.additionalProperties, false);
  assert.equal(tools.get("update_agent_config")?.parameters.additionalProperties, false);
});

test("update_stream_progress aliases progress reporting with expected payload shape", async () => {
  let capturedPayload = null;
  const { deps } = createDeps({
    client: {
      syncMemory: async () => ({}),
      checkSpawnGuard: async () => ({ ok: true, allowed: true, modelTier: "sonnet", checks: {} }),
      createEntity: async () => ({}),
      updateEntity: async () => ({}),
      updateEntityDetailed: async () => ({ entity: {} }),
      listEntities: async () => ({ data: [] }),
      emitActivity: async (payload) => {
        capturedPayload = payload;
        return { run_id: "run-12345678" };
      },
      applyChangeset: async () => ({ applied_count: 1, replayed: false, run_id: "run" }),
    },
    toReportingPhase: () => "execution",
  });
  const tool = registerCoreTools(deps).get("update_stream_progress");

  const result = await tool.execute("call-progress", {
    summary: "Started slice",
    phase: "implementing",
    progress_pct: 15,
    next_step: "Write targeted tests",
  });

  assert.equal(typeof tool?.execute, "function");
  assert.equal(capturedPayload?.message, "Started slice");
  assert.equal(capturedPayload?.phase, "execution");
  assert.equal(capturedPayload?.progress_pct, 15);
  assert.equal(capturedPayload?.metadata?.source, "update_stream_progress");
  assert.match(result.content[0].text, /Activity emitted: Started slice/);
});

test("list_agent_configs returns the default config snapshot", async () => {
  const { deps } = createDeps();
  const tool = registerCoreTools(deps).get("list_agent_configs");

  const result = await tool.execute("call-list", {});
  const payload = JSON.parse(result.content[0].text.split("\n").slice(1).join("\n"));

  assert.equal(payload.total, 1);
  assert.equal(payload.configs[0].config_id, "default");
  assert.equal(payload.configs[0].config_type, "skill_pack_policy");
  assert.equal(payload.configs[0].update_available, true);
});

test("get_agent_config rejects unknown config ids", async () => {
  const { deps } = createDeps();
  const tool = registerCoreTools(deps).get("get_agent_config");

  const result = await tool.execute("call-get", { config_id: "unknown" });
  assert.match(result.content[0].text, /config_id must be 'default'/);
});

test("update_agent_config validates mutation payload", async () => {
  const { deps, calls } = createDeps();
  const tool = registerCoreTools(deps).get("update_agent_config");

  const empty = await tool.execute("call-update-empty", { config_id: "default" });
  assert.equal(calls.length, 0);
  assert.match(empty.content[0].text, /Include at least one mutable field/);

  const conflict = await tool.execute("call-update-conflict", {
    config_id: "default",
    pin_to_current: true,
    clear_pin: true,
  });
  assert.equal(calls.length, 0);
  assert.match(conflict.content[0].text, /cannot both be true/);

  const badTemplate = await tool.execute("call-update-template", {
    config_id: "default",
    template_id: "unknown",
  });
  assert.equal(calls.length, 0);
  assert.match(badTemplate.content[0].text, /template_id must be 'startup-speed'/);

  const badAction = await tool.execute("call-update-bad-action", {
    config_id: "default",
    action: "rotate",
  });
  assert.equal(calls.length, 0);
  assert.match(badAction.content[0].text, /action must be 'rollback'/);

  const rollbackConflict = await tool.execute("call-update-rollback-conflict", {
    config_id: "default",
    action: "rollback",
    clear_pin: true,
  });
  assert.equal(calls.length, 0);
  assert.match(rollbackConflict.content[0].text, /Rollback requests cannot include update fields/);
});

test("update_agent_config applies policy updates and returns updated snapshot", async () => {
  const { deps, calls } = createDeps();
  const tool = registerCoreTools(deps).get("update_agent_config");

  const result = await tool.execute("call-update", {
    config_id: "default",
    frozen: true,
    pinned_checksum: "  sha-123  ",
  });

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], {
    frozen: true,
    pinnedChecksum: "sha-123",
    pinToCurrent: false,
    clearPin: false,
  });

  const payload = JSON.parse(result.content[0].text.split("\n").slice(1).join("\n"));
  assert.equal(payload.config_id, "default");
  assert.equal(payload.policy.frozen, true);
  assert.equal(payload.policy.pinnedChecksum, "sha-123");
  assert.equal(payload.updated_at, "2026-02-20T00:10:00.000Z");
});

test("update_agent_config supports one-click rollback to previous version", async () => {
  const { deps, calls } = createDeps();
  const tool = registerCoreTools(deps).get("update_agent_config");

  const result = await tool.execute("call-rollback", {
    config_id: "default",
    action: "rollback",
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.rollback, true);
  assert.equal(calls[0]?.auditId, undefined);
  assert.match(result.content[0].text, /Agent config rolled back/);
});

test("update_agent_config applies startup-speed template for shared default config", async () => {
  const { deps, calls, state } = createDeps();
  state.policy.frozen = true;
  state.policy.pinnedChecksum = "sha-old";
  const tool = registerCoreTools(deps).get("update_agent_config");

  const result = await tool.execute("call-update-template", {
    config_id: "default",
    template_id: "startup-speed",
  });

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], {
    frozen: false,
    pinnedChecksum: undefined,
    pinToCurrent: false,
    clearPin: true,
  });

  const payload = JSON.parse(result.content[0].text.split("\n").slice(1).join("\n"));
  assert.equal(payload.policy.frozen, false);
  assert.equal(payload.policy.pinnedChecksum, null);
});

test("list_agent_configs refresh_remote fetches and reflects latest server pack", async () => {
  let getSkillPackCalls = 0;
  const { deps, state } = createDeps({
    client: {
      syncMemory: async () => ({}),
      checkSpawnGuard: async () => ({ ok: true, allowed: true, modelTier: "sonnet", checks: {} }),
      createEntity: async () => ({}),
      updateEntity: async () => ({}),
      updateEntityDetailed: async () => ({ entity: {} }),
      listEntities: async () => ({ data: [] }),
      emitActivity: async () => ({}),
      applyChangeset: async () => ({ applied_count: 1, replayed: false, run_id: "run" }),
      getSkillPack: async () => {
        getSkillPackCalls += 1;
        return {
          ok: true,
          notModified: false,
          etag: "etag-2",
          pack: {
            name: "orgx-agent-suite",
            version: "1.0.2",
            checksum: "sha-server",
            updated_at: "2026-02-20T00:15:00.000Z",
          },
        };
      },
    },
  });
  state.policy.pinnedChecksum = null;

  const tool = registerCoreTools(deps).get("list_agent_configs");
  const result = await tool.execute("call-list-refresh", { refresh_remote: true });
  const payload = JSON.parse(result.content[0].text.split("\n").slice(1).join("\n"));

  assert.equal(getSkillPackCalls, 1);
  assert.equal(payload.configs[0].pack.checksum, "sha-server");
  assert.equal(payload.configs[0].remote.checksum, "sha-server");
  assert.equal(payload.configs[0].update_available, false);
});

test("get_agent_config refresh_remote keeps pinned local checksum while updating remote", async () => {
  let getSkillPackCalls = 0;
  const { deps, state } = createDeps({
    client: {
      syncMemory: async () => ({}),
      checkSpawnGuard: async () => ({ ok: true, allowed: true, modelTier: "sonnet", checks: {} }),
      createEntity: async () => ({}),
      updateEntity: async () => ({}),
      updateEntityDetailed: async () => ({ entity: {} }),
      listEntities: async () => ({ data: [] }),
      emitActivity: async () => ({}),
      applyChangeset: async () => ({ applied_count: 1, replayed: false, run_id: "run" }),
      getSkillPack: async () => {
        getSkillPackCalls += 1;
        return {
          ok: true,
          notModified: false,
          etag: "etag-2",
          pack: {
            name: "orgx-agent-suite",
            version: "1.0.2",
            checksum: "sha-server",
            updated_at: "2026-02-20T00:15:00.000Z",
          },
        };
      },
    },
  });
  state.policy.pinnedChecksum = "sha-old";

  const tool = registerCoreTools(deps).get("get_agent_config");
  const result = await tool.execute("call-get-refresh", {
    config_id: "default",
    refresh_remote: true,
  });
  const payload = JSON.parse(result.content[0].text.split("\n").slice(1).join("\n"));

  assert.equal(getSkillPackCalls, 1);
  assert.equal(payload.pack.checksum, "sha-old");
  assert.equal(payload.remote.checksum, "sha-server");
  assert.equal(payload.update_available, true);
});

test("list_agent_configs refresh_remote blocks activation when eval status is not approved", async () => {
  let getSkillPackCalls = 0;
  const { deps } = createDeps({
    client: {
      syncMemory: async () => ({}),
      checkSpawnGuard: async () => ({ ok: true, allowed: true, modelTier: "sonnet", checks: {} }),
      createEntity: async () => ({}),
      updateEntity: async () => ({}),
      updateEntityDetailed: async () => ({ entity: {} }),
      listEntities: async () => ({ data: [] }),
      emitActivity: async () => ({}),
      applyChangeset: async () => ({ applied_count: 1, replayed: false, run_id: "run" }),
      getSkillPack: async () => {
        getSkillPackCalls += 1;
        return {
          ok: true,
          notModified: false,
          etag: "etag-2",
          pack: {
            name: "orgx-agent-suite",
            version: "1.0.2",
            checksum: "sha-server",
            status: "pending_review",
            updated_at: "2026-02-20T00:15:00.000Z",
          },
        };
      },
    },
  });

  const tool = registerCoreTools(deps).get("list_agent_configs");
  const result = await tool.execute("call-list-refresh-eval-block", { refresh_remote: true });
  const payload = JSON.parse(result.content[0].text.split("\n").slice(1).join("\n"));

  assert.equal(getSkillPackCalls, 1);
  assert.equal(payload.configs[0].pack.checksum, "sha-old");
  assert.equal(payload.configs[0].remote.checksum, "sha-server");
  assert.match(payload.configs[0].last_error ?? "", /eval gate blocked activation/i);
  assert.equal(payload.configs[0].update_available, true);
});

test("list_agent_configs refresh_remote blocks activation when manifest validation fails", async () => {
  let getSkillPackCalls = 0;
  const { deps } = createDeps({
    client: {
      syncMemory: async () => ({}),
      checkSpawnGuard: async () => ({ ok: true, allowed: true, modelTier: "sonnet", checks: {} }),
      createEntity: async () => ({}),
      updateEntity: async () => ({}),
      updateEntityDetailed: async () => ({ entity: {} }),
      listEntities: async () => ({ data: [] }),
      emitActivity: async () => ({}),
      applyChangeset: async () => ({ applied_count: 1, replayed: false, run_id: "run" }),
      getSkillPack: async () => {
        getSkillPackCalls += 1;
        return {
          ok: true,
          notModified: false,
          etag: "etag-2",
          pack: {
            name: "orgx-agent-suite",
            version: "1.0.2",
            checksum: "sha-server",
            status: "approved",
            manifest: {
              openclaw_skills: {
                engineering: "# valid override",
                invalid_domain: "# invalid override",
              },
            },
            updated_at: "2026-02-20T00:15:00.000Z",
          },
        };
      },
    },
  });

  const tool = registerCoreTools(deps).get("list_agent_configs");
  const result = await tool.execute("call-list-refresh-manifest-block", { refresh_remote: true });
  const payload = JSON.parse(result.content[0].text.split("\n").slice(1).join("\n"));

  assert.equal(getSkillPackCalls, 1);
  assert.equal(payload.configs[0].pack.checksum, "sha-old");
  assert.equal(payload.configs[0].remote.checksum, "sha-server");
  assert.match(payload.configs[0].last_error ?? "", /manifest validation errors/i);
  assert.equal(payload.configs[0].update_available, true);
});
