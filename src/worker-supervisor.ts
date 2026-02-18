export type WorkerKillDecision =
  | { kill: false; elapsedMs: number; idleMs: number }
  | { kill: true; kind: "timeout" | "log_stall"; reason: string; elapsedMs: number; idleMs: number };

export type McpHandshakeFailure = {
  kind: "mcp_handshake";
  server: string | null;
  line: string | null;
};

function pickString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function parseIgnoredMcpServers(raw: string | undefined): Set<string> {
  if (typeof raw !== "string") return new Set(["codex_apps"]);
  const trimmed = raw.trim();
  if (!trimmed || trimmed.toLowerCase() === "none") return new Set();
  return new Set(
    trimmed
      .split(",")
      .map((entry) => entry.trim().toLowerCase())
      .filter(Boolean)
  );
}

function parseRequiredMcpServers(raw: string | undefined): Set<string> | null {
  // Default to OrgX-critical servers only. Most user-installed MCP servers are optional
  // for autopilot slices and should not hard-fail dispatch on handshake issues.
  if (typeof raw !== "string") return new Set(["orgx-openclaw", "orgx"]);
  const trimmed = raw.trim();
  if (!trimmed) return new Set(["orgx-openclaw", "orgx"]);
  if (trimmed.toLowerCase() === "all") return null;
  if (trimmed.toLowerCase() === "none") return new Set();
  return new Set(
    trimmed
      .split(",")
      .map((entry) => entry.trim().toLowerCase())
      .filter(Boolean)
  );
}

export function detectMcpHandshakeFailure(logText: unknown): McpHandshakeFailure | null {
  const text = String(logText ?? "");
  const lower = text.toLowerCase();
  const handshakeSignals = [
    "mcp startup failed",
    "handshaking with mcp server failed",
    "initialize response",
    "send message error transport",
  ];

  if (!handshakeSignals.some((needle) => lower.includes(needle))) {
    return null;
  }

  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const signalLine =
    lines.find((line) => /mcp startup failed|handshaking with mcp server failed/i.test(line)) ??
    lines.find((line) => /initialize response|send message error transport/i.test(line)) ??
    null;

  const serverMatch =
    signalLine?.match(/mcp(?:\s*:\s*)?\s*([a-z0-9_-]+)\s+failed:/i) ??
    signalLine?.match(/mcp client for\s+`?([^`]+)`?\s+failed to start/i) ??
    signalLine?.match(/mcp client for\s+\[?([^\]]+)\]?\s+failed to start/i) ??
    null;

  const server = serverMatch ? pickString(serverMatch[1]) ?? null : null;
  const ignoredServers = parseIgnoredMcpServers(process.env.ORGX_AUTOPILOT_MCP_HANDSHAKE_IGNORE_SERVERS);
  if (server && ignoredServers.has(server.toLowerCase())) {
    return null;
  }
  const requiredServers = parseRequiredMcpServers(
    process.env.ORGX_AUTOPILOT_MCP_HANDSHAKE_REQUIRED_SERVERS
  );
  if (
    server &&
    requiredServers &&
    (requiredServers.size === 0 || !requiredServers.has(server.toLowerCase()))
  ) {
    return null;
  }

  return {
    kind: "mcp_handshake",
    server,
    line: signalLine,
  };
}

export function shouldKillWorker(
  input: { nowEpochMs: number; startedAtEpochMs: number; logUpdatedAtEpochMs: number },
  limits: { timeoutMs: number; stallMs: number }
): WorkerKillDecision {
  const now = Number(input.nowEpochMs) || Date.now();
  const startedAt = Number(input.startedAtEpochMs) || now;
  const logUpdatedAt = Number(input.logUpdatedAtEpochMs) || startedAt;

  const elapsedMs = Math.max(0, now - startedAt);
  const idleMs = Math.max(0, now - logUpdatedAt);

  if (Number.isFinite(limits.timeoutMs) && limits.timeoutMs > 0 && elapsedMs > limits.timeoutMs) {
    return {
      kill: true,
      kind: "timeout",
      reason: `Worker exceeded timeout (${Math.round(limits.timeoutMs / 1_000)}s)`,
      elapsedMs,
      idleMs,
    };
  }

  if (Number.isFinite(limits.stallMs) && limits.stallMs > 0 && idleMs > limits.stallMs) {
    return {
      kill: true,
      kind: "log_stall",
      reason: `Worker log stalled (${Math.round(limits.stallMs / 1_000)}s)`,
      elapsedMs,
      idleMs,
    };
  }

  return { kill: false, elapsedMs, idleMs };
}
