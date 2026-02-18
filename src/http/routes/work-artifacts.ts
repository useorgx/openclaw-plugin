import type { Router } from "../router.js";

type RegisterWorkArtifactsRoutesDeps<TRes> = {
  rawRequest: (
    method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
    path: string,
    body?: unknown
  ) => Promise<unknown>;
  buildLocalArtifactDetailFallback: (
    artifactId: string,
    warning: string
  ) => Record<string, unknown> | null;
  sendJson: (res: TRes, status: number, payload: unknown) => void;
  safeErrorMessage: (err: unknown) => string;
};

export function registerWorkArtifactsRoutes<TReq, TRes>(
  router: Router<Record<string, never>, TReq, TRes>,
  deps: RegisterWorkArtifactsRoutesDeps<TRes>
): void {
  router.add(
    "GET",
    "work-artifacts/by-entity",
    async ({ query, res }) => {
      const qs = query.toString();
      try {
        const path = `/api/client/artifacts/by-entity${qs ? `?${qs}` : ""}`;
        const data = await deps.rawRequest("GET", path);
        deps.sendJson(res, 200, data);
      } catch (err: unknown) {
        const warning = deps.safeErrorMessage(err);
        try {
          const fallbackPath = `/api/work-artifacts/by-entity${qs ? `?${qs}` : ""}`;
          const fallback = await deps.rawRequest("GET", fallbackPath);
          deps.sendJson(res, 200, fallback);
        } catch (fallbackErr: unknown) {
          deps.sendJson(res, 502, {
            error: deps.safeErrorMessage(fallbackErr),
            warning,
          });
        }
      }
    },
    "Work artifacts by entity"
  );

  router.add(
    "GET",
    "artifacts/*",
    async ({ path, res }) => {
      const artifactDetailMatch = path.match(/^artifacts\/([^/]+)$/);
      if (!artifactDetailMatch) {
        deps.sendJson(res, 404, { error: "Unknown API endpoint" });
        return;
      }

      const artifactId = decodeURIComponent(artifactDetailMatch[1]);
      try {
        const upstreamPath = `/api/client/artifacts/${encodeURIComponent(artifactId)}`;
        const data = await deps.rawRequest("GET", upstreamPath);
        deps.sendJson(res, 200, data);
      } catch (err: unknown) {
        const warning = deps.safeErrorMessage(err);
        try {
          const legacyPath = `/api/artifacts/${encodeURIComponent(artifactId)}`;
          const legacyData = await deps.rawRequest("GET", legacyPath);
          deps.sendJson(res, 200, legacyData);
        } catch (legacyErr: unknown) {
          const legacyWarning = `${warning}; legacy route failed: ${deps.safeErrorMessage(legacyErr)}`;
          const fallback = deps.buildLocalArtifactDetailFallback(artifactId, legacyWarning);
          if (fallback) {
            deps.sendJson(res, 200, fallback);
          } else {
            deps.sendJson(res, 502, { error: legacyWarning });
          }
        }
      }
    },
    "Artifact detail"
  );
}
