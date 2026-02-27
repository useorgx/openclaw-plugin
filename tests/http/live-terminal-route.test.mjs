import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { registerLiveTerminalRoutes } from "../../dist/http/routes/live-terminal.js";

test("live terminal route rejects parent directory traversal IDs", async () => {
  const configDir = mkdtempSync(join(tmpdir(), "orgx-live-terminal-"));
  const logsDir = join(configDir, "autopilot-logs");
  mkdirSync(logsDir, { recursive: true });
  writeFileSync(join(logsDir, "safe-run.log"), "ok\n", "utf8");

  const previous = process.env.ORGX_OPENCLAW_PLUGIN_CONFIG_DIR;
  process.env.ORGX_OPENCLAW_PLUGIN_CONFIG_DIR = configDir;

  const routes = new Map();
  const responses = [];

  const router = {
    add(method, path, handler) {
      routes.set(`${method}:${path}`, handler);
    },
  };

  const deps = {
    parseJsonRequest: async () => ({ runId: ".." }),
    sendJson: (_res, status, payload) => {
      responses.push({ status, payload });
    },
    safeErrorMessage: (err) => String(err),
  };

  try {
    registerLiveTerminalRoutes(router, deps);
    const handler = routes.get("POST:live/terminal/open");
    assert.equal(typeof handler, "function");

    await handler({ req: {}, res: {} });

    assert.equal(responses.length, 1);
    assert.equal(responses[0].status, 404);
    assert.match(String(responses[0].payload.error), /not found/i);
  } finally {
    if (previous == null) delete process.env.ORGX_OPENCLAW_PLUGIN_CONFIG_DIR;
    else process.env.ORGX_OPENCLAW_PLUGIN_CONFIG_DIR = previous;
  }
});

test("live terminal route rejects explicit absolute paths outside logs dir", async () => {
  const configDir = mkdtempSync(join(tmpdir(), "orgx-live-terminal-"));
  const logsDir = join(configDir, "autopilot-logs");
  mkdirSync(logsDir, { recursive: true });
  writeFileSync(join(logsDir, "safe-run.log"), "ok\n", "utf8");

  const outsidePath = join(configDir, "outside.log");
  writeFileSync(outsidePath, "nope\n", "utf8");

  const previous = process.env.ORGX_OPENCLAW_PLUGIN_CONFIG_DIR;
  process.env.ORGX_OPENCLAW_PLUGIN_CONFIG_DIR = configDir;

  const routes = new Map();
  const responses = [];

  const router = {
    add(method, path, handler) {
      routes.set(`${method}:${path}`, handler);
    },
  };

  const deps = {
    parseJsonRequest: async () => ({ logPath: outsidePath }),
    sendJson: (_res, status, payload) => {
      responses.push({ status, payload });
    },
    safeErrorMessage: (err) => String(err),
  };

  try {
    registerLiveTerminalRoutes(router, deps);
    const handler = routes.get("POST:live/terminal/open");
    assert.equal(typeof handler, "function");

    await handler({ req: {}, res: {} });

    assert.equal(responses.length, 1);
    assert.equal(responses[0].status, 404);
    assert.match(String(responses[0].payload.error), /not found/i);
  } finally {
    if (previous == null) delete process.env.ORGX_OPENCLAW_PLUGIN_CONFIG_DIR;
    else process.env.ORGX_OPENCLAW_PLUGIN_CONFIG_DIR = previous;
  }
});

test("live terminal route rejects slash-containing IDs instead of normalizing them", async () => {
  const configDir = mkdtempSync(join(tmpdir(), "orgx-live-terminal-"));
  const logsDir = join(configDir, "autopilot-logs");
  mkdirSync(logsDir, { recursive: true });
  writeFileSync(join(logsDir, "saferun.log"), "ok\n", "utf8");

  const previous = process.env.ORGX_OPENCLAW_PLUGIN_CONFIG_DIR;
  process.env.ORGX_OPENCLAW_PLUGIN_CONFIG_DIR = configDir;

  const routes = new Map();
  const responses = [];

  const router = {
    add(method, path, handler) {
      routes.set(`${method}:${path}`, handler);
    },
  };

  const deps = {
    parseJsonRequest: async () => ({ runId: "safe/run" }),
    sendJson: (_res, status, payload) => {
      responses.push({ status, payload });
    },
    safeErrorMessage: (err) => String(err),
  };

  try {
    registerLiveTerminalRoutes(router, deps);
    const handler = routes.get("POST:live/terminal/open");
    assert.equal(typeof handler, "function");

    await handler({ req: {}, res: {} });

    assert.equal(responses.length, 1);
    assert.equal(responses[0].status, 404);
    assert.match(String(responses[0].payload.error), /not found/i);
  } finally {
    if (previous == null) delete process.env.ORGX_OPENCLAW_PLUGIN_CONFIG_DIR;
    else process.env.ORGX_OPENCLAW_PLUGIN_CONFIG_DIR = previous;
  }
});

test("live terminal tail route returns last lines for a safe run log", async () => {
  const configDir = mkdtempSync(join(tmpdir(), "orgx-live-terminal-"));
  const logsDir = join(configDir, "autopilot-logs");
  mkdirSync(logsDir, { recursive: true });
  writeFileSync(join(logsDir, "tail-safe.log"), "line-1\nline-2\nline-3\n", "utf8");

  const previous = process.env.ORGX_OPENCLAW_PLUGIN_CONFIG_DIR;
  process.env.ORGX_OPENCLAW_PLUGIN_CONFIG_DIR = configDir;

  const routes = new Map();
  const responses = [];

  const router = {
    add(method, path, handler) {
      routes.set(`${method}:${path}`, handler);
    },
  };

  const deps = {
    parseJsonRequest: async () => ({}),
    sendJson: (_res, status, payload) => {
      responses.push({ status, payload });
    },
    safeErrorMessage: (err) => String(err),
  };

  try {
    registerLiveTerminalRoutes(router, deps);
    const handler = routes.get("GET:live/terminal/tail");
    assert.equal(typeof handler, "function");

    await handler({
      query: new URLSearchParams({ runId: "tail-safe", lines: "2" }),
      req: {},
      res: {},
    });

    assert.equal(responses.length, 1);
    assert.equal(responses[0].status, 200);
    assert.equal(responses[0].payload.ok, true);
    assert.equal(responses[0].payload.lines_requested, 2);
    assert.equal(responses[0].payload.line_count, 2);
    assert.equal(responses[0].payload.text, "line-2\nline-3");
    assert.match(String(responses[0].payload.path), /tail-safe\.log$/);
  } finally {
    if (previous == null) delete process.env.ORGX_OPENCLAW_PLUGIN_CONFIG_DIR;
    else process.env.ORGX_OPENCLAW_PLUGIN_CONFIG_DIR = previous;
  }
});

test("live terminal tail route rejects explicit paths outside logs dir", async () => {
  const configDir = mkdtempSync(join(tmpdir(), "orgx-live-terminal-"));
  const logsDir = join(configDir, "autopilot-logs");
  mkdirSync(logsDir, { recursive: true });
  writeFileSync(join(logsDir, "tail-safe.log"), "line-1\n", "utf8");
  const outsidePath = join(configDir, "outside.log");
  writeFileSync(outsidePath, "nope\n", "utf8");

  const previous = process.env.ORGX_OPENCLAW_PLUGIN_CONFIG_DIR;
  process.env.ORGX_OPENCLAW_PLUGIN_CONFIG_DIR = configDir;

  const routes = new Map();
  const responses = [];

  const router = {
    add(method, path, handler) {
      routes.set(`${method}:${path}`, handler);
    },
  };

  const deps = {
    parseJsonRequest: async () => ({}),
    sendJson: (_res, status, payload) => {
      responses.push({ status, payload });
    },
    safeErrorMessage: (err) => String(err),
  };

  try {
    registerLiveTerminalRoutes(router, deps);
    const handler = routes.get("GET:live/terminal/tail");
    assert.equal(typeof handler, "function");

    await handler({
      query: new URLSearchParams({ path: outsidePath }),
      req: {},
      res: {},
    });

    assert.equal(responses.length, 1);
    assert.equal(responses[0].status, 404);
    assert.match(String(responses[0].payload.error), /not found/i);
  } finally {
    if (previous == null) delete process.env.ORGX_OPENCLAW_PLUGIN_CONFIG_DIR;
    else process.env.ORGX_OPENCLAW_PLUGIN_CONFIG_DIR = previous;
  }
});
