import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Import the module fresh each time so that the config-dir env var
 * is picked up on initialisation and each test gets its own store.
 */
async function importFresh(configDir) {
  process.env.ORGX_OPENCLAW_PLUGIN_CONFIG_DIR = configDir;
  const url = new URL("../dist/team-context-store.js", import.meta.url);
  url.searchParams.set("t", `${Date.now()}-${Math.random()}`);
  return import(url.href);
}

test("readTeamContext returns empty context for unknown initiative", async () => {
  const dir = mkdtempSync(join(tmpdir(), "team-ctx-"));
  const { readTeamContext } = await importFresh(dir);

  const ctx = readTeamContext("init-unknown");

  assert.ok(Array.isArray(ctx.recent_completions), "recent_completions should be an array");
  assert.equal(ctx.recent_completions.length, 0, "recent_completions should be empty");
  assert.ok(Array.isArray(ctx.recent_decisions), "recent_decisions should be an array");
  assert.equal(ctx.recent_decisions.length, 0, "recent_decisions should be empty");
});

test("appendTeamCompletion persists and can be read back", async () => {
  const dir = mkdtempSync(join(tmpdir(), "team-ctx-"));
  const { appendTeamCompletion, readTeamContext } = await importFresh(dir);

  appendTeamCompletion("init-1", {
    domain: "engineering",
    task_title: "Ship auth",
    summary: "Done",
    key_outputs: ["api"],
    completed_at: "2026-01-01T00:00:00Z",
  });

  const ctx = readTeamContext("init-1");

  assert.equal(ctx.recent_completions.length, 1, "should have 1 completion");
  assert.equal(ctx.recent_completions[0].domain, "engineering", "domain should be engineering");
});

test("appendTeamDecision persists and can be read back", async () => {
  const dir = mkdtempSync(join(tmpdir(), "team-ctx-"));
  const { appendTeamDecision, readTeamContext } = await importFresh(dir);

  appendTeamDecision("init-2", {
    title: "Use JWT",
    resolution: "Approved",
    resolved_at: "2026-01-01T00:00:00Z",
  });

  const ctx = readTeamContext("init-2");

  assert.equal(ctx.recent_decisions.length, 1, "should have 1 decision");
});

test("clearTeamContext removes data for specific initiative", async () => {
  const dir = mkdtempSync(join(tmpdir(), "team-ctx-"));
  const { appendTeamCompletion, clearTeamContext, readTeamContext } =
    await importFresh(dir);

  appendTeamCompletion("init-a", {
    domain: "engineering",
    task_title: "Task A",
    summary: "Done A",
    key_outputs: ["a"],
    completed_at: "2026-01-01T00:00:00Z",
  });

  appendTeamCompletion("init-b", {
    domain: "design",
    task_title: "Task B",
    summary: "Done B",
    key_outputs: ["b"],
    completed_at: "2026-01-02T00:00:00Z",
  });

  clearTeamContext("init-a");

  const ctxA = readTeamContext("init-a");
  assert.equal(ctxA.recent_completions.length, 0, "init-a completions should be empty after clear");
  assert.equal(ctxA.recent_decisions.length, 0, "init-a decisions should be empty after clear");

  const ctxB = readTeamContext("init-b");
  assert.equal(ctxB.recent_completions.length, 1, "init-b completions should still have data");
});
