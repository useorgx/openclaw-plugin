import test from "node:test";
import assert from "node:assert/strict";

test("resolveConfig includes ORGX_API_FALLBACK_URL without changing the primary base URL", async () => {
  const { resolveConfig } = await import("../dist/config/resolution.js");
  const previousFallback = process.env.ORGX_API_FALLBACK_URL;
  const previousBase = process.env.ORGX_BASE_URL;

  try {
    process.env.ORGX_BASE_URL = "https://www.useorgx.com";
    process.env.ORGX_API_FALLBACK_URL = "https://orgx-api-fallback.example";

    const config = resolveConfig(
      { config: { plugins: { entries: { orgx: { config: {} } } } } },
      {
        installationId: "install-1",
        persistedApiKey: null,
        persistedUserId: null,
        persistedWorkspaceId: "11111111-1111-4111-8111-111111111111",
      }
    );

    assert.equal(config.baseUrl, "https://www.useorgx.com");
    assert.equal(config.apiFallbackUrl, "https://orgx-api-fallback.example");
    assert.equal(config.workspaceId, "11111111-1111-4111-8111-111111111111");
  } finally {
    if (previousFallback === undefined) {
      delete process.env.ORGX_API_FALLBACK_URL;
    } else {
      process.env.ORGX_API_FALLBACK_URL = previousFallback;
    }
    if (previousBase === undefined) {
      delete process.env.ORGX_BASE_URL;
    } else {
      process.env.ORGX_BASE_URL = previousBase;
    }
  }
});
