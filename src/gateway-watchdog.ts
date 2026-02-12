import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { getOpenClawDir } from "./paths.js";
import { readOpenClawGatewayPort, readOpenClawSettingsSnapshot } from "./openclaw-settings.js";

type Logger = {
  info?: (message: string, meta?: Record<string, unknown>) => void;
  warn?: (message: string, meta?: Record<string, unknown>) => void;
  debug?: (message: string, meta?: Record<string, unknown>) => void;
};

const DEFAULT_MONITOR_INTERVAL_MS = 30_000;
const DEFAULT_FAILURES_BEFORE_RESTART = 2;
const DEFAULT_PROBE_TIMEOUT_MS = 2_500;

const WATCHDOG_PID_FILE = join(getOpenClawDir(), "orgx-gateway-watchdog.pid");

function readEnvNumber(name: string, fallback: number, min: number): number {
  const raw = (process.env[name] ?? "").trim();
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < min) return fallback;
  return parsed;
}

function isPidAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readWatchdogPid(): number | null {
  try {
    if (!existsSync(WATCHDOG_PID_FILE)) return null;
    const raw = readFileSync(WATCHDOG_PID_FILE, "utf8").trim();
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeWatchdogPid(pid: number): void {
  const dir = getOpenClawDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(WATCHDOG_PID_FILE, `${pid}\n`, { mode: 0o600 });
}

function clearWatchdogPid(): void {
  try {
    rmSync(WATCHDOG_PID_FILE, { force: true });
  } catch {
    // best effort
  }
}

async function runCommandCollect(input: {
  command: string;
  args: string[];
  timeoutMs?: number;
}): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  const timeoutMs = input.timeoutMs ?? 10_000;
  return await new Promise((resolve, reject) => {
    const child = spawn(input.command, input.args, {
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = timeoutMs
      ? setTimeout(() => {
          try {
            child.kill("SIGKILL");
          } catch {
            // best effort
          }
          reject(new Error(`Command timed out after ${timeoutMs}ms`));
        }, timeoutMs)
      : null;

    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve({ stdout, stderr, exitCode: typeof code === "number" ? code : null });
    });
  });
}

async function probeGateway(port: number, timeoutMs: number): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // Any HTTP response (including 404) means the gateway port is reachable.
    await fetch(`http://127.0.0.1:${port}/`, {
      method: "GET",
      signal: controller.signal,
      headers: {
        "cache-control": "no-cache",
      },
    });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

async function restartGateway(logger: Logger): Promise<void> {
  const restart = await runCommandCollect({
    command: "openclaw",
    args: ["gateway", "restart", "--json"],
    timeoutMs: 30_000,
  });
  if (restart.exitCode === 0) {
    logger.warn?.("[orgx] Gateway watchdog restarted OpenClaw gateway service");
    return;
  }

  const start = await runCommandCollect({
    command: "openclaw",
    args: ["gateway", "start", "--json"],
    timeoutMs: 30_000,
  });
  if (start.exitCode !== 0) {
    throw new Error(start.stderr.trim() || restart.stderr.trim() || "Failed to restart gateway");
  }

  logger.warn?.("[orgx] Gateway watchdog started OpenClaw gateway service");
}

export async function runGatewayWatchdogDaemon(logger: Logger = console): Promise<void> {
  const monitorIntervalMs = readEnvNumber(
    "ORGX_GATEWAY_WATCHDOG_INTERVAL_MS",
    DEFAULT_MONITOR_INTERVAL_MS,
    5_000
  );
  const failuresBeforeRestart = readEnvNumber(
    "ORGX_GATEWAY_WATCHDOG_FAILURES",
    DEFAULT_FAILURES_BEFORE_RESTART,
    1
  );
  const probeTimeoutMs = readEnvNumber(
    "ORGX_GATEWAY_WATCHDOG_TIMEOUT_MS",
    DEFAULT_PROBE_TIMEOUT_MS,
    500
  );

  let consecutiveFailures = 0;
  let restartInFlight = false;

  const cleanup = () => {
    const pid = readWatchdogPid();
    if (pid === process.pid) {
      clearWatchdogPid();
    }
  };

  process.on("SIGTERM", () => {
    cleanup();
    process.exit(0);
  });
  process.on("SIGINT", () => {
    cleanup();
    process.exit(0);
  });
  process.on("exit", cleanup);

  writeWatchdogPid(process.pid);
  logger.info?.("[orgx] Gateway watchdog daemon started", {
    intervalMs: monitorIntervalMs,
    failuresBeforeRestart,
  });

  const tick = async () => {
    if (restartInFlight) return;
    const snapshot = readOpenClawSettingsSnapshot();
    const port = readOpenClawGatewayPort(snapshot.raw);
    const healthy = await probeGateway(port, probeTimeoutMs);

    if (healthy) {
      consecutiveFailures = 0;
      return;
    }

    consecutiveFailures += 1;
    logger.warn?.("[orgx] Gateway watchdog probe failed", {
      port,
      consecutiveFailures,
      threshold: failuresBeforeRestart,
    });

    if (consecutiveFailures < failuresBeforeRestart) {
      return;
    }

    restartInFlight = true;
    try {
      await restartGateway(logger);
      consecutiveFailures = 0;
    } catch (err: unknown) {
      logger.warn?.("[orgx] Gateway watchdog failed to restart gateway", {
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      restartInFlight = false;
    }
  };

  await tick();
  setInterval(() => {
    void tick();
  }, monitorIntervalMs);
}

export function ensureGatewayWatchdog(logger: Logger): { started: boolean; pid: number | null } {
  if (process.env.ORGX_DISABLE_GATEWAY_WATCHDOG === "1") {
    logger.debug?.("[orgx] Gateway watchdog disabled via ORGX_DISABLE_GATEWAY_WATCHDOG=1");
    return { started: false, pid: null };
  }

  const existing = readWatchdogPid();
  if (existing && isPidAlive(existing)) {
    return { started: false, pid: existing };
  }

  if (existing && !isPidAlive(existing)) {
    clearWatchdogPid();
  }

  const runnerPath = fileURLToPath(new URL("./gateway-watchdog-runner.js", import.meta.url));
  const child = spawn(process.execPath, [runnerPath], {
    env: process.env,
    stdio: "ignore",
    detached: true,
  });
  child.unref();

  return { started: true, pid: child.pid ?? null };
}
