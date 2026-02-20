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

test("detectEvalPassRateDrift alerts when 7-day rolling pass rate drops by more than 5%", async () => {
  const mod = await importFreshModule();
  const passRates = [...Array(7).fill(0.95), ...Array(7).fill(0.88)];

  const drift = mod.detectEvalPassRateDrift({ passRates });
  assert.ok(drift);
  assert.equal(drift.alert, true);
  assert.equal(drift.dropPct, 7);
  assert.equal(drift.thresholdDropPct, 5);
  assert.equal(drift.baselineSamples, 7);
  assert.equal(drift.rollingSamples, 7);
});

test("detectEvalPassRateDrift does not alert when drop is exactly 5%", async () => {
  const mod = await importFreshModule();
  const passRates = [...Array(7).fill(0.9), ...Array(7).fill(0.85)];

  const drift = mod.detectEvalPassRateDrift({ passRates });
  assert.ok(drift);
  assert.equal(drift.alert, false);
  assert.equal(drift.dropPct, 5);
});

test("detectEvalPassRateDrift supports percent-style rates and requires baseline + rolling windows", async () => {
  const mod = await importFreshModule();
  const tooShort = mod.detectEvalPassRateDrift({ passRates: [95, 96, 94] });
  assert.equal(tooShort, null);

  const passRates = [...Array(7).fill(92), ...Array(7).fill(88)];
  const drift = mod.detectEvalPassRateDrift({ passRates });
  assert.ok(drift);
  assert.equal(drift.alert, false);
  assert.equal(drift.dropPct, 4);
  assert.equal(drift.rollingPassRate7d, 0.88);
});
