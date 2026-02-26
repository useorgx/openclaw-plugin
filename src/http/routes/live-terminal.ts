/**
 * Live terminal / filesystem integration.
 * POST /orgx/api/live/terminal/open — open a run's log file in the native terminal or editor.
 */

import { exec } from "node:child_process";
import { platform } from "node:os";
import { join, resolve } from "node:path";
import { existsSync } from "node:fs";
import { getOrgxPluginConfigDir } from "../../paths.js";
import type { Router } from "../router.js";

type JsonRecord = Record<string, unknown>;

type RegisterLiveTerminalRoutesDeps<TReq, TRes> = {
  parseJsonRequest: (req: TReq) => Promise<JsonRecord>;
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

function openPathInTerminal(targetPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const plat = platform();
    const escaped = targetPath.replaceAll("'", "'\\''");

    let cmd: string;
    if (plat === "darwin") {
      // macOS: open Terminal.app with tail -f on the log
      cmd = `osascript -e 'tell application "Terminal" to do script "tail -f \\\'${escaped}\\\'"'`;
    } else if (plat === "linux") {
      // Linux: try gnome-terminal, fallback to xterm
      cmd = `gnome-terminal -- bash -c 'tail -f "${escaped}"' 2>/dev/null || xterm -e 'tail -f "${escaped}"'`;
    } else {
      reject(new Error(`Terminal open not supported on ${plat}`));
      return;
    }

    exec(cmd, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

function openPathInEditor(targetPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const escaped = targetPath.replaceAll("'", "'\\''");
    // Try cursor first (common in Cursor IDE users), then code
    const cmd = `cursor "${escaped}" 2>/dev/null || code "${escaped}" 2>/dev/null || true`;
    exec(cmd, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
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
        const logPathArg = pickString(payload as JsonRecord, ["logPath", "log_path", "path"]);
        const runIdArg = pickString(payload as JsonRecord, ["runId", "run_id"]);
        const sliceRunIdArg = pickString(payload as JsonRecord, ["sliceRunId", "slice_run_id"]);

        let targetPath: string | null = null;

        if (logPathArg) {
          // Relative path only — resolve under autopilot-logs for security
          if (!logPathArg.includes("..") && !logPathArg.startsWith("/")) {
            const logsDir = resolve(getOrgxPluginConfigDir(), "autopilot-logs");
            const candidate = resolve(logsDir, logPathArg);
            if (candidate.startsWith(logsDir) && existsSync(candidate)) {
              targetPath = candidate;
            }
          }
        }

        if (!targetPath && (runIdArg || sliceRunIdArg)) {
          const logsDir = join(getOrgxPluginConfigDir(), "autopilot-logs");
          // Try sliceRunId first (log files are named by slice run id), then runId
          const ids = [sliceRunIdArg, runIdArg].filter(Boolean) as string[];
          for (const id of ids) {
            const candidate = join(logsDir, `${id}.log`);
            if (existsSync(candidate)) {
              targetPath = candidate;
              break;
            }
          }
        }

        if (!targetPath) {
          deps.sendJson(res, 404, {
            error: "Log file not found. Provide runId, sliceRunId, or logPath.",
          });
          return;
        }

        try {
          await openPathInTerminal(targetPath);
        } catch {
          // Fallback: open in editor
          try {
            await openPathInEditor(targetPath);
          } catch (editorErr) {
            deps.sendJson(res, 500, {
              error: `Failed to open: ${deps.safeErrorMessage(editorErr)}`,
            });
            return;
          }
        }

        deps.sendJson(res, 200, { ok: true, path: targetPath });
      } catch (err: unknown) {
        deps.sendJson(res, 500, {
          error: deps.safeErrorMessage(err),
        });
      }
    },
    "Open run log in terminal or editor"
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
