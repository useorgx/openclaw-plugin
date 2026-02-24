import test from "node:test";
import assert from "node:assert/strict";
import { brotliCompressSync, gzipSync } from "node:zlib";
import {
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createHttpHandler } from "../../dist/http-handler.js";

function createStubResponse() {
  const res = {
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
  return res;
}

function createNoopOnboarding() {
  return {
    getState: () => ({
      status: "idle",
      hasApiKey: false,
      connectionVerified: false,
      workspaceName: null,
      lastError: null,
      nextAction: "connect",
      docsUrl: "https://example.com",
      keySource: "none",
      installationId: null,
      connectUrl: null,
      pairingId: null,
      expiresAt: null,
      pollIntervalMs: null,
    }),
    startPairing: async () => {
      throw new Error("not implemented");
    },
    getStatus: async () => {
      throw new Error("not implemented");
    },
    submitManualKey: async () => {
      throw new Error("not implemented");
    },
    disconnect: async () => {
      throw new Error("not implemented");
    },
  };
}

function baseConfig() {
  return {
    apiKey: "oxk_test",
    userId: "",
    baseUrl: "https://www.useorgx.com",
    syncIntervalMs: 300_000,
    enabled: true,
    dashboardEnabled: true,
    pluginVersion: "0.0.0-test",
  };
}

test("dashboard static assets negotiate br/gzip sidecars", async () => {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  const repoRoot = resolve(__dirname, "..", "..");
  const distAssetsDir = resolve(repoRoot, "dashboard", "dist", "assets");
  mkdirSync(distAssetsDir, { recursive: true });

  const basename = `compression-test-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const sourcePath = resolve(distAssetsDir, `${basename}.js`);
  const brPath = `${sourcePath}.br`;
  const gzPath = `${sourcePath}.gz`;

  const source = Buffer.from("console.log('compression test');\n".repeat(80), "utf8");
  const br = brotliCompressSync(source);
  const gz = gzipSync(source);
  writeFileSync(sourcePath, source);
  writeFileSync(brPath, br);
  writeFileSync(gzPath, gz);

  const config = baseConfig();
  const client = { getBaseUrl: () => config.baseUrl };
  const handler = createHttpHandler(config, client, () => null, createNoopOnboarding());
  const url = `/orgx/live/assets/${basename}.js`;

  try {
    const brRes = createStubResponse();
    await handler(
      { method: "GET", url, headers: { "accept-encoding": "br, gzip" } },
      brRes
    );
    assert.equal(brRes.status, 200);
    assert.equal(brRes.headers?.["Content-Encoding"], "br");
    assert.equal(brRes.headers?.Vary, "Accept-Encoding");
    assert.equal(brRes.body.length, br.length);

    const gzRes = createStubResponse();
    await handler(
      { method: "GET", url, headers: { "accept-encoding": "gzip" } },
      gzRes
    );
    assert.equal(gzRes.status, 200);
    assert.equal(gzRes.headers?.["Content-Encoding"], "gzip");
    assert.equal(gzRes.headers?.Vary, "Accept-Encoding");
    assert.equal(gzRes.body.length, gz.length);

    const identityRes = createStubResponse();
    await handler(
      { method: "GET", url, headers: { "accept-encoding": "identity" } },
      identityRes
    );
    assert.equal(identityRes.status, 200);
    assert.equal(identityRes.headers?.["Content-Encoding"], undefined);
    assert.equal(identityRes.headers?.Vary, "Accept-Encoding");
    assert.equal(identityRes.body.length, source.length);
  } finally {
    rmSync(sourcePath, { force: true });
    rmSync(brPath, { force: true });
    rmSync(gzPath, { force: true });
  }
});

test("missing hashed JS chunk returns recovery module instead of hard 404", async () => {
  const config = baseConfig();
  const client = { getBaseUrl: () => config.baseUrl };
  const handler = createHttpHandler(config, client, () => null, createNoopOnboarding());

  const res = createStubResponse();
  await handler(
    {
      method: "GET",
      url: `/orgx/live/assets/${Date.now()}-missing-chunk.js`,
      headers: {},
    },
    res
  );

  assert.equal(res.status, 200);
  assert.match(String(res.headers?.["Content-Type"] ?? ""), /application\/javascript/i);
  assert.match(String(res.headers?.["Cache-Control"] ?? ""), /no-store/i);
  const body = res.body.toString("utf8");
  assert.match(body, /window\.location\.replace\('\/orgx\/live'/);
});
