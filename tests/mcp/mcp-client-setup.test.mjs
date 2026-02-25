import test from "node:test";
import assert from "node:assert/strict";

async function importFreshModule() {
  const url = new URL("../../dist/mcp-client-setup.js", import.meta.url);
  url.searchParams.set("t", `${Date.now()}-${Math.random()}`);
  return import(url.href);
}

test("patchClaudeMcpConfig adds orgx-openclaw entry without overwriting orgx", async () => {
  const mod = await importFreshModule();
  const local = "http://127.0.0.1:18789/orgx/mcp";
  const current = {
    mcpServers: {
      orgx: {
        type: "http",
        url: "https://mcp.useorgx.com/mcp",
        description: "OrgX cloud",
      },
    },
  };

  const patched = mod.patchClaudeMcpConfig({ current, localMcpUrl: local });
  assert.equal(patched.updated, true);
  assert.equal(patched.next.mcpServers.orgx.url, "https://mcp.useorgx.com/mcp");
  assert.equal(patched.next.mcpServers["orgx-openclaw"].url, local);
  assert.equal(patched.next.mcpServers["orgx-openclaw"].type, "http");
});

test("patchClaudeMcpConfig migrates orgx from local proxy to hosted and keeps orgx-openclaw", async () => {
  const mod = await importFreshModule();
  const local = "http://127.0.0.1:18789/orgx/mcp";
  const current = {
    mcpServers: {
      orgx: {
        type: "http",
        url: local,
      },
    },
  };

  const patched = mod.patchClaudeMcpConfig({ current, localMcpUrl: local });
  assert.equal(patched.updated, true);
  assert.equal(patched.next.mcpServers.orgx.url, "https://mcp.useorgx.com/mcp");
  assert.equal(patched.next.mcpServers["orgx-openclaw"].url, local);
});

test("patchClaudeMcpConfig removes stale scoped entries", async () => {
  const mod = await importFreshModule();
  const local = "http://127.0.0.1:18789/orgx/mcp";
  const legacyScopedA = "orgx-openclaw-legacy-alpha";
  const legacyScopedB = "orgx-openclaw-legacy-beta";
  const current = {
    mcpServers: {
      orgx: { type: "http", url: "https://mcp.useorgx.com/mcp" },
      "orgx-openclaw": { type: "http", url: local },
      [legacyScopedA]: { type: "http", url: `${local}/alpha` },
      [legacyScopedB]: { type: "http", url: `${local}/beta` },
    },
  };

  const patched = mod.patchClaudeMcpConfig({ current, localMcpUrl: local });
  assert.equal(patched.updated, true);
  assert.ok(!(legacyScopedA in patched.next.mcpServers), "scoped entry should be removed");
  assert.ok(!(legacyScopedB in patched.next.mcpServers), "scoped entry should be removed");
  assert.ok("orgx-openclaw" in patched.next.mcpServers, "base entry should remain");
  assert.ok("orgx" in patched.next.mcpServers, "hosted entry should remain");
});

test("patchCursorMcpConfig adds orgx-openclaw entry", async () => {
  const mod = await importFreshModule();
  const local = "http://127.0.0.1:18789/orgx/mcp";
  const current = {
    mcpServers: {
      "orgx-production": {
        command: "npx",
        args: ["mcp-remote", "https://mcp.useorgx.com/sse"],
      },
    },
  };

  const patched = mod.patchCursorMcpConfig({ current, localMcpUrl: local });
  assert.equal(patched.updated, true);
  assert.equal(patched.next.mcpServers["orgx-openclaw"].url, local);
  assert.equal(patched.next.mcpServers["orgx-production"].args[1], "https://mcp.useorgx.com/sse");
});

test("patchCursorMcpConfig removes stale scoped entries", async () => {
  const mod = await importFreshModule();
  const local = "http://127.0.0.1:18789/orgx/mcp";
  const legacyScopedA = "orgx-openclaw-legacy-alpha";
  const legacyScopedB = "orgx-openclaw-legacy-beta";
  const current = {
    mcpServers: {
      "orgx-openclaw": { url: local },
      [legacyScopedA]: { url: `${local}/alpha` },
      [legacyScopedB]: { url: `${local}/beta` },
    },
  };

  const patched = mod.patchCursorMcpConfig({ current, localMcpUrl: local });
  assert.equal(patched.updated, true);
  assert.ok(!(legacyScopedA in patched.next.mcpServers));
  assert.ok(!(legacyScopedB in patched.next.mcpServers));
  assert.ok("orgx-openclaw" in patched.next.mcpServers);
});

test("patchCodexConfigToml adds orgx-openclaw section without overwriting orgx", async () => {
  const mod = await importFreshModule();
  const local = "http://127.0.0.1:18789/orgx/mcp";
  const current = [
    'model = "gpt-5.3-codex"',
    "",
    "[mcp_servers.orgx]",
    'url = "https://mcp.useorgx.com/mcp"',
    "",
  ].join("\n");

  const patched = mod.patchCodexConfigToml({ current, localMcpUrl: local });
  assert.equal(patched.updated, true);
  assert.ok(patched.next.includes('[mcp_servers."orgx-openclaw"]'));
  assert.ok(patched.next.includes(`url = "https://mcp.useorgx.com/mcp"`));
  assert.ok(patched.next.includes(`url = "${local}"`));
});

test("patchCodexConfigToml strips stale stdio fields (command, args, startup_timeout_sec)", async () => {
  const mod = await importFreshModule();
  const local = "http://127.0.0.1:18789/orgx/mcp";
  const current = [
    'model = "gpt-5.3-codex"',
    "",
    "[mcp_servers.orgx]",
    'url = "https://mcp.useorgx.com/mcp"',
    "",
    '[mcp_servers."orgx-openclaw"]',
    `url = "${local}"`,
    'command = "npx"',
    'args = ["-y", "mcp-remote", "http://127.0.0.1:18789/orgx/mcp"]',
    "startup_timeout_sec = 60.0",
    "",
  ].join("\n");

  const patched = mod.patchCodexConfigToml({ current, localMcpUrl: local });
  assert.equal(patched.updated, true);
  assert.ok(patched.next.includes(`url = "${local}"`));
  assert.ok(!patched.next.includes("command ="), "command field should be stripped");
  assert.ok(!patched.next.includes("args ="), "args field should be stripped");
  assert.ok(!patched.next.includes("startup_timeout_sec ="), "startup_timeout_sec field should be stripped");
});

test("patchCodexConfigToml converts hosted orgx from mcp-remote stdio to direct url", async () => {
  const mod = await importFreshModule();
  const local = "http://127.0.0.1:18789/orgx/mcp";
  const current = [
    'model = "gpt-5.3-codex"',
    "",
    "[mcp_servers.orgx]",
    'command = "npx"',
    'args = ["-y", "mcp-remote", "https://mcp.useorgx.com/mcp"]',
    "startup_timeout_sec = 60.0",
    "",
  ].join("\n");

  const patched = mod.patchCodexConfigToml({ current, localMcpUrl: local });
  assert.equal(patched.updated, true);
  assert.ok(patched.next.includes('url = "https://mcp.useorgx.com/mcp"'), "should have url for hosted orgx");
  // stdio fields should be stripped from the orgx section
  const lines = patched.next.split("\n");
  const orgxHeaderIdx = lines.findIndex((l) => /^\[mcp_servers\.(?:"orgx"|orgx)\]/.test(l.trim()));
  assert.ok(orgxHeaderIdx >= 0, "orgx header should exist");
  let nextSectionIdx = lines.length;
  for (let i = orgxHeaderIdx + 1; i < lines.length; i++) {
    if (lines[i].trim().startsWith("[")) { nextSectionIdx = i; break; }
  }
  const orgxSection = lines.slice(orgxHeaderIdx, nextSectionIdx).join("\n");
  assert.ok(!orgxSection.includes("command ="), "command should be stripped from orgx section");
  assert.ok(!orgxSection.includes("args ="), "args should be stripped from orgx section");
  assert.ok(!orgxSection.includes("startup_timeout_sec ="), "startup_timeout_sec should be stripped from orgx section");
});

test("patchCodexConfigToml adds hosted orgx and local orgx-openclaw entries when missing", async () => {
  const mod = await importFreshModule();
  const local = "http://127.0.0.1:18789/orgx/mcp";
  const current = ['model = "gpt-5.3-codex"', ""].join("\n");

  const patched = mod.patchCodexConfigToml({ current, localMcpUrl: local });
  assert.equal(patched.updated, true);
  assert.ok(patched.next.includes("[mcp_servers.orgx]"));
  assert.ok(patched.next.includes('url = "https://mcp.useorgx.com/mcp"'));
  assert.ok(patched.next.includes('[mcp_servers."orgx-openclaw"]'));
  assert.ok(patched.next.includes(`url = "${local}"`));
  // Should NOT contain any scoped entries
  assert.ok(!patched.next.includes("orgx-openclaw-legacy-alpha"), "should not create scoped entries");
  assert.ok(!patched.next.includes("orgx-openclaw-legacy-beta"), "should not create scoped entries");
});

test("patchCodexConfigToml removes stale scoped entries", async () => {
  const mod = await importFreshModule();
  const local = "http://127.0.0.1:18789/orgx/mcp";
  const legacyScopedA = "orgx-openclaw-legacy-alpha";
  const legacyScopedB = "orgx-openclaw-legacy-beta";
  const current = [
    'model = "gpt-5.3-codex"',
    "",
    "[mcp_servers.orgx]",
    'url = "https://mcp.useorgx.com/mcp"',
    "",
    '[mcp_servers."orgx-openclaw"]',
    `url = "${local}"`,
    "",
    `[mcp_servers."${legacyScopedA}"]`,
    `url = "${local}/alpha"`,
    "",
    `[mcp_servers."${legacyScopedB}"]`,
    `url = "${local}/beta"`,
    "",
  ].join("\n");

  const patched = mod.patchCodexConfigToml({ current, localMcpUrl: local });
  assert.equal(patched.updated, true);
  assert.ok(patched.next.includes("[mcp_servers.orgx]"), "hosted entry should remain");
  assert.ok(patched.next.includes('[mcp_servers."orgx-openclaw"]'), "base entry should remain");
  assert.ok(!patched.next.includes(legacyScopedA), "scoped entry should be removed");
  assert.ok(!patched.next.includes(legacyScopedB), "scoped entry should be removed");
});

test("patchCodexConfigToml updates and cleans single-quoted table keys", async () => {
  const mod = await importFreshModule();
  const local = "http://127.0.0.1:18789/orgx/mcp";
  const legacyScoped = "orgx-openclaw-legacy-single";
  const current = [
    "model = 'gpt-5.3-codex'",
    "",
    "[mcp_servers.'orgx']",
    "url = 'https://old.example.invalid/mcp'",
    "",
    "[mcp_servers.'orgx-openclaw']",
    "url = 'http://127.0.0.1:9999/old'",
    "",
    `[mcp_servers.'${legacyScoped}']`,
    "url = 'http://127.0.0.1:9999/old-legacy'",
    "",
  ].join("\n");

  const patched = mod.patchCodexConfigToml({ current, localMcpUrl: local });
  assert.equal(patched.updated, true);
  assert.ok(
    patched.next.includes("[mcp_servers.orgx]") || patched.next.includes("[mcp_servers.'orgx']"),
    "hosted orgx header should exist"
  );
  assert.ok(patched.next.includes('url = "https://mcp.useorgx.com/mcp"'));
  assert.ok(
    patched.next.includes('[mcp_servers."orgx-openclaw"]') ||
      patched.next.includes("[mcp_servers.'orgx-openclaw']"),
    "local orgx-openclaw header should exist"
  );
  assert.ok(patched.next.includes(`url = "${local}"`));
  assert.ok(!patched.next.includes("old.example.invalid"), "stale hosted URL should be replaced");
  assert.ok(!patched.next.includes("127.0.0.1:9999/old"), "stale local URL should be replaced");
  assert.ok(!patched.next.includes(legacyScoped), "single-quoted scoped entry should be removed");
});
