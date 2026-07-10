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

test("terminal reporting remains available after the execution cap", () => {
  const guard = createManagedHeartbeatExecutionGuard({ maxExecutionCalls: 1 });
  canonicalDiscovery(guard);
  guard.beforeToolCall({ toolName: "read", params: {} }, context);

  for (const toolName of [
    "orgx_emit_activity",
    "orgx_register_artifact",
    "orgx_verify_completion",
    "heartbeat_respond",
  ]) {
    assert.equal(
      guard.beforeToolCall({ toolName, params: {} }, context),
      undefined
    );
  }
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
  assert.equal(
    guard.beforeToolCall({ toolName: "read", params: {} }, context),
    undefined
  );
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

test("broad discovery detection covers find, recursive grep, and home paths", () => {
  assert.equal(isBroadHeartbeatDiscoveryCommand("find . -type f"), true);
  assert.equal(isBroadHeartbeatDiscoveryCommand("grep -R TODO ."), true);
  assert.equal(
    isBroadHeartbeatDiscoveryCommand("rg TODO /Users/hope/repo"),
    true
  );
  assert.equal(
    isBroadHeartbeatDiscoveryCommand("rg TODO src/file.ts"),
    false
  );
});
