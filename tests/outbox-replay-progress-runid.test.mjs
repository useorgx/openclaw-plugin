import test from "node:test";
import assert from "node:assert/strict";

async function importFreshModule() {
  const url = new URL("../dist/sync/outbox-replay.js", import.meta.url);
  url.searchParams.set("cacheBust", `${Date.now()}-${Math.random()}`);
  return import(url.href);
}

test("progress replay keeps run_id first and falls back to correlation_id on 404 run-not-found", async () => {
  const { createOutboxReplayer } = await importFreshModule();

  const calls = [];
  const runId = "00000000-0000-0000-0000-000000000111";
  const replayer = createOutboxReplayer({
    client: {
      emitActivity: async (payload) => {
        calls.push(payload);
        if (calls.length === 1) {
          throw new Error("404 Not Found: run not found");
        }
        return { ok: true, run_id: "run_1", event_id: null, reused_run: false };
      },
      applyChangeset: async () => ({ ok: true, run_id: "run_1", applied_count: 0, replayed: false }),
      recordRunOutcome: async () => ({ ok: true, run_id: "run_1", status: "recorded" }),
      recordRunRetro: async () => ({ ok: true, run_id: "run_1", accepted_count: 0 }),
      registerArtifact: async () => ({ ok: true, artifact: { id: "art_1" } }),
    },
    logger: {},
    toErrorMessage: (err) => (err instanceof Error ? err.message : String(err)),
    stableHash: () => "abcdef0123456789abcdef0123456789",
    resolveReportingContext: () => ({
      ok: true,
      value: {
        initiativeId: "11111111-1111-1111-1111-111111111111",
        runId,
        sourceClient: "openclaw",
      },
    }),
    pickStringField: (input, ...keys) => {
      for (const key of keys) {
        const value = input[key];
        if (typeof value === "string" && value.trim().length > 0) {
          return value.trim();
        }
      }
      return null;
    },
    pickStringArrayField: () => undefined,
    toReportingPhase: () => "execution",
    parseRetroEntityType: () => null,
    isUuid: (value) =>
      typeof value === "string" &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value),
    readOutboxReplayState: () => ({
      status: "idle",
      lastReplayAttemptAt: null,
      lastReplaySuccessAt: null,
      lastReplayFailureAt: null,
      lastReplayError: null,
    }),
    writeOutboxReplayState: () => {},
  });

  await replayer.replayOutboxEvent({
    id: "evt-1",
    type: "progress",
    timestamp: "2026-02-19T00:00:00.000Z",
    payload: {
      initiative_id: "11111111-1111-1111-1111-111111111111",
      run_id: runId,
      message: "replaying progress",
      phase: "execution",
    },
    activityItem: null,
  });

  assert.equal(calls.length, 2);
  assert.equal(calls[0].run_id, runId);
  assert.equal(calls[0].correlation_id, undefined);
  assert.equal(calls[1].run_id, undefined);
  assert.equal(calls[1].correlation_id, "openclaw_run_abcdef0123456789abcdef01");
});
