import test from "node:test";
import assert from "node:assert/strict";

async function importFreshModule() {
  const url = new URL("../dist/reporting/outbox-replay.js", import.meta.url);
  url.searchParams.set("cacheBust", `${Date.now()}-${Math.random()}`);
  return import(url.href);
}

test("extractProgressOutboxMessage prefers message", async () => {
  const mod = await importFreshModule();
  const msg = mod.extractProgressOutboxMessage({
    message: " hello ",
    summary: "fallback",
  });
  assert.equal(msg, "hello");
});

test("extractProgressOutboxMessage falls back to summary", async () => {
  const mod = await importFreshModule();
  const msg = mod.extractProgressOutboxMessage({
    summary: " legacy ",
  });
  assert.equal(msg, "legacy");
});

test("extractProgressOutboxMessage returns null when empty", async () => {
  const mod = await importFreshModule();
  assert.equal(mod.extractProgressOutboxMessage({}), null);
  assert.equal(mod.extractProgressOutboxMessage({ message: "  " }), null);
  assert.equal(mod.extractProgressOutboxMessage({ summary: "" }), null);
});

