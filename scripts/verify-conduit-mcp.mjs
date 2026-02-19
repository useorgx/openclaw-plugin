#!/usr/bin/env node

import process from "node:process";

function parseArgs(argv) {
  const args = {
    statusUrl: process.env.CONDUIT_STATUS_URL ?? "http://127.0.0.1:3055/status",
    timeoutMs: Number(process.env.CONDUIT_VERIFY_TIMEOUT_MS ?? 8000),
    requireChannel: process.env.CONDUIT_REQUIRE_CHANNEL === "1",
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--status-url") args.statusUrl = argv[++i];
    else if (arg === "--timeout-ms") args.timeoutMs = Number(argv[++i]);
    else if (arg === "--require-channel") args.requireChannel = true;
  }

  if (!Number.isFinite(args.timeoutMs) || args.timeoutMs <= 0) {
    throw new Error("timeout must be a positive number");
  }
  if (!args.statusUrl) {
    throw new Error("status-url is required");
  }
  return args;
}

function extractChannelId(payload) {
  if (!payload || typeof payload !== "object") return null;
  const map = payload;
  const direct =
    map.channelId ??
    map.channel_id ??
    map.channel ??
    map.activeChannel ??
    map.active_channel ??
    null;
  if (typeof direct === "string" && direct.trim().length > 0) {
    return direct.trim();
  }

  if (Array.isArray(map.channels)) {
    for (const entry of map.channels) {
      if (!entry || typeof entry !== "object") continue;
      const candidate = entry.channel ?? entry.channelId ?? entry.channel_id ?? null;
      if (typeof candidate === "string" && candidate.trim().length > 0) {
        return candidate.trim();
      }
    }
  }

  return null;
}

async function fetchStatus(statusUrl, timeoutMs) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(statusUrl, { signal: ac.signal });
    const raw = await res.text();
    let json = null;
    try {
      json = JSON.parse(raw);
    } catch {
      // Some Conduit builds return plain text; keep raw for diagnostics.
    }
    return { ok: res.ok, status: res.status, raw, json };
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const status = await fetchStatus(args.statusUrl, args.timeoutMs);

  if (!status.ok) {
    throw new Error(
      `status check failed (${status.status}) at ${args.statusUrl}: ${status.raw.slice(0, 300)}`
    );
  }

  if (args.requireChannel) {
    const channelId = extractChannelId(status.json);
    if (!channelId || typeof channelId !== "string" || channelId.trim().length === 0) {
      throw new Error(
        "Conduit status is reachable but no channel ID is available. Connect the Figma plugin first."
      );
    }
  }

  const result = {
    ok: true,
    statusUrl: args.statusUrl,
    httpStatus: status.status,
    requireChannel: args.requireChannel,
    channelId: extractChannelId(status.json),
    statusBody: status.json ?? status.raw,
  };
  console.log(JSON.stringify(result, null, 2));
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`[verify-conduit-mcp] failed: ${message}`);
  process.exit(1);
});
