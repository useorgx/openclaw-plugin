import test from "node:test";
import assert from "node:assert/strict";

import { mkdtempSync, writeFileSync, readdirSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function importFreshOutbox() {
  const url = new URL("../dist/outbox.js", import.meta.url);
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
    initiativeId: null,
    timestamp: new Date().toISOString(),
    phase: "execution",
    summary: "Sample",
    metadata: {},
  };
}

test("appendToOutbox dedupes events by id", async () => {
  const originalHome = process.env.HOME;
  const home = mkdtempSync(join(tmpdir(), "orgx-outbox-test-"));
  process.env.HOME = home;

  try {
    const outbox = await importFreshOutbox();

    await outbox.appendToOutbox("queue-1", {
      id: "evt-1",
      type: "progress",
      timestamp: new Date().toISOString(),
      payload: { summary: "first" },
      activityItem: sampleActivityItem("evt-1"),
    });

    await outbox.appendToOutbox("queue-1", {
      id: "evt-1",
      type: "progress",
      timestamp: new Date().toISOString(),
      payload: { summary: "second" },
      activityItem: sampleActivityItem("evt-1"),
    });

    const events = await outbox.readOutbox("queue-1");
    assert.equal(events.length, 1);
    assert.equal(events[0].payload.summary, "second");
  } finally {
    process.env.HOME = originalHome;
  }
});

test("readOutbox backs up corrupted JSON file and returns empty list", async () => {
  const originalHome = process.env.HOME;
  const home = mkdtempSync(join(tmpdir(), "orgx-outbox-corrupt-test-"));
  process.env.HOME = home;

  try {
    const outboxDir = join(home, ".openclaw", "orgx-outbox");
    const filePath = join(outboxDir, "queue-1.json");
    mkdirSync(outboxDir, { recursive: true });
    // Create a corrupted outbox file.
    writeFileSync(filePath, "{ this is not json", { encoding: "utf8" });

    const outbox = await importFreshOutbox();
    const events = await outbox.readOutbox("queue-1");
    assert.deepEqual(events, []);

    const files = readdirSync(outboxDir);
    assert.equal(files.includes("queue-1.json"), false);
    assert.ok(
      files.some((name) => name.startsWith("queue-1.json.corrupt.")),
      "expected corrupt backup to exist"
    );
  } finally {
    process.env.HOME = originalHome;
  }
});

test("replaceOutbox([]) deletes the queue file", async () => {
  const originalHome = process.env.HOME;
  const home = mkdtempSync(join(tmpdir(), "orgx-outbox-replace-test-"));
  process.env.HOME = home;

  try {
    const outbox = await importFreshOutbox();
    await outbox.appendToOutbox("queue-1", {
      id: "evt-1",
      type: "progress",
      timestamp: new Date().toISOString(),
      payload: { summary: "first" },
      activityItem: sampleActivityItem("evt-1"),
    });

    await outbox.replaceOutbox("queue-1", []);
    const events = await outbox.readOutbox("queue-1");
    assert.deepEqual(events, []);
  } finally {
    process.env.HOME = originalHome;
  }
});

test("appendToOutbox suppresses synthetic artifact events and writes dead-letter", async () => {
  const originalHome = process.env.HOME;
  const home = mkdtempSync(join(tmpdir(), "orgx-outbox-suppress-test-"));
  process.env.HOME = home;

  try {
    const outbox = await importFreshOutbox();
    await outbox.appendToOutbox("init-1", {
      id: "evt-art-1",
      type: "artifact",
      timestamp: new Date().toISOString(),
      payload: {
        entity_type: "initiative",
        entity_id: "init-1",
        name: "Mock deliverable",
        artifact_type: "document",
      },
      activityItem: sampleActivityItem("evt-art-1"),
    });

    const events = await outbox.readOutbox("init-1");
    assert.deepEqual(events, []);

    const deadLetterDir = join(home, ".openclaw", "orgx-outbox", "_dead-letter");
    const files = readdirSync(deadLetterDir);
    assert.ok(files.some((name) => name === "init-1.jsonl"));
    const content = readFileSync(join(deadLetterDir, "init-1.jsonl"), "utf8");
    assert.ok(content.includes("suppressed_on_append:synthetic_artifact_entity_id"));
  } finally {
    process.env.HOME = originalHome;
  }
});

test("readOutbox prunes legacy synthetic events and keeps replayable events", async () => {
  const originalHome = process.env.HOME;
  const home = mkdtempSync(join(tmpdir(), "orgx-outbox-prune-test-"));
  process.env.HOME = home;

  try {
    const outboxDir = join(home, ".openclaw", "orgx-outbox");
    mkdirSync(outboxDir, { recursive: true });
    const queuePath = join(outboxDir, "queue-1.json");
    const now = new Date().toISOString();
    writeFileSync(
      queuePath,
      JSON.stringify([
        {
          id: "bad-1",
          type: "artifact",
          timestamp: now,
          payload: {
            entity_type: "initiative",
            entity_id: "init-1",
            name: "Mock deliverable",
            artifact_type: "document",
          },
          activityItem: sampleActivityItem("bad-1"),
        },
        {
          id: "good-1",
          type: "progress",
          timestamp: now,
          payload: { message: "ok" },
          activityItem: sampleActivityItem("good-1"),
        },
      ]),
      { encoding: "utf8" }
    );

    const outbox = await importFreshOutbox();
    const events = await outbox.readOutbox("queue-1");
    assert.equal(events.length, 1);
    assert.equal(events[0].id, "good-1");

    const deadLetterPath = join(home, ".openclaw", "orgx-outbox", "_dead-letter", "queue-1.jsonl");
    const deadLetter = readFileSync(deadLetterPath, "utf8");
    assert.ok(deadLetter.includes("pruned_on_read:synthetic_artifact_entity_id"));
  } finally {
    process.env.HOME = originalHome;
  }
});
