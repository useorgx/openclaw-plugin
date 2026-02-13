import { randomUUID } from "node:crypto";

export type Logger = {
  info?: (message: string, meta?: Record<string, unknown>) => void;
  warn?: (message: string, meta?: Record<string, unknown>) => void;
  debug?: (message: string, meta?: Record<string, unknown>) => void;
};

export interface PluginRequest {
  method?: string;
  url?: string;
  headers: Record<string, string | string[] | undefined>;
  body?: unknown;
  on?: (event: string, listener: (...args: unknown[]) => void) => void;
  once?: (event: string, listener: (...args: unknown[]) => void) => void;
}

export interface PluginResponse {
  writeHead(status: number, headers?: Record<string, string>): void;
  end(body?: string | Buffer): void;
  write?(chunk: string | Buffer): boolean | void;
  writableEnded?: boolean;
}

export type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

export type RegisteredTool = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (callId: string, params?: unknown) => Promise<ToolResult>;
};

type PromptRole = "system" | "user" | "assistant";
type PromptMessage = { role: PromptRole; content: string };

export type RegisteredPrompt = {
  name: string;
  description?: string;
  arguments?: Array<{
    name: string;
    description?: string;
    required?: boolean;
  }>;
  messages: PromptMessage[];
};

const DEFAULT_PROTOCOL_VERSION = "2024-11-05";

type JsonRpcId = string | number | null;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function sendJson(res: PluginResponse, status: number, payload: unknown): void {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(payload));
}

function sendText(res: PluginResponse, status: number, body: string): void {
  res.writeHead(status, {
    "content-type": "text/plain; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(body);
}

function jsonRpcError(id: JsonRpcId, code: number, message: string): Record<string, unknown> {
  return {
    jsonrpc: "2.0",
    id,
    error: {
      code,
      message,
    },
  };
}

function jsonRpcResult(id: JsonRpcId, result: unknown): Record<string, unknown> {
  return {
    jsonrpc: "2.0",
    id,
    result,
  };
}

function normalizePath(rawUrl: string): string {
  const [path] = rawUrl.split("?", 2);
  return path || "/";
}

async function readRequestBodyBuffer(req: PluginRequest): Promise<Buffer> {
  const body = req.body;
  if (typeof body === "string") return Buffer.from(body, "utf8");
  if (Buffer.isBuffer(body)) return body;
  if (body instanceof Uint8Array) return Buffer.from(body);
  if (body instanceof ArrayBuffer) return Buffer.from(body);
  if (body && typeof body === "object" && !Buffer.isBuffer(body)) {
    try {
      return Buffer.from(JSON.stringify(body), "utf8");
    } catch {
      return Buffer.from("", "utf8");
    }
  }

  if (typeof req.on !== "function") return Buffer.from("", "utf8");

  return await new Promise((resolve) => {
    const chunks: Buffer[] = [];
    const onData = (chunk: unknown) => {
      if (typeof chunk === "string") {
        chunks.push(Buffer.from(chunk, "utf8"));
      } else if (Buffer.isBuffer(chunk)) {
        chunks.push(chunk);
      } else if (chunk instanceof Uint8Array) {
        chunks.push(Buffer.from(chunk));
      }
    };
    const onEnd = () => resolve(Buffer.concat(chunks));
    const onError = () => resolve(Buffer.concat(chunks));

    req.on?.("data", onData);
    req.on?.("end", onEnd);
    req.on?.("error", onError);
  });
}

async function parseJsonBody(req: PluginRequest): Promise<unknown> {
  const buffer = await readRequestBodyBuffer(req);
  if (!buffer || buffer.length === 0) return null;
  try {
    return JSON.parse(buffer.toString("utf8"));
  } catch {
    return null;
  }
}

function pickId(value: unknown): JsonRpcId {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (value === null) return null;
  return null;
}

function normalizeToolArguments(value: unknown): Record<string, unknown> {
  if (isRecord(value)) return value;
  return {};
}

function buildToolsList(tools: Map<string, RegisteredTool>): Array<Record<string, unknown>> {
  const entries = Array.from(tools.values())
    .map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.parameters,
    }))
    .sort((a, b) => String(a.name).localeCompare(String(b.name)));
  return entries;
}

async function handleRpcMessage(input: {
  message: unknown;
  tools: Map<string, RegisteredTool>;
  prompts: Map<string, RegisteredPrompt>;
  logger: Logger;
  serverName: string;
  serverVersion: string;
}): Promise<Record<string, unknown> | null> {
  const msg = input.message;
  if (!isRecord(msg)) {
    return jsonRpcError(null, -32600, "Invalid Request");
  }

  const id = pickId(msg.id);
  const method = typeof msg.method === "string" ? msg.method.trim() : "";
  if (!method) {
    return jsonRpcError(id, -32600, "Invalid Request");
  }

  const params = isRecord(msg.params) ? msg.params : {};

  // Notifications do not receive a response.
  if (id === null && method.startsWith("notifications/")) {
    return null;
  }

  if (method === "initialize") {
    const requestedProtocol = typeof params.protocolVersion === "string" ? params.protocolVersion : null;
    const protocolVersion = requestedProtocol?.trim() || DEFAULT_PROTOCOL_VERSION;
    return jsonRpcResult(id, {
      protocolVersion,
      capabilities: {
        tools: {},
        prompts: {},
      },
      serverInfo: {
        name: input.serverName,
        version: input.serverVersion,
      },
    });
  }

  if (method === "ping") {
    return jsonRpcResult(id, { ok: true });
  }

  if (method === "tools/list") {
    return jsonRpcResult(id, {
      tools: buildToolsList(input.tools),
    });
  }

  if (method === "tools/call") {
    const toolName = typeof params.name === "string" ? params.name.trim() : "";
    if (!toolName) {
      return jsonRpcError(id, -32602, "Missing tool name");
    }

    const tool = input.tools.get(toolName) ?? null;
    if (!tool) {
      return jsonRpcError(id, -32601, `Tool not found: ${toolName}`);
    }

    const args = normalizeToolArguments(params.arguments);
    try {
      const callId = `mcp-${id ?? randomUUID()}`;
      const result = await tool.execute(callId, args);
      return jsonRpcResult(id, {
        content: Array.isArray(result?.content) ? result.content : [],
        isError: result?.isError === true,
      });
    } catch (err: unknown) {
      input.logger.warn?.("[orgx] Local MCP tool call failed", {
        tool: toolName,
        error: err instanceof Error ? err.message : String(err),
      });
      return jsonRpcResult(id, {
        content: [
          {
            type: "text",
            text: `❌ Tool execution failed: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        isError: true,
      });
    }
  }

  if (method === "resources/list") {
    return jsonRpcResult(id, { resources: [] });
  }

  if (method === "prompts/list") {
    const prompts = Array.from(input.prompts.values())
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((prompt) => ({
        name: prompt.name,
        description: prompt.description ?? "",
        arguments: Array.isArray(prompt.arguments) ? prompt.arguments : [],
      }));
    return jsonRpcResult(id, { prompts });
  }

  if (method === "prompts/get") {
    const promptName = typeof params.name === "string" ? params.name.trim() : "";
    if (!promptName) {
      return jsonRpcError(id, -32602, "Missing prompt name");
    }

    const prompt = input.prompts.get(promptName) ?? null;
    if (!prompt) {
      return jsonRpcError(id, -32601, `Prompt not found: ${promptName}`);
    }

    return jsonRpcResult(id, {
      description: prompt.description ?? "",
      messages: prompt.messages,
    });
  }

  if (method.startsWith("notifications/")) {
    return null;
  }

  return jsonRpcError(id, -32601, `Method not found: ${method}`);
}

export function createMcpHttpHandler(input: {
  tools: Map<string, RegisteredTool>;
  prompts?: Map<string, RegisteredPrompt>;
  logger?: Logger;
  serverName: string;
  serverVersion: string;
}): (req: PluginRequest, res: PluginResponse) => Promise<boolean> {
  const logger = input.logger ?? {};
  const prompts = input.prompts ?? new Map<string, RegisteredPrompt>();

  return async function handler(req: PluginRequest, res: PluginResponse): Promise<boolean> {
    const method = (req.method ?? "GET").toUpperCase();
    const rawUrl = req.url ?? "/";
    const url = normalizePath(rawUrl);

    if (!(url === "/orgx/mcp" || url.startsWith("/orgx/mcp/"))) {
      return false;
    }

    if (method === "OPTIONS") {
      res.writeHead(204, {
        "cache-control": "no-store",
      });
      res.end();
      return true;
    }

    if (method === "GET") {
      sendText(res, 200, "OrgX Local MCP bridge is running.\n");
      return true;
    }

    if (method !== "POST") {
      sendJson(res, 405, {
        error: "Use POST /orgx/mcp",
      });
      return true;
    }

    const payload = await parseJsonBody(req);
    if (!payload) {
      sendJson(res, 400, {
        error: "Invalid JSON body",
      });
      return true;
    }

    const messages = Array.isArray(payload) ? payload : [payload];
    const responses: Array<Record<string, unknown>> = [];

    for (const message of messages) {
      const response = await handleRpcMessage({
        message,
        tools: input.tools,
        prompts,
        logger,
        serverName: input.serverName,
        serverVersion: input.serverVersion,
      });
      if (response) responses.push(response);
    }

    if (responses.length === 0) {
      res.writeHead(204, {
        "cache-control": "no-store",
      });
      res.end();
      return true;
    }

    sendJson(res, 200, Array.isArray(payload) ? responses : responses[0]);
    return true;
  };
}
