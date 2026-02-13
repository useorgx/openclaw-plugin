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
