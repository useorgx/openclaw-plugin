import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  buildRunExecutionGraphEvent,
  executionGraphEmitEnabled,
  maybeEmitRunExecutionGraph,
} from "./execution-graph-emit.js";

describe("executionGraphEmitEnabled", () => {
  test("only truthy ORGX_EMIT_EXECUTION_GRAPH enables it", () => {
    assert.equal(executionGraphEmitEnabled({}), false);
    assert.equal(executionGraphEmitEnabled({ ORGX_EMIT_EXECUTION_GRAPH: "0" }), false);
    assert.equal(executionGraphEmitEnabled({ ORGX_EMIT_EXECUTION_GRAPH: "1" }), true);
    assert.equal(executionGraphEmitEnabled({ ORGX_EMIT_EXECUTION_GRAPH: "true" }), true);
  });
});

describe("buildRunExecutionGraphEvent", () => {
  test("null without an initiative id", () => {
    assert.equal(
      buildRunExecutionGraphEvent({ initiativeId: "", success: true }),
      null,
    );
  });

  test("a successful run is one completed task node carrying economy", () => {
    const event = buildRunExecutionGraphEvent({
      initiativeId: "9e52303c-430a-4472-a5ae-ec3ab169e4f3",
      runId: "11111111-1111-1111-1111-111111111111",
      success: true,
      summary: "Shipped the thing",
      model: "claude-opus-4-8",
      provider: "anthropic",
      costUsd: 0.42,
      tokens: 1234,
      durationMs: 9000,
    });
    assert.ok(event);
    assert.equal(event!.source_client, "openclaw");
    assert.equal(event!.run_id, "11111111-1111-1111-1111-111111111111");
    assert.equal(event!.correlation_id, undefined);
    assert.equal(event!.nodes.length, 1);
    assert.equal(event!.nodes[0].status, "completed");
    assert.equal(event!.nodes[0].economy?.model, "claude-opus-4-8");
    assert.equal(event!.nodes[0].economy?.cost_usd, 0.42);
    assert.deepEqual(event!.edges, []);
    assert.deepEqual(event!.trust_events, []);
    assert.equal(event!.metadata?.provider, "anthropic");
  });

  test("a run with hadError is marked failed", () => {
    const event = buildRunExecutionGraphEvent({
      initiativeId: "i",
      success: true,
      hadError: true,
    });
    assert.equal(event!.nodes[0].status, "failed");
  });

  test("no run_id -> correlation_id carries run identity", () => {
    const event = buildRunExecutionGraphEvent({ initiativeId: "abc", success: false });
    assert.equal(event!.run_id, undefined);
    assert.equal(event!.correlation_id, "openclaw-abc");
    assert.equal(event!.nodes[0].status, "failed");
  });
});

describe("maybeEmitRunExecutionGraph", () => {
  test("no-op unless enabled (safety floor)", async () => {
    let called = false;
    const client = { emitExecutionGraph: async () => { called = true; return {} as never; } };
    const res = await maybeEmitRunExecutionGraph(client, { initiativeId: "i", success: true }, {});
    assert.equal(res.skipped, "not_enabled");
    assert.equal(called, false);
  });

  test("enabled + configured emits the built event", async () => {
    let posted: unknown = null;
    const client = {
      emitExecutionGraph: async (payload: unknown) => {
        posted = payload;
        return {} as never;
      },
    };
    const res = await maybeEmitRunExecutionGraph(
      client,
      { initiativeId: "9e52303c-430a-4472-a5ae-ec3ab169e4f3", runId: "r1", success: true },
      { ORGX_EMIT_EXECUTION_GRAPH: "1" },
    );
    assert.equal(res.emitted, true);
    assert.equal((posted as { source_client: string }).source_client, "openclaw");
  });

  test("a throwing client never propagates (run lifecycle must not fail)", async () => {
    const client = {
      emitExecutionGraph: async () => {
        throw new Error("network boom");
      },
    };
    const res = await maybeEmitRunExecutionGraph(
      client,
      { initiativeId: "i", success: true },
      { ORGX_EMIT_EXECUTION_GRAPH: "1" },
    );
    assert.equal(res.emitted, false);
    assert.equal(res.skipped, "emit_failed");
  });
});
