import test from "node:test";
import assert from "node:assert/strict";

import { registerCoreTools } from "../../dist/tools/core-tools.js";

function deps() {
  const calls = [];
  return {
    calls,
    value: {
      registerTool: () => {},
      client: {
        requestAttention: async (input) => {
          calls.push({ kind: "request", input });
          return { decision_id: "decision-1" };
        },
        pollAttention: async (id) => {
          calls.push({ kind: "poll", id });
          return { question: { resolved: true, answer: "Continue" } };
        },
        acknowledgeAttention: async (id, receipt) => {
          calls.push({ kind: "ack", id, receipt });
          return { ok: true };
        },
        manageLifecycle: async (input) => {
          calls.push({ kind: "lifecycle", input });
          return {
            ok: true,
            ...input,
            affected: {
              nodes: 1,
              runsPaused: 0,
              runsCancelled: 0,
              redispatched: input.action === "retry" ? 1 : 0,
            },
            message: "Lifecycle action applied",
          };
        },
      },
      config: { syncIntervalMs: 10_000, pluginVersion: "test" },
      getCachedSnapshot: () => null,
      getLastSnapshotAt: () => 0,
      doSync: async () => {},
      text: (text) => ({ content: [{ type: "text", text }] }),
      json: (label, data) => ({
        content: [{ type: "text", text: `${label}\n${JSON.stringify(data)}` }],
      }),
      formatSnapshot: () => "snapshot",
      autoAssignEntityForCreate: async () => ({
        assignmentSource: "manual",
        assignedAgents: [],
        warnings: [],
      }),
      toReportingPhase: () => "execution",
      inferReportingInitiativeId: () => undefined,
      isUuid: () => true,
      pickNonEmptyString: (...values) => values.find((value) => typeof value === "string" && value.trim()),
      resolveReportingContext: () => ({ ok: false, error: "unused" }),
      readSkillPackState: () => ({}),
      updateSkillPackPolicy: () => ({}),
      rollbackSkillPackPolicy: () => ({}),
      randomUUID: () => "11111111-1111-4111-8111-111111111111",
    },
  };
}

test("attention tools preserve one request id through polling and truthful continuation", async () => {
  const setup = deps();
  const tools = registerCoreTools(setup.value);
  const requestTool = tools.get("orgx_request_attention");
  const pollTool = tools.get("orgx_poll_attention");
  const ackTool = tools.get("orgx_ack_attention");
  assert.ok(requestTool && pollTool && ackTool);
  assert.equal(requestTool.parameters.additionalProperties, false);
  assert.equal(pollTool.parameters.additionalProperties, false);
  assert.equal(ackTool.parameters.additionalProperties, false);

  await requestTool.execute("call-1", {
    initiative_id: "11111111-1111-4111-8111-111111111111",
    attention_kind: "question",
    idempotency_key: "openclaw-question-1",
    question: "Which direction?",
    source_tool: "openclaw.ask",
    source_session_id: "session-1",
  });
  await pollTool.execute("call-2", { attention_id: "decision-1" });
  await ackTool.execute("call-3", {
    attention_id: "decision-1",
    state: "resumed",
    idempotency_key: "decision-1:resumed",
    session_handle: "session-1",
  });

  assert.equal(setup.calls[0].input.correlation_id.startsWith("openclaw:"), true);
  assert.deepEqual(setup.calls[0].input.continuation, {
    strategy: "poll",
    capability_version: "openclaw-attention-v1",
  });
  assert.deepEqual(setup.calls.slice(1), [
    { kind: "poll", id: "decision-1" },
    {
      kind: "ack",
      id: "decision-1",
      receipt: {
        state: "resumed",
        idempotency_key: "decision-1:resumed",
        session_handle: "session-1",
      },
    },
  ]);
});

test("hierarchy lifecycle tool forwards one atomic recovery request", async () => {
  const setup = deps();
  const tools = registerCoreTools(setup.value);
  const lifecycleTool = tools.get("orgx_manage_lifecycle");
  assert.ok(lifecycleTool);
  assert.deepEqual(lifecycleTool.parameters.required, ["level", "id", "action"]);
  assert.equal(lifecycleTool.parameters.additionalProperties, false);

  const result = await lifecycleTool.execute("call-lifecycle", {
    level: "workstream",
    id: "11111111-1111-4111-8111-111111111111",
    action: "retry",
  });

  assert.deepEqual(setup.calls, [
    {
      kind: "lifecycle",
      input: {
        level: "workstream",
        id: "11111111-1111-4111-8111-111111111111",
        action: "retry",
      },
    },
  ]);
  assert.match(result.content[0].text, /Lifecycle action applied/);
});
