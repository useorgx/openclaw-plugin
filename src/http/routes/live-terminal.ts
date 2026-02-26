import { exec } from "node:child_process";
import { existsSync } from "node:fs";
import { platform } from "node:os";
import { join, resolve, sep } from "node:path";
import { getOrgxPluginConfigDir } from "../../paths.js";
import type { Router } from "../router.js";

type RegisterLiveTerminalRoutesDeps<TReq, TRes> = {
  parseJsonRequest: (req: TReq) => Promise<Record<string, unknown>>;
  sendJson: (res: TRes, status: number, payload: unknown) => void;
  safeErrorMessage: (err: unknown) => string;
};

function pickString(input: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = input[key];
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return null;
}

function resolveLogsDir(): string {
  return resolve(getOrgxPluginConfigDir(), "autopilot-logs");
}

function resolveSafeLogPath(logsDir: string, rawPath: string): string | null {
  if (rawPath.includes("\0")) return null;
  const isAbsolute = rawPath.startsWith("/") || rawPath.startsWith("\\");
  if (!isAbsolute && rawPath.includes("..")) return null;
  const candidate = isAbsolute ? resolve(rawPath) : resolve(logsDir, rawPath);
  const base = logsDir.endsWith(sep) ? logsDir : `${logsDir}${sep}`;
  if (!candidate.startsWith(base)) return null;
  return existsSync(candidate) ? candidate : null;
}

function resolveLogPathFromIds(logsDir: string, ids: string[]): string | null {
  for (const rawId of ids) {
    const id = rawId.trim().replaceAll(/[\\/]/g, "");
    if (!id) continue;
    const candidates = [join(logsDir, id), join(logsDir, `${id}.log`), join(logsDir, `${id}.output.json`)];
    for (const candidate of candidates) {
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

function openPathInTerminal(targetPath: string): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    const os = platform();
    const escaped = targetPath.replaceAll("'", "'\\''");

    let cmd: string;
    if (os === "darwin") {
      cmd = `osascript -e 'tell application "Terminal" to do script "tail -f \\\'${escaped}\\\'"'`;
    } else if (os === "linux") {
      cmd = `gnome-terminal -- bash -c 'tail -f "${escaped}"' 2>/dev/null || xterm -e 'tail -f "${escaped}"'`;
    } else {
      rejectPromise(new Error(`Terminal open not supported on ${os}`));
      return;
    }

    exec(cmd, (err) => {
      if (err) rejectPromise(err);
      else resolvePromise();
    });
  });
}

function openPathInEditor(targetPath: string): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    const escaped = targetPath.replaceAll("'", "'\\''");
    const os = platform();
    const cmd =
      os === "darwin"
        ? `cursor "${escaped}" 2>/dev/null || code "${escaped}" 2>/dev/null || open "${escaped}" 2>/dev/null`
        : os === "linux"
          ? `cursor "${escaped}" 2>/dev/null || code "${escaped}" 2>/dev/null || xdg-open "${escaped}" 2>/dev/null`
          : "";
    if (!cmd) {
      rejectPromise(new Error(`Editor open not supported on ${os}`));
      return;
    }
    exec(cmd, (err) => {
      if (err) rejectPromise(err);
      else resolvePromise();
    });
  });
}

function resolveTargetPath(payload: Record<string, unknown>): string | null {
  const logsDir = resolveLogsDir();
  const explicitPath = pickString(payload, [
    "logPath",
    "log_path",
    "path",
    "sessionPath",
    "session_path",
  ]);
  if (explicitPath) {
    const resolved = resolveSafeLogPath(logsDir, explicitPath);
    if (resolved) return resolved;
  }

  const ids = [
    pickString(payload, ["sliceRunId", "slice_run_id"]),
    pickString(payload, ["runId", "run_id"]),
    pickString(payload, ["sessionId", "session_id"]),
  ].filter((value): value is string => Boolean(value));
  if (ids.length > 0) {
    return resolveLogPathFromIds(logsDir, ids);
  }
  return null;
}

export function registerLiveTerminalRoutes<TReq, TRes>(
  router: Router<Record<string, never>, TReq, TRes>,
  deps: RegisterLiveTerminalRoutesDeps<TReq, TRes>
): void {
  router.add(
    "POST",
    "live/terminal/open",
    async ({ req, res }) => {
      try {
        const payload = await deps.parseJsonRequest(req);
        const targetPath = resolveTargetPath(payload);
        if (!targetPath) {
          deps.sendJson(res, 404, {
            error: "Terminal target not found. Provide runId, sliceRunId, sessionId, or logPath.",
          });
          return;
        }

        try {
          await openPathInTerminal(targetPath);
        } catch {
          await openPathInEditor(targetPath);
        }
        deps.sendJson(res, 200, { ok: true, path: targetPath });
      } catch (err) {
        deps.sendJson(res, 500, { error: deps.safeErrorMessage(err) });
      }
    },
    "Open run/session logs in terminal or editor"
  );

  router.add(
    "*",
    "live/terminal/open",
    ({ res }) => {
      deps.sendJson(res, 405, { error: "Use POST /orgx/api/live/terminal/open" });
    },
    "Reject unsupported methods for live/terminal/open"
  );
}
