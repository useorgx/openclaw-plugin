import test from "node:test";
import assert from "node:assert/strict";

import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function importFreshAuthStore() {
  const url = new URL("../dist/auth-store.js", import.meta.url);
  url.searchParams.set("t", `${Date.now()}-${Math.random()}`);
  return import(url.href);
}

function ensureMode600(filePath) {
  const mode = statSync(filePath).mode & 0o777;
  assert.equal(
    mode,
    0o600,
    `expected ${filePath} to have mode 0600, got ${mode.toString(8)}`
  );
}

test("auth store persists installation id + stores UUID userId for user-scoped oxk_ keys", async () => {
  const dir = mkdtempSync(join(tmpdir(), "orgx-openclaw-auth-"));
  const prevDir = process.env.ORGX_OPENCLAW_PLUGIN_CONFIG_DIR;
  process.env.ORGX_OPENCLAW_PLUGIN_CONFIG_DIR = dir;

  try {
    const mod = await importFreshAuthStore();

    const id1 = mod.resolveInstallationId();
    const id2 = mod.resolveInstallationId();
    assert.ok(id1 && String(id1).startsWith("ocw_"));
    assert.equal(id1, id2, "installation id should be stable");

    const installationRaw = readFileSync(join(dir, "installation.json"), "utf8");
    const installation = JSON.parse(installationRaw);
    assert.equal(installation.installationId, id1);
    ensureMode600(join(dir, "installation.json"));

    const saved = mod.saveAuthStore({
      installationId: id1,
      apiKey: "oxk_abcdef0123456789abcdef0123456789abcdef01".slice(0, 44),
      source: "manual",
      userId: "user_test_should_be_stripped",
      workspaceName: "Acme",
      keyPrefix: "oxk_deadbeef",
    });

    assert.equal(saved.installationId, id1);
    assert.equal(saved.userId, null, "non-UUID userId should be stripped for oxk_ keys");

    const loaded = mod.loadAuthStore();
    assert.ok(loaded);
    assert.equal(loaded.installationId, id1);
    assert.equal(loaded.userId, null);
    ensureMode600(join(dir, "auth.json"));

    const uuidUserId = "00000000-0000-4000-8000-000000000000";
    const savedUuid = mod.saveAuthStore({
      installationId: id1,
      apiKey: "oxk_abcdef0123456789abcdef0123456789abcdef01".slice(0, 44),
      source: "manual",
      userId: uuidUserId,
      workspaceName: "Acme",
      keyPrefix: "oxk_deadbeef",
    });
    assert.equal(savedUuid.userId, uuidUserId, "UUID userId should be preserved for oxk_ keys");

    const loadedUuid = mod.loadAuthStore();
    assert.ok(loadedUuid);
    assert.equal(loadedUuid.userId, uuidUserId);
  } finally {
    if (prevDir === undefined) {
      delete process.env.ORGX_OPENCLAW_PLUGIN_CONFIG_DIR;
    } else {
      process.env.ORGX_OPENCLAW_PLUGIN_CONFIG_DIR = prevDir;
    }
  }
});
