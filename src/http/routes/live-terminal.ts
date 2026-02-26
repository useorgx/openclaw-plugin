import { exec } from "node:child_process";
import { platform } from "node:os";
import type { Router } from "../router.js";

type RegisterLiveTerminalRoutesDeps<TReq, TRes> = {
  parseJsonRequest: (req: TReq) => Promise<Record<string, unknown>>;
  sendJson: (res: TRes, status: number, payload: unknown) => void;
  safeErrorMessage: (err: unknown) => string;
};

function terminalCommand(sessionPath: string): string | null {
  const os = platform();
  const escaped = sessionPath.replaceAll("'", "'\\''");
  if (os === "darwin") {
    return `open -a Terminal '${escaped}'`;
  }
  if (os === "linux") {
    return `xdg-open '${escaped}' 2>/dev/null || xterm -e 'less "${escaped}"' &`;
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
        const body = await deps.parseJsonRequest(req);
        const sessionPath =
          typeof body.sessionPath === "string" ? body.sessionPath.trim() : "";
        const sessionId =
          typeof body.sessionId === "string" ? body.sessionId.trim() : "";

        if (!sessionPath && !sessionId) {
          deps.sendJson(res, 400, {
            error: "sessionPath or sessionId is required",
          });
          return;
        }

        const target = sessionPath || sessionId;
        const cmd = terminalCommand(target);
        if (!cmd) {
          deps.sendJson(res, 501, {
            error: `Unsupported platform: ${platform()}`,
          });
          return;
        }

        exec(cmd, { timeout: 5_000 }, (err) => {
          if (err) {
            deps.sendJson(res, 500, {
              error: `Failed to open terminal: ${deps.safeErrorMessage(err)}`,
            });
            return;
          }
          deps.sendJson(res, 200, { ok: true, command: cmd });
        });
      } catch (err) {
        deps.sendJson(res, 500, { error: deps.safeErrorMessage(err) });
      }
    },
    "Open a session log in the native terminal"
  );
}
