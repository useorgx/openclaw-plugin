import test from "node:test";
import assert from "node:assert/strict";

async function importFreshModule() {
  const url = new URL("../dist/openclaw-settings.js", import.meta.url);
  url.searchParams.set("t", `${Date.now()}-${Math.random()}`);
  return import(url.href);
}

test("resolvePreferredOpenClawProvider prefers sonnet-capable provider", async () => {
  const mod = await importFreshModule();

  const raw = {
    agents: {
      defaults: {
        models: {
          "anthropic/claude-opus-4-5": {},
          "openrouter/anthropic/claude-sonnet-4.5": {},
          "openai-codex/gpt-5.2-codex": {},
        },
      },
    },
  };

  const preferred = mod.resolvePreferredOpenClawProvider(raw);
  assert.equal(preferred, "openrouter");
});

test("summarizeOpenClawProviderModels counts openai-codex as openai", async () => {
  const mod = await importFreshModule();

  const summary = mod.summarizeOpenClawProviderModels({
    agents: {
      defaults: {
        models: {
          "openai-codex/gpt-5.2-codex": {},
          "openai/gpt-4.1": {},
        },
      },
    },
  });

  assert.equal(summary.openai.total, 2);
  assert.equal(summary.openai.sonnetCount, 0);
  assert.equal(summary.anthropic.total, 0);
  assert.equal(summary.openrouter.total, 0);
});

test("readOpenClawGatewayPort uses configured port and safe default", async () => {
  const mod = await importFreshModule();

  assert.equal(mod.readOpenClawGatewayPort({ gateway: { port: 19123 } }), 19123);
  assert.equal(mod.readOpenClawGatewayPort({ gateway: { port: "19124" } }), 19124);
  assert.equal(mod.readOpenClawGatewayPort({ gateway: { port: "bad" } }), 18789);
  assert.equal(mod.readOpenClawGatewayPort(null), 18789);
});
