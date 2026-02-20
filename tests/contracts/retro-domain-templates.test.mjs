import test from "node:test";
import assert from "node:assert/strict";

async function importFreshModule(modulePath) {
  const url = new URL(modulePath, import.meta.url);
  url.searchParams.set("cacheBust", `${Date.now()}-${Math.random()}`);
  return import(url.href);
}

test("buildRetroTemplateForAgent emits engineering-focused success retro content", async () => {
  const { buildRetroTemplateForAgent } = await importFreshModule(
    "../../dist/retro/domain-templates.js"
  );

  const template = buildRetroTemplateForAgent({
    agentId: "orgx-engineering",
    success: true,
    taskId: "task-123",
    runId: "run-123",
    errorMessage: null,
  });

  assert.equal(template.domain, "engineering");
  assert.match(template.summary, /Engineering execution completed task task-123\./);
  assert.equal(template.whatWentWrong.length, 0);
  assert.equal(template.decisions.length, 1);
  assert.match(template.decisions[0] ?? "", /no immediate intervention required/i);
  assert.equal(template.followUps.length, 1);
});

test("buildRetroTemplateForAgent emits sales-focused failure follow-up", async () => {
  const { buildRetroTemplateForAgent } = await importFreshModule(
    "../../dist/retro/domain-templates.js"
  );

  const template = buildRetroTemplateForAgent({
    agentId: "orgx-sales",
    success: false,
    taskId: null,
    runId: "run-999",
    errorMessage: "rate limit exceeded",
  });

  assert.equal(template.domain, "sales");
  assert.match(template.summary, /Sales execution run blocked \(session run-999\)\./);
  assert.deepEqual(template.whatWentWrong, ["rate limit exceeded"]);
  assert.equal(template.decisions.length, 1);
  assert.match(template.decisions[0] ?? "", /sales unblock decision/i);
  assert.equal(template.followUps[0]?.priority, "p0");
  assert.match(template.followUps[0]?.title ?? "", /sales motion/i);
});

test("buildRetroTemplateForAgent infers domain from common role aliases", async () => {
  const { buildRetroTemplateForAgent } = await importFreshModule(
    "../../dist/retro/domain-templates.js"
  );

  const cases = [
    { agentId: "agent-eng-1", expectedDomain: "engineering" },
    { agentId: "dev-frontend", expectedDomain: "engineering" },
    { agentId: "pm.primary", expectedDomain: "product" },
    { agentId: "ux-reviewer", expectedDomain: "design" },
    { agentId: "growth-lane", expectedDomain: "marketing" },
    { agentId: "mkt-campaign", expectedDomain: "marketing" },
    { agentId: "sdr-west", expectedDomain: "sales" },
    { agentId: "ops-nightly", expectedDomain: "operations" },
    { agentId: "platform-infra", expectedDomain: "operations" },
    { agentId: "router-main", expectedDomain: "orchestration" },
    { agentId: "coordinator-primary", expectedDomain: "orchestration" },
    { agentId: "sentinel-engineering", expectedDomain: "orchestration" },
  ];

  for (const sample of cases) {
    const template = buildRetroTemplateForAgent({
      agentId: sample.agentId,
      success: true,
      taskId: "task-alias",
      runId: "run-alias",
      errorMessage: null,
    });
    assert.equal(template.domain, sample.expectedDomain);
  }
});

test("buildRetroTemplateForAgent emits sentinel-specific failure decision language", async () => {
  const { buildRetroTemplateForAgent } = await importFreshModule(
    "../../dist/retro/domain-templates.js"
  );

  const template = buildRetroTemplateForAgent({
    agentId: "sentinel-main",
    success: false,
    taskId: "task-sentinel",
    runId: "run-sentinel",
    errorMessage: "dependency blocked",
  });

  assert.equal(template.domain, "orchestration");
  assert.equal(template.decisions.length, 1);
  assert.match(template.decisions[0] ?? "", /sentinel:\s*resolve decision/i);
});
