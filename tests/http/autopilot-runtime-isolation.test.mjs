import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createAutopilotRuntime } from "../../dist/http/helpers/autopilot-runtime.js";

function withEnv(patch, fn) {
  const prev = {};
  for (const [k, v] of Object.entries(patch)) {
    prev[k] = process.env[k];
    if (v == null) delete process.env[k];
    else process.env[k] = String(v);
  }
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const [k, v] of Object.entries(prev)) {
        if (v == null) delete process.env[k];
        else process.env[k] = v;
      }
    });
}

test("autopilot codex worker isolates broken global config via CODEX_HOME", async (t) => {
  const codexVersion = spawnSync("codex", ["--version"], { encoding: "utf8" });
  if (codexVersion.status !== 0) {
    t.skip("codex binary is not available in this environment");
    return;
  }

  const root = mkdtempSync(join(tmpdir(), "orgx-autopilot-runtime-"));
  const brokenHome = join(root, "broken-codex-home");
  const pluginConfigDir = join(root, "plugin-config");
  mkdirSync(brokenHome, { recursive: true });
  mkdirSync(pluginConfigDir, { recursive: true });

  writeFileSync(
    join(brokenHome, "config.toml"),
    '[mcp_servers.codex_apps]\ntransport = "bogus"\n',
    "utf8"
  );

  const logPath = join(root, "slice.log");
  const outputPath = join(root, "slice.output.json");
  const runtime = createAutopilotRuntime({
    filename: new URL("../../dist/http/helpers/autopilot-runtime.js", import.meta.url).pathname,
    autoContinueSliceChildren: new Map(),
    resolveByokEnvOverrides: () => ({}),
    safeErrorMessage: (err) => (err instanceof Error ? err.message : String(err)),
    resolveCodexBinInfo: () => ({
      bin: "codex",
      version: null,
      versionString: "codex",
    }),
    upsertRuntimeInstanceFromHook: (payload) => ({
      id: "runtime-test",
      sourceClient: "openclaw",
      displayName: "runtime-test",
      providerLogo: "openclaw",
      state: "active",
      runId: payload.run_id ?? null,
      correlationId: payload.correlation_id ?? null,
      initiativeId: payload.initiative_id ?? null,
      workstreamId: payload.workstream_id ?? null,
      taskId: payload.task_id ?? null,
      agentId: payload.agent_id ?? null,
      agentName: payload.agent_name ?? null,
      phase: payload.phase ?? null,
      progressPct: payload.progress_pct ?? null,
      currentTask: null,
      lastHeartbeatAt: null,
      lastEventAt: payload.timestamp ?? new Date().toISOString(),
      lastMessage: payload.message ?? null,
      metadata: payload.metadata ?? null,
    }),
    broadcastRuntimeSse: () => {},
    clearSnapshotResponseCache: () => {},
  });

  await withEnv(
    {
      CODEX_HOME: brokenHome,
      ORGX_OPENCLAW_PLUGIN_CONFIG_DIR: pluginConfigDir,
      ORGX_AUTOPILOT_ISOLATE_CODEX_HOME: "true",
      ORGX_AUTOPILOT_CODEX_MCP_MODE: "none",
      ORGX_CODEX_ARGS: "--help",
    },
    async () => {
      runtime.spawnCodexSliceWorker({
        runId: "slice-test",
        prompt: "Return exactly OK",
        cwd: process.cwd(),
        logPath,
        outputPath,
        env: {
          ORGX_WORKSTREAM_ID: "ws-test",
          ORGX_WORKSTREAM_TITLE: "WS Test",
        },
      });

      await new Promise((resolve) => setTimeout(resolve, 1200));
    }
  );

  const log = existsSync(logPath) ? readFileSync(logPath, "utf8") : "";
  assert.ok(log.includes("Run Codex non-interactively"), "expected codex to boot");
  assert.ok(!/Error loading config\\.toml/i.test(log), "broken global config should be isolated");
  assert.ok(existsSync(outputPath), "worker should always leave a structured output file");
  const outputRaw = readFileSync(outputPath, "utf8");
  const output = JSON.parse(outputRaw);
  assert.equal(output.status, "error");
  assert.match(String(output.summary ?? ""), /without structured output/i);
});

test("autopilot isolation falls back to temp CODEX_HOME when configured path is invalid", async (t) => {
  const codexVersion = spawnSync("codex", ["--version"], { encoding: "utf8" });
  if (codexVersion.status !== 0) {
    t.skip("codex binary is not available in this environment");
    return;
  }

  const root = mkdtempSync(join(tmpdir(), "orgx-autopilot-runtime-fallback-"));
  const brokenHome = join(root, "broken-codex-home");
  const pluginConfigDir = join(root, "plugin-config");
  mkdirSync(brokenHome, { recursive: true });
  mkdirSync(pluginConfigDir, { recursive: true });

  writeFileSync(
    join(brokenHome, "config.toml"),
    '[mcp_servers.firecrawl]\ntransport = "bogus"\n',
    "utf8"
  );

  const invalidTargetHome = join(root, "invalid-codex-home");
  writeFileSync(invalidTargetHome, "not-a-directory", "utf8");

  const logPath = join(root, "slice.log");
  const outputPath = join(root, "slice.output.json");
  const runtime = createAutopilotRuntime({
    filename: new URL("../../dist/http/helpers/autopilot-runtime.js", import.meta.url).pathname,
    autoContinueSliceChildren: new Map(),
    resolveByokEnvOverrides: () => ({}),
    safeErrorMessage: (err) => (err instanceof Error ? err.message : String(err)),
    resolveCodexBinInfo: () => ({
      bin: "codex",
      version: null,
      versionString: "codex",
    }),
    upsertRuntimeInstanceFromHook: (payload) => ({
      id: "runtime-test",
      sourceClient: "openclaw",
      displayName: "runtime-test",
      providerLogo: "openclaw",
      state: "active",
      runId: payload.run_id ?? null,
      correlationId: payload.correlation_id ?? null,
      initiativeId: payload.initiative_id ?? null,
      workstreamId: payload.workstream_id ?? null,
      taskId: payload.task_id ?? null,
      agentId: payload.agent_id ?? null,
      agentName: payload.agent_name ?? null,
      phase: payload.phase ?? null,
      progressPct: payload.progress_pct ?? null,
      currentTask: null,
      lastHeartbeatAt: null,
      lastEventAt: payload.timestamp ?? new Date().toISOString(),
      lastMessage: payload.message ?? null,
      metadata: payload.metadata ?? null,
    }),
    broadcastRuntimeSse: () => {},
    clearSnapshotResponseCache: () => {},
  });

  await withEnv(
    {
      CODEX_HOME: brokenHome,
      ORGX_OPENCLAW_PLUGIN_CONFIG_DIR: pluginConfigDir,
      ORGX_AUTOPILOT_ISOLATE_CODEX_HOME: "true",
      ORGX_AUTOPILOT_CODEX_HOME: invalidTargetHome,
      ORGX_AUTOPILOT_CODEX_MCP_MODE: "none",
      ORGX_CODEX_ARGS: "--help",
    },
    async () => {
      runtime.spawnCodexSliceWorker({
        runId: "slice-test-fallback",
        prompt: "Return exactly OK",
        cwd: process.cwd(),
        logPath,
        outputPath,
        env: {
          ORGX_WORKSTREAM_ID: "ws-test",
          ORGX_WORKSTREAM_TITLE: "WS Test",
        },
      });

      await new Promise((resolve) => setTimeout(resolve, 1200));
    }
  );

  const log = existsSync(logPath) ? readFileSync(logPath, "utf8") : "";
  assert.ok(
    /codex_home:\s+.*orgx-autopilot-codex-home-/i.test(log),
    "expected fallback temporary CODEX_HOME path in log"
  );
  assert.ok(log.includes("Run Codex non-interactively"), "expected codex to boot");
  assert.ok(!/Error loading config\\.toml/i.test(log), "fallback home should avoid broken inherited config");
  assert.ok(existsSync(outputPath), "worker should always leave a structured output file");
});
