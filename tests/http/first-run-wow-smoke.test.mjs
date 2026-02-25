import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import register from "../../dist/index.js";

function createStubResponse() {
  return {
    status: null,
    headers: null,
    body: Buffer.alloc(0),
    writableEnded: false,
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers ?? null;
    },
    end(body) {
      if (body) {
        const chunk = Buffer.isBuffer(body) ? body : Buffer.from(String(body), "utf8");
        this.body = Buffer.concat([this.body, chunk]);
      }
      this.writableEnded = true;
    },
  };
}

function createApiStub(configOverrides = {}) {
  const stub = {
    config: {
      plugins: {
        entries: {
          orgx: {
            config: {
              enabled: true,
              dashboardEnabled: true,
              apiKey: "",
              userId: "",
              baseUrl: "https://www.useorgx.com",
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

async function readOnboardingStatus(handler) {
  const res = createStubResponse();
  await handler(
    {
      method: "GET",
      url: "/orgx/api/onboarding/status",
      headers: {},
    },
    res
  );

  assert.equal(res.status, 200);
  const payload = JSON.parse(res.body.toString("utf8"));
  assert.equal(payload?.ok, true);
  return payload?.data;
}

test("first-run smoke: disconnect path returns connect onboarding state and live dashboard route", async () => {
  const dir = mkdtempSync(join(tmpdir(), "orgx-openclaw-first-run-"));
  const prevPluginDir = process.env.ORGX_OPENCLAW_PLUGIN_CONFIG_DIR;
  const prevApiKey = process.env.ORGX_API_KEY;
  const prevUserId = process.env.ORGX_USER_ID;
  process.env.ORGX_OPENCLAW_PLUGIN_CONFIG_DIR = dir;
  delete process.env.ORGX_API_KEY;
  delete process.env.ORGX_USER_ID;

  try {
    const api = createApiStub({ apiKey: "oxk_seed_key" });
    register(api);
    assert.equal(typeof api._httpHandler, "function");

    const disconnectRes = createStubResponse();
    await api._httpHandler(
      {
        method: "POST",
        url: "/orgx/api/onboarding/disconnect",
        headers: {},
      },
      disconnectRes
    );
    assert.equal(disconnectRes.status, 200);
    const disconnectPayload = JSON.parse(disconnectRes.body.toString("utf8"));
    assert.equal(disconnectPayload?.ok, true);

    const state = await readOnboardingStatus(api._httpHandler);
    assert.equal(state.hasApiKey, false);
    assert.equal(state.status, "idle");
    assert.equal(state.nextAction, "connect");

    const rootRes = createStubResponse();
    await api._httpHandler(
      {
        method: "GET",
        url: "/orgx",
        headers: {},
      },
      rootRes
    );
    assert.equal(rootRes.status, 302);
    assert.equal(rootRes.headers?.Location, "/orgx/live");

    const liveRes = createStubResponse();
    await api._httpHandler(
      {
        method: "GET",
        url: "/orgx/live",
        headers: {},
      },
      liveRes
    );
    assert.ok([200, 503].includes(Number(liveRes.status)));
  } finally {
    if (prevApiKey === undefined) {
      delete process.env.ORGX_API_KEY;
    } else {
      process.env.ORGX_API_KEY = prevApiKey;
    }
    if (prevUserId === undefined) {
      delete process.env.ORGX_USER_ID;
    } else {
      process.env.ORGX_USER_ID = prevUserId;
    }
    if (prevPluginDir === undefined) {
      delete process.env.ORGX_OPENCLAW_PLUGIN_CONFIG_DIR;
    } else {
      process.env.ORGX_OPENCLAW_PLUGIN_CONFIG_DIR = prevPluginDir;
    }
  }
});

test("first-run smoke: configured API key defaults onboarding to open_dashboard", async () => {
  const dir = mkdtempSync(join(tmpdir(), "orgx-openclaw-first-run-"));
  const prevPluginDir = process.env.ORGX_OPENCLAW_PLUGIN_CONFIG_DIR;
  const prevApiKey = process.env.ORGX_API_KEY;
  const prevUserId = process.env.ORGX_USER_ID;
  process.env.ORGX_OPENCLAW_PLUGIN_CONFIG_DIR = dir;
  delete process.env.ORGX_API_KEY;
  delete process.env.ORGX_USER_ID;

  try {
    const api = createApiStub({ apiKey: "oxk_test_key" });
    register(api);
    assert.equal(typeof api._httpHandler, "function");

    const state = await readOnboardingStatus(api._httpHandler);
    assert.equal(state.hasApiKey, true);
    assert.equal(state.status, "connected");
    assert.equal(state.nextAction, "open_dashboard");
  } finally {
    if (prevApiKey === undefined) {
      delete process.env.ORGX_API_KEY;
    } else {
      process.env.ORGX_API_KEY = prevApiKey;
    }
    if (prevUserId === undefined) {
      delete process.env.ORGX_USER_ID;
    } else {
      process.env.ORGX_USER_ID = prevUserId;
    }
    if (prevPluginDir === undefined) {
      delete process.env.ORGX_OPENCLAW_PLUGIN_CONFIG_DIR;
    } else {
      process.env.ORGX_OPENCLAW_PLUGIN_CONFIG_DIR = prevPluginDir;
    }
  }
});
