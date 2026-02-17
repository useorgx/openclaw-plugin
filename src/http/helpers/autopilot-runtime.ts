import {
  chmodSync,
  createWriteStream,
  mkdirSync,
  writeFileSync,
} from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { dirname, resolve, sep } from "node:path";

import type { RuntimeHookPayload, RuntimeInstanceRecord } from "../../runtime-instance-store.js";
import type { RuntimeSourceClient } from "../../runtime-instance-store.js";
import type { CodexBinInfo } from "./autopilot-slice-utils.js";
import { normalizeCodexArgs } from "./autopilot-slice-utils.js";

type CreateAutopilotRuntimeDeps = {
  filename: string;
  autoContinueSliceChildren: Map<string, ChildProcess>;
  resolveByokEnvOverrides: () => Record<string, string | undefined>;
  safeErrorMessage: (err: unknown) => string;
  resolveCodexBinInfo: () => CodexBinInfo;
  upsertRuntimeInstanceFromHook: (
    payload: RuntimeHookPayload
  ) => RuntimeInstanceRecord;
  broadcastRuntimeSse: (
    event: string,
    payload: RuntimeInstanceRecord
  ) => void;
  clearSnapshotResponseCache: () => void;
};

export function createAutopilotRuntime(deps: CreateAutopilotRuntimeDeps) {
  function ensurePrivateDirForFile(pathname: string): void {
    const dir = dirname(pathname);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    try {
      chmodSync(dir, 0o700);
    } catch {
      // best effort
    }
  }

  function spawnCodexSliceWorker(input: {
    runId: string;
    prompt: string;
    cwd: string;
    logPath: string;
    outputPath: string;
    env: Record<string, string | undefined>;
  }): { pid: number | null } {
    ensurePrivateDirForFile(input.logPath);
    ensurePrivateDirForFile(input.outputPath);

    const workerKind = (process.env.ORGX_AUTOPILOT_WORKER_KIND ?? "").trim().toLowerCase();
    if (workerKind === "mock") {
      const scriptPath = resolve(
        dirname(deps.filename),
        "..",
        "..",
        "scripts",
        "mock-autopilot-slice-worker.mjs"
      );
      const logStream = createWriteStream(input.logPath, { flags: "a" });
      const outStream = createWriteStream(input.outputPath, { flags: "a" });
      logStream.write(`\n==== ${new Date().toISOString()} :: mock slice ${input.runId} ====\n`);

      const child = spawn("node", [scriptPath], {
        cwd: input.cwd,
        env: {
          ...process.env,
          ...input.env,
        },
        stdio: ["ignore", "pipe", "pipe"],
        // Keep the mock worker as a normal child so stdout/stderr capture is deterministic.
        detached: false,
      });
      deps.autoContinueSliceChildren.set(input.runId, child);
      try {
        logStream.write(
          `spawned pid=${String(child.pid ?? "")} stdout=${String(Boolean(child.stdout))} stderr=${String(
            Boolean(child.stderr)
          )}\n`
        );
      } catch {
        // ignore
      }

      child.stdout?.on("data", (chunk) => {
        try {
          logStream.write(chunk);
        } catch {
          // ignore
        }
        try {
          outStream.write(chunk);
        } catch {
          // ignore
        }
      });
      child.stderr?.on("data", (chunk) => {
        try {
          logStream.write(chunk);
        } catch {
          // ignore
        }
      });

      child.on("close", (code, signal) => {
        deps.autoContinueSliceChildren.delete(input.runId);
        const stamp = new Date().toISOString();
        try {
          logStream.write(`\n==== ${stamp} :: exit code=${String(code)} signal=${String(signal)} ====\n`);
        } catch {
          // ignore
        }
        try {
          logStream.end();
        } catch {
          // ignore
        }
        try {
          outStream.end();
        } catch {
          // ignore
        }
      });
      child.on("error", (error) => {
        deps.autoContinueSliceChildren.delete(input.runId);
        const msg = deps.safeErrorMessage(error);
        try {
          logStream.write(`\nworker error: ${msg}\n`);
        } catch {
          // ignore
        }
        try {
          outStream.write(
            `${JSON.stringify(
              {
                status: "error",
                summary: `Worker spawn error: ${msg}`,
                workstream_id: input.env.ORGX_WORKSTREAM_ID ?? "unknown",
                workstream_title: input.env.ORGX_WORKSTREAM_TITLE ?? null,
                slice_id: input.runId,
              },
              null,
              2
            )}\n`
          );
        } catch {
          // ignore
        }
      });

      return { pid: child.pid ?? null };
    }

    if (workerKind === "claude-code" || workerKind === "claude_code") {
      const claudeBin = (process.env.ORGX_CLAUDE_CODE_BIN ?? "").trim() || "claude";
      const rawArgs = (process.env.ORGX_CLAUDE_CODE_ARGS ?? "").trim();
      const args = rawArgs.length > 0 ? rawArgs.split(/\s+/).filter(Boolean) : [];

      const logStream = createWriteStream(input.logPath, { flags: "a" });
      const outStream = createWriteStream(input.outputPath, { flags: "a" });
      logStream.write(`\n==== ${new Date().toISOString()} :: claude slice ${input.runId} ====\n`);

      // Claude Code invocation is environment-specific; ORGX_CLAUDE_CODE_ARGS should be set to
      // a headless-compatible command shape. We pass the prompt as the final argument.
      const child = spawn(claudeBin, [...args, input.prompt], {
        cwd: input.cwd,
        env: {
          ...process.env,
          ...deps.resolveByokEnvOverrides(),
          ...input.env,
        },
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
      });
      deps.autoContinueSliceChildren.set(input.runId, child);

      child.stdout?.on("data", (chunk) => {
        try {
          logStream.write(chunk);
        } catch {
          // ignore
        }
        try {
          outStream.write(chunk);
        } catch {
          // ignore
        }
      });
      child.stderr?.on("data", (chunk) => {
        try {
          logStream.write(chunk);
        } catch {
          // ignore
        }
      });

      child.on("close", (code, signal) => {
        deps.autoContinueSliceChildren.delete(input.runId);
        const stamp = new Date().toISOString();
        try {
          logStream.write(`\n==== ${stamp} :: exit code=${String(code)} signal=${String(signal)} ====\n`);
        } catch {
          // ignore
        }
        try {
          logStream.end();
        } catch {
          // ignore
        }
        try {
          outStream.end();
        } catch {
          // ignore
        }
      });

      child.on("error", (error) => {
        deps.autoContinueSliceChildren.delete(input.runId);
        const msg = deps.safeErrorMessage(error);
        try {
          logStream.write(`\nworker error: ${msg}\n`);
        } catch {
          // ignore
        }
        try {
          outStream.write(
            `${JSON.stringify(
              {
                status: "error",
                summary: `Worker spawn error: ${msg}`,
                workstream_id: input.env.ORGX_WORKSTREAM_ID ?? "unknown",
                workstream_title: input.env.ORGX_WORKSTREAM_TITLE ?? null,
                slice_id: input.runId,
              },
              null,
              2
            )}\n`
          );
        } catch {
          // ignore
        }
      });

      child.unref();
      return { pid: child.pid ?? null };
    }

    const codexInfo = deps.resolveCodexBinInfo();
    const codexBin = codexInfo.bin;
    const rawArgs = (process.env.ORGX_CODEX_ARGS ?? "").trim();
    const args = normalizeCodexArgs(
      rawArgs.length > 0 ? rawArgs.split(/\s+/).filter(Boolean) : ["--full-auto"]
    );

    // Autopilot slices should not fail just because an unrelated MCP server is flaky.
    // Default: disable firecrawl unless explicitly re-enabled.
    const disableFirecrawlRaw = (process.env.ORGX_AUTOPILOT_DISABLE_FIRECRAWL ?? "").trim().toLowerCase();
    const disableFirecrawl =
      disableFirecrawlRaw !== "false" && disableFirecrawlRaw !== "0" && disableFirecrawlRaw !== "no";
    const hasFirecrawlOverride = args.some((arg) => String(arg).includes("mcp_servers.firecrawl"));
    const extraArgs: string[] = [];
    if (disableFirecrawl && !hasFirecrawlOverride) {
      extraArgs.push("-c", "mcp_servers.firecrawl.enabled=false");
    }

    const logStream = createWriteStream(input.logPath, { flags: "a" });
    logStream.write(`\n==== ${new Date().toISOString()} :: slice ${input.runId} ====\n`);
    logStream.write(
      `codex_bin: ${codexBin}${codexInfo.versionString ? ` (${codexInfo.versionString})` : ""}\n`
    );

    const childEnv: Record<string, string | undefined> = {
      ...process.env,
      ...deps.resolveByokEnvOverrides(),
      ...input.env,
    };
    if (codexBin.includes(sep)) {
      const binDir = dirname(codexBin);
      childEnv.PATH = childEnv.PATH ? `${binDir}:${childEnv.PATH}` : binDir;
    }

    const hasOutputLastMessage =
      args.includes("--output-last-message") ||
      args.some((arg) => typeof arg === "string" && arg.startsWith("--output-last-message="));
    const outputArgs = hasOutputLastMessage
      ? []
      : ["--output-last-message", input.outputPath];

    const child = spawn(codexBin, [...args, ...extraArgs, ...outputArgs, input.prompt], {
      cwd: input.cwd,
      env: childEnv,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    deps.autoContinueSliceChildren.set(input.runId, child);

    child.stdout?.on("data", (chunk) => {
      try {
        logStream.write(chunk);
      } catch {
        // ignore
      }
    });
    child.stderr?.on("data", (chunk) => {
      try {
        logStream.write(chunk);
      } catch {
        // ignore
      }
    });

    child.on("close", (code, signal) => {
      deps.autoContinueSliceChildren.delete(input.runId);
      const stamp = new Date().toISOString();
      try {
        logStream.write(`\n==== ${stamp} :: exit code=${String(code)} signal=${String(signal)} ====\n`);
      } catch {
        // ignore
      }
      try {
        logStream.end();
      } catch {
        // ignore
      }
    });
    child.on("error", (error) => {
      deps.autoContinueSliceChildren.delete(input.runId);
      const msg = deps.safeErrorMessage(error);
      try {
        logStream.write(`\nworker error: ${msg}\n`);
      } catch {
        // ignore
      }
      try {
        writeFileSync(
          input.outputPath,
          `${JSON.stringify(
            {
              status: "error",
              summary: `Worker spawn error: ${msg}`,
              workstream_id: input.env.ORGX_WORKSTREAM_ID ?? "unknown",
              workstream_title: input.env.ORGX_WORKSTREAM_TITLE ?? null,
              slice_id: input.runId,
            },
            null,
            2
          )}\n`,
          { encoding: "utf8" }
        );
      } catch {
        // ignore
      }
    });

    child.unref();
    return { pid: child.pid ?? null };
  }

  function writeRuntimeEvent(input: {
    sourceClient: RuntimeSourceClient;
    event: RuntimeHookPayload["event"];
    runId: string;
    initiativeId: string;
    workstreamId: string | null;
    taskId: string | null;
    agentId: string | null;
    agentName: string | null;
    phase: string | null;
    message?: string | null;
    progressPct?: number | null;
    metadata?: Record<string, unknown> | null;
    timestamp?: string | null;
  }): RuntimeInstanceRecord {
    const instance = deps.upsertRuntimeInstanceFromHook({
      source_client: input.sourceClient,
      event: input.event ?? null,
      run_id: input.runId,
      correlation_id: input.runId,
      initiative_id: input.initiativeId,
      workstream_id: input.workstreamId,
      task_id: input.taskId,
      agent_id: input.agentId,
      agent_name: input.agentName,
      phase: input.phase,
      progress_pct: input.progressPct ?? null,
      message: input.message ?? null,
      metadata: input.metadata ?? null,
      timestamp: input.timestamp ?? new Date().toISOString(),
    });
    // Make runtime updates feel instantaneous (don't wait for the 15s staleness timer).
    deps.broadcastRuntimeSse("runtime.updated", instance);
    deps.clearSnapshotResponseCache();
    return instance;
  }

  return {
    spawnCodexSliceWorker,
    writeRuntimeEvent,
  };
}
