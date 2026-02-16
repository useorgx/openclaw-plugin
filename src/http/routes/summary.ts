import type { OrgSnapshot } from "../../types.js";
import type { Router } from "../router.js";

type SummaryRoutesDeps<TRes> = {
  getSnapshot: () => OrgSnapshot | null;
  getOrgSnapshot: () => Promise<OrgSnapshot>;
  sendJson: (res: TRes, status: number, payload: unknown) => void;
  writeHead: (
    res: TRes,
    status: number,
    headers: Record<string, string>
  ) => void;
  end: (res: TRes) => void;
  securityHeaders: Record<string, string>;
  corsHeaders: Record<string, string>;
  formatStatus: (snapshot: OrgSnapshot | null) => unknown;
  formatAgents: (snapshot: OrgSnapshot | null) => unknown;
  formatActivity: (snapshot: OrgSnapshot | null) => unknown;
  formatInitiatives: (snapshot: OrgSnapshot | null) => unknown;
  getOnboardingState: () => Promise<unknown>;
};

export function registerSummaryRoutes<TReq, TRes>(
  router: Router<Record<string, never>, TReq, TRes>,
  deps: SummaryRoutesDeps<TRes>
): void {
  router.add(
    "HEAD",
    "status",
    async ({ res }) => {
      let snapshot = deps.getSnapshot();
      if (!snapshot) {
        try {
          snapshot = await deps.getOrgSnapshot();
        } catch {
          // use null snapshot
        }
      }
      deps.writeHead(res, snapshot ? 200 : 503, {
        ...deps.securityHeaders,
        ...deps.corsHeaders,
      });
      deps.end(res);
    },
    "Status probe (HEAD)"
  );

  router.add(
    "GET",
    "status",
    async ({ res }) => {
      let snapshot = deps.getSnapshot();
      if (!snapshot) {
        try {
          snapshot = await deps.getOrgSnapshot();
        } catch {
          // use null snapshot
        }
      }
      deps.sendJson(res, 200, deps.formatStatus(snapshot));
    },
    "Status snapshot"
  );

  router.add(
    "GET",
    "agents",
    ({ res }) => {
      deps.sendJson(res, 200, deps.formatAgents(deps.getSnapshot()));
    },
    "Agent summary"
  );

  router.add(
    "GET",
    "activity",
    ({ res }) => {
      deps.sendJson(res, 200, deps.formatActivity(deps.getSnapshot()));
    },
    "Activity summary"
  );

  router.add(
    "GET",
    "initiatives",
    ({ res }) => {
      deps.sendJson(res, 200, deps.formatInitiatives(deps.getSnapshot()));
    },
    "Initiatives summary"
  );

  router.add(
    "GET",
    "onboarding",
    async ({ res }) => {
      deps.sendJson(res, 200, await deps.getOnboardingState());
    },
    "Legacy onboarding state endpoint"
  );
}
