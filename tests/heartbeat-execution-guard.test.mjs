import assert from "node:assert/strict";
import test from "node:test";

import {
  createManagedHeartbeatExecutionGuard,
  isBroadHeartbeatDiscoveryCommand,
} from "../dist/heartbeat-execution-guard.js";

const context = {
  agentId: "orgx-engineering",
  runId: "run-1",
  sessionKey: "agent:orgx-engineering:main",
};

function canonicalDiscovery(guard) {
  guard.beforeToolCall(
    { toolName: "orgx_status", params: { canonical_only: true } },
    context
  );
  guard.beforeToolCall(
    {
      toolName: "orgx_recommend_next_action",
      params: { canonical_only: true },
    },
    context
  );
}

test("managed heartbeat allows five execution calls and blocks the sixth", () => {
  const guard = createManagedHeartbeatExecutionGuard();
  canonicalDiscovery(guard);

  for (let index = 0; index < 5; index += 1) {
    assert.equal(
      guard.beforeToolCall({ toolName: "read", params: {} }, context),
      undefined
    );
  }

  const blocked = guard.beforeToolCall(
    { toolName: "edit", params: {} },
    context
  );
  assert.equal(blocked?.block, true);
  assert.match(blocked?.blockReason ?? "", /execution limit reached/i);
});

test("only the terminal heartbeat response remains available after the call cap", () => {
  const guard = createManagedHeartbeatExecutionGuard({ maxExecutionCalls: 1 });
  canonicalDiscovery(guard);
  guard.beforeToolCall({ toolName: "read", params: {} }, context);

  const reportingBlocked = guard.beforeToolCall(
    { toolName: "orgx_emit_activity", params: { phase: "execution" } },
    context
  );
  assert.equal(reportingBlocked?.block, true);
  assert.match(reportingBlocked?.blockReason ?? "", /total tool-call budget/i);
  assert.equal(
    guard.beforeToolCall(
      { toolName: "heartbeat_respond", params: { outcome: "progress" } },
      context
    ),
    undefined
  );
});

test("proof and reporting tools consume the shared call budget", () => {
  const guard = createManagedHeartbeatExecutionGuard({ maxExecutionCalls: 2 });
  canonicalDiscovery(guard);
  assert.equal(
    guard.beforeToolCall(
      { toolName: "orgx_verify_completion", params: {} },
      context
    ),
    undefined
  );
  assert.equal(
    guard.beforeToolCall(
      { toolName: "orgx_register_artifact", params: {} },
      context
    ),
    undefined
  );
  const blocked = guard.beforeToolCall(
    { toolName: "orgx_quality_score", params: {} },
    context
  );
  assert.equal(blocked?.block, true);
  assert.match(blocked?.blockReason ?? "", /total tool-call budget/i);
});

test("heartbeat response closes the turn to additional tools", () => {
  const guard = createManagedHeartbeatExecutionGuard();
  canonicalDiscovery(guard);
  guard.afterToolCall(
    {
      toolName: "orgx_verify_completion",
      params: {},
      result: {
        content: [{ type: "text", text: '{"ready":true,"verified":true}' }],
      },
    },
    context
  );
  guard.beforeToolCall(
    { toolName: "heartbeat_respond", params: { outcome: "progress" } },
    context
  );

  for (const toolName of ["read", "orgx_status", "orgx_emit_activity"]) {
    const blocked = guard.beforeToolCall(
      {
        toolName,
        params: toolName === "orgx_status" ? { canonical_only: true } : {},
      },
      context
    );
    assert.equal(blocked?.block, true);
    assert.match(blocked?.blockReason ?? "", /terminal status is already recorded/i);
  }
});

test("done outcomes require a passing completion verification result", () => {
  const guard = createManagedHeartbeatExecutionGuard();
  canonicalDiscovery(guard);

  const missing = guard.beforeToolCall(
    { toolName: "heartbeat_respond", params: { outcome: "done" } },
    context
  );
  assert.equal(missing?.block, true);
  assert.match(missing?.blockReason ?? "", /completion is not verified/i);

  guard.afterToolCall(
    {
      toolName: "orgx_verify_completion",
      params: {},
      result: {
        content: [
          { type: "text", text: '{"ready":false,"verified":false}' },
        ],
      },
    },
    context
  );
  const failed = guard.beforeToolCall(
    { toolName: "orgx_emit_activity", params: { phase: "completed" } },
    context
  );
  assert.equal(failed?.block, true);
  assert.match(failed?.blockReason ?? "", /completion is not verified/i);
  const outcomeBlocked = guard.beforeToolCall(
    { toolName: "orgx_record_outcome", params: { success: true } },
    context
  );
  assert.equal(outcomeBlocked?.block, true);
  assert.match(outcomeBlocked?.blockReason ?? "", /completion is not verified/i);

  guard.afterToolCall(
    {
      toolName: "orgx_verify_completion",
      params: {},
      result: {
        content: [
          {
            type: "text",
            text: '{"ready":true,"verification":{"verified":true}}',
          },
        ],
      },
    },
    context
  );
  assert.equal(
    guard.beforeToolCall(
      { toolName: "orgx_emit_activity", params: { phase: "completed" } },
      context
    ),
    undefined
  );
  assert.equal(
    guard.beforeToolCall(
      { toolName: "orgx_update_entity", params: { status: "done" } },
      context
    ),
    undefined
  );
  assert.equal(
    guard.beforeToolCall(
      { toolName: "orgx_record_outcome", params: { success: true } },
      context
    ),
    undefined
  );
  assert.equal(
    guard.beforeToolCall(
      { toolName: "heartbeat_respond", params: { outcome: "done" } },
      context
    ),
    undefined
  );
});

test("repeated status discovery cannot reset the execution budget", () => {
  const guard = createManagedHeartbeatExecutionGuard({ maxExecutionCalls: 1 });
  canonicalDiscovery(guard);
  guard.beforeToolCall({ toolName: "read", params: {} }, context);
  guard.beforeToolCall(
    { toolName: "orgx_status", params: { canonical_only: true } },
    context
  );

  const blocked = guard.beforeToolCall(
    { toolName: "edit", params: {} },
    context
  );
  assert.equal(blocked?.block, true);
  assert.match(blocked?.blockReason ?? "", /execution limit reached/i);
});

test("execution is blocked until canonical recommendation discovery", () => {
  const guard = createManagedHeartbeatExecutionGuard();
  guard.beforeToolCall(
    { toolName: "orgx_status", params: { canonical_only: true } },
    context
  );

  const blocked = guard.beforeToolCall(
    { toolName: "exec", params: { command: "git status -sb" } },
    context
  );
  assert.equal(blocked?.block, true);
  assert.match(blocked?.blockReason ?? "", /discovery is incomplete/i);
});

test("noncanonical recommendation discovery is blocked", () => {
  const guard = createManagedHeartbeatExecutionGuard();
  guard.beforeToolCall(
    { toolName: "orgx_status", params: { canonical_only: true } },
    context
  );

  const blocked = guard.beforeToolCall(
    {
      toolName: "orgx_recommend_next_action",
      params: { canonical_only: false },
    },
    context
  );
  assert.equal(blocked?.block, true);
  assert.match(blocked?.blockReason ?? "", /require canonical_only=true/i);
});

test("broad filesystem discovery is blocked and consumes execution budget", () => {
  const guard = createManagedHeartbeatExecutionGuard({ maxExecutionCalls: 1 });
  canonicalDiscovery(guard);

  const discoveryBlock = guard.beforeToolCall(
    { toolName: "exec", params: { command: "find . -type f" } },
    context
  );
  assert.equal(discoveryBlock?.block, true);
  assert.match(discoveryBlock?.blockReason ?? "", /broad filesystem discovery/i);

  const capBlock = guard.beforeToolCall(
    { toolName: "read", params: {} },
    context
  );
  assert.equal(capBlock?.block, true);
  assert.match(capBlock?.blockReason ?? "", /execution limit reached/i);
});

test("guard ignores non-managed agents and clears completed runs", () => {
  const guard = createManagedHeartbeatExecutionGuard({ maxExecutionCalls: 1 });
  assert.equal(
    guard.beforeToolCall(
      { toolName: "exec", params: { command: "find ." } },
      { agentId: "main", runId: "run-main" }
    ),
    undefined
  );

  canonicalDiscovery(guard);
  guard.beforeToolCall({ toolName: "read", params: {} }, context);
  guard.endRun(context);
  const afterEnd = guard.beforeToolCall(
    { toolName: "read", params: {} },
    context
  );
  assert.equal(afterEnd?.block, true);
  assert.match(afterEnd?.blockReason ?? "", /must begin each turn/i);
});

test("managed turns cannot execute from stale context before status", () => {
  const guard = createManagedHeartbeatExecutionGuard();
  const blocked = guard.beforeToolCall(
    { toolName: "read", params: {} },
    context
  );
  assert.equal(blocked?.block, true);
  assert.match(blocked?.blockReason ?? "", /must begin each turn/i);
});

test("managed session keys activate the guard when agentId is omitted", () => {
  const guard = createManagedHeartbeatExecutionGuard({ maxExecutionCalls: 1 });
  const sessionOnlyContext = {
    runId: "run-session-only",
    sessionKey: "agent:orgx-engineering:main",
  };
  guard.beforeToolCall(
    { toolName: "orgx_status", params: { canonical_only: true } },
    sessionOnlyContext
  );
  guard.beforeToolCall(
    {
      toolName: "orgx_recommend_next_action",
      params: { canonical_only: true },
    },
    sessionOnlyContext
  );
  guard.beforeToolCall(
    { toolName: "bash", params: { command: "pwd" } },
    sessionOnlyContext
  );

  const blocked = guard.beforeToolCall(
    { toolName: "bash", params: { command: "git status -sb" } },
    sessionOnlyContext
  );
  assert.equal(blocked?.block, true);
  assert.match(blocked?.blockReason ?? "", /execution limit reached/i);
});

test("broad discovery detection blocks home roots but allows assigned repositories", () => {
  assert.equal(isBroadHeartbeatDiscoveryCommand("find . -type f"), true);
  assert.equal(isBroadHeartbeatDiscoveryCommand("grep -R TODO ."), true);
  assert.equal(
    isBroadHeartbeatDiscoveryCommand("rg TODO /Users/hope"),
    true
  );
  assert.equal(
    isBroadHeartbeatDiscoveryCommand(
      "cd /Users/hope/Code/orgx/orgx && npx vitest run tests/telemetry.spec.ts"
    ),
    false
  );
  assert.equal(
    isBroadHeartbeatDiscoveryCommand("rg TODO src/file.ts"),
    false
  );
});
