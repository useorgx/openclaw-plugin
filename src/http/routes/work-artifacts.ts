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
      try {
        const qs = query.toString();
        const path = `/api/work-artifacts/by-entity${qs ? `?${qs}` : ""}`;
        const data = await deps.rawRequest("GET", path);
        deps.sendJson(res, 200, data);
      } catch (err: unknown) {
        deps.sendJson(res, 502, { error: deps.safeErrorMessage(err) });
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
        const upstreamPath = `/api/artifacts/${encodeURIComponent(artifactId)}`;
        const data = await deps.rawRequest("GET", upstreamPath);
        deps.sendJson(res, 200, data);
      } catch (err: unknown) {
        const warning = deps.safeErrorMessage(err);
        const fallback = deps.buildLocalArtifactDetailFallback(artifactId, warning);
        if (fallback) {
          deps.sendJson(res, 200, fallback);
        } else {
          deps.sendJson(res, 502, { error: warning });
        }
      }
    },
    "Artifact detail"
  );
}
