import test from "node:test";
import assert from "node:assert/strict";

test("local client configuration includes gateway authentication without changing hosted credentials", async () => {
  const mod = await importFreshModule();
  const input = { current: { mcpServers: { orgx: { url: 'https://mcp.useorgx.com/mcp' } } }, localMcpUrl: 'http://127.0.0.1:18789/orgx/mcp', gatewayToken: 'SYNTHETIC_GATEWAY_CONFIG' };
  for (const patch of [mod.patchClaudeMcpConfig, mod.patchCursorMcpConfig]) {
    const result = patch(input);
    assert.equal(result.next.mcpServers['orgx-openclaw'].headers.Authorization, 'Bearer SYNTHETIC_GATEWAY_CONFIG');
    assert.equal(result.next.mcpServers.orgx.headers, undefined);
  }
  const codex = mod.patchCodexConfigToml({ current: '', localMcpUrl: input.localMcpUrl, gatewayToken: input.gatewayToken });
  assert.match(codex.next, /http_headers = \{ Authorization = "Bearer SYNTHETIC_GATEWAY_CONFIG" \}/);
  assert.equal(mod.patchCodexConfigToml({ current: codex.next, localMcpUrl: input.localMcpUrl, gatewayToken: input.gatewayToken }).updated, false);
});

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
  assert.equal(patched.next.mcpServers.orgx.url, "https://mcp.useorgx.com/mcp?profile=v2");
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
  assert.ok(patched.next.includes('url = "https://mcp.useorgx.com/mcp?profile=v2"'), "should have url for hosted orgx");
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
  assert.ok(patched.next.includes('url = "https://mcp.useorgx.com/mcp?profile=v2"'));
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

test("patchCodexConfigToml updates local and cleans single-quoted keys while preserving custom endpoints", async () => {
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
  assert.ok(patched.next.includes("url = 'https://old.example.invalid/mcp'"));
  assert.ok(
    patched.next.includes('[mcp_servers."orgx-openclaw"]') ||
      patched.next.includes("[mcp_servers.'orgx-openclaw']"),
    "local orgx-openclaw header should exist"
  );
  assert.ok(patched.next.includes(`url = "${local}"`));
  assert.ok(patched.next.includes("old.example.invalid"), "custom endpoint should remain unchanged");
  assert.ok(!patched.next.includes("127.0.0.1:9999/old"), "stale local URL should be replaced");
  assert.ok(!patched.next.includes(legacyScoped), "single-quoted scoped entry should be removed");
});

test("Codex repair preserves a custom hosted profile and headers", async () => {
  const { patchCodexConfigToml } = await importFreshModule();
  const current = [
    '[mcp_servers.orgx]',
    'url = "https://mcp.useorgx.com/mcp?profile=commander" # existing connection',
    'oauth_resource = "https://mcp.useorgx.com/mcp"',
    '',
    '[mcp_servers.orgx.http_headers]',
    '"x-orgx-tool-profile" = "commander"',
    '',
  ].join('\n');
  const patched = patchCodexConfigToml({ current, localMcpUrl: 'http://127.0.0.1:18789/orgx/mcp' });
  assert.ok(patched.next.includes('url = "https://mcp.useorgx.com/mcp?profile=commander" # existing connection'));
  assert.ok(patched.next.includes('"x-orgx-tool-profile" = "commander"'));
  assert.ok(patched.next.includes('[mcp_servers."orgx-openclaw"]'));
  assert.equal(patchCodexConfigToml({ current: patched.next, localMcpUrl: 'http://127.0.0.1:18789/orgx/mcp' }).updated, false);
});

test("Claude local-to-hosted migration keeps every local credential only on the local entry", async () => {
  const { patchClaudeMcpConfig } = await importFreshModule();
  const localMcpUrl = 'http://127.0.0.1:18789/orgx/mcp';
  const current = { mcpServers: { orgx: {
    type: 'http', url: localMcpUrl,
    headers: { authorization: 'Bearer SYNTHETIC_OLD_LOCAL', Cookie: 'SYNTHETIC_LOCAL_COOKIE' },
    http_headers: { AUTHORIZATION: 'Bearer SYNTHETIC_LOCAL_HEADER' },
  } } };
  const migrated = patchClaudeMcpConfig({ current, localMcpUrl });
  assert.equal(migrated.next.mcpServers.orgx.url, 'https://mcp.useorgx.com/mcp?profile=v2');
  assert.doesNotMatch(JSON.stringify(migrated.next.mcpServers.orgx), /SYNTHETIC_/);
  assert.deepEqual(migrated.next.mcpServers['orgx-openclaw'].headers, current.mcpServers.orgx.headers);
  assert.deepEqual(migrated.next.mcpServers['orgx-openclaw'].http_headers, current.mcpServers.orgx.http_headers);
  assert.equal(patchClaudeMcpConfig({ current: migrated.next, localMcpUrl }).updated, false);

  const rotated = patchClaudeMcpConfig({ current, localMcpUrl, gatewayToken: 'SYNTHETIC_NEW_LOCAL' });
  assert.equal(rotated.next.mcpServers['orgx-openclaw'].headers.Authorization, 'Bearer SYNTHETIC_NEW_LOCAL');
  assert.doesNotMatch(JSON.stringify(rotated.next.mcpServers.orgx), /SYNTHETIC_/);
});

test("local configuration repair preserves genuine existing hosted OAuth headers", async () => {
  const { patchClaudeMcpConfig, patchCodexConfigToml } = await importFreshModule();
  const localMcpUrl = 'http://127.0.0.1:18789/orgx/mcp';
  const hostedUrl = 'https://mcp.useorgx.com/mcp?profile=commander';
  const hosted = { type: 'http', url: hostedUrl, headers: { AUTHORIZATION: 'Bearer SYNTHETIC_HOSTED_OAUTH' } };
  const claude = patchClaudeMcpConfig({ current: { mcpServers: { orgx: hosted } }, localMcpUrl, gatewayToken: 'SYNTHETIC_LOCAL' });
  assert.deepEqual(claude.next.mcpServers.orgx, hosted);
  const current = `[mcp_servers.orgx]\nurl = "${hostedUrl}"\n[mcp_servers.orgx.http_headers]\nAUTHORIZATION = "Bearer SYNTHETIC_HOSTED_OAUTH"\n`;
  const codex = patchCodexConfigToml({ current, localMcpUrl, gatewayToken: 'SYNTHETIC_LOCAL' });
  assert.ok(codex.next.startsWith(current));
  assert.equal(patchCodexConfigToml({ current: codex.next, localMcpUrl, gatewayToken: 'SYNTHETIC_LOCAL' }).updated, false);
});

test("Codex local-to-hosted migration isolates inline and nested credentials and preserves local authentication", async () => {
  const { patchCodexConfigToml } = await importFreshModule();
  const localMcpUrl = 'http://127.0.0.1:18789/orgx/mcp';
  for (const headers of [
    'http_headers = { authorization = "Bearer SYNTHETIC_OLD_LOCAL" }\n',
    '  [mcp_servers.orgx."http_headers"] # local credentials\n  "AUTHORIZATION" = "Bearer SYNTHETIC_OLD_LOCAL"\n',
  ]) {
    const current = `[mcp_servers.orgx] # local proxy\n"url" = "${localMcpUrl}"\nbearer_token_env_var = "SYNTHETIC_LOCAL_ENV"\n${headers}`;
    const migrated = patchCodexConfigToml({ current, localMcpUrl });
    const hosted = migrated.next.slice(migrated.next.indexOf('[mcp_servers.orgx]'));
    assert.match(hosted, /url = "https:\/\/mcp.useorgx.com\/mcp\?profile=v2"/);
    assert.doesNotMatch(hosted, /SYNTHETIC_/);
    assert.match(migrated.next, /Bearer SYNTHETIC_OLD_LOCAL/);
    assert.equal(patchCodexConfigToml({ current: migrated.next, localMcpUrl }).updated, false);

    const rotated = patchCodexConfigToml({ current, localMcpUrl, gatewayToken: 'SYNTHETIC_NEW_LOCAL' });
    assert.match(rotated.next, /Bearer SYNTHETIC_NEW_LOCAL/);
    assert.doesNotMatch(rotated.next, /Bearer SYNTHETIC_OLD_LOCAL/);
    assert.doesNotMatch(rotated.next.slice(rotated.next.indexOf('[mcp_servers.orgx]')), /SYNTHETIC_/);
    if (headers.includes('[mcp_servers.')) {
      assert.doesNotMatch(rotated.next, /http_headers\s*=\s*\{/);
    }
    assert.equal(patchCodexConfigToml({ current: rotated.next, localMcpUrl, gatewayToken: 'SYNTHETIC_NEW_LOCAL' }).updated, false);
  }
});

test("Codex migration preserves an existing authenticated local entry while removing old local orgx credentials", async () => {
  const { patchCodexConfigToml } = await importFreshModule();
  const localMcpUrl = 'http://127.0.0.1:18789/orgx/mcp';
  const current = `[mcp_servers.orgx]\nurl = "${localMcpUrl}"\n[mcp_servers.orgx.http_headers]\nAuthorization = "Bearer SYNTHETIC_OLD_LOCAL"\n[mcp_servers."orgx-openclaw"]\nurl = "${localMcpUrl}"\nhttp_headers = { Authorization = "Bearer SYNTHETIC_CURRENT_LOCAL" }\n`;
  const migrated = patchCodexConfigToml({ current, localMcpUrl });
  assert.doesNotMatch(migrated.next, /SYNTHETIC_OLD_LOCAL/);
  assert.match(migrated.next, /SYNTHETIC_CURRENT_LOCAL/);
  assert.doesNotMatch(migrated.next.slice(migrated.next.indexOf('[mcp_servers.orgx]')), /SYNTHETIC_/);
  assert.equal(patchCodexConfigToml({ current: migrated.next, localMcpUrl }).updated, false);
});

test("local-to-hosted migration recognizes a stale loopback port without forwarding its credentials", async () => {
  const { patchClaudeMcpConfig, patchCodexConfigToml } = await importFreshModule();
  const localMcpUrl = 'http://127.0.0.1:19001/orgx/mcp';
  const priorUrl = 'http://localhost:18789/orgx/mcp';
  const claude = patchClaudeMcpConfig({ current: { mcpServers: { orgx: {
    type: 'http', url: priorUrl, headers: { Authorization: 'Bearer SYNTHETIC_LOCAL' },
  } } }, localMcpUrl });
  assert.equal(claude.next.mcpServers.orgx.url, 'https://mcp.useorgx.com/mcp?profile=v2');
  assert.equal(claude.next.mcpServers['orgx-openclaw'].url, localMcpUrl);
  assert.equal(claude.next.mcpServers['orgx-openclaw'].headers.Authorization, 'Bearer SYNTHETIC_LOCAL');
  assert.doesNotMatch(JSON.stringify(claude.next.mcpServers.orgx), /SYNTHETIC_LOCAL/);
  const codex = patchCodexConfigToml({ current: `[mcp_servers.orgx]\nurl = "${priorUrl}"\nhttp_headers = { Authorization = "Bearer SYNTHETIC_LOCAL" }\n`, localMcpUrl });
  assert.doesNotMatch(codex.next.slice(codex.next.indexOf('[mcp_servers.orgx]')), /SYNTHETIC_LOCAL/);
  assert.match(codex.next, /url = "http:\/\/127.0.0.1:19001\/orgx\/mcp"/);
  assert.match(codex.next, /SYNTHETIC_LOCAL/);
});

test("Codex repair preserves custom endpoint and credential-bearing stdio authority", async () => {
  const { patchCodexConfigToml } = await importFreshModule();
  const localMcpUrl = 'http://127.0.0.1:18789/orgx/mcp';
  for (const current of [
    '[mcp_servers.orgx]\nurl = "https://custom.example.invalid/mcp"\nhttp_headers = { Authorization = "Bearer SYNTHETIC_CUSTOM" }\n',
    '[mcp_servers.orgx]\ncommand = "custom-mcp"\nhttp_headers = { Authorization = "Bearer SYNTHETIC_CUSTOM" }\n',
    '[mcp_servers.orgx]\ncommand = "custom-mcp"\n[mcp_servers.orgx.http_headers]\nAuthorization = "Bearer SYNTHETIC_CUSTOM"\n',
  ]) {
    const repaired = patchCodexConfigToml({ current, localMcpUrl, gatewayToken: 'SYNTHETIC_LOCAL' });
    assert.ok(repaired.next.startsWith(current));
    assert.doesNotMatch(repaired.next, /https:\/\/mcp.useorgx.com/);
    assert.match(repaired.next, /SYNTHETIC_LOCAL/);
    assert.equal(patchCodexConfigToml({ current: repaired.next, localMcpUrl, gatewayToken: 'SYNTHETIC_LOCAL' }).updated, false);
  }
});
