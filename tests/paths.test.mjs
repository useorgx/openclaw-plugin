import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

async function importFreshPaths() {
  const url = new URL("../dist/paths.js", import.meta.url);
  url.searchParams.set("t", `${Date.now()}-${Math.random()}`);
  return import(url.href);
}

function restoreEnv(key, value) {
  if (value === undefined) {
    delete process.env[key];
    return;
  }
  process.env[key] = value;
}

test("paths uses defaults under HOME when no overrides are set", async () => {
  const originalHome = process.env.HOME;
  const originalPluginDir = process.env.ORGX_OPENCLAW_PLUGIN_CONFIG_DIR;
  const originalOpenClawHome = process.env.OPENCLAW_HOME;
  const originalOutboxDir = process.env.ORGX_OUTBOX_DIR;

  const home = mkdtempSync(join(tmpdir(), "orgx-paths-defaults-"));
  process.env.HOME = home;
  delete process.env.ORGX_OPENCLAW_PLUGIN_CONFIG_DIR;
  delete process.env.OPENCLAW_HOME;
  delete process.env.ORGX_OUTBOX_DIR;

  try {
    const paths = await importFreshPaths();
    assert.equal(
      paths.getOrgxPluginConfigDir(),
      join(home, ".config", "useorgx", "openclaw-plugin")
    );
    assert.equal(paths.getOpenClawDir(), join(home, ".openclaw"));
    assert.equal(paths.getOrgxOutboxDir(), join(home, ".openclaw", "orgx-outbox"));
  } finally {
    restoreEnv("HOME", originalHome);
    restoreEnv("ORGX_OPENCLAW_PLUGIN_CONFIG_DIR", originalPluginDir);
    restoreEnv("OPENCLAW_HOME", originalOpenClawHome);
    restoreEnv("ORGX_OUTBOX_DIR", originalOutboxDir);
  }
});

test("paths ignore blank overrides and resolve valid relative overrides", async () => {
  const originalHome = process.env.HOME;
  const originalPluginDir = process.env.ORGX_OPENCLAW_PLUGIN_CONFIG_DIR;
  const originalOpenClawHome = process.env.OPENCLAW_HOME;
  const originalOutboxDir = process.env.ORGX_OUTBOX_DIR;

  const home = mkdtempSync(join(tmpdir(), "orgx-paths-overrides-"));
  process.env.HOME = home;

  try {
    const paths = await importFreshPaths();

    process.env.ORGX_OPENCLAW_PLUGIN_CONFIG_DIR = "   ";
    assert.equal(
      paths.getOrgxPluginConfigDir(),
      join(home, ".config", "useorgx", "openclaw-plugin")
    );

    process.env.OPENCLAW_HOME = " ./openclaw-custom ";
    assert.equal(paths.getOpenClawDir(), resolve("./openclaw-custom"));

    process.env.ORGX_OUTBOX_DIR = " ./tmp-outbox ";
    assert.equal(paths.getOrgxOutboxDir(), resolve("./tmp-outbox"));

    process.env.OPENCLAW_HOME = ' "./quoted-openclaw" ';
    assert.equal(paths.getOpenClawDir(), resolve("./quoted-openclaw"));

    process.env.ORGX_OUTBOX_DIR = " './quoted-outbox' ";
    assert.equal(paths.getOrgxOutboxDir(), resolve("./quoted-outbox"));

    process.env.ORGX_OPENCLAW_PLUGIN_CONFIG_DIR = "\\0bad-path";
    assert.equal(
      paths.getOrgxPluginConfigDir(),
      join(home, ".config", "useorgx", "openclaw-plugin")
    );
  } finally {
    restoreEnv("HOME", originalHome);
    restoreEnv("ORGX_OPENCLAW_PLUGIN_CONFIG_DIR", originalPluginDir);
    restoreEnv("OPENCLAW_HOME", originalOpenClawHome);
    restoreEnv("ORGX_OUTBOX_DIR", originalOutboxDir);
  }
});

test("paths reject control-character and null-byte-like overrides", async () => {
  const originalHome = process.env.HOME;
  const originalPluginDir = process.env.ORGX_OPENCLAW_PLUGIN_CONFIG_DIR;
  const originalOpenClawHome = process.env.OPENCLAW_HOME;
  const originalOutboxDir = process.env.ORGX_OUTBOX_DIR;

  const home = mkdtempSync(join(tmpdir(), "orgx-paths-null-byte-"));
  process.env.HOME = home;
  process.env.ORGX_OPENCLAW_PLUGIN_CONFIG_DIR = "bad\\0path";
  process.env.OPENCLAW_HOME = "bad\\x00openclaw";
  process.env.ORGX_OUTBOX_DIR = "bad%00outbox";

  try {
    const paths = await importFreshPaths();
    assert.equal(
      paths.getOrgxPluginConfigDir(),
      join(home, ".config", "useorgx", "openclaw-plugin")
    );
    assert.equal(paths.getOpenClawDir(), join(home, ".openclaw"));
    assert.equal(paths.getOrgxOutboxDir(), join(home, ".openclaw", "orgx-outbox"));
  } finally {
    restoreEnv("HOME", originalHome);
    restoreEnv("ORGX_OPENCLAW_PLUGIN_CONFIG_DIR", originalPluginDir);
    restoreEnv("OPENCLAW_HOME", originalOpenClawHome);
    restoreEnv("ORGX_OUTBOX_DIR", originalOutboxDir);
  }
});

test("paths ignore overrides that become empty after quote normalization", async () => {
  const originalHome = process.env.HOME;
  const originalPluginDir = process.env.ORGX_OPENCLAW_PLUGIN_CONFIG_DIR;
  const originalOpenClawHome = process.env.OPENCLAW_HOME;
  const originalOutboxDir = process.env.ORGX_OUTBOX_DIR;

  const home = mkdtempSync(join(tmpdir(), "orgx-paths-quoted-empty-"));
  process.env.HOME = home;
  process.env.ORGX_OPENCLAW_PLUGIN_CONFIG_DIR = ' "   " ';
  process.env.OPENCLAW_HOME = " '\n' ";
  process.env.ORGX_OUTBOX_DIR = " '   ' ";

  try {
    const paths = await importFreshPaths();
    assert.equal(
      paths.getOrgxPluginConfigDir(),
      join(home, ".config", "useorgx", "openclaw-plugin")
    );
    assert.equal(paths.getOpenClawDir(), join(home, ".openclaw"));
    assert.equal(paths.getOrgxOutboxDir(), join(home, ".openclaw", "orgx-outbox"));
  } finally {
    restoreEnv("HOME", originalHome);
    restoreEnv("ORGX_OPENCLAW_PLUGIN_CONFIG_DIR", originalPluginDir);
    restoreEnv("OPENCLAW_HOME", originalOpenClawHome);
    restoreEnv("ORGX_OUTBOX_DIR", originalOutboxDir);
  }
});

test("paths expand leading tilde in overrides", async () => {
  const originalHome = process.env.HOME;
  const originalPluginDir = process.env.ORGX_OPENCLAW_PLUGIN_CONFIG_DIR;
  const originalOpenClawHome = process.env.OPENCLAW_HOME;
  const originalOutboxDir = process.env.ORGX_OUTBOX_DIR;

  const home = mkdtempSync(join(tmpdir(), "orgx-paths-tilde-"));
  process.env.HOME = home;
  process.env.ORGX_OPENCLAW_PLUGIN_CONFIG_DIR = "~/.orgx-plugin-config";
  process.env.OPENCLAW_HOME = "~/.openclaw-alt";
  process.env.ORGX_OUTBOX_DIR = "~/orgx-outbox-alt";

  try {
    const paths = await importFreshPaths();
    assert.equal(paths.getOrgxPluginConfigDir(), join(home, ".orgx-plugin-config"));
    assert.equal(paths.getOpenClawDir(), join(home, ".openclaw-alt"));
    assert.equal(paths.getOrgxOutboxDir(), join(home, "orgx-outbox-alt"));
  } finally {
    restoreEnv("HOME", originalHome);
    restoreEnv("ORGX_OPENCLAW_PLUGIN_CONFIG_DIR", originalPluginDir);
    restoreEnv("OPENCLAW_HOME", originalOpenClawHome);
    restoreEnv("ORGX_OUTBOX_DIR", originalOutboxDir);
  }
});

test("paths expand Windows-style tilde prefixes in overrides", async () => {
  const originalHome = process.env.HOME;
  const originalPluginDir = process.env.ORGX_OPENCLAW_PLUGIN_CONFIG_DIR;
  const originalOpenClawHome = process.env.OPENCLAW_HOME;
  const originalOutboxDir = process.env.ORGX_OUTBOX_DIR;

  const home = mkdtempSync(join(tmpdir(), "orgx-paths-tilde-win-"));
  process.env.HOME = home;
  process.env.ORGX_OPENCLAW_PLUGIN_CONFIG_DIR = "~\\orgx-plugin-config-win";
  process.env.OPENCLAW_HOME = "~\\openclaw-alt-win";
  process.env.ORGX_OUTBOX_DIR = "~\\orgx-outbox-alt-win";

  try {
    const paths = await importFreshPaths();
    assert.equal(paths.getOrgxPluginConfigDir(), join(home, "orgx-plugin-config-win"));
    assert.equal(paths.getOpenClawDir(), join(home, "openclaw-alt-win"));
    assert.equal(paths.getOrgxOutboxDir(), join(home, "orgx-outbox-alt-win"));
  } finally {
    restoreEnv("HOME", originalHome);
    restoreEnv("ORGX_OPENCLAW_PLUGIN_CONFIG_DIR", originalPluginDir);
    restoreEnv("OPENCLAW_HOME", originalOpenClawHome);
    restoreEnv("ORGX_OUTBOX_DIR", originalOutboxDir);
  }
});
