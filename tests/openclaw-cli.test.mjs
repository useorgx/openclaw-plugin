import test from "node:test";
import assert from "node:assert/strict";

async function importFreshModule() {
  const url = new URL("../dist/http/helpers/openclaw-cli.js", import.meta.url);
  url.searchParams.set("t", `${Date.now()}-${Math.random()}`);
  return import(url.href);
}

test("normalizeOpenClawProvider maps supported aliases", async () => {
  const mod = await importFreshModule();

  assert.equal(mod.normalizeOpenClawProvider("openai"), "openai");
  assert.equal(mod.normalizeOpenClawProvider("openai-codex"), "openai");
  assert.equal(mod.normalizeOpenClawProvider("open-router"), "openrouter");
  assert.equal(mod.normalizeOpenClawProvider("open_router"), "openrouter");
  assert.equal(mod.normalizeOpenClawProvider("claude"), "anthropic");
  assert.equal(mod.normalizeOpenClawProvider("auto"), null);
  assert.equal(mod.normalizeOpenClawProvider(""), null);
});
