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

test("Onboarding pairing start uses an extended timeout for /api/plugin/openclaw/pairings", async () => {
  const dir = mkdtempSync(join(tmpdir(), "orgx-openclaw-pairing-"));
  const prevPluginDir = process.env.ORGX_OPENCLAW_PLUGIN_CONFIG_DIR;
  process.env.ORGX_OPENCLAW_PLUGIN_CONFIG_DIR = dir;

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

    // The first timer created in fetchOrgxJson must be >= 30s for pairing start.
    assert.ok(
      recorded.some((ms) => typeof ms === "number" && ms >= 30_000),
      `expected an extended timeout >= 30000ms; got: ${JSON.stringify(recorded)}`
    );
  } finally {
    globalThis.fetch = prevFetch;
    globalThis.setTimeout = prevSetTimeout;
    globalThis.clearTimeout = prevClearTimeout;
    if (prevPluginDir === undefined) {
      delete process.env.ORGX_OPENCLAW_PLUGIN_CONFIG_DIR;
    } else {
      process.env.ORGX_OPENCLAW_PLUGIN_CONFIG_DIR = prevPluginDir;
    }
  }
});
