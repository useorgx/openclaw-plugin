import type { OnboardingState } from "../../types.js";
import type { Router } from "../router.js";

type JsonRecord = Record<string, unknown>;

type OnboardingControllerLike = {
  startPairing: (input: {
    openclawVersion?: string;
    platform?: string;
    deviceName?: string;
  }) => Promise<{
    pairingId: string;
    connectUrl: string;
    expiresAt: string | null;
    pollIntervalMs: number | null;
    state: OnboardingState;
  }>;
  getStatus: () => Promise<OnboardingState>;
  submitManualKey: (input: { apiKey: string; userId?: string }) => Promise<OnboardingState>;
  cancelPairing?: () => Promise<OnboardingState>;
  disconnect: () => Promise<OnboardingState>;
};

type RegisterOnboardingRoutesDeps<TReq, TRes> = {
  onboarding: OnboardingControllerLike;
  parseJsonRequest: (req: TReq) => Promise<JsonRecord>;
  pickString: (input: unknown, keys: string[]) => string | null;
  pickHeaderString: (headers: unknown, names: string[]) => string | null;
  isUserScopedApiKey: (apiKey: string) => boolean;
  sendJson: (res: TRes, status: number, payload: unknown) => void;
  safeErrorMessage: (err: unknown) => string;
  getOnboardingState: (state: OnboardingState) => OnboardingState;
};

export function registerOnboardingRoutes<TReq, TRes>(
  router: Router<Record<string, never>, TReq, TRes>,
  deps: RegisterOnboardingRoutesDeps<TReq, TRes>
): void {
  router.add(
    "GET",
    "onboarding/status",
    async ({ res }) => {
      try {
        const state = await deps.onboarding.getStatus();
        deps.sendJson(res, 200, {
          ok: true,
          data: deps.getOnboardingState(state),
        });
      } catch (err: unknown) {
        deps.sendJson(res, 500, {
          ok: false,
          error: deps.safeErrorMessage(err),
        });
      }
    },
    "Read onboarding status"
  );

  router.add(
    "POST",
    "onboarding/start",
    async ({ req, res }) => {
      try {
        const payload = await deps.parseJsonRequest(req);
        const started = await deps.onboarding.startPairing({
          openclawVersion:
            deps.pickString(payload, ["openclawVersion", "openclaw_version"]) ??
            undefined,
          platform: deps.pickString(payload, ["platform"]) ?? undefined,
          deviceName: deps.pickString(payload, ["deviceName", "device_name"]) ?? undefined,
        });
        deps.sendJson(res, 200, {
          ok: true,
          data: {
            pairingId: started.pairingId,
            connectUrl: started.connectUrl,
            expiresAt: started.expiresAt,
            pollIntervalMs: started.pollIntervalMs,
            state: deps.getOnboardingState(started.state),
          },
        });
      } catch (err: unknown) {
        deps.sendJson(res, 400, {
          ok: false,
          error: deps.safeErrorMessage(err),
        });
      }
    },
    "Start onboarding pairing flow"
  );

  router.add(
    "POST",
    "onboarding/manual-key",
    async ({ req, res }) => {
      try {
        const payload = await deps.parseJsonRequest(req);
        const reqWithHeaders = req as unknown as { headers?: unknown };
        const authHeader = deps.pickHeaderString(reqWithHeaders.headers, ["authorization"]);
        const bearerApiKey =
          authHeader && authHeader.toLowerCase().startsWith("bearer ")
            ? authHeader.slice("bearer ".length).trim()
            : null;
        const headerApiKey = deps.pickHeaderString(reqWithHeaders.headers, [
          "x-orgx-api-key",
          "x-api-key",
        ]);
        const apiKey =
          deps.pickString(payload, ["apiKey", "api_key"]) ??
          headerApiKey ??
          bearerApiKey;
        if (!apiKey) {
          deps.sendJson(res, 400, {
            ok: false,
            error: "apiKey is required",
          });
          return;
        }

        const requestedUserId =
          deps.pickString(payload, ["userId", "user_id"]) ??
          deps.pickHeaderString(reqWithHeaders.headers, ["x-orgx-user-id", "x-user-id"]) ??
          undefined;
        const userId = deps.isUserScopedApiKey(apiKey) ? undefined : requestedUserId;
        const state = await deps.onboarding.submitManualKey({
          apiKey,
          userId,
        });

        deps.sendJson(res, 200, {
          ok: true,
          data: deps.getOnboardingState(state),
        });
      } catch (err: unknown) {
        deps.sendJson(res, 400, {
          ok: false,
          error: deps.safeErrorMessage(err),
        });
      }
    },
    "Submit manual OrgX API key"
  );

  router.add(
    "POST",
    "onboarding/cancel",
    async ({ res }) => {
      try {
        const state = deps.onboarding.cancelPairing
          ? await deps.onboarding.cancelPairing()
          : await deps.onboarding.getStatus();
        deps.sendJson(res, 200, {
          ok: true,
          data: deps.getOnboardingState(state),
        });
      } catch (err: unknown) {
        deps.sendJson(res, 500, {
          ok: false,
          error: deps.safeErrorMessage(err),
        });
      }
    },
    "Cancel onboarding pairing flow"
  );

  router.add(
    "POST",
    "onboarding/disconnect",
    async ({ res }) => {
      try {
        const state = await deps.onboarding.disconnect();
        deps.sendJson(res, 200, {
          ok: true,
          data: deps.getOnboardingState(state),
        });
      } catch (err: unknown) {
        deps.sendJson(res, 500, {
          ok: false,
          error: deps.safeErrorMessage(err),
        });
      }
    },
    "Disconnect onboarding session"
  );
}
