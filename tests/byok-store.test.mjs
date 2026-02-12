import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function importFreshByokStore() {
  const url = new URL("../dist/byok-store.js", import.meta.url);
  url.searchParams.set("t", `${Date.now()}-${Math.random()}`);
  return import(url.href);
}

test("byok-store persists keys in OpenClaw auth profiles (not plugin byok.json)", async () => {
  const originalHome = process.env.HOME;
  const originalOpenClawHome = process.env.OPENCLAW_HOME;
  const originalPluginDir = process.env.ORGX_OPENCLAW_PLUGIN_CONFIG_DIR;

  const home = mkdtempSync(join(tmpdir(), "orgx-byok-home-"));
  const openclawHome = join(home, ".openclaw-custom");
  const pluginDir = join(home, ".plugin-config");

  process.env.HOME = home;
  process.env.OPENCLAW_HOME = openclawHome;
  process.env.ORGX_OPENCLAW_PLUGIN_CONFIG_DIR = pluginDir;

  try {
    const store = await importFreshByokStore();
    const saved = store.writeByokKeys({
      anthropicApiKey: "sk-ant-test",
      openrouterApiKey: "sk-or-test",
    });

    assert.equal(saved.anthropicApiKey, "sk-ant-test");
    assert.equal(saved.openrouterApiKey, "sk-or-test");

    const authProfilesPath = join(
      openclawHome,
      "agents",
      "main",
      "agent",
      "auth-profiles.json"
    );
    assert.equal(existsSync(authProfilesPath), true);

    const parsed = JSON.parse(readFileSync(authProfilesPath, "utf8"));
    assert.equal(parsed?.profiles?.anthropic?.provider, "anthropic");
    assert.equal(parsed?.profiles?.anthropic?.key, "sk-ant-test");
    assert.equal(parsed?.profiles?.openrouter?.provider, "openrouter");
    assert.equal(parsed?.profiles?.openrouter?.key, "sk-or-test");

    const legacyByokPath = join(pluginDir, "byok.json");
    assert.equal(existsSync(legacyByokPath), false);
  } finally {
    process.env.HOME = originalHome;
    process.env.OPENCLAW_HOME = originalOpenClawHome;
    process.env.ORGX_OPENCLAW_PLUGIN_CONFIG_DIR = originalPluginDir;
  }
});

test("byok-store uses OpenClaw default agent from openclaw.json", async () => {
  const originalHome = process.env.HOME;
  const originalOpenClawHome = process.env.OPENCLAW_HOME;

  const home = mkdtempSync(join(tmpdir(), "orgx-byok-agent-"));
  const openclawHome = join(home, ".openclaw-custom");

  process.env.HOME = home;
  process.env.OPENCLAW_HOME = openclawHome;

  try {
    const { mkdirSync, writeFileSync } = await import("node:fs");
    mkdirSync(openclawHome, { recursive: true });
    writeFileSync(
      join(openclawHome, "openclaw.json"),
      JSON.stringify(
        {
          agents: {
            list: [
              { id: "alpha" },
              { id: "beta", default: true },
            ],
          },
        },
        null,
        2
      )
    );

    const store = await importFreshByokStore();
    store.writeByokKeys({ openaiApiKey: "sk-openai-test" });

    const expected = join(
      openclawHome,
      "agents",
      "beta",
      "agent",
      "auth-profiles.json"
    );
    assert.equal(existsSync(expected), true);

    const parsed = JSON.parse(readFileSync(expected, "utf8"));
    assert.equal(parsed?.profiles?.["openai-codex"]?.provider, "openai-codex");
    assert.equal(parsed?.profiles?.["openai-codex"]?.key, "sk-openai-test");
  } finally {
    process.env.HOME = originalHome;
    process.env.OPENCLAW_HOME = originalOpenClawHome;
  }
});
