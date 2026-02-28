import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function importFreshOutbox() {
  const url = new URL("../dist/outbox.js", import.meta.url);
  url.searchParams.set("cacheBust", `${Date.now()}-${Math.random()}`);
  return import(url.href);
}

async function importFreshReplayModule() {
  const url = new URL("../dist/sync/outbox-replay.js", import.meta.url);
  url.searchParams.set("cacheBust", `${Date.now()}-${Math.random()}`);
  return import(url.href);
}

function sampleActivityItem(id = "evt-1") {
  return {
    id,
    type: "delegation",
    title: "Sample",
    description: null,
    agentId: null,
    agentName: null,
    runId: null,
    initiativeId: "11111111-1111-1111-1111-111111111111",
    timestamp: new Date().toISOString(),
    phase: "execution",
    summary: "Sample",
    metadata: {},
  };
}

test("flushOutboxQueues dead-letters repeatedly failing events after max failures", async () => {
  const originalHome = process.env.HOME;
  const originalMax = process.env.ORGX_OUTBOX_MAX_REPLAY_FAILURES;
  const home = mkdtempSync(join(tmpdir(), "orgx-outbox-replay-dead-letter-"));
  process.env.HOME = home;
  process.env.ORGX_OUTBOX_MAX_REPLAY_FAILURES = "2";

  try {
    const outbox = await importFreshOutbox();
    await outbox.appendToOutbox("queue-1", {
      id: "evt-progress-1",
      type: "progress",
      timestamp: new Date().toISOString(),
      payload: {
        initiative_id: "11111111-1111-1111-1111-111111111111",
        message: "replay me",
      },
      activityItem: sampleActivityItem("evt-progress-1"),
    });

    const { createOutboxReplayer } = await importFreshReplayModule();
    let calls = 0;
    const infoLogs = [];
    const replayer = createOutboxReplayer({
      client: {
        emitActivity: async () => {
          calls += 1;
          throw new Error("503 temporary upstream failure");
        },
        applyChangeset: async () => ({ ok: true }),
        recordRunOutcome: async () => ({ ok: true }),
        recordRunRetro: async () => ({ ok: true }),
      },
      logger: {
        info: (_msg, meta) => infoLogs.push(meta ?? {}),
      },
      toErrorMessage: (err) => (err instanceof Error ? err.message : String(err)),
      stableHash: () => "abcdef0123456789abcdef0123456789",
      resolveReportingContext: () => ({
        ok: true,
        value: {
          initiativeId: "11111111-1111-1111-1111-111111111111",
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

    await replayer.flushOutboxQueues();
    let pending = await outbox.readOutbox("queue-1");
    assert.equal(pending.length, 1);
    assert.equal(pending[0].replayFailures, 1);

    await replayer.flushOutboxQueues();
    pending = await outbox.readOutbox("queue-1");
    assert.deepEqual(pending, []);
    assert.equal(calls, 2);
    const replayLog = infoLogs.filter((entry) => entry?.queue === "queue-1").at(-1);
    assert.equal(replayLog?.replayed, 0);
    assert.equal(replayLog?.dropped, 0);
    assert.equal(replayLog?.deadLettered, 1);
    assert.equal(replayLog?.failed, 0);
    assert.equal(replayLog?.remaining, 0);

    const deadLetterPath = join(
      home,
      ".openclaw",
      "orgx-outbox",
      "_dead-letter",
      "queue-1.jsonl"
    );
    const content = readFileSync(deadLetterPath, "utf8");
    assert.ok(content.includes("max_replay_failures"));
  } finally {
    process.env.HOME = originalHome;
    if (originalMax == null) {
      delete process.env.ORGX_OUTBOX_MAX_REPLAY_FAILURES;
    } else {
      process.env.ORGX_OUTBOX_MAX_REPLAY_FAILURES = originalMax;
    }
  }
});

test("flushOutboxQueues logs processed counters for failed replay attempts", async () => {
  const originalHome = process.env.HOME;
  const originalMax = process.env.ORGX_OUTBOX_MAX_REPLAY_FAILURES;
  const home = mkdtempSync(join(tmpdir(), "orgx-outbox-replay-observability-"));
  process.env.HOME = home;
  process.env.ORGX_OUTBOX_MAX_REPLAY_FAILURES = "3";

  try {
    const outbox = await importFreshOutbox();
    await outbox.appendToOutbox("queue-obs", {
      id: "evt-progress-observability",
      type: "progress",
      timestamp: new Date().toISOString(),
      payload: {
        initiative_id: "11111111-1111-1111-1111-111111111111",
        message: "replay me",
      },
      activityItem: sampleActivityItem("evt-progress-observability"),
    });

    const infoCalls = [];
    const { createOutboxReplayer } = await importFreshReplayModule();
    const replayer = createOutboxReplayer({
      client: {
        emitActivity: async () => {
          throw new Error("503 temporary upstream failure");
        },
        applyChangeset: async () => ({ ok: true }),
        recordRunOutcome: async () => ({ ok: true }),
        recordRunRetro: async () => ({ ok: true }),
      },
      logger: {
        info: (msg, meta) => {
          infoCalls.push({ msg, meta });
        },
      },
      toErrorMessage: (err) => (err instanceof Error ? err.message : String(err)),
      stableHash: () => "abcdef0123456789abcdef0123456789",
      resolveReportingContext: () => ({
        ok: true,
        value: {
          initiativeId: "11111111-1111-1111-1111-111111111111",
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

    await replayer.flushOutboxQueues();

    assert.equal(infoCalls.length, 1);
    assert.equal(infoCalls[0].msg, "[orgx] Processed buffered outbox events");
    assert.deepEqual(infoCalls[0].meta, {
      queue: "queue-obs",
      pending: 1,
      replayed: 0,
      dropped: 0,
      deadLettered: 0,
      failed: 1,
      remaining: 1,
    });
  } finally {
    process.env.HOME = originalHome;
    if (originalMax == null) {
      delete process.env.ORGX_OUTBOX_MAX_REPLAY_FAILURES;
    } else {
      process.env.ORGX_OUTBOX_MAX_REPLAY_FAILURES = originalMax;
    }
  }
});
