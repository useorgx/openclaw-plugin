import test from "node:test";
import assert from "node:assert/strict";

import { mkdtempSync, writeFileSync, readdirSync, mkdirSync } from "node:fs";
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
