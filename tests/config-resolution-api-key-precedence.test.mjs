import test from "node:test";
import assert from "node:assert/strict";

import { resolveConfig } from "../dist/config/resolution.js";

function withEnv(name, value, fn) {
  const prev = process.env[name];
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
  try {
    fn();
  } finally {
    if (prev === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = prev;
    }
  }
}

function resolveWith({ pluginApiKey = "", persistedApiKey = null }) {
  return resolveConfig(
    {
      config: {
        plugins: {
          entries: {
            orgx: {
              config: {
                apiKey: pluginApiKey,
              },
            },
          },
        },
      },
    },
    {
      installationId: "install-test",
      persistedApiKey,
      persistedUserId: null,
    }
  );
}

test("resolveConfig prefers plugin config apiKey over env and persisted", () => {
  withEnv("ORGX_API_KEY", "oxk_env_key", () => {
    const resolved = resolveWith({
      pluginApiKey: "oxk_config_key",
      persistedApiKey: "oxk_persisted_key",
    });

    assert.equal(resolved.apiKey, "oxk_config_key");
    assert.equal(resolved.apiKeySource, "config");
  });
});

test("resolveConfig prefers ORGX_API_KEY over persisted apiKey when config is empty", () => {
  withEnv("ORGX_API_KEY", "oxk_env_key", () => {
    const resolved = resolveWith({
      pluginApiKey: "",
      persistedApiKey: "oxk_persisted_key",
    });

    assert.equal(resolved.apiKey, "oxk_env_key");
    assert.equal(resolved.apiKeySource, "environment");
  });
});

test("resolveConfig uses persisted apiKey when config and env are unavailable", () => {
  withEnv("ORGX_API_KEY", undefined, () => {
    const resolved = resolveWith({
      pluginApiKey: "",
      persistedApiKey: "oxk_persisted_key",
    });

    assert.equal(resolved.apiKey, "oxk_persisted_key");
    assert.equal(resolved.apiKeySource, "persisted");
  });
});

test("resolveConfig treats whitespace config/env values as empty and falls back to persisted", () => {
  withEnv("ORGX_API_KEY", "   ", () => {
    const resolved = resolveWith({
      pluginApiKey: "   ",
      persistedApiKey: "oxk_persisted_key",
    });

    assert.equal(resolved.apiKey, "oxk_persisted_key");
    assert.equal(resolved.apiKeySource, "persisted");
  });
});
