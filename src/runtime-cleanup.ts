import { pathToFileURL } from "node:url";

import { markAgentRunStopped, readAgentRuns } from "./agent-run-store.js";
import { stopGatewayWatchdog } from "./gateway-watchdog.js";

type CleanupLogger = {
  info?: (message: string, meta?: Record<string, unknown>) => void;
  warn?: (message: string, meta?: Record<string, unknown>) => void;
};

function isPidAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function sendSignal(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
    return;
  } catch {
    // Fall back to direct process kill.
  }
  try {
    process.kill(pid, signal);
  } catch {
    // best effort
  }
}

async function stopDetachedPid(pid: number): Promise<boolean> {
  if (!isPidAlive(pid)) return true;
  sendSignal(pid, "SIGTERM");
  await new Promise((resolve) => setTimeout(resolve, 450));
  if (isPidAlive(pid)) {
    sendSignal(pid, "SIGKILL");
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return !isPidAlive(pid);
}

export async function cleanupOrgxRuntime(logger: CleanupLogger = console): Promise<{
  watchdog: { pid: number | null; wasRunning: boolean; stopped: boolean };
  runs: { attempted: number; stopped: number; failed: number; markedStopped: number };
}> {
  const watchdog = await stopGatewayWatchdog(logger as any);

  const runningRuns = Object.values(readAgentRuns().runs ?? {}).filter(
    (run) => run?.status === "running"
  );

  let attempted = 0;
  let stopped = 0;
  let failed = 0;
  let markedStopped = 0;

  for (const run of runningRuns) {
    if (!run || typeof run !== "object") continue;
    attempted += 1;

    let runStopped = false;
    if (typeof run.pid === "number" && Number.isFinite(run.pid) && run.pid > 0) {
      runStopped = await stopDetachedPid(run.pid);
    } else {
      runStopped = true;
    }

    if (runStopped) stopped += 1;
    else failed += 1;

    if (markAgentRunStopped(run.runId)) {
      markedStopped += 1;
    }
  }

  const summary = {
    watchdog,
    runs: { attempted, stopped, failed, markedStopped },
  };

  logger.info?.("[orgx] Runtime cleanup summary", summary);
  return summary;
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return import.meta.url === pathToFileURL(entry).href;
}

if (isDirectRun()) {
  cleanupOrgxRuntime().catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[orgx] runtime cleanup failed: ${message}`);
    // Never block uninstall/update for best-effort cleanup.
    process.exitCode = 0;
  });
}
