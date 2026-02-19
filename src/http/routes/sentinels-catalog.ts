import { listBuiltInSentinels } from "../helpers/sentinel-catalog.js";
import type { Router } from "../router.js";

type SentinelsCatalogDeps<TRes> = {
  sendJson: (res: TRes, status: number, payload: unknown) => void;
  safeErrorMessage: (err: unknown) => string;
};

export function registerSentinelsCatalogRoutes<TReq, TRes>(
  router: Router<Record<string, never>, TReq, TRes>,
  deps: SentinelsCatalogDeps<TRes>
): void {
  async function handle(res: TRes, domain: string | undefined): Promise<void> {
    try {
      const sentinels = listBuiltInSentinels({ domain });
      deps.sendJson(res, 200, {
        generatedAt: new Date().toISOString(),
        domain: domain ?? null,
        sentinels,
      });
    } catch (err: unknown) {
      deps.sendJson(res, 500, {
        error: deps.safeErrorMessage(err),
      });
    }
  }

  router.add(
    "GET",
    "sentinels/catalog",
    async ({ query, res }) => {
      return handle(res, query?.get("domain") ?? undefined);
    },
    "Sentinel catalog"
  );
  router.add(
    "HEAD",
    "sentinels/catalog",
    async ({ query, res }) => {
      return handle(res, query?.get("domain") ?? undefined);
    },
    "Sentinel catalog (HEAD)"
  );
}
