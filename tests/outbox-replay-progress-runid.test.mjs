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

test("retro replay normalizes structured retro payload before submit", async () => {
  const { createOutboxReplayer } = await importFreshModule();
  const longSummary = `  ${"s".repeat(4505)}  `;
  const longListItem = ` ${"w".repeat(1200)} `;
  const longTitle = ` ${"t".repeat(700)} `;
  const longReason = ` ${"r".repeat(2300)} `;

  const retroCalls = [];
  const replayer = createOutboxReplayer({
    client: {
      emitActivity: async () => ({ ok: true, run_id: "run_1", event_id: null, reused_run: false }),
      applyChangeset: async () => ({ ok: true, run_id: "run_1", applied_count: 0, replayed: false }),
      recordRunOutcome: async () => ({ ok: true, run_id: "run_1", status: "recorded" }),
      recordRunRetro: async (payload) => {
        retroCalls.push(payload);
        return { ok: true, run_id: "run_1", accepted_count: 1 };
      },
      registerArtifact: async () => ({ ok: true, artifact: { id: "art_1" } }),
    },
    logger: {},
    toErrorMessage: (err) => (err instanceof Error ? err.message : String(err)),
    stableHash: () => "abcdef0123456789abcdef0123456789",
    resolveReportingContext: () => ({
      ok: true,
      value: {
        initiativeId: "11111111-1111-1111-1111-111111111111",
        runId: "00000000-0000-0000-0000-000000000222",
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
    parseRetroEntityType: () => "task",
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
    id: "evt-retro",
    type: "retro",
    timestamp: "2026-02-19T00:00:00.000Z",
    payload: {
      initiative_id: "11111111-1111-1111-1111-111111111111",
      entity_type: "task",
      entity_id: "22222222-2222-2222-2222-222222222222",
      retro: {
        summary: longSummary,
        whatWentWell: [" shipped ", "", 42, longListItem],
        whatWentWrong: [" flaky test ", null],
        keyDecisions: [" merge fix ", " "],
        followUps: [
          { title: " tighten schema ", priority: "P0", reason: "  prevents drift " },
          { title: longTitle, reason: longReason },
          { title: "  " },
          "invalid",
        ],
        signals: { retries: 2 },
      },
    },
    activityItem: null,
  });

  assert.equal(retroCalls.length, 1);
  const sent = retroCalls[0];
  assert.equal(sent.entity_type, "task");
  assert.equal(sent.entity_id, "22222222-2222-2222-2222-222222222222");
  assert.equal(sent.retro.summary.length, 4000);
  assert.equal(sent.retro.follow_ups[1].title.length, 500);
  assert.equal(sent.retro.follow_ups[1].reason.length, 2000);
  assert.equal(sent.retro.what_went_well[1].length, 1000);
  assert.deepEqual(sent.retro, {
    schema_version: "retro.v1",
    summary: "s".repeat(4000),
    what_went_well: ["shipped", "w".repeat(1000)],
    what_went_wrong: ["flaky test"],
    decisions: ["merge fix"],
    follow_ups: [
      { title: "tighten schema", priority: "p0", reason: "prevents drift" },
      { title: "t".repeat(500), reason: "r".repeat(2000) },
    ],
    signals: { retries: 2 },
  });
});
