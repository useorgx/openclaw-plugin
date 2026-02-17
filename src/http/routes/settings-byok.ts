import type { ByokKeysRecord } from "../../byok-store.js";
import type { Router } from "../router.js";

type JsonRecord = Record<string, unknown>;

type RegisterSettingsByokRoutesDeps<TReq, TRes> = {
  parseJsonRequest: (req: TReq) => Promise<JsonRecord>;
  readByokKeys: () => ByokKeysRecord | null;
  writeByokKeys: (input: Partial<ByokKeysRecord>) => ByokKeysRecord;
  maskSecret: (value: string | null) => string | null;
  listAgents: () => Promise<Array<{ id?: string; isDefault?: boolean }>>;
  listOpenClawProviderModels: (input: {
    agentId: string;
    provider: "openai" | "anthropic" | "openrouter";
  }) => Promise<Array<{ key: string }>>;
  sendJson: (res: TRes, status: number, payload: unknown) => void;
  safeErrorMessage: (err: unknown) => string;
};

function readEnvByokKeys(): {
  openai: string | null;
  anthropic: string | null;
  openrouter: string | null;
} {
  return {
    openai: process.env.OPENAI_API_KEY ?? null,
    anthropic: process.env.ANTHROPIC_API_KEY ?? null,
    openrouter: process.env.OPENROUTER_API_KEY ?? null,
  };
}

export function registerSettingsByokRoutes<TReq, TRes>(
  router: Router<Record<string, never>, TReq, TRes>,
  deps: RegisterSettingsByokRoutesDeps<TReq, TRes>
): void {
  async function renderByokSettings(req: TReq, method: string, res: TRes): Promise<void> {
    const stored = deps.readByokKeys();
    const envKeys = readEnvByokKeys();
    const effectiveOpenai = stored?.openaiApiKey ?? envKeys.openai ?? null;
    const effectiveAnthropic = stored?.anthropicApiKey ?? envKeys.anthropic ?? null;
    const effectiveOpenrouter = stored?.openrouterApiKey ?? envKeys.openrouter ?? null;

    const toProvider = (input: {
      storedValue: string | null | undefined;
      envValue: string | null;
      effective: string | null;
    }) => {
      const hasStored =
        typeof input.storedValue === "string" && input.storedValue.trim().length > 0;
      const hasEnv = typeof input.envValue === "string" && input.envValue.trim().length > 0;
      const source = hasStored ? "stored" : hasEnv ? "env" : "none";
      return {
        configured: Boolean(input.effective && input.effective.trim().length > 0),
        source,
        masked: deps.maskSecret(input.effective),
      };
    };

    if (method === "POST") {
      try {
        const payload = await deps.parseJsonRequest(req);
        const updates: Record<string, unknown> = {};

        const setIfPresent = (key: string, aliases: string[]) => {
          for (const alias of aliases) {
            if (!Object.prototype.hasOwnProperty.call(payload, alias)) continue;
            const raw = payload[alias];
            if (raw === null || typeof raw === "string") {
              updates[key] = raw;
              return;
            }
          }
        };

        setIfPresent("openaiApiKey", [
          "openaiApiKey",
          "openai_api_key",
          "openaiKey",
          "openai_key",
        ]);
        setIfPresent("anthropicApiKey", [
          "anthropicApiKey",
          "anthropic_api_key",
          "anthropicKey",
          "anthropic_key",
        ]);
        setIfPresent("openrouterApiKey", [
          "openrouterApiKey",
          "openrouter_api_key",
          "openrouterKey",
          "openrouter_key",
        ]);

        const saved = deps.writeByokKeys(updates as Partial<ByokKeysRecord>);
        const nextEffectiveOpenai = saved.openaiApiKey ?? envKeys.openai ?? null;
        const nextEffectiveAnthropic = saved.anthropicApiKey ?? envKeys.anthropic ?? null;
        const nextEffectiveOpenrouter = saved.openrouterApiKey ?? envKeys.openrouter ?? null;

        deps.sendJson(res, 200, {
          ok: true,
          updatedAt: saved.updatedAt,
          providers: {
            openai: toProvider({
              storedValue: saved.openaiApiKey,
              envValue: envKeys.openai,
              effective: nextEffectiveOpenai,
            }),
            anthropic: toProvider({
              storedValue: saved.anthropicApiKey,
              envValue: envKeys.anthropic,
              effective: nextEffectiveAnthropic,
            }),
            openrouter: toProvider({
              storedValue: saved.openrouterApiKey,
              envValue: envKeys.openrouter,
              effective: nextEffectiveOpenrouter,
            }),
          },
        });
      } catch (err: unknown) {
        deps.sendJson(res, 500, { ok: false, error: deps.safeErrorMessage(err) });
      }
      return;
    }

    deps.sendJson(res, 200, {
      ok: true,
      updatedAt: stored?.updatedAt ?? null,
      providers: {
        openai: toProvider({
          storedValue: stored?.openaiApiKey,
          envValue: envKeys.openai,
          effective: effectiveOpenai,
        }),
        anthropic: toProvider({
          storedValue: stored?.anthropicApiKey,
          envValue: envKeys.anthropic,
          effective: effectiveAnthropic,
        }),
        openrouter: toProvider({
          storedValue: stored?.openrouterApiKey,
          envValue: envKeys.openrouter,
          effective: effectiveOpenrouter,
        }),
      },
    });
  }

  async function renderByokHealth(query: URLSearchParams, res: TRes): Promise<void> {
    let agentId = (query.get("agentId") ?? query.get("agent_id") ?? "").trim();

    if (!agentId) {
      try {
        const agents = await deps.listAgents();
        const defaultAgent =
          agents.find((entry) => Boolean(entry.isDefault)) ?? agents[0] ?? null;
        const candidate =
          defaultAgent && typeof defaultAgent.id === "string"
            ? defaultAgent.id.trim()
            : "";
        if (candidate) agentId = candidate;
      } catch {
        // ignore
      }
    }
    if (!agentId) agentId = "main";

    const providers: Record<string, unknown> = {};
    for (const provider of ["openai", "anthropic", "openrouter"] as const) {
      try {
        const models = await deps.listOpenClawProviderModels({ agentId, provider });
        providers[provider] = {
          ok: true,
          modelCount: models.length,
          sample: models.slice(0, 4).map((model) => model.key),
        };
      } catch (err: unknown) {
        providers[provider] = {
          ok: false,
          error: deps.safeErrorMessage(err),
        };
      }
    }

    deps.sendJson(res, 200, {
      ok: true,
      agentId,
      providers,
    });
  }

  router.add(
    "GET",
    "settings/byok",
    async ({ req, res }) => renderByokSettings(req, "GET", res),
    "Read BYOK settings"
  );
  router.add(
    "POST",
    "settings/byok",
    async ({ req, res }) => renderByokSettings(req, "POST", res),
    "Write BYOK settings"
  );
  router.add(
    "HEAD",
    "settings/byok",
    async ({ req, res }) => renderByokSettings(req, "GET", res),
    "Read BYOK settings (HEAD)"
  );

  router.add(
    "GET",
    "settings/byok/health",
    async ({ query, res }) => renderByokHealth(query, res),
    "Probe BYOK provider health"
  );
  router.add(
    "HEAD",
    "settings/byok/health",
    async ({ query, res }) => renderByokHealth(query, res),
    "Probe BYOK provider health (HEAD)"
  );

  router.add(
    "*",
    "settings/byok",
    ({ res }) => {
      deps.sendJson(res, 405, { ok: false, error: "Method not allowed" });
    },
    "Reject unsupported methods for settings/byok"
  );
  router.add(
    "*",
    "settings/byok/health",
    ({ res }) => {
      deps.sendJson(res, 405, { ok: false, error: "Method not allowed" });
    },
    "Reject unsupported methods for settings/byok/health"
  );
}
