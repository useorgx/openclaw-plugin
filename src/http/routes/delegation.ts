import type { Router } from "../router.js";

type JsonRecord = Record<string, unknown>;

type DelegationClientLike = {
  delegationPreflight: (input: {
    intent: string;
    acceptanceCriteria?: string[];
    constraints?: string[];
    domains?: string[];
  }) => Promise<unknown>;
};

type RegisterDelegationRoutesDeps<TReq, TRes> = {
  client: DelegationClientLike;
  parseJsonRequest: (req: TReq) => Promise<JsonRecord>;
  pickString: (input: JsonRecord, keys: string[]) => string | null;
  sendJson: (res: TRes, status: number, payload: unknown) => void;
  safeErrorMessage: (err: unknown) => string;
};

function toStringArray(value: unknown): string[] | undefined {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : undefined;
}

export function registerDelegationRoutes<TReq, TRes>(
  router: Router<Record<string, never>, TReq, TRes>,
  deps: RegisterDelegationRoutesDeps<TReq, TRes>
): void {
  router.add(
    "POST",
    "delegation/preflight",
    async ({ req, res }) => {
      try {
        const payload = await deps.parseJsonRequest(req);
        const intent = deps.pickString(payload, ["intent"]);
        if (!intent) {
          deps.sendJson(res, 400, { error: "intent is required" });
          return;
        }

        const data = await deps.client.delegationPreflight({
          intent,
          acceptanceCriteria: toStringArray(payload.acceptanceCriteria),
          constraints: toStringArray(payload.constraints),
          domains: toStringArray(payload.domains),
        });

        deps.sendJson(res, 200, data);
      } catch (err: unknown) {
        deps.sendJson(res, 500, {
          error: deps.safeErrorMessage(err),
        });
      }
    },
    "Delegation preflight"
  );
  router.add(
    "*",
    "delegation/preflight",
    ({ res }) => {
      deps.sendJson(res, 405, { error: "Use POST /orgx/api/delegation/preflight" });
    },
    "Reject unsupported methods for delegation/preflight"
  );
}
