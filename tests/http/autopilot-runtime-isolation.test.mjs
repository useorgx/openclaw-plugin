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

test("autopilot codex worker forces safe CODEX_HOME even when isolation flag is disabled", async (t) => {
  const codexVersion = spawnSync("codex", ["--version"], { encoding: "utf8" });
  if (codexVersion.status !== 0) {
    t.skip("codex binary is not available in this environment");
    return;
  }

  const root = mkdtempSync(join(tmpdir(), "orgx-autopilot-runtime-force-"));
  const brokenHome = join(root, "broken-codex-home");
  const pluginConfigDir = join(root, "plugin-config");
  mkdirSync(brokenHome, { recursive: true });
  mkdirSync(pluginConfigDir, { recursive: true });

  writeFileSync(
    join(brokenHome, "config.toml"),
    '[mcp_servers.firecrawl]\ntransport = "bogus"\n',
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
      ORGX_AUTOPILOT_ISOLATE_CODEX_HOME: "false",
      ORGX_AUTOPILOT_CODEX_MCP_MODE: "none",
      ORGX_CODEX_ARGS: "--help",
    },
    async () => {
      runtime.spawnCodexSliceWorker({
        runId: "slice-test-force",
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
    /forced-safe override while ORGX_AUTOPILOT_ISOLATE_CODEX_HOME=false/i.test(log),
    "expected forced-safe codex home log line"
  );
  assert.ok(log.includes("Run Codex non-interactively"), "expected codex to boot");
  assert.ok(!/Error loading config\\.toml/i.test(log), "forced-safe override should avoid broken global config");
  assert.ok(existsSync(outputPath), "worker should always leave a structured output file");
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

test("autopilot isolation extracts orgx-openclaw MCP URL from single-quoted source config", async () => {
  const root = mkdtempSync(join(tmpdir(), "orgx-autopilot-runtime-source-url-"));
  const sourceHome = join(root, "source-codex-home");
  const pluginConfigDir = join(root, "plugin-config");
  mkdirSync(sourceHome, { recursive: true });
  mkdirSync(pluginConfigDir, { recursive: true });

  writeFileSync(
    join(sourceHome, "config.toml"),
    [
      '[mcp_servers."orgx-openclaw"]',
      "url = 'https://mcp.example.com/orgx/mcp' # inherited from user config",
      "",
    ].join("\n"),
    "utf8"
  );

  const nodeStubPath = join(root, "node-stub.mjs");
  writeFileSync(nodeStubPath, "process.exit(0);\n", "utf8");

  const runtime = createAutopilotRuntime({
    filename: new URL("../../dist/http/helpers/autopilot-runtime.js", import.meta.url).pathname,
    autoContinueSliceChildren: new Map(),
    resolveByokEnvOverrides: () => ({}),
    safeErrorMessage: (err) => (err instanceof Error ? err.message : String(err)),
    resolveCodexBinInfo: () => ({
      bin: process.execPath,
      version: process.version,
      versionString: process.version,
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

  const logPath = join(root, "slice.log");
  const outputPath = join(root, "slice.output.json");
  await withEnv(
    {
      CODEX_HOME: sourceHome,
      ORGX_OPENCLAW_PLUGIN_CONFIG_DIR: pluginConfigDir,
      ORGX_AUTOPILOT_ISOLATE_CODEX_HOME: "true",
      ORGX_CODEX_ARGS: nodeStubPath,
    },
    async () => {
      runtime.spawnCodexSliceWorker({
        runId: "slice-test-source-url",
        prompt: "Return exactly OK",
        cwd: process.cwd(),
        logPath,
        outputPath,
        env: {
          ORGX_WORKSTREAM_ID: "ws-test",
          ORGX_WORKSTREAM_TITLE: "WS Test",
        },
      });

      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  );

  const generatedConfigPath = join(pluginConfigDir, "codex-autopilot-home", "config.toml");
  assert.ok(existsSync(generatedConfigPath), "expected isolated config.toml to be generated");
  const generatedConfig = readFileSync(generatedConfigPath, "utf8");
  assert.match(
    generatedConfig,
    /url = "https:\/\/mcp\.example\.com\/orgx\/mcp"/,
    "expected source orgx-openclaw URL to be preserved in isolated config"
  );
});

test("autopilot claude worker injects print/json/schema defaults for structured output parity", async () => {
  const root = mkdtempSync(join(tmpdir(), "orgx-autopilot-runtime-claude-"));
  const pluginConfigDir = join(root, "plugin-config");
  mkdirSync(pluginConfigDir, { recursive: true });

  const schemaPath = join(root, "slice.schema.json");
  writeFileSync(
    schemaPath,
    JSON.stringify({
      type: "object",
      additionalProperties: false,
      required: ["status", "summary"],
      properties: {
        status: { type: "string" },
        summary: { type: "string" },
      },
    }),
    "utf8"
  );

  const claudeStubPath = join(root, "claude-stub.mjs");
  writeFileSync(
    claudeStubPath,
    [
      "const args = process.argv.slice(2);",
      "const hasPrint = args.includes('--print') || args.includes('-p');",
      "const outputFormatFlag = args.find((arg) => arg.startsWith('--output-format=')) || null;",
      "const outputFormatInline = outputFormatFlag ? outputFormatFlag.split('=')[1] : null;",
      "const outputFormatIndex = args.indexOf('--output-format');",
      "const outputFormat = outputFormatInline || (outputFormatIndex >= 0 ? args[outputFormatIndex + 1] || null : null);",
      "const schemaFlag = args.find((arg) => arg.startsWith('--json-schema=')) || null;",
      "const schemaInline = schemaFlag ? schemaFlag.slice('--json-schema='.length) : null;",
      "const schemaIndex = args.indexOf('--json-schema');",
      "const schemaValue = schemaInline || (schemaIndex >= 0 ? args[schemaIndex + 1] || null : null);",
      "const permissionFlag = args.find((arg) => arg.startsWith('--permission-mode=')) || null;",
      "const permissionInline = permissionFlag ? permissionFlag.slice('--permission-mode='.length) : null;",
      "const permissionIndex = args.indexOf('--permission-mode');",
      "const permissionMode = permissionInline || (permissionIndex >= 0 ? args[permissionIndex + 1] || null : null);",
      "const hasDangerousSkip = args.includes('--dangerously-skip-permissions') || args.includes('--allow-dangerously-skip-permissions');",
      "const prompt = args[args.length - 1] || '';",
      "const payload = {",
      "  type: 'result',",
      "  structured_output: {",
      "    status: 'completed',",
      "    summary: 'claude stub completed',",
      "    workstream_id: process.env.ORGX_WORKSTREAM_ID || 'ws-test',",
      "    workstream_title: process.env.ORGX_WORKSTREAM_TITLE || 'WS Test',",
      "    slice_id: process.env.ORGX_RUN_ID || 'slice-claude-test',",
      "    artifacts: [],",
      "    decisions_needed: [],",
      "    skill_evidence: [],",
      "    task_updates: [],",
      "    milestone_updates: [],",
      "    next_actions: []",
      "  },",
      "  debug: {",
      "    hasPrint,",
      "    outputFormat,",
      "    hasJsonSchema: Boolean(schemaValue),",
      "    permissionMode,",
      "    hasDangerousSkip,",
      "    promptSeen: prompt.includes('stub prompt')",
      "  }",
      "};",
      "process.stdout.write(`${JSON.stringify(payload)}\\n`);",
    ].join("\n"),
    "utf8"
  );

  const logPath = join(root, "claude-slice.log");
  const outputPath = join(root, "claude-slice.output.json");
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
      ORGX_OPENCLAW_PLUGIN_CONFIG_DIR: pluginConfigDir,
      ORGX_AUTOPILOT_WORKER_KIND: "claude-code",
      ORGX_CLAUDE_CODE_BIN: "node",
      ORGX_CLAUDE_CODE_ARGS: claudeStubPath,
    },
    async () => {
      runtime.spawnCodexSliceWorker({
        runId: "slice-claude-test",
        prompt: "stub prompt for claude worker parity",
        cwd: process.cwd(),
        logPath,
        outputPath,
        outputSchemaPath: schemaPath,
        env: {
          ORGX_WORKSTREAM_ID: "ws-test",
          ORGX_WORKSTREAM_TITLE: "WS Test",
          ORGX_RUN_ID: "slice-claude-test",
        },
      });

      await new Promise((resolve) => setTimeout(resolve, 1200));
    }
  );

  const log = existsSync(logPath) ? readFileSync(logPath, "utf8") : "";
  assert.match(log, /claude_bin:\s+node/i);
  assert.match(log, /claude_output_format:\s+json/i);
  assert.match(log, /claude_json_schema:\s+/i);
  assert.ok(existsSync(outputPath), "claude worker should write output");
  const output = JSON.parse(readFileSync(outputPath, "utf8"));
  assert.equal(output?.debug?.hasPrint, true);
  assert.equal(String(output?.debug?.outputFormat ?? "").toLowerCase(), "json");
  assert.equal(output?.debug?.hasJsonSchema, true);
  assert.equal(String(output?.debug?.permissionMode ?? "").toLowerCase(), "bypasspermissions");
  assert.equal(output?.debug?.hasDangerousSkip, true);
  assert.equal(output?.debug?.promptSeen, true);
});
