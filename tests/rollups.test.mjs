import test from "node:test";
import assert from "node:assert/strict";

async function importFreshModule() {
  const url = new URL("../dist/reporting/rollups.js", import.meta.url);
  url.searchParams.set("cacheBust", `${Date.now()}-${Math.random()}`);
  return import(url.href);
}

test("computeMilestoneRollup matches expected status rules", async () => {
  const mod = await importFreshModule();
  const inProgress = mod.computeMilestoneRollup(["done", "in_progress", "todo"]);
  assert.equal(inProgress.status, "in_progress");
  assert.equal(inProgress.progressPct, 33);

  const atRisk = mod.computeMilestoneRollup(["done", "blocked", "todo"]);
  assert.equal(atRisk.status, "at_risk");
  assert.equal(atRisk.progressPct, 33);

  const completed = mod.computeMilestoneRollup(["done", "completed"]);
  assert.equal(completed.status, "completed");
  assert.equal(completed.progressPct, 100);
});

test("computeWorkstreamRollup matches expected status rules", async () => {
  const mod = await importFreshModule();
  const active = mod.computeWorkstreamRollup(["done", "in_progress", "todo"]);
  assert.equal(active.status, "active");
  assert.equal(active.progressPct, 33);

  const blocked = mod.computeWorkstreamRollup(["done", "blocked", "todo"]);
  assert.equal(blocked.status, "blocked");
  assert.equal(blocked.progressPct, 33);

  const done = mod.computeWorkstreamRollup(["done", "completed"]);
  assert.equal(done.status, "done");
  assert.equal(done.progressPct, 100);
});

