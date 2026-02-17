import type { Router } from "../router.js";

type CodexBinInfo = {
  bin: string | null;
  version: unknown;
  versionString: string | null;
};

type DebugRoutesDeps<TRes> = {
  sendJson: (res: TRes, status: number, payload: unknown) => void;
  safeErrorMessage: (err: unknown) => string;
  resolveCodexBinInfo: () => CodexBinInfo;
  getCachedCodexProbeSummary: () => unknown;
};

export function registerDebugRoutes<TReq, TRes>(
  router: Router<Record<string, never>, TReq, TRes>,
  deps: DebugRoutesDeps<TRes>
): void {
  router.add(
    "GET",
    "debug/codex-bin",
    ({ res }) => {
      try {
        const codex = deps.resolveCodexBinInfo();
        deps.sendJson(res, 200, {
          ok: true,
          spawnGuardBypassEnv: Boolean(
            (process.env.ORGX_SPAWN_GUARD_BYPASS ?? "").trim() ||
              ["off", "bypass"].includes(
                (process.env.ORGX_SPAWN_GUARD_MODE ?? "").trim().toLowerCase()
              )
          ),
          codex: {
            bin: codex.bin,
            version: codex.version,
            versionString: codex.versionString,
          },
          probe: deps.getCachedCodexProbeSummary(),
        });
      } catch (err: unknown) {
        deps.sendJson(res, 500, { ok: false, error: deps.safeErrorMessage(err) });
      }
    },
    "Debug codex binary/probe status"
  );
}
