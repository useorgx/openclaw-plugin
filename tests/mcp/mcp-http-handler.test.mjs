import test from "node:test";
import assert from "node:assert/strict";

async function importFreshModule() {
  const url = new URL("../../dist/mcp-http-handler.js", import.meta.url);
  url.searchParams.set("t", `${Date.now()}-${Math.random()}`);
  return import(url.href);
}

function createMockResponse() {
  const state = {
    status: null,
    headers: null,
    body: null,
  };

  return {
    state,
    res: {
      writeHead(status, headers = {}) {
        state.status = status;
        state.headers = headers;
      },
      end(body) {
        state.body = body ?? null;
      },
    },
  };
}

test("initialize responds with serverInfo and tools capability", async () => {
  const mod = await importFreshModule();
  const tools = new Map();
  const handler = mod.createMcpHttpHandler({
    tools,
    serverName: "orgx-local",
    serverVersion: "0.0.0",
  });

  const req = {
    method: "POST",
    url: "/orgx/mcp",
    headers: {},
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2024-11-05" },
    }),
  };
  const mock = createMockResponse();
  const handled = await handler(req, mock.res);
  assert.equal(handled, true);
  assert.equal(mock.state.status, 200);

  const payload = JSON.parse(mock.state.body);
  assert.equal(payload.jsonrpc, "2.0");
  assert.equal(payload.id, 1);
  assert.equal(payload.result.serverInfo.name, "orgx-local");
  assert.equal(payload.result.serverInfo.version, "0.0.0");
  assert.ok(payload.result.capabilities);
  assert.ok(payload.result.capabilities.tools);
});

test("tools/list returns registered tools", async () => {
  const mod = await importFreshModule();
  const tools = new Map();
  tools.set("orgx_status", {
    name: "orgx_status",
    description: "status",
    parameters: { type: "object", properties: {} },
    async execute() {
      return { content: [{ type: "text", text: "ok" }] };
    },
  });

  const handler = mod.createMcpHttpHandler({
    tools,
    serverName: "orgx-local",
    serverVersion: "0.0.0",
  });

  const req = {
    method: "POST",
    url: "/orgx/mcp",
    headers: {},
    body: JSON.stringify({ jsonrpc: "2.0", id: "t1", method: "tools/list", params: {} }),
  };
  const mock = createMockResponse();
  await handler(req, mock.res);
  assert.equal(mock.state.status, 200);

  const payload = JSON.parse(mock.state.body);
  assert.equal(payload.id, "t1");
  assert.equal(payload.result.tools.length, 1);
  assert.equal(payload.result.tools[0].name, "orgx_status");
  assert.equal(payload.result.tools[0].description, "status");
  assert.deepEqual(payload.result.tools[0].inputSchema, { type: "object", properties: {} });
});

test("tools/call executes tool and returns content", async () => {
  const mod = await importFreshModule();
  const tools = new Map();
  tools.set("echo", {
    name: "echo",
    description: "echo",
    parameters: { type: "object", properties: { text: { type: "string" } } },
    async execute(_callId, params = {}) {
      return {
        content: [{ type: "text", text: `echo:${params.text ?? ""}` }],
      };
    },
  });

  const handler = mod.createMcpHttpHandler({
    tools,
    serverName: "orgx-local",
    serverVersion: "0.0.0",
  });

  const req = {
    method: "POST",
    url: "/orgx/mcp",
    headers: {},
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 9,
      method: "tools/call",
      params: { name: "echo", arguments: { text: "hi" } },
    }),
  };
  const mock = createMockResponse();
  await handler(req, mock.res);
  assert.equal(mock.state.status, 200);

  const payload = JSON.parse(mock.state.body);
  assert.equal(payload.id, 9);
  assert.equal(payload.result.isError, false);
  assert.equal(payload.result.content[0].type, "text");
  assert.equal(payload.result.content[0].text, "echo:hi");
});

test("notifications do not produce a JSON-RPC response", async () => {
  const mod = await importFreshModule();
  const tools = new Map();
  const handler = mod.createMcpHttpHandler({
    tools,
    serverName: "orgx-local",
    serverVersion: "0.0.0",
  });

  const req = {
    method: "POST",
    url: "/orgx/mcp",
    headers: {},
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }),
  };
  const mock = createMockResponse();
  await handler(req, mock.res);
  assert.equal(mock.state.status, 204);
});

