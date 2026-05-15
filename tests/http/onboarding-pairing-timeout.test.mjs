import test from "node:test";
import assert from "node:assert/strict";

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import register from "../../dist/index.js";

function createStubResponse() {
  const res = {
    status: null,
    headers: null,
    body: "",
    writableEnded: false,
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers ?? null;
    },
    end(body) {
      if (body) {
        this.body += Buffer.isBuffer(body) ? body.toString("utf8") : String(body);
      }
      this.writableEnded = true;
    },
  };
  return res;
}

function createApiStub(configOverrides = {}) {
  const stub = {
    config: {
      plugins: {
        entries: {
          orgx: {
            config: {
              enabled: true,
              dashboardEnabled: false,
              apiKey: "",
              userId: "",
              baseUrl: "https://example.useorgx.com",
              ...configOverrides,
            },
          },
        },
      },
    },
    log: {},
    registerService: () => {},
    registerTool: () => {},
    registerCli: () => {},
    registerHttpHandler(handler) {
      stub._httpHandler = handler;
    },
    _httpHandler: null,
  };
  return stub;
}

function isolateOnboardingConfig(dir) {
  const previous = {
    pluginDir: process.env.ORGX_OPENCLAW_PLUGIN_CONFIG_DIR,
    openclawHome: process.env.OPENCLAW_HOME,
    home: process.env.HOME,
    orgxApiKey: process.env.ORGX_API_KEY,
  };
  process.env.ORGX_OPENCLAW_PLUGIN_CONFIG_DIR = dir;
  process.env.OPENCLAW_HOME = dir;
  process.env.HOME = dir;
  delete process.env.ORGX_API_KEY;

  return () => {
    if (previous.pluginDir === undefined) {
      delete process.env.ORGX_OPENCLAW_PLUGIN_CONFIG_DIR;
    } else {
      process.env.ORGX_OPENCLAW_PLUGIN_CONFIG_DIR = previous.pluginDir;
    }

    if (previous.openclawHome === undefined) {
      delete process.env.OPENCLAW_HOME;
    } else {
      process.env.OPENCLAW_HOME = previous.openclawHome;
    }

    if (previous.home === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previous.home;
    }

    if (previous.orgxApiKey === undefined) {
      delete process.env.ORGX_API_KEY;
    } else {
      process.env.ORGX_API_KEY = previous.orgxApiKey;
    }
  };
}

test("Onboarding pairing start uses an extended timeout for /api/plugin/openclaw/pairings", async () => {
  const dir = mkdtempSync(join(tmpdir(), "orgx-openclaw-pairing-"));
  const restoreConfig = isolateOnboardingConfig(dir);

  const prevFetch = globalThis.fetch;
  const prevSetTimeout = globalThis.setTimeout;
  const prevClearTimeout = globalThis.clearTimeout;

  const recorded = [];

  try {
    globalThis.setTimeout = (fn, ms, ...args) => {
      recorded.push(ms);
      // Don't fire timers during test; return a dummy id compatible with clearTimeout.
      return 1;
    };
    globalThis.clearTimeout = () => {};

    globalThis.fetch = async (url, init) => {
      // Ensure we pass AbortController + JSON.
      assert.equal(init?.method, "POST");
      assert.ok(String(url).includes("/api/plugin/openclaw/pairings"));
      assert.ok(init?.signal, "expected AbortSignal");
      const body = JSON.parse(init?.body ?? "{}");
      assert.ok(body.installationId);

      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        text: async () =>
          JSON.stringify({
            ok: true,
            data: {
              pairingId: "pair-1",
              pollToken: "poll-1",
              connectUrl: "https://example.useorgx.com/connect/openclaw?pairingId=pair-1",
              expiresAt: new Date(Date.now() + 60_000).toISOString(),
              pollIntervalMs: 1500,
            },
          }),
      };
    };

    const api = createApiStub();
    register(api);
    assert.equal(typeof api._httpHandler, "function");

    const res = createStubResponse();
    await api._httpHandler(
      {
        method: "POST",
        url: "/orgx/api/onboarding/start",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ platform: "darwin", openclawVersion: "0.0-test" }),
      },
      res
    );

    assert.equal(res.status, 200);
    const payload = JSON.parse(res.body);
    assert.equal(payload.ok, true);
    assert.equal(payload.data.pairingId, "pair-1");
    assert.equal(
      payload.data.connectUrl,
      "https://example.useorgx.com/connect/openclaw?pairingId=pair-1"
    );
    assert.ok(payload.data.expiresAt, "expected onboarding start to include expiresAt");
    assert.equal(payload.data.pollIntervalMs, 1500);
    assert.equal(typeof payload.data.state, "object");
    assert.ok(
      ["pairing_pending", "awaiting_browser_auth"].includes(payload.data.state.status),
      `unexpected onboarding status: ${String(payload.data.state.status)}`
    );
    assert.ok(
      typeof payload.data.state.nextAction === "string" && payload.data.state.nextAction.length > 0
    );

    // The first timer created in fetchOrgxJson must be >= 30s for pairing start.
    assert.ok(
      recorded.some((ms) => typeof ms === "number" && ms >= 30_000),
      `expected an extended timeout >= 30000ms; got: ${JSON.stringify(recorded)}`
    );
  } finally {
    globalThis.fetch = prevFetch;
    globalThis.setTimeout = prevSetTimeout;
    globalThis.clearTimeout = prevClearTimeout;
    restoreConfig();
  }
});

test("Onboarding pairing start surfaces request tracing on failure", async () => {
  const dir = mkdtempSync(join(tmpdir(), "orgx-openclaw-pairing-"));
  const restoreConfig = isolateOnboardingConfig(dir);

  const prevFetch = globalThis.fetch;

  try {
    globalThis.fetch = async (url, init) => {
      assert.equal(init?.method, "POST");
      assert.ok(String(url).includes("/api/plugin/openclaw/pairings"));

      return {
        ok: false,
        status: 500,
        headers: {
          get: (name) => {
            const key = String(name || "").toLowerCase();
            if (key === "x-request-id") return "req_test_123";
            if (key === "x-vercel-id") return "vercel_test_456";
            if (key === "cf-ray") return "cf_ray_test";
            if (key === "x-clerk-auth-status") return "signed-out";
            if (key === "x-clerk-auth-reason") return "session-token-and-uat-missing";
            return null;
          },
        },
        text: async () =>
          JSON.stringify({ error: "Failed to create pairing session" }),
      };
    };

    const api = createApiStub();
    register(api);
    assert.equal(typeof api._httpHandler, "function");

    const res = createStubResponse();
    await api._httpHandler(
      {
        method: "POST",
        url: "/orgx/api/onboarding/start",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ platform: "darwin", openclawVersion: "0.0-test" }),
      },
      res
    );

    assert.equal(res.status, 400);
    const payload = JSON.parse(res.body);
    assert.equal(payload.ok, false);
    assert.ok(String(payload.error).includes("Pairing start failed (HTTP 500)"));
    assert.ok(String(payload.error).includes("req=req_test_123"));
    assert.ok(String(payload.error).includes("clerk=signed-out"));
  } finally {
    globalThis.fetch = prevFetch;
    restoreConfig();
  }
});

test("Onboarding pairing start retries against canonical OrgX URL when configured base URL is unreachable", async () => {
  const dir = mkdtempSync(join(tmpdir(), "orgx-openclaw-pairing-retry-canonical-"));
  const restoreConfig = isolateOnboardingConfig(dir);

  const prevFetch = globalThis.fetch;
  const calls = [];

  try {
    globalThis.fetch = async (url, init) => {
      calls.push(String(url));
      assert.equal(init?.method, "POST");
      assert.ok(String(url).includes("/api/plugin/openclaw/pairings"));

      if (String(url).startsWith("https://stale.useorgx.invalid")) {
        throw new Error("fetch failed");
      }

      if (String(url).startsWith("https://www.useorgx.com")) {
        return {
          ok: true,
          status: 200,
          headers: { get: () => null },
          text: async () =>
            JSON.stringify({
              ok: true,
              data: {
                pairingId: "pair-fallback-1",
                pollToken: "poll-fallback-1",
                connectUrl:
                  "https://www.useorgx.com/connect/openclaw?pairingId=pair-fallback-1",
                expiresAt: new Date(Date.now() + 60_000).toISOString(),
                pollIntervalMs: 1500,
              },
            }),
        };
      }

      throw new Error(`unexpected url ${String(url)}`);
    };

    const api = createApiStub({ baseUrl: "https://stale.useorgx.invalid" });
    register(api);
    assert.equal(typeof api._httpHandler, "function");

    const res = createStubResponse();
    await api._httpHandler(
      {
        method: "POST",
        url: "/orgx/api/onboarding/start",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ platform: "darwin", openclawVersion: "0.0-test" }),
      },
      res
    );

    assert.equal(res.status, 200);
    const payload = JSON.parse(res.body);
    assert.equal(payload.ok, true);
    assert.equal(payload.data.pairingId, "pair-fallback-1");
    assert.ok(
      calls.some((entry) => entry.startsWith("https://stale.useorgx.invalid")),
      "expected initial pairing call against configured stale base URL"
    );
    assert.ok(
      calls.some((entry) => entry.startsWith("https://www.useorgx.com")),
      "expected fallback pairing call against canonical OrgX base URL"
    );
  } finally {
    globalThis.fetch = prevFetch;
    restoreConfig();
  }
});
