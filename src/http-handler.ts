/**
 * HTTP Handler — Serves the React dashboard SPA and API proxy endpoints.
 *
 * Registered at the `/orgx` prefix. Handles:
 *   /orgx/live           → dashboard SPA (index.html)
 *   /orgx/live/assets/*  → static assets (JS, CSS, images)
 *   /orgx/api/status     → org status summary
 *   /orgx/api/agents     → agent states
 *   /orgx/api/activity   → activity feed
 *   /orgx/api/initiatives → initiative data
 *   /orgx/api/health     → plugin diagnostics + outbox/sync status
 *   /orgx/api/onboarding → onboarding / config state
 *   /orgx/api/delegation/preflight → delegation preflight
 *   /orgx/api/runs/:id/checkpoints → list/create checkpoints
 *   /orgx/api/runs/:id/checkpoints/:checkpointId/restore → restore checkpoint
 *   /orgx/api/runs/:id/actions/:action → run control action
 */

import { readFileSync, existsSync } from "node:fs";
import { join, extname, normalize, resolve, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";

import type { OrgXClient } from "./api.js";
import type {
  OnboardingState,
  OrgXConfig,
  OrgSnapshot,
  Entity,
  LiveActivityItem,
  SessionTreeResponse,
  HandoffSummary,
} from "./types.js";
import {
  formatStatus,
  formatAgents,
  formatActivity,
  formatInitiatives,
  getOnboardingState,
} from "./dashboard-api.js";
import {
  loadLocalOpenClawSnapshot,
  loadLocalTurnDetail,
  toLocalLiveActivity,
  toLocalLiveAgents,
  toLocalLiveInitiatives,
  toLocalSessionTree,
} from "./local-openclaw.js";
import { readAllOutboxItems, readOutboxSummary } from "./outbox.js";
import { readAgentContexts, upsertAgentContext } from "./agent-context-store.js";
import type { AgentLaunchContext } from "./agent-context-store.js";

// =============================================================================
// Helpers
// =============================================================================

function safeErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  return "Unexpected error";
}

function isUserScopedApiKey(apiKey: string): boolean {
  return apiKey.trim().toLowerCase().startsWith("oxk_");
}

function parseJsonSafe<T>(value: string): T | null {
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

async function runCommandCollect(input: {
  command: string;
  args: string[];
  timeoutMs?: number;
}): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  const timeoutMs = input.timeoutMs ?? 10_000;
  return await new Promise((resolve, reject) => {
    const child = spawn(input.command, input.args, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = timeoutMs
      ? setTimeout(() => {
          try {
            child.kill("SIGKILL");
          } catch {
            // best effort
          }
          reject(new Error(`Command timed out after ${timeoutMs}ms`));
        }, timeoutMs)
      : null;

    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve({ stdout, stderr, exitCode: typeof code === "number" ? code : null });
    });
  });
}

async function listOpenClawAgents(): Promise<Array<Record<string, unknown>>> {
  const result = await runCommandCollect({
    command: "openclaw",
    args: ["agents", "list", "--json"],
    timeoutMs: 5_000,
  });
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.trim() || "openclaw agents list failed");
  }
  const parsed = parseJsonSafe<unknown>(result.stdout);
  if (!Array.isArray(parsed)) {
    throw new Error("openclaw agents list returned invalid JSON");
  }
  return parsed.filter((entry): entry is Record<string, unknown> => Boolean(entry && typeof entry === "object"));
}

function spawnOpenClawAgentTurn(input: {
  agentId: string;
  sessionId: string;
  message: string;
  thinking?: string | null;
}): { pid: number | null } {
  const args = [
    "agent",
    "--agent",
    input.agentId,
    "--session-id",
    input.sessionId,
    "--message",
    input.message,
  ];
  if (input.thinking) {
    args.push("--thinking", input.thinking);
  }

  const child = spawn("openclaw", args, {
    stdio: "ignore",
    detached: true,
  });
  child.unref();
  return { pid: child.pid ?? null };
}

function getScopedAgentIds(contexts: Record<string, AgentLaunchContext>): Set<string> {
  const scoped = new Set<string>();
  for (const [key, ctx] of Object.entries(contexts)) {
    if (!ctx || typeof ctx !== "object") continue;
    const agentId = (ctx.agentId ?? key).trim();
    if (!agentId) continue;
    const initiativeId = ctx.initiativeId?.trim() ?? "";
    if (initiativeId) {
      scoped.add(agentId);
    }
  }
  return scoped;
}

function applyAgentContextsToSessionTree(
  input: SessionTreeResponse,
  contexts: Record<string, AgentLaunchContext>
): SessionTreeResponse {
  if (!input || !Array.isArray(input.nodes)) return input;

  const groupsById = new Map<string, { id: string; label: string; status: string | null }>();
  for (const group of input.groups ?? []) {
    if (!group) continue;
    groupsById.set(group.id, {
      id: group.id,
      label: group.label,
      status: group.status ?? null,
    });
  }

  const nodes = input.nodes.map((node) => {
    const agentId = node.agentId?.trim() ?? "";
    if (!agentId) return node;
    const ctx = contexts[agentId];
    const initiativeId = ctx?.initiativeId?.trim() ?? "";
    if (!initiativeId) return node;

    const groupId = initiativeId;
    const ctxTitle = (ctx as AgentLaunchContext).initiativeTitle?.trim() ?? "";
    const groupLabel = ctxTitle || node.groupLabel || initiativeId;

    const existing = groupsById.get(groupId);
    if (!existing) {
      groupsById.set(groupId, {
        id: groupId,
        label: groupLabel,
        status: node.status ?? null,
      });
    } else if (ctxTitle && (existing.label === groupId || existing.label.startsWith("Agent "))) {
      groupsById.set(groupId, { ...existing, label: groupLabel });
    }

    return {
      ...node,
      initiativeId,
      workstreamId: ctx.workstreamId ?? node.workstreamId ?? null,
      groupId,
      groupLabel,
    };
  });

  // Ensure every node's group exists.
  for (const node of nodes) {
    if (!groupsById.has(node.groupId)) {
      groupsById.set(node.groupId, {
        id: node.groupId,
        label: node.groupLabel || node.groupId,
        status: node.status ?? null,
      });
    }
  }

  return {
    ...input,
    nodes,
    groups: Array.from(groupsById.values()),
  };
}

function applyAgentContextsToActivity(
  input: LiveActivityItem[],
  contexts: Record<string, AgentLaunchContext>
): LiveActivityItem[] {
  if (!Array.isArray(input)) return [];
  return input.map((item) => {
    const agentId = item.agentId?.trim() ?? "";
    if (!agentId) return item;
    const ctx = contexts[agentId];
    const initiativeId = ctx?.initiativeId?.trim() ?? "";
    if (!initiativeId) return item;

    const metadata =
      item.metadata && typeof item.metadata === "object"
        ? { ...(item.metadata as Record<string, unknown>) }
        : {};
    metadata.orgx_context = {
      initiativeId,
      workstreamId: ctx.workstreamId ?? null,
      taskId: ctx.taskId ?? null,
      updatedAt: ctx.updatedAt,
    };

    return {
      ...item,
      initiativeId,
      metadata,
    };
  });
}

function mergeSessionTrees(
  base: SessionTreeResponse,
  extra: SessionTreeResponse
): SessionTreeResponse {
  const seenNodes = new Set<string>();
  const nodes: SessionTreeResponse["nodes"] = [];

  for (const node of base.nodes ?? []) {
    seenNodes.add(node.id);
    nodes.push(node);
  }
  for (const node of extra.nodes ?? []) {
    if (seenNodes.has(node.id)) continue;
    seenNodes.add(node.id);
    nodes.push(node);
  }

  const seenEdges = new Set<string>();
  const edges: SessionTreeResponse["edges"] = [];
  for (const edge of base.edges ?? []) {
    const key = `${edge.parentId}→${edge.childId}`;
    seenEdges.add(key);
    edges.push(edge);
  }
  for (const edge of extra.edges ?? []) {
    const key = `${edge.parentId}→${edge.childId}`;
    if (seenEdges.has(key)) continue;
    seenEdges.add(key);
    edges.push(edge);
  }

  const groupsById = new Map<string, { id: string; label: string; status: string | null }>();
  for (const group of base.groups ?? []) {
    groupsById.set(group.id, group);
  }
  for (const group of extra.groups ?? []) {
    const existing = groupsById.get(group.id);
    if (!existing) {
      groupsById.set(group.id, group);
      continue;
    }
    const nextLabel =
      existing.label === existing.id && group.label && group.label !== group.id
        ? group.label
        : existing.label;
    groupsById.set(group.id, { ...existing, label: nextLabel });
  }

  return {
    nodes,
    edges,
    groups: Array.from(groupsById.values()),
  };
}

function mergeActivities(
  base: LiveActivityItem[],
  extra: LiveActivityItem[],
  limit: number
): LiveActivityItem[] {
  const merged = [...(base ?? []), ...(extra ?? [])].sort(
    (a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp)
  );
  const deduped: LiveActivityItem[] = [];
  const seen = new Set<string>();
  for (const item of merged) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    deduped.push(item);
    if (deduped.length >= limit) break;
  }
  return deduped;
}

const ACTIVITY_HEADLINE_TIMEOUT_MS = 4_000;
const ACTIVITY_HEADLINE_CACHE_TTL_MS = 12 * 60 * 60_000;
const ACTIVITY_HEADLINE_CACHE_MAX = 1_000;
const ACTIVITY_HEADLINE_MAX_INPUT_CHARS = 8_000;
const DEFAULT_ACTIVITY_HEADLINE_MODEL = "openai/gpt-4.1-nano";

type ActivityHeadlineSource = "llm" | "heuristic";

interface ActivityHeadlineCacheEntry {
  headline: string;
  source: ActivityHeadlineSource;
  expiresAt: number;
}

const activityHeadlineCache = new Map<string, ActivityHeadlineCacheEntry>();
let resolvedActivitySummaryApiKey: string | null | undefined;

function normalizeSpaces(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function stripMarkdownLite(value: string): string {
  return value
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/\*([^*\n]+)\*/g, "$1")
    .replace(/_([^_\n]+)_/g, "$1")
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, "$1")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s*[-*]\s+/gm, "")
    .replace(/^\s*\d+\.\s+/gm, "")
    .replace(/\r\n/g, "\n")
    .trim();
}

function cleanActivityHeadline(value: string): string {
  const lines = stripMarkdownLite(value)
    .split("\n")
    .map((line) => normalizeSpaces(line))
    .filter((line) => line.length > 0 && !/^\|?[:\-| ]+\|?$/.test(line));
  const headline = lines[0] ?? "";
  if (!headline) return "";
  if (headline.length <= 108) return headline;
  return `${headline.slice(0, 107).trimEnd()}…`;
}

function heuristicActivityHeadline(text: string, title?: string | null): string {
  const cleanedText = cleanActivityHeadline(text);
  if (cleanedText.length > 0) return cleanedText;
  const cleanedTitle = cleanActivityHeadline(title ?? "");
  if (cleanedTitle.length > 0) return cleanedTitle;
  return "Activity update";
}

function resolveActivitySummaryApiKey(): string | null {
  if (resolvedActivitySummaryApiKey !== undefined) {
    return resolvedActivitySummaryApiKey;
  }

  const candidates = [
    process.env.ORGX_ACTIVITY_SUMMARY_API_KEY ?? "",
    process.env.OPENROUTER_API_KEY ?? "",
  ];

  const key = candidates.find((candidate) => candidate.trim().length > 0)?.trim() ?? "";
  resolvedActivitySummaryApiKey = key || null;
  return resolvedActivitySummaryApiKey;
}

function trimActivityHeadlineCache(): void {
  while (activityHeadlineCache.size > ACTIVITY_HEADLINE_CACHE_MAX) {
    const firstKey = activityHeadlineCache.keys().next().value;
    if (!firstKey) break;
    activityHeadlineCache.delete(firstKey);
  }
}

function extractCompletionText(payload: Record<string, unknown>): string | null {
  const choices = payload.choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const first = choices[0];
  if (!first || typeof first !== "object") return null;

  const firstRecord = first as Record<string, unknown>;
  const message = firstRecord.message;
  if (message && typeof message === "object") {
    const content = (message as Record<string, unknown>).content;
    if (typeof content === "string") {
      return content;
    }
    if (Array.isArray(content)) {
      const textParts = content
        .map((part) => {
          if (typeof part === "string") return part;
          if (!part || typeof part !== "object") return "";
          const record = part as Record<string, unknown>;
          return typeof record.text === "string" ? record.text : "";
        })
        .filter((part) => part.length > 0);
      if (textParts.length > 0) {
        return textParts.join(" ");
      }
    }
  }

  return pickString(firstRecord, ["text", "content"]);
}

async function summarizeActivityHeadline(
  input: {
    text: string;
    title?: string | null;
    type?: string | null;
  }
): Promise<{ headline: string; source: ActivityHeadlineSource; model: string | null }> {
  const normalizedText = normalizeSpaces(input.text).slice(0, ACTIVITY_HEADLINE_MAX_INPUT_CHARS);
  const normalizedTitle = normalizeSpaces(input.title ?? "");
  const normalizedType = normalizeSpaces(input.type ?? "");
  const heuristic = heuristicActivityHeadline(normalizedText, normalizedTitle);

  const cacheKey = createHash("sha256")
    .update(`${normalizedType}\n${normalizedTitle}\n${normalizedText}`)
    .digest("hex");

  const cached = activityHeadlineCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return { headline: cached.headline, source: cached.source, model: null };
  }

  const apiKey = resolveActivitySummaryApiKey();
  if (!apiKey) {
    activityHeadlineCache.set(cacheKey, {
      headline: heuristic,
      source: "heuristic",
      expiresAt: Date.now() + ACTIVITY_HEADLINE_CACHE_TTL_MS,
    });
    trimActivityHeadlineCache();
    return { headline: heuristic, source: "heuristic", model: null };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ACTIVITY_HEADLINE_TIMEOUT_MS);

  const model = process.env.ORGX_ACTIVITY_SUMMARY_MODEL?.trim() || DEFAULT_ACTIVITY_HEADLINE_MODEL;
  const prompt = [
    "Create one short activity title for a dashboard header.",
    "Rules:",
    "- Max 96 characters.",
    "- Keep key numbers/status markers (for example: 15 tasks, 0 blocked).",
    "- No markdown, no quotes, no trailing period unless needed.",
    "- Prefer plain language over jargon.",
    "",
    `Type: ${normalizedType || "activity"}`,
    normalizedTitle ? `Current title: ${normalizedTitle}` : "",
    "Full detail:",
    normalizedText,
  ]
    .filter(Boolean)
    .join("\n");

  try {
    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        temperature: 0.1,
        max_tokens: 48,
        messages: [
          {
            role: "system",
            content:
              "You write concise activity headers for operational dashboards. Return only the header text.",
          },
          {
            role: "user",
            content: prompt,
          },
        ],
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`headline model request failed (${response.status})`);
    }

    const payload = (await response.json()) as Record<string, unknown>;
    const generated = cleanActivityHeadline(extractCompletionText(payload) ?? "");
    const headline = generated || heuristic;
    const source: ActivityHeadlineSource = generated ? "llm" : "heuristic";
    activityHeadlineCache.set(cacheKey, {
      headline,
      source,
      expiresAt: Date.now() + ACTIVITY_HEADLINE_CACHE_TTL_MS,
    });
    trimActivityHeadlineCache();
    return { headline, source, model };
  } catch {
    activityHeadlineCache.set(cacheKey, {
      headline: heuristic,
      source: "heuristic",
      expiresAt: Date.now() + ACTIVITY_HEADLINE_CACHE_TTL_MS,
    });
    trimActivityHeadlineCache();
    return { headline: heuristic, source: "heuristic", model: null };
  } finally {
    clearTimeout(timeout);
  }
}

// =============================================================================
// Types — mirrors the Node http.IncomingMessage / http.ServerResponse pattern
// that Clawdbot provides to plugin HTTP handlers.
// =============================================================================

interface PluginRequest {
  method?: string;
  url?: string;
  headers: Record<string, string | string[] | undefined>;
  body?: unknown;
  on?: (event: string, listener: (...args: unknown[]) => void) => void;
  once?: (event: string, listener: (...args: unknown[]) => void) => void;
}

interface PluginResponse {
  writeHead(status: number, headers?: Record<string, string>): void;
  end(body?: string | Buffer): void;
  write?(chunk: string | Buffer): boolean | void;
  on?: (event: string, listener: (...args: unknown[]) => void) => void;
  once?: (event: string, listener: (...args: unknown[]) => void) => void;
  writableEnded?: boolean;
}

interface OnboardingController {
  getState: () => OnboardingState;
  startPairing: (input: {
    openclawVersion?: string;
    platform?: string;
    deviceName?: string;
  }) => Promise<{
    pairingId: string;
    connectUrl: string;
    expiresAt: string;
    pollIntervalMs: number;
    state: OnboardingState;
  }>;
  getStatus: () => Promise<OnboardingState>;
  submitManualKey: (input: {
    apiKey: string;
    userId?: string;
  }) => Promise<OnboardingState>;
  disconnect: () => Promise<OnboardingState>;
}

interface DiagnosticsProvider {
  getHealth?: (input?: { probeRemote?: boolean }) => Promise<unknown>;
}

// =============================================================================
// Content-Type mapping
// =============================================================================

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".map": "application/json",
};

function contentType(filePath: string): string {
  return MIME_TYPES[extname(filePath).toLowerCase()] ?? "application/octet-stream";
}

// =============================================================================
// CORS + response hardening
// =============================================================================

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Methods": "GET, POST, PATCH, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, Authorization, X-OrgX-Api-Key, X-API-Key, X-OrgX-User-Id",
  Vary: "Origin",
};

const SECURITY_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
};

function normalizeHost(value: string): string {
  return value.trim().toLowerCase().replace(/^\[|\]$/g, "");
}

function isLoopbackHost(hostname: string): boolean {
  const host = normalizeHost(hostname);
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

function isTrustedOrigin(origin: string): boolean {
  try {
    const parsed = new URL(origin);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return false;
    }
    return isLoopbackHost(parsed.hostname);
  } catch {
    return false;
  }
}

function isTrustedRequestSource(
  headers: Record<string, string | string[] | undefined>
): boolean {
  const fetchSite = pickHeaderString(headers, ["sec-fetch-site"]);
  if (fetchSite) {
    const normalizedFetchSite = fetchSite.trim().toLowerCase();
    if (
      normalizedFetchSite !== "same-origin" &&
      normalizedFetchSite !== "same-site" &&
      normalizedFetchSite !== "none"
    ) {
      return false;
    }
  }

  const origin = pickHeaderString(headers, ["origin"]);
  if (origin) {
    return isTrustedOrigin(origin);
  }

  const referer = pickHeaderString(headers, ["referer"]);
  if (referer) {
    try {
      return isTrustedOrigin(new URL(referer).origin);
    } catch {
      return false;
    }
  }

  return true;
}

const STREAM_IDLE_TIMEOUT_MS = 60_000;

// =============================================================================
// Resolve the dashboard/dist/ directory relative to this file
// =============================================================================

const __filename = fileURLToPath(import.meta.url);
// src/http-handler.ts → up to plugin root → dashboard/dist
const DIST_DIR = join(__filename, "..", "..", "dashboard", "dist");
const RESOLVED_DIST_DIR = resolve(DIST_DIR);
const RESOLVED_DIST_ASSETS_DIR = resolve(DIST_DIR, "assets");

function resolveSafeDistPath(subPath: string): string | null {
  if (!subPath || subPath.includes("\0")) return null;

  const normalized = normalize(subPath).replace(/^([/\\])+/, "");
  if (!normalized || normalized === ".") return null;

  const candidate = resolve(DIST_DIR, normalized);
  const rel = relative(RESOLVED_DIST_DIR, candidate);
  if (!rel || rel === "." || rel.startsWith("..") || rel.includes(`..${sep}`)) {
    return null;
  }

  return candidate;
}

// =============================================================================
// Helpers
// =============================================================================

function sendJson(
  res: PluginResponse,
  status: number,
  data: unknown
): void {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    ...SECURITY_HEADERS,
    ...CORS_HEADERS,
  });
  res.end(body);
}

function sendFile(
  res: PluginResponse,
  filePath: string,
  cacheControl: string
): void {
  try {
    const content = readFileSync(filePath);
    res.writeHead(200, {
      "Content-Type": contentType(filePath),
      "Cache-Control": cacheControl,
      ...SECURITY_HEADERS,
      ...CORS_HEADERS,
    });
    res.end(content);
  } catch {
    send404(res);
  }
}

function send404(res: PluginResponse): void {
  res.writeHead(404, {
    "Content-Type": "text/plain; charset=utf-8",
    ...SECURITY_HEADERS,
    ...CORS_HEADERS,
  });
  res.end("Not Found");
}

function sendIndexHtml(res: PluginResponse): void {
  const indexPath = join(DIST_DIR, "index.html");
  if (existsSync(indexPath)) {
    sendFile(res, indexPath, "no-cache, no-store, must-revalidate");
  } else {
    res.writeHead(503, {
      "Content-Type": "text/html; charset=utf-8",
      ...SECURITY_HEADERS,
      ...CORS_HEADERS,
    });
    res.end(
      "<html><body><h1>Dashboard not built</h1>" +
        "<p>Run <code>cd dashboard &amp;&amp; npm run build</code> to build the SPA.</p>" +
        "</body></html>"
    );
  }
}

function parseJsonBody(body: unknown): Record<string, unknown> {
  if (!body) return {};
  if (typeof body === "string") {
    try {
      const parsed = JSON.parse(body);
      return typeof parsed === "object" && parsed !== null
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }
  if (Buffer.isBuffer(body)) {
    try {
      const parsed = JSON.parse(body.toString("utf8"));
      return typeof parsed === "object" && parsed !== null
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }
  if (body instanceof Uint8Array) {
    try {
      const parsed = JSON.parse(Buffer.from(body).toString("utf8"));
      return typeof parsed === "object" && parsed !== null
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }
  if (body instanceof ArrayBuffer) {
    try {
      const parsed = JSON.parse(Buffer.from(body).toString("utf8"));
      return typeof parsed === "object" && parsed !== null
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }
  if (typeof body === "object") {
    return body as Record<string, unknown>;
  }
  return {};
}

function pickString(record: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return null;
}

function pickHeaderString(
  headers: Record<string, string | string[] | undefined>,
  keys: string[]
): string | null {
  for (const key of keys) {
    const candidates = [key, key.toLowerCase(), key.toUpperCase()];
    for (const candidate of candidates) {
      const raw = headers[candidate];
      if (typeof raw === "string" && raw.trim().length > 0) {
        return raw.trim();
      }
      if (Array.isArray(raw)) {
        const first = raw.find(
          (value) => typeof value === "string" && value.trim().length > 0
        );
        if (first) return first.trim();
      }
    }
  }
  return null;
}

function pickNumber(record: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === "string") {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
  }
  return null;
}

function toIsoString(value: string | null): string | null {
  if (!value) return null;
  const epoch = Date.parse(value);
  if (!Number.isFinite(epoch)) return null;
  return new Date(epoch).toISOString();
}

function mapDecisionEntity(entity: Entity) {
  const record = entity as Record<string, unknown>;
  const requestedAt = toIsoString(
    pickString(record, [
      "requestedAt",
      "requested_at",
      "createdAt",
      "created_at",
      "updatedAt",
      "updated_at",
    ])
  );
  const updatedAt = toIsoString(
    pickString(record, ["updatedAt", "updated_at", "createdAt", "created_at"])
  );

  const waitingMinutesFromEntity = pickNumber(record, [
    "waitingMinutes",
    "waiting_minutes",
    "ageMinutes",
    "age_minutes",
  ]);
  const waitingMinutes =
    waitingMinutesFromEntity ??
    (requestedAt
      ? Math.max(0, Math.floor((Date.now() - Date.parse(requestedAt)) / 60_000))
      : 0);

  return {
    id: String(record.id ?? ""),
    title: pickString(record, ["title", "name"]) ?? "Decision",
    context: pickString(record, ["context", "summary", "description", "details"]),
    status: pickString(record, ["status", "decision_status"]) ?? "pending",
    agentName: pickString(record, [
      "agentName",
      "agent_name",
      "requestedBy",
      "requested_by",
      "ownerName",
      "owner_name",
      "assignee",
      "createdBy",
      "created_by",
    ]),
    requestedAt,
    updatedAt,
    waitingMinutes,
    metadata: record,
  };
}

function parsePositiveInt(raw: string | null, fallback: number): number {
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.floor(parsed));
}

function parseBooleanQuery(raw: string | null): boolean {
  if (!raw) return false;
  const normalized = raw.trim().toLowerCase();
  return (
    normalized === "1" ||
    normalized === "true" ||
    normalized === "yes" ||
    normalized === "on"
  );
}

type MissionControlNodeType = "initiative" | "workstream" | "milestone" | "task";

interface MissionControlAssignedAgent {
  id: string;
  name: string;
  domain: string | null;
}

interface MissionControlNode {
  id: string;
  type: MissionControlNodeType;
  title: string;
  status: string;
  parentId: string | null;
  initiativeId: string | null;
  workstreamId: string | null;
  milestoneId: string | null;
  priorityNum: number;
  priorityLabel: string | null;
  dependencyIds: string[];
  dueDate: string | null;
  etaEndAt: string | null;
  expectedDurationHours: number;
  expectedBudgetUsd: number;
  assignedAgents: MissionControlAssignedAgent[];
  updatedAt: string | null;
}

interface MissionControlEdge {
  from: string;
  to: string;
  kind: "depends_on";
}

const DEFAULT_DURATION_HOURS: Record<MissionControlNodeType, number> = {
  initiative: 40,
  workstream: 16,
  milestone: 6,
  task: 2,
};

interface BudgetEnvBounds {
  min?: number;
  max?: number;
}

function readBudgetEnvNumber(name: string, fallback: number, bounds: BudgetEnvBounds = {}): number {
  const raw = process.env[name];
  if (typeof raw !== "string" || raw.trim().length === 0) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  if (typeof bounds.min === "number" && parsed < bounds.min) return fallback;
  if (typeof bounds.max === "number" && parsed > bounds.max) return fallback;
  return parsed;
}

const DEFAULT_TOKEN_MODEL_PRICING_USD_PER_1M = {
  // GPT-5.3 Codex API pricing is not published yet; use GPT-5.2 Codex pricing as proxy.
  gpt53CodexProxy: {
    input: readBudgetEnvNumber("ORGX_BUDGET_GPT53_CODEX_INPUT_PER_1M", 1.75, { min: 0 }),
    cachedInput: readBudgetEnvNumber("ORGX_BUDGET_GPT53_CODEX_CACHED_INPUT_PER_1M", 0.175, {
      min: 0,
    }),
    output: readBudgetEnvNumber("ORGX_BUDGET_GPT53_CODEX_OUTPUT_PER_1M", 14, { min: 0 }),
  },
  opus46: {
    input: readBudgetEnvNumber("ORGX_BUDGET_OPUS46_INPUT_PER_1M", 5, { min: 0 }),
    // Anthropic does not publish a fixed cached-input rate on the model page.
    cachedInput: readBudgetEnvNumber("ORGX_BUDGET_OPUS46_CACHED_INPUT_PER_1M", 5, { min: 0 }),
    output: readBudgetEnvNumber("ORGX_BUDGET_OPUS46_OUTPUT_PER_1M", 25, { min: 0 }),
  },
};

const DEFAULT_TOKEN_BUDGET_ASSUMPTIONS = {
  tokensPerHour: readBudgetEnvNumber("ORGX_BUDGET_TOKENS_PER_HOUR", 1_200_000, { min: 1 }),
  inputShare: readBudgetEnvNumber("ORGX_BUDGET_INPUT_TOKEN_SHARE", 0.86, { min: 0, max: 1 }),
  cachedInputShare: readBudgetEnvNumber("ORGX_BUDGET_CACHED_INPUT_SHARE", 0.15, {
    min: 0,
    max: 1,
  }),
  contingencyMultiplier: readBudgetEnvNumber("ORGX_BUDGET_CONTINGENCY_MULTIPLIER", 1.3, {
    min: 0.1,
  }),
  roundingStepUsd: readBudgetEnvNumber("ORGX_BUDGET_ROUNDING_STEP_USD", 5, { min: 0.01 }),
};

const DEFAULT_TOKEN_MODEL_MIX = {
  gpt53CodexProxy: 0.7,
  opus46: 0.3,
};

function modelCostPerMillionTokensUsd(pricing: {
  input: number;
  cachedInput: number;
  output: number;
}): number {
  const inputShare = DEFAULT_TOKEN_BUDGET_ASSUMPTIONS.inputShare;
  const outputShare = Math.max(0, 1 - inputShare);
  const cachedShare = DEFAULT_TOKEN_BUDGET_ASSUMPTIONS.cachedInputShare;
  const uncachedShare = Math.max(0, 1 - cachedShare);
  const effectiveInputRate = pricing.input * uncachedShare + pricing.cachedInput * cachedShare;
  return inputShare * effectiveInputRate + outputShare * pricing.output;
}

function estimateBudgetUsdFromDurationHours(durationHours: number): number {
  if (!Number.isFinite(durationHours) || durationHours <= 0) return 0;
  const blendedPerMillionUsd =
    DEFAULT_TOKEN_MODEL_MIX.gpt53CodexProxy *
      modelCostPerMillionTokensUsd(DEFAULT_TOKEN_MODEL_PRICING_USD_PER_1M.gpt53CodexProxy) +
    DEFAULT_TOKEN_MODEL_MIX.opus46 *
      modelCostPerMillionTokensUsd(DEFAULT_TOKEN_MODEL_PRICING_USD_PER_1M.opus46);
  const tokenMillions =
    (durationHours * DEFAULT_TOKEN_BUDGET_ASSUMPTIONS.tokensPerHour) / 1_000_000;
  const rawBudgetUsd =
    tokenMillions *
    blendedPerMillionUsd *
    DEFAULT_TOKEN_BUDGET_ASSUMPTIONS.contingencyMultiplier;
  const roundedBudgetUsd =
    Math.round(rawBudgetUsd / DEFAULT_TOKEN_BUDGET_ASSUMPTIONS.roundingStepUsd) *
    DEFAULT_TOKEN_BUDGET_ASSUMPTIONS.roundingStepUsd;
  return Math.max(0, roundedBudgetUsd);
}

function isLegacyHourlyBudget(budgetUsd: number, durationHours: number): boolean {
  if (!Number.isFinite(budgetUsd) || !Number.isFinite(durationHours) || durationHours <= 0) {
    return false;
  }
  const legacyHourlyBudget = durationHours * 40;
  return Math.abs(budgetUsd - legacyHourlyBudget) <= 0.5;
}

const DEFAULT_BUDGET_USD: Record<MissionControlNodeType, number> = {
  initiative: estimateBudgetUsdFromDurationHours(DEFAULT_DURATION_HOURS.initiative),
  workstream: estimateBudgetUsdFromDurationHours(DEFAULT_DURATION_HOURS.workstream),
  milestone: estimateBudgetUsdFromDurationHours(DEFAULT_DURATION_HOURS.milestone),
  task: estimateBudgetUsdFromDurationHours(DEFAULT_DURATION_HOURS.task),
};

const PRIORITY_LABEL_TO_NUM: Record<string, number> = {
  urgent: 10,
  high: 25,
  medium: 50,
  low: 75,
};

function clampPriority(value: number): number {
  if (!Number.isFinite(value)) return 60;
  return Math.max(1, Math.min(100, Math.round(value)));
}

function mapPriorityNumToLabel(priorityNum: number): string {
  if (priorityNum <= 12) return "urgent";
  if (priorityNum <= 30) return "high";
  if (priorityNum <= 60) return "medium";
  return "low";
}

function getRecordMetadata(record: Record<string, unknown>): Record<string, unknown> {
  const metadata = record.metadata;
  if (metadata && typeof metadata === "object" && !Array.isArray(metadata)) {
    return metadata as Record<string, unknown>;
  }
  return {};
}

function extractBudgetUsdFromText(...texts: Array<string | null | undefined>): number | null {
  for (const text of texts) {
    if (typeof text !== "string" || text.trim().length === 0) continue;
    const moneyMatch = /(?:expected\s+budget|budget)[^0-9$]{0,24}\$?\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)/i.exec(
      text
    );
    if (!moneyMatch) continue;
    const numeric = Number(moneyMatch[1].replace(/,/g, ""));
    if (Number.isFinite(numeric) && numeric >= 0) return numeric;
  }
  return null;
}

function extractDurationHoursFromText(
  ...texts: Array<string | null | undefined>
): number | null {
  for (const text of texts) {
    if (typeof text !== "string" || text.trim().length === 0) continue;
    const durationMatch = /(?:expected\s+duration|duration)[^0-9]{0,24}([0-9]+(?:\.[0-9]+)?)\s*h/i.exec(
      text
    );
    if (!durationMatch) continue;
    const numeric = Number(durationMatch[1]);
    if (Number.isFinite(numeric) && numeric >= 0) return numeric;
  }
  return null;
}

function pickStringArray(
  record: Record<string, unknown>,
  keys: string[]
): string[] {
  for (const key of keys) {
    const value = record[key];
    if (Array.isArray(value)) {
      const items = value
        .filter((entry): entry is string => typeof entry === "string")
        .map((entry) => entry.trim())
        .filter(Boolean);
      if (items.length > 0) return items;
    }
    if (typeof value === "string") {
      const items = value
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean);
      if (items.length > 0) return items;
    }
  }
  return [];
}

function dedupeStrings(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    if (!item || seen.has(item)) continue;
    seen.add(item);
    out.push(item);
  }
  return out;
}

function normalizePriorityForEntity(record: Record<string, unknown>): {
  priorityNum: number;
  priorityLabel: string | null;
} {
  const explicitPriorityNum = pickNumber(record, [
    "priority_num",
    "priorityNum",
    "priority_number",
  ]);
  const priorityLabelRaw = pickString(record, ["priority", "priority_label"]);

  if (explicitPriorityNum !== null) {
    const clamped = clampPriority(explicitPriorityNum);
    return {
      priorityNum: clamped,
      priorityLabel: priorityLabelRaw ?? mapPriorityNumToLabel(clamped),
    };
  }

  if (priorityLabelRaw) {
    const mapped = PRIORITY_LABEL_TO_NUM[priorityLabelRaw.toLowerCase()] ?? 60;
    return {
      priorityNum: mapped,
      priorityLabel: priorityLabelRaw.toLowerCase(),
    };
  }

  return {
    priorityNum: 60,
    priorityLabel: null,
  };
}

function normalizeDependencies(record: Record<string, unknown>): string[] {
  const metadata = getRecordMetadata(record);
  const direct = pickStringArray(record, [
    "depends_on",
    "dependsOn",
    "dependency_ids",
    "dependencyIds",
    "dependencies",
  ]);
  const nested = pickStringArray(metadata, [
    "depends_on",
    "dependsOn",
    "dependency_ids",
    "dependencyIds",
    "dependencies",
  ]);
  return dedupeStrings([...direct, ...nested]);
}

function normalizeAssignedAgents(
  record: Record<string, unknown>
): MissionControlAssignedAgent[] {
  const metadata = getRecordMetadata(record);
  const ids = dedupeStrings([
    ...pickStringArray(record, ["assigned_agent_ids", "assignedAgentIds"]),
    ...pickStringArray(metadata, ["assigned_agent_ids", "assignedAgentIds"]),
  ]);
  const names = dedupeStrings([
    ...pickStringArray(record, ["assigned_agent_names", "assignedAgentNames"]),
    ...pickStringArray(metadata, ["assigned_agent_names", "assignedAgentNames"]),
  ]);

  const objectCandidates = [
    record.assigned_agents,
    record.assignedAgents,
    metadata.assigned_agents,
    metadata.assignedAgents,
  ];
  const fromObjects: MissionControlAssignedAgent[] = [];
  for (const candidate of objectCandidates) {
    if (!Array.isArray(candidate)) continue;
    for (const entry of candidate) {
      if (!entry || typeof entry !== "object") continue;
      const item = entry as Record<string, unknown>;
      const id = pickString(item, ["id", "agent_id", "agentId"]) ?? "";
      const name = pickString(item, ["name", "agent_name", "agentName"]) ?? id;
      if (!name) continue;
      fromObjects.push({
        id: id || `name:${name}`,
        name,
        domain: pickString(item, ["domain", "role"]),
      });
    }
  }

  const merged: MissionControlAssignedAgent[] = [...fromObjects];
  if (merged.length === 0 && (names.length > 0 || ids.length > 0)) {
    const maxLen = Math.max(names.length, ids.length);
    for (let i = 0; i < maxLen; i += 1) {
      const id = ids[i] ?? `name:${names[i] ?? `agent-${i + 1}`}`;
      const name = names[i] ?? ids[i] ?? `Agent ${i + 1}`;
      merged.push({ id, name, domain: null });
    }
  }

  const seen = new Set<string>();
  const deduped: MissionControlAssignedAgent[] = [];
  for (const item of merged) {
    const key = `${item.id}:${item.name}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(item);
  }
  return deduped;
}

function toMissionControlNode(
  type: MissionControlNodeType,
  entity: Entity,
  fallbackInitiativeId: string
): MissionControlNode {
  const record = entity as Record<string, unknown>;
  const metadata = getRecordMetadata(record);
  const initiativeId =
    pickString(record, ["initiative_id", "initiativeId"]) ??
    pickString(metadata, ["initiative_id", "initiativeId"]) ??
    (type === "initiative" ? String(record.id ?? fallbackInitiativeId) : fallbackInitiativeId);

  const workstreamId =
    type === "workstream"
      ? String(record.id ?? "")
      : pickString(record, ["workstream_id", "workstreamId"]) ??
        pickString(metadata, ["workstream_id", "workstreamId"]);

  const milestoneId =
    type === "milestone"
      ? String(record.id ?? "")
      : pickString(record, ["milestone_id", "milestoneId"]) ??
        pickString(metadata, ["milestone_id", "milestoneId"]);

  const parentIdRaw =
    pickString(record, ["parentId", "parent_id"]) ??
    pickString(metadata, ["parentId", "parent_id"]);

  const parentId =
    parentIdRaw ??
    (type === "initiative"
      ? null
      : type === "workstream"
        ? initiativeId
        : type === "milestone"
          ? workstreamId ?? initiativeId
          : milestoneId ?? workstreamId ?? initiativeId);

  const status =
    pickString(record, ["status"]) ??
    (type === "task" ? "todo" : "planned");

  const dueDate = toIsoString(
    pickString(record, ["due_date", "dueDate", "target_date", "targetDate"])
  );
  const etaEndAt = toIsoString(
    pickString(record, ["eta_end_at", "etaEndAt"])
  );
  const expectedDuration =
    pickNumber(record, [
      "expected_duration_hours",
      "expectedDurationHours",
      "duration_hours",
      "durationHours",
    ]) ??
    pickNumber(metadata, [
      "expected_duration_hours",
      "expectedDurationHours",
      "duration_hours",
      "durationHours",
    ]) ??
    extractDurationHoursFromText(
      pickString(record, ["description", "summary", "context"]),
      pickString(metadata, ["description", "summary", "context"])
    ) ??
    DEFAULT_DURATION_HOURS[type];

  const explicitBudget =
    pickNumber(record, [
      "expected_budget_usd",
      "expectedBudgetUsd",
      "budget_usd",
      "budgetUsd",
    ]) ??
    pickNumber(metadata, [
      "expected_budget_usd",
      "expectedBudgetUsd",
      "budget_usd",
      "budgetUsd",
    ]);
  const extractedBudget =
    extractBudgetUsdFromText(
      pickString(record, ["description", "summary", "context"]),
      pickString(metadata, ["description", "summary", "context"])
    ) ?? null;
  const tokenModeledBudget =
    estimateBudgetUsdFromDurationHours(
      expectedDuration > 0 ? expectedDuration : DEFAULT_DURATION_HOURS[type]
    ) || DEFAULT_BUDGET_USD[type];
  const expectedBudget =
    explicitBudget ??
    (typeof extractedBudget === "number"
      ? isLegacyHourlyBudget(extractedBudget, expectedDuration)
        ? tokenModeledBudget
        : extractedBudget
      : DEFAULT_BUDGET_USD[type]);

  const priority = normalizePriorityForEntity(record);

  return {
    id: String(record.id ?? ""),
    type,
    title:
      pickString(record, ["title", "name"]) ??
      `${type[0].toUpperCase()}${type.slice(1)} ${String(record.id ?? "")}`,
    status,
    parentId: parentId ?? null,
    initiativeId: initiativeId ?? null,
    workstreamId: workstreamId ?? null,
    milestoneId: milestoneId ?? null,
    priorityNum: priority.priorityNum,
    priorityLabel: priority.priorityLabel,
    dependencyIds: normalizeDependencies(record),
    dueDate,
    etaEndAt,
    expectedDurationHours:
      expectedDuration > 0 ? expectedDuration : DEFAULT_DURATION_HOURS[type],
    expectedBudgetUsd:
      expectedBudget >= 0 ? expectedBudget : DEFAULT_BUDGET_USD[type],
    assignedAgents: normalizeAssignedAgents(record),
    updatedAt: toIsoString(
      pickString(record, [
        "updated_at",
        "updatedAt",
        "created_at",
        "createdAt",
      ])
    ),
  };
}

function isTodoStatus(status: string): boolean {
  const normalized = status.toLowerCase();
  return (
    normalized === "todo" ||
    normalized === "not_started" ||
    normalized === "planned" ||
    normalized === "backlog" ||
    normalized === "pending"
  );
}

function isInProgressStatus(status: string): boolean {
  const normalized = status.toLowerCase();
  return (
    normalized === "in_progress" ||
    normalized === "active" ||
    normalized === "running" ||
    normalized === "queued"
  );
}

function isDoneStatus(status: string): boolean {
  const normalized = status.toLowerCase();
  return (
    normalized === "done" ||
    normalized === "completed" ||
    normalized === "cancelled" ||
    normalized === "archived" ||
    normalized === "deleted"
  );
}

function detectCycleEdgeKeys(edges: MissionControlEdge[]): Set<string> {
  const adjacency = new Map<string, string[]>();
  for (const edge of edges) {
    const list = adjacency.get(edge.from) ?? [];
    list.push(edge.to);
    adjacency.set(edge.from, list);
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const cycleEdgeKeys = new Set<string>();

  function dfs(nodeId: string) {
    if (visited.has(nodeId)) return;
    visiting.add(nodeId);
    const next = adjacency.get(nodeId) ?? [];
    for (const childId of next) {
      if (visiting.has(childId)) {
        cycleEdgeKeys.add(`${nodeId}->${childId}`);
        continue;
      }
      dfs(childId);
    }
    visiting.delete(nodeId);
    visited.add(nodeId);
  }

  for (const key of adjacency.keys()) {
    if (!visited.has(key)) dfs(key);
  }
  return cycleEdgeKeys;
}

async function listEntitiesSafe(
  client: OrgXClient,
  type: MissionControlNodeType,
  filters: Record<string, unknown>
): Promise<{ items: Entity[]; warning: string | null }> {
  try {
    const response = await client.listEntities(type, filters);
    const items = Array.isArray(response.data) ? response.data : [];
    return { items, warning: null };
  } catch (err: unknown) {
    return {
      items: [],
      warning: `${type} unavailable (${safeErrorMessage(err)})`,
    };
  }
}

async function buildMissionControlGraph(
  client: OrgXClient,
  initiativeId: string
): Promise<{
  initiative: {
    id: string;
    title: string;
    status: string;
    summary: string | null;
    assignedAgents: MissionControlAssignedAgent[];
  };
  nodes: MissionControlNode[];
  edges: MissionControlEdge[];
  recentTodos: string[];
  degraded: string[];
}> {
  const degraded: string[] = [];

  const [initiativeResult, workstreamResult, milestoneResult, taskResult] =
    await Promise.all([
      listEntitiesSafe(client, "initiative", { limit: 300 }),
      listEntitiesSafe(client, "workstream", {
        initiative_id: initiativeId,
        limit: 500,
      }),
      listEntitiesSafe(client, "milestone", {
        initiative_id: initiativeId,
        limit: 700,
      }),
      listEntitiesSafe(client, "task", {
        initiative_id: initiativeId,
        limit: 1200,
      }),
    ]);

  for (const warning of [
    initiativeResult.warning,
    workstreamResult.warning,
    milestoneResult.warning,
    taskResult.warning,
  ]) {
    if (warning) degraded.push(warning);
  }

  const initiativeEntity = initiativeResult.items.find(
    (item) => String((item as Record<string, unknown>).id ?? "") === initiativeId
  );
  const initiativeNode = initiativeEntity
    ? toMissionControlNode("initiative", initiativeEntity, initiativeId)
    : {
        id: initiativeId,
        type: "initiative" as const,
        title: `Initiative ${initiativeId.slice(0, 8)}`,
        status: "active",
        parentId: null,
        initiativeId,
        workstreamId: null,
        milestoneId: null,
        priorityNum: 60,
        priorityLabel: null,
        dependencyIds: [],
        dueDate: null,
        etaEndAt: null,
        expectedDurationHours: DEFAULT_DURATION_HOURS.initiative,
        expectedBudgetUsd: DEFAULT_BUDGET_USD.initiative,
        assignedAgents: [],
        updatedAt: null,
      };

  const workstreamNodes = workstreamResult.items.map((item) =>
    toMissionControlNode("workstream", item, initiativeId)
  );
  const milestoneNodes = milestoneResult.items.map((item) =>
    toMissionControlNode("milestone", item, initiativeId)
  );
  const taskNodes = taskResult.items.map((item) =>
    toMissionControlNode("task", item, initiativeId)
  );

  const nodes: MissionControlNode[] = [
    initiativeNode,
    ...workstreamNodes,
    ...milestoneNodes,
    ...taskNodes,
  ];

  const nodeMap = new Map(nodes.map((node) => [node.id, node]));
  for (const node of nodes) {
    const validDependencies = dedupeStrings(
      node.dependencyIds.filter((depId) => depId !== node.id && nodeMap.has(depId))
    );
    node.dependencyIds = validDependencies;
  }

  let edges: MissionControlEdge[] = [];
  for (const node of nodes) {
    if (node.type === "initiative") continue;
    for (const depId of node.dependencyIds) {
      edges.push({
        from: depId,
        to: node.id,
        kind: "depends_on",
      });
    }
  }
  edges = edges.filter(
    (edge, index, arr) =>
      arr.findIndex(
        (candidate) =>
          candidate.from === edge.from &&
          candidate.to === edge.to &&
          candidate.kind === edge.kind
      ) === index
  );

  const cyclicEdgeKeys = detectCycleEdgeKeys(edges);
  if (cyclicEdgeKeys.size > 0) {
    degraded.push(
      `Detected ${cyclicEdgeKeys.size} cyclic dependency edge(s); excluded from ETA graph.`
    );
    edges = edges.filter((edge) => !cyclicEdgeKeys.has(`${edge.from}->${edge.to}`));
    for (const node of nodes) {
      node.dependencyIds = node.dependencyIds.filter(
        (depId) => !cyclicEdgeKeys.has(`${depId}->${node.id}`)
      );
    }
  }

  const etaMemo = new Map<string, number>();
  const etaVisiting = new Set<string>();

  const computeEtaEpoch = (nodeId: string): number => {
    const node = nodeMap.get(nodeId);
    if (!node) return Date.now();
    const cached = etaMemo.get(nodeId);
    if (cached !== undefined) return cached;

    const parsedEtaOverride = node.etaEndAt ? Date.parse(node.etaEndAt) : Number.NaN;
    if (Number.isFinite(parsedEtaOverride)) {
      etaMemo.set(nodeId, parsedEtaOverride);
      return parsedEtaOverride;
    }

    const parsedDueDate = node.dueDate ? Date.parse(node.dueDate) : Number.NaN;
    if (Number.isFinite(parsedDueDate)) {
      etaMemo.set(nodeId, parsedDueDate);
      return parsedDueDate;
    }

    if (etaVisiting.has(nodeId)) {
      degraded.push(`ETA cycle fallback on node ${nodeId}.`);
      const fallback = Date.now();
      etaMemo.set(nodeId, fallback);
      return fallback;
    }

    etaVisiting.add(nodeId);
    let dependencyMax = 0;
    for (const depId of node.dependencyIds) {
      dependencyMax = Math.max(dependencyMax, computeEtaEpoch(depId));
    }
    etaVisiting.delete(nodeId);

    const durationMs =
      (node.expectedDurationHours > 0
        ? node.expectedDurationHours
        : DEFAULT_DURATION_HOURS[node.type]) * 60 * 60 * 1000;
    const eta = Math.max(Date.now(), dependencyMax) + durationMs;
    etaMemo.set(nodeId, eta);
    return eta;
  };

  for (const node of nodes) {
    const eta = computeEtaEpoch(node.id);
    if (Number.isFinite(eta)) {
      node.etaEndAt = new Date(eta).toISOString();
    }
  }

  const taskNodesOnly = nodes.filter((node) => node.type === "task");
  const hasActiveTasks = taskNodesOnly.some((node) => isInProgressStatus(node.status));
  const hasTodoTasks = taskNodesOnly.some((node) => isTodoStatus(node.status));
  if (
    initiativeNode.status.toLowerCase() === "active" &&
    !hasActiveTasks &&
    hasTodoTasks
  ) {
    initiativeNode.status = "paused";
  }

  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const taskIsReady = (task: MissionControlNode): boolean =>
    task.dependencyIds.every((depId) => {
      const dependency = nodeById.get(depId);
      return dependency ? isDoneStatus(dependency.status) : true;
    });

  const taskHasBlockedParent = (task: MissionControlNode): boolean => {
    const milestone =
      task.milestoneId ? nodeById.get(task.milestoneId) ?? null : null;
    const workstream =
      task.workstreamId ? nodeById.get(task.workstreamId) ?? null : null;
    return (
      milestone?.status?.toLowerCase() === "blocked" ||
      workstream?.status?.toLowerCase() === "blocked"
    );
  };

  const recentTodos = nodes
    .filter((node) => node.type === "task" && isTodoStatus(node.status))
    .sort((a, b) => {
      const aReady = taskIsReady(a);
      const bReady = taskIsReady(b);
      if (aReady !== bReady) return aReady ? -1 : 1;

      const aBlocked = taskHasBlockedParent(a);
      const bBlocked = taskHasBlockedParent(b);
      if (aBlocked !== bBlocked) return aBlocked ? 1 : -1;

      const priorityDelta = a.priorityNum - b.priorityNum;
      if (priorityDelta !== 0) return priorityDelta;

      const aDue = a.dueDate ? Date.parse(a.dueDate) : Number.POSITIVE_INFINITY;
      const bDue = b.dueDate ? Date.parse(b.dueDate) : Number.POSITIVE_INFINITY;
      if (aDue !== bDue) return aDue - bDue;

      const aEta = a.etaEndAt ? Date.parse(a.etaEndAt) : Number.POSITIVE_INFINITY;
      const bEta = b.etaEndAt ? Date.parse(b.etaEndAt) : Number.POSITIVE_INFINITY;
      if (aEta !== bEta) return aEta - bEta;

      const aEpoch = a.updatedAt ? Date.parse(a.updatedAt) : 0;
      const bEpoch = b.updatedAt ? Date.parse(b.updatedAt) : 0;
      return aEpoch - bEpoch;
    })
    .map((node) => node.id);

  return {
    initiative: {
      id: initiativeNode.id,
      title: initiativeNode.title,
      status: initiativeNode.status,
      summary:
        initiativeEntity
          ? pickString(initiativeEntity as Record<string, unknown>, [
              "summary",
              "description",
              "context",
            ])
          : null,
      assignedAgents: initiativeNode.assignedAgents,
    },
    nodes,
    edges,
    recentTodos,
    degraded,
  };
}

function normalizeEntityMutationPayload(
  payload: Record<string, unknown>
): Record<string, unknown> {
  const next = { ...payload };
  const priorityNumRaw = pickNumber(next, ["priority_num", "priorityNum"]);
  const priorityLabelRaw = pickString(next, ["priority", "priority_label"]);

  if (priorityNumRaw !== null) {
    const clamped = clampPriority(priorityNumRaw);
    next.priority_num = clamped;
    if (!priorityLabelRaw) {
      next.priority = mapPriorityNumToLabel(clamped);
    }
  } else if (priorityLabelRaw) {
    next.priority_num = PRIORITY_LABEL_TO_NUM[priorityLabelRaw.toLowerCase()] ?? 60;
    next.priority = priorityLabelRaw.toLowerCase();
  }

  const dependsOnArray = pickStringArray(next, ["depends_on", "dependsOn", "dependencies"]);
  if (dependsOnArray.length > 0) {
    next.depends_on = dedupeStrings(dependsOnArray);
  } else if ("depends_on" in next) {
    next.depends_on = [];
  }

  const expectedDuration = pickNumber(next, [
    "expected_duration_hours",
    "expectedDurationHours",
  ]);
  if (expectedDuration !== null) {
    next.expected_duration_hours = Math.max(0, expectedDuration);
  }

  const expectedBudget = pickNumber(next, [
    "expected_budget_usd",
    "expectedBudgetUsd",
    "budget_usd",
    "budgetUsd",
  ]);
  if (expectedBudget !== null) {
    next.expected_budget_usd = Math.max(0, expectedBudget);
  }

  const etaEndAt = pickString(next, ["eta_end_at", "etaEndAt"]);
  if (etaEndAt !== null) {
    next.eta_end_at = toIsoString(etaEndAt) ?? null;
  }

  const assignedIds = pickStringArray(next, [
    "assigned_agent_ids",
    "assignedAgentIds",
  ]);
  const assignedNames = pickStringArray(next, [
    "assigned_agent_names",
    "assignedAgentNames",
  ]);
  if (assignedIds.length > 0) {
    next.assigned_agent_ids = dedupeStrings(assignedIds);
  }
  if (assignedNames.length > 0) {
    next.assigned_agent_names = dedupeStrings(assignedNames);
  }

  return next;
}

async function resolveAutoAssignments(input: {
  client: OrgXClient;
  entityId: string;
  entityType: string;
  initiativeId: string | null;
  title: string;
  summary: string | null;
}): Promise<{
  ok: boolean;
  assignment_source: "orchestrator" | "fallback" | "manual";
  assigned_agents: MissionControlAssignedAgent[];
  warnings: string[];
  updated_entity?: Entity;
}> {
  const warnings: string[] = [];
  const assignedById = new Map<string, MissionControlAssignedAgent>();

  const addAgent = (agent: MissionControlAssignedAgent) => {
    const key = agent.id || `name:${agent.name}`;
    if (!assignedById.has(key)) assignedById.set(key, agent);
  };

  type LiveAgent = MissionControlAssignedAgent & { status: string | null };
  let liveAgents: LiveAgent[] = [];

  try {
    const data = await input.client.getLiveAgents({
      initiative: input.initiativeId,
      includeIdle: true,
    });
    liveAgents = (Array.isArray(data.agents) ? data.agents : [])
      .map((raw): LiveAgent | null => {
        if (!raw || typeof raw !== "object") return null;
        const record = raw as Record<string, unknown>;
        const id = pickString(record, ["id", "agentId"]) ?? "";
        const name =
          pickString(record, ["name", "agentName"]) ?? (id ? `Agent ${id}` : "");
        if (!name) return null;
        return {
          id: id || `name:${name}`,
          name,
          domain: pickString(record, ["domain", "role"]),
          status: pickString(record, ["status"]),
        };
      })
      .filter((item): item is LiveAgent => item !== null);
  } catch (err: unknown) {
    warnings.push(`live agent lookup failed (${safeErrorMessage(err)})`);
  }

  const orchestrator = liveAgents.find(
    (agent) =>
      /holt|orchestrator/i.test(agent.name) ||
      /orchestrator/i.test(agent.domain ?? "")
  );
  if (orchestrator) addAgent(orchestrator);

  let assignmentSource: "orchestrator" | "fallback" | "manual" = "fallback";

  try {
    const preflight = await input.client.delegationPreflight({
      intent: `${input.title}${input.summary ? `: ${input.summary}` : ""}`,
    });
    const recommendations = preflight.data?.recommended_split ?? [];
    const recommendedDomains = dedupeStrings(
      recommendations
        .map((entry) => String(entry.owner_domain ?? "").trim().toLowerCase())
        .filter(Boolean)
    );

    for (const domain of recommendedDomains) {
      const matched = liveAgents.find((agent) =>
        (agent.domain ?? "").toLowerCase().includes(domain)
      );
      if (matched) addAgent(matched);
    }

    if (recommendedDomains.length > 0) {
      assignmentSource = "orchestrator";
    }
  } catch (err: unknown) {
    warnings.push(`delegation preflight failed (${safeErrorMessage(err)})`);
  }

  if (assignedById.size === 0) {
    const text = `${input.title} ${input.summary ?? ""}`.toLowerCase();
    const fallbackDomains: string[] = [];
    if (/market|campaign|thread|article|tweet|copy/.test(text)) {
      fallbackDomains.push("marketing");
    } else if (/design|ux|ui|a11y|accessibility/.test(text)) {
      fallbackDomains.push("design");
    } else if (/ops|incident|runbook|reliability/.test(text)) {
      fallbackDomains.push("operations");
    } else if (/sales|deal|pipeline|mrr/.test(text)) {
      fallbackDomains.push("sales");
    } else {
      fallbackDomains.push("engineering", "product");
    }

    for (const domain of fallbackDomains) {
      const matched = liveAgents.find((agent) =>
        (agent.domain ?? "").toLowerCase().includes(domain)
      );
      if (matched) addAgent(matched);
    }
  }

  if (assignedById.size === 0 && liveAgents.length > 0) {
    addAgent(liveAgents[0]);
    warnings.push("using first available live agent as fallback");
  }

  const assignedAgents = Array.from(assignedById.values());
  const updatePayload = normalizeEntityMutationPayload({
    assigned_agent_ids: assignedAgents.map((agent) => agent.id),
    assigned_agent_names: assignedAgents.map((agent) => agent.name),
    assignment_source: assignmentSource,
  });

  let updatedEntity: Entity | undefined;
  try {
    updatedEntity = await input.client.updateEntity(
      input.entityType,
      input.entityId,
      updatePayload
    );
  } catch (err: unknown) {
    warnings.push(`assignment patch failed (${safeErrorMessage(err)})`);
  }

  return {
    ok: true,
    assignment_source: assignmentSource,
    assigned_agents: assignedAgents,
    warnings,
    ...(updatedEntity ? { updated_entity: updatedEntity } : {}),
  };
}

// =============================================================================
// Factory
// =============================================================================

export function createHttpHandler(
  config: OrgXConfig,
  client: OrgXClient,
  getSnapshot: () => OrgSnapshot | null,
  onboarding: OnboardingController,
  diagnostics?: DiagnosticsProvider
) {
  const dashboardEnabled =
    (config as OrgXConfig & { dashboardEnabled?: boolean }).dashboardEnabled ??
    true;

  return async function handler(
    req: PluginRequest,
    res: PluginResponse
  ): Promise<boolean> {
    const method = (req.method ?? "GET").toUpperCase();
    const rawUrl = req.url ?? "/";
    const [path, queryString] = rawUrl.split("?", 2);
    const url = path;
    const searchParams = new URLSearchParams(queryString ?? "");

    // Only handle /orgx paths — return false for everything else
    if (!url.startsWith("/orgx")) {
      return false;
    }

    // Handle CORS preflight
    if (method === "OPTIONS") {
      if (url.startsWith("/orgx/api/") && !isTrustedRequestSource(req.headers)) {
        sendJson(res, 403, {
          error: "Cross-origin browser requests are blocked for /orgx/api endpoints.",
        });
        return true;
      }

      res.writeHead(204, {
        ...SECURITY_HEADERS,
        ...CORS_HEADERS,
      });
      res.end();
      return true;
    }

    // ── API endpoints ──────────────────────────────────────────────────────
    if (url.startsWith("/orgx/api/")) {
      if (!isTrustedRequestSource(req.headers)) {
        sendJson(res, 403, {
          error: "Cross-origin browser requests are blocked for /orgx/api endpoints.",
        });
        return true;
      }

      const route = url.replace("/orgx/api/", "").replace(/\/+$/, "");
      const decisionApproveMatch = route.match(
        /^live\/decisions\/([^/]+)\/approve$/
      );
      const runActionMatch = route.match(/^runs\/([^/]+)\/actions\/([^/]+)$/);
      const runCheckpointsMatch = route.match(/^runs\/([^/]+)\/checkpoints$/);
      const runCheckpointRestoreMatch = route.match(
        /^runs\/([^/]+)\/checkpoints\/([^/]+)\/restore$/
      );
      const isDelegationPreflight = route === "delegation/preflight";
      const isMissionControlAutoAssignmentRoute =
        route === "mission-control/assignments/auto";
      const isEntitiesRoute = route === "entities";
      const entityActionMatch = route.match(
        /^entities\/([^/]+)\/([^/]+)\/([^/]+)$/
      );
      const isOnboardingStartRoute = route === "onboarding/start";
      const isOnboardingStatusRoute = route === "onboarding/status";
      const isOnboardingManualKeyRoute = route === "onboarding/manual-key";
      const isOnboardingDisconnectRoute = route === "onboarding/disconnect";
      const isLiveActivityHeadlineRoute = route === "live/activity/headline";
      const isAgentLaunchRoute = route === "agents/launch";

      if (method === "POST" && isOnboardingStartRoute) {
        try {
          const payload = parseJsonBody(req.body);
          const started = await onboarding.startPairing({
            openclawVersion:
              pickString(payload, ["openclawVersion", "openclaw_version"]) ??
              undefined,
            platform: pickString(payload, ["platform"]) ?? undefined,
            deviceName: pickString(payload, ["deviceName", "device_name"]) ?? undefined,
          });
          sendJson(res, 200, {
            ok: true,
            data: {
              pairingId: started.pairingId,
              connectUrl: started.connectUrl,
              expiresAt: started.expiresAt,
              pollIntervalMs: started.pollIntervalMs,
              state: getOnboardingState(started.state),
            },
          });
        } catch (err: unknown) {
          sendJson(res, 400, {
            ok: false,
            error: safeErrorMessage(err),
          });
        }
        return true;
      }

      if (method === "GET" && isOnboardingStatusRoute) {
        try {
          const state = await onboarding.getStatus();
          sendJson(res, 200, {
            ok: true,
            data: getOnboardingState(state),
          });
        } catch (err: unknown) {
          sendJson(res, 500, {
            ok: false,
            error: safeErrorMessage(err),
          });
        }
        return true;
      }

      if (method === "POST" && isOnboardingManualKeyRoute) {
        try {
          const payload = parseJsonBody(req.body);
          const authHeader = pickHeaderString(req.headers, ["authorization"]);
          const bearerApiKey =
            authHeader && authHeader.toLowerCase().startsWith("bearer ")
              ? authHeader.slice("bearer ".length).trim()
              : null;
          const headerApiKey = pickHeaderString(req.headers, [
            "x-orgx-api-key",
            "x-api-key",
          ]);
          const apiKey =
            pickString(payload, ["apiKey", "api_key"]) ??
            headerApiKey ??
            bearerApiKey;
          if (!apiKey) {
            sendJson(res, 400, {
              ok: false,
              error: "apiKey is required",
            });
            return true;
          }

          const requestedUserId =
            pickString(payload, ["userId", "user_id"]) ??
            pickHeaderString(req.headers, ["x-orgx-user-id", "x-user-id"]) ??
            undefined;
          const userId = isUserScopedApiKey(apiKey) ? undefined : requestedUserId;
          const state = await onboarding.submitManualKey({
            apiKey,
            userId,
          });

          sendJson(res, 200, {
            ok: true,
            data: getOnboardingState(state),
          });
        } catch (err: unknown) {
          sendJson(res, 400, {
            ok: false,
            error: safeErrorMessage(err),
          });
        }
        return true;
      }

      if (method === "POST" && isOnboardingDisconnectRoute) {
        try {
          const state = await onboarding.disconnect();
          sendJson(res, 200, {
            ok: true,
            data: getOnboardingState(state),
          });
        } catch (err: unknown) {
          sendJson(res, 500, {
            ok: false,
            error: safeErrorMessage(err),
          });
        }
        return true;
      }

      if (method === "POST" && isAgentLaunchRoute) {
        try {
          const payload = parseJsonBody(req.body);
          const agentId =
            (pickString(payload, ["agentId", "agent_id", "id"]) ??
              searchParams.get("agentId") ??
              searchParams.get("agent_id") ??
              searchParams.get("id") ??
              "")
              .trim();
          if (!agentId) {
            sendJson(res, 400, { ok: false, error: "agentId is required" });
            return true;
          }
          if (!/^[a-zA-Z0-9_-]+$/.test(agentId)) {
            sendJson(res, 400, {
              ok: false,
              error: "agentId must be a simple identifier (letters, numbers, _ or -).",
            });
            return true;
          }

          const sessionId =
            (pickString(payload, ["sessionId", "session_id"]) ??
              searchParams.get("sessionId") ??
              searchParams.get("session_id") ??
              "")
              .trim() ||
            randomUUID();
          const initiativeId =
            pickString(payload, ["initiativeId", "initiative_id"]) ??
            searchParams.get("initiativeId") ??
            searchParams.get("initiative_id") ??
            null;
          const initiativeTitle =
            pickString(payload, [
              "initiativeTitle",
              "initiative_title",
              "initiativeName",
              "initiative_name",
            ]) ??
            searchParams.get("initiativeTitle") ??
            searchParams.get("initiative_title") ??
            searchParams.get("initiativeName") ??
            searchParams.get("initiative_name") ??
            null;
          const workstreamId =
            pickString(payload, ["workstreamId", "workstream_id"]) ??
            searchParams.get("workstreamId") ??
            searchParams.get("workstream_id") ??
            null;
          const taskId =
            pickString(payload, ["taskId", "task_id"]) ??
            searchParams.get("taskId") ??
            searchParams.get("task_id") ??
            null;
          const thinking =
            (pickString(payload, ["thinking"]) ??
              searchParams.get("thinking") ??
              "")
              .trim() || null;

          const messageInput =
            (pickString(payload, ["message", "prompt", "text"]) ??
              searchParams.get("message") ??
              searchParams.get("prompt") ??
              searchParams.get("text") ??
              "")
              .trim();
          const message =
            messageInput ||
            (initiativeTitle
              ? `Kick off: ${initiativeTitle}`
              : initiativeId
                ? `Kick off initiative ${initiativeId}`
                : `Kick off agent ${agentId}`);

          upsertAgentContext({
            agentId,
            initiativeId,
            initiativeTitle,
            workstreamId,
            taskId,
          });

          const spawned = spawnOpenClawAgentTurn({
            agentId,
            sessionId,
            message,
            thinking,
          });

          sendJson(res, 202, {
            ok: true,
            agentId,
            sessionId,
            pid: spawned.pid,
            initiativeId,
            workstreamId,
            taskId,
            startedAt: new Date().toISOString(),
          });
        } catch (err: unknown) {
          sendJson(res, 500, {
            ok: false,
            error: safeErrorMessage(err),
          });
        }
        return true;
      }

      if (
        method === "POST" &&
        (route === "live/decisions/approve" || decisionApproveMatch)
      ) {
        try {
          const payload = parseJsonBody(req.body);
          const action = payload.action === "reject" ? "reject" : "approve";
          const note =
            typeof payload.note === "string" && payload.note.trim().length > 0
              ? payload.note.trim()
              : undefined;

          const ids = decisionApproveMatch
            ? [decodeURIComponent(decisionApproveMatch[1])]
            : Array.isArray(payload.ids)
              ? payload.ids
                  .filter((id): id is string => typeof id === "string")
                  .map((id) => id.trim())
                  .filter(Boolean)
              : [];

          if (ids.length === 0) {
            sendJson(res, 400, {
              error: "Decision IDs are required.",
              expected: {
                route: "/orgx/api/live/decisions/approve",
                body: { ids: ["decision-id"], action: "approve|reject" },
              },
            });
            return true;
          }

          const results = await client.bulkDecideDecisions(ids, action, note);
          const updated = results.filter((result) => result.ok).length;
          const failed = results.length - updated;

          sendJson(res, failed > 0 ? 207 : 200, {
            action,
            requested: ids.length,
            updated,
            failed,
            results,
          });
        } catch (err: unknown) {
          sendJson(res, 500, {
            error: safeErrorMessage(err),
          });
        }
        return true;
      }

      if (method === "POST" && isDelegationPreflight) {
        try {
          const payload = parseJsonBody(req.body);
          const intent = pickString(payload, ["intent"]);
          if (!intent) {
            sendJson(res, 400, { error: "intent is required" });
            return true;
          }

          const toStringArray = (value: unknown): string[] | undefined =>
            Array.isArray(value)
              ? value.filter((entry): entry is string => typeof entry === "string")
              : undefined;

          const data = await client.delegationPreflight({
            intent,
            acceptanceCriteria: toStringArray(payload.acceptanceCriteria),
            constraints: toStringArray(payload.constraints),
            domains: toStringArray(payload.domains),
          });

          sendJson(res, 200, data);
        } catch (err: unknown) {
          sendJson(res, 500, {
            error: safeErrorMessage(err),
          });
        }
        return true;
      }

      if (method === "POST" && isMissionControlAutoAssignmentRoute) {
        try {
          const payload = parseJsonBody(req.body);
          const entityId = pickString(payload, ["entity_id", "entityId"]);
          const entityType = pickString(payload, ["entity_type", "entityType"]);
          const initiativeId =
            pickString(payload, ["initiative_id", "initiativeId"]) ?? null;
          const title = pickString(payload, ["title", "name"]) ?? "Untitled";
          const summary =
            pickString(payload, ["summary", "description", "context"]) ?? null;

          if (!entityId || !entityType) {
            sendJson(res, 400, {
              ok: false,
              error: "entity_id and entity_type are required.",
            });
            return true;
          }

          const assignment = await resolveAutoAssignments({
            client,
            entityId,
            entityType,
            initiativeId,
            title,
            summary,
          });

          sendJson(res, 200, assignment);
        } catch (err: unknown) {
          sendJson(res, 500, {
            ok: false,
            error: safeErrorMessage(err),
          });
        }
        return true;
      }

      if (runCheckpointsMatch && method === "POST") {
        try {
          const runId = decodeURIComponent(runCheckpointsMatch[1]);
          const payload = parseJsonBody(req.body);
          const reason = pickString(payload, ["reason"]) ?? undefined;
          const rawPayload = payload.payload;
          const checkpointPayload =
            rawPayload && typeof rawPayload === "object" && !Array.isArray(rawPayload)
              ? (rawPayload as Record<string, unknown>)
              : undefined;

          const data = await client.createRunCheckpoint(runId, {
            reason,
            payload: checkpointPayload,
          });
          sendJson(res, 200, data);
        } catch (err: unknown) {
          sendJson(res, 500, {
            error: safeErrorMessage(err),
          });
        }
        return true;
      }

      if (runCheckpointRestoreMatch && method === "POST") {
        try {
          const runId = decodeURIComponent(runCheckpointRestoreMatch[1]);
          const checkpointId = decodeURIComponent(runCheckpointRestoreMatch[2]);
          const payload = parseJsonBody(req.body);
          const reason = pickString(payload, ["reason"]) ?? undefined;
          const data = await client.restoreRunCheckpoint(runId, {
            checkpointId,
            reason,
          });
          sendJson(res, 200, data);
        } catch (err: unknown) {
          sendJson(res, 500, {
            error: safeErrorMessage(err),
          });
        }
        return true;
      }

      if (runActionMatch && method === "POST") {
        try {
          const runId = decodeURIComponent(runActionMatch[1]);
          const action = decodeURIComponent(runActionMatch[2]) as
            | "pause"
            | "resume"
            | "cancel"
            | "rollback";
          const payload = parseJsonBody(req.body);
          const checkpointId = pickString(payload, ["checkpointId", "checkpoint_id"]);
          const reason = pickString(payload, ["reason"]);

          const data = await client.runAction(runId, action, {
            checkpointId: checkpointId ?? undefined,
            reason: reason ?? undefined,
          });
          sendJson(res, 200, data);
        } catch (err: unknown) {
          sendJson(res, 500, {
            error: safeErrorMessage(err),
          });
        }
        return true;
      }

      // Entity action / delete route: POST /orgx/api/entities/{type}/{id}/{action}
      if (entityActionMatch && method === "POST") {
        try {
          const entityType = decodeURIComponent(entityActionMatch[1]);
          const entityId = decodeURIComponent(entityActionMatch[2]);
          const entityAction = decodeURIComponent(entityActionMatch[3]);
          const payload = parseJsonBody(req.body);

          if (entityAction === "delete") {
            // Delete via status update
            const entity = await client.updateEntity(entityType, entityId, {
              status: "deleted",
            });
            sendJson(res, 200, { ok: true, entity });
          } else {
            // Map action to status update
            const statusMap: Record<string, string> = {
              start: "in_progress",
              complete: "done",
              block: "blocked",
              unblock: "in_progress",
              pause: "paused",
              resume: "active",
            };
            const newStatus = statusMap[entityAction];
            if (!newStatus) {
              sendJson(res, 400, {
                error: `Unknown entity action: ${entityAction}`,
              });
              return true;
            }
            const entity = await client.updateEntity(entityType, entityId, {
              status: newStatus,
              ...(payload.force ? { force: true } : {}),
            });
            sendJson(res, 200, { ok: true, entity });
          }
        } catch (err: unknown) {
          sendJson(res, 500, {
            error: safeErrorMessage(err),
          });
        }
        return true;
      }

      if (
        method !== "GET" &&
        !(runCheckpointsMatch && method === "POST") &&
        !(runCheckpointRestoreMatch && method === "POST") &&
        !(runActionMatch && method === "POST") &&
        !(isDelegationPreflight && method === "POST") &&
        !(isMissionControlAutoAssignmentRoute && method === "POST") &&
        !(isEntitiesRoute && method === "POST") &&
        !(isEntitiesRoute && method === "PATCH") &&
        !(entityActionMatch && method === "POST") &&
        !(isOnboardingStartRoute && method === "POST") &&
        !(isOnboardingManualKeyRoute && method === "POST") &&
        !(isOnboardingDisconnectRoute && method === "POST") &&
        !(isLiveActivityHeadlineRoute && method === "POST")
      ) {
        res.writeHead(405, {
          "Content-Type": "text/plain",
          ...SECURITY_HEADERS,
          ...CORS_HEADERS,
        });
        res.end("Method Not Allowed");
        return true;
      }

      switch (route) {
        case "status": {
          // Proxy-style: try live fetch, fall back to cache
          let snapshot = getSnapshot();
          if (!snapshot) {
            try {
              snapshot = await client.getOrgSnapshot();
            } catch {
              // use null snapshot
            }
          }
          sendJson(res, 200, formatStatus(snapshot));
          return true;
        }

        case "health": {
          const probeRemote = parseBooleanQuery(
            searchParams.get("probe") ?? searchParams.get("probe_remote")
          );
          try {
            if (diagnostics?.getHealth) {
              const health = await diagnostics.getHealth({ probeRemote });
              sendJson(res, 200, health);
              return true;
            }

            const outbox = await readOutboxSummary();
            sendJson(res, 200, {
              ok: true,
              status: "ok",
              generatedAt: new Date().toISOString(),
              checks: [],
              plugin: {
                baseUrl: config.baseUrl,
              },
              auth: {
                hasApiKey: Boolean(config.apiKey),
              },
              outbox: {
                pendingTotal: outbox.pendingTotal,
                pendingByQueue: outbox.pendingByQueue,
                oldestEventAt: outbox.oldestEventAt,
                newestEventAt: outbox.newestEventAt,
                replayStatus: "idle",
                lastReplayAttemptAt: null,
                lastReplaySuccessAt: null,
                lastReplayFailureAt: null,
                lastReplayError: null,
              },
              remote: {
                enabled: false,
                reachable: null,
                latencyMs: null,
                error: null,
              },
            });
          } catch (err: unknown) {
            sendJson(res, 500, {
              error: safeErrorMessage(err),
            });
          }
          return true;
        }

        case "agents":
          sendJson(res, 200, formatAgents(getSnapshot()));
          return true;

        case "agents/catalog": {
          try {
            const [openclawAgents, localSnapshot] = await Promise.all([
              listOpenClawAgents(),
              loadLocalOpenClawSnapshot(240).catch(() => null),
            ]);

            const localById = new Map<
              string,
              {
                status: string;
                currentTask: string | null;
                runId: string | null;
                startedAt: string | null;
                blockers: string[];
              }
            >();
            if (localSnapshot) {
              for (const agent of localSnapshot.agents) {
                localById.set(agent.id, {
                  status: agent.status,
                  currentTask: agent.currentTask,
                  runId: agent.runId,
                  startedAt: agent.startedAt,
                  blockers: agent.blockers,
                });
              }
            }

            const contexts = readAgentContexts().agents;

            const agents = openclawAgents.map((entry) => {
              const id = typeof entry.id === "string" ? entry.id.trim() : "";
              const name =
                typeof entry.name === "string" && entry.name.trim().length > 0
                  ? entry.name.trim()
                  : id || "unknown";
              const local = id ? localById.get(id) ?? null : null;
              const context = id ? contexts[id] ?? null : null;
              return {
                id,
                name,
                workspace: typeof entry.workspace === "string" ? entry.workspace : null,
                model: typeof entry.model === "string" ? entry.model : null,
                isDefault: Boolean(entry.isDefault),
                status: local?.status ?? null,
                currentTask: local?.currentTask ?? null,
                runId: local?.runId ?? null,
                startedAt: local?.startedAt ?? null,
                blockers: local?.blockers ?? [],
                context,
              };
            });

            sendJson(res, 200, {
              generatedAt: new Date().toISOString(),
              agents,
            });
          } catch (err: unknown) {
            sendJson(res, 500, {
              error: safeErrorMessage(err),
            });
          }
          return true;
        }

        case "activity":
          sendJson(res, 200, formatActivity(getSnapshot()));
          return true;

        case "initiatives":
          sendJson(res, 200, formatInitiatives(getSnapshot()));
          return true;

        case "onboarding":
          sendJson(res, 200, getOnboardingState(await onboarding.getStatus()));
          return true;

        case "mission-control/graph": {
          const initiativeId =
            searchParams.get("initiative_id") ??
            searchParams.get("initiativeId");
          if (!initiativeId || initiativeId.trim().length === 0) {
            sendJson(res, 400, {
              error: "Query parameter 'initiative_id' is required.",
            });
            return true;
          }

          try {
            const graph = await buildMissionControlGraph(client, initiativeId.trim());
            sendJson(res, 200, graph);
          } catch (err: unknown) {
            sendJson(res, 500, {
              error: safeErrorMessage(err),
            });
          }
          return true;
        }

        case "entities": {
          if (method === "POST") {
            try {
              const payload = parseJsonBody(req.body);
              const type = pickString(payload, ["type"]);
              const title = pickString(payload, ["title", "name"]);

              if (!type || !title) {
                sendJson(res, 400, {
                  error: "Both 'type' and 'title' are required.",
                });
                return true;
              }

              const data = normalizeEntityMutationPayload({ ...payload, title });
              delete (data as Record<string, unknown>).type;

              let entity = await client.createEntity(type, data);
              let autoAssignment:
                | {
                    ok: boolean;
                    assignment_source: "orchestrator" | "fallback" | "manual";
                    assigned_agents: MissionControlAssignedAgent[];
                    warnings: string[];
                    updated_entity?: Entity;
                  }
                | null = null;

              if (type === "initiative" || type === "workstream") {
                const entityRecord = entity as Record<string, unknown>;
                autoAssignment = await resolveAutoAssignments({
                  client,
                  entityId: String(entityRecord.id ?? ""),
                  entityType: type,
                  initiativeId:
                    type === "initiative"
                      ? String(entityRecord.id ?? "")
                      : pickString(data, ["initiative_id", "initiativeId"]),
                  title:
                    pickString(entityRecord, ["title", "name"]) ??
                    title ??
                    "Untitled",
                  summary:
                    pickString(entityRecord, [
                      "summary",
                      "description",
                      "context",
                    ]) ?? null,
                });
                if (autoAssignment.updated_entity) {
                  entity = autoAssignment.updated_entity;
                }
              }

              sendJson(res, 201, { ok: true, entity, auto_assignment: autoAssignment });
            } catch (err: unknown) {
              sendJson(res, 500, {
                error: safeErrorMessage(err),
              });
            }
            return true;
          }

          if (method === "PATCH") {
            try {
              const payload = parseJsonBody(req.body);
              const type = pickString(payload, ["type"]);
              const id = pickString(payload, ["id"]);

              if (!type || !id) {
                sendJson(res, 400, {
                  error: "Both 'type' and 'id' are required for PATCH.",
                });
                return true;
              }

              const updates = { ...payload };
              delete (updates as Record<string, unknown>).type;
              delete (updates as Record<string, unknown>).id;

              const entity = await client.updateEntity(
                type,
                id,
                normalizeEntityMutationPayload(updates)
              );
              sendJson(res, 200, { ok: true, entity });
            } catch (err: unknown) {
              sendJson(res, 500, {
                error: safeErrorMessage(err),
              });
            }
            return true;
          }

          try {
            const type = searchParams.get("type");
            if (!type) {
              sendJson(res, 400, {
                error: "Query parameter 'type' is required for GET /entities.",
              });
              return true;
            }

            const status = searchParams.get("status") ?? undefined;
            const initiativeId = searchParams.get("initiative_id") ?? undefined;
            const limit = searchParams.get("limit")
              ? Number(searchParams.get("limit"))
              : undefined;
            const data = await client.listEntities(type, {
              status,
              initiative_id: initiativeId,
              limit: Number.isFinite(limit) ? limit : undefined,
            });
            sendJson(res, 200, data);
          } catch (err: unknown) {
            sendJson(res, 500, {
              error: safeErrorMessage(err),
            });
          }
          return true;
        }

        case "dashboard-bundle":
        case "live/snapshot": {
          const sessionsLimit = parsePositiveInt(
            searchParams.get("sessionsLimit") ?? searchParams.get("sessions_limit"),
            320
          );
          const activityLimit = parsePositiveInt(
            searchParams.get("activityLimit") ?? searchParams.get("activity_limit"),
            600
          );
          const decisionsLimit = parsePositiveInt(
            searchParams.get("decisionsLimit") ?? searchParams.get("decisions_limit"),
            120
          );
          const initiative = searchParams.get("initiative");
          const run = searchParams.get("run");
          const since = searchParams.get("since");
          const decisionStatus = searchParams.get("status") ?? "pending";
          const includeIdleRaw = searchParams.get("include_idle");
          const includeIdle =
            includeIdleRaw === null ? undefined : includeIdleRaw !== "false";
          const degraded: string[] = [];
          const agentContexts = readAgentContexts().agents;
          const scopedAgentIds = getScopedAgentIds(agentContexts);

          let outboxStatus: Record<string, unknown> | null = null;
          try {
            if (diagnostics?.getHealth) {
              const health = await diagnostics.getHealth({ probeRemote: false });
              if (health && typeof health === "object") {
                const maybeOutbox = (health as Record<string, unknown>).outbox;
                if (maybeOutbox && typeof maybeOutbox === "object") {
                  outboxStatus = maybeOutbox as Record<string, unknown>;
                }
              }
            }
            if (!outboxStatus) {
              const outbox = await readOutboxSummary();
              outboxStatus = {
                pendingTotal: outbox.pendingTotal,
                pendingByQueue: outbox.pendingByQueue,
                oldestEventAt: outbox.oldestEventAt,
                newestEventAt: outbox.newestEventAt,
                replayStatus: "idle",
                lastReplayAttemptAt: null,
                lastReplaySuccessAt: null,
                lastReplayFailureAt: null,
                lastReplayError: null,
              };
            }
          } catch (err: unknown) {
            degraded.push(`outbox status unavailable (${safeErrorMessage(err)})`);
            outboxStatus = {
              pendingTotal: 0,
              pendingByQueue: {},
              oldestEventAt: null,
              newestEventAt: null,
              replayStatus: "idle",
              lastReplayAttemptAt: null,
              lastReplaySuccessAt: null,
              lastReplayFailureAt: null,
              lastReplayError: null,
            };
          }

          let localSnapshot:
            | Awaited<ReturnType<typeof loadLocalOpenClawSnapshot>>
            | null = null;
          const ensureLocalSnapshot = async (minimumLimit: number) => {
            if (!localSnapshot || localSnapshot.sessions.length < minimumLimit) {
              localSnapshot = await loadLocalOpenClawSnapshot(minimumLimit);
            }
            return localSnapshot;
          };

          const settled = await Promise.allSettled([
            client.getLiveSessions({
              initiative,
              limit: sessionsLimit,
            }),
            client.getLiveActivity({
              run,
              since,
              limit: activityLimit,
            }),
            client.getHandoffs(),
            client.getLiveDecisions({
              status: decisionStatus,
              limit: decisionsLimit,
            }),
            client.getLiveAgents({
              initiative,
              includeIdle,
            }),
          ]);

          // sessions
          let sessions: SessionTreeResponse = {
            nodes: [],
            edges: [],
            groups: [],
          };
          const sessionsResult = settled[0];
          if (sessionsResult.status === "fulfilled") {
            sessions = sessionsResult.value;
          } else {
            degraded.push(`sessions unavailable (${safeErrorMessage(sessionsResult.reason)})`);
            try {
              let local = toLocalSessionTree(
                await ensureLocalSnapshot(Math.max(sessionsLimit, 200)),
                sessionsLimit
              );

              local = applyAgentContextsToSessionTree(local, agentContexts);

              if (initiative && initiative.trim().length > 0) {
                const filteredNodes = local.nodes.filter(
                  (node) => node.initiativeId === initiative || node.groupId === initiative
                );
                const filteredIds = new Set(filteredNodes.map((node) => node.id));
                const filteredGroupIds = new Set(filteredNodes.map((node) => node.groupId));

                local = {
                  nodes: filteredNodes,
                  edges: local.edges.filter(
                    (edge) => filteredIds.has(edge.parentId) && filteredIds.has(edge.childId)
                  ),
                  groups: local.groups.filter((group) => filteredGroupIds.has(group.id)),
                };
              }

              sessions = local;
            } catch (localErr: unknown) {
              degraded.push(`sessions local fallback failed (${safeErrorMessage(localErr)})`);
            }
          }

          // activity
          let activity: LiveActivityItem[] = [];
          const activityResult = settled[1];
          if (activityResult.status === "fulfilled") {
            activity = Array.isArray(activityResult.value.activities)
              ? activityResult.value.activities
              : [];
          } else {
            degraded.push(`activity unavailable (${safeErrorMessage(activityResult.reason)})`);
            try {
              const local = await toLocalLiveActivity(
                await ensureLocalSnapshot(Math.max(activityLimit, 240)),
                Math.max(activityLimit, 240)
              );
              let filtered = local.activities;

              if (run && run.trim().length > 0) {
                filtered = filtered.filter((item) => item.runId === run);
              }

              if (since && since.trim().length > 0) {
                const sinceEpoch = Date.parse(since);
                if (Number.isFinite(sinceEpoch)) {
                  filtered = filtered.filter(
                    (item) => Date.parse(item.timestamp) >= sinceEpoch
                  );
                }
              }

              filtered = applyAgentContextsToActivity(filtered, agentContexts);
              activity = filtered.slice(0, activityLimit);
            } catch (localErr: unknown) {
              degraded.push(`activity local fallback failed (${safeErrorMessage(localErr)})`);
            }
          }

          // handoffs
          let handoffs: HandoffSummary[] = [];
          const handoffsResult = settled[2];
          if (handoffsResult.status === "fulfilled") {
            handoffs = Array.isArray(handoffsResult.value.handoffs)
              ? handoffsResult.value.handoffs
              : [];
          } else {
            degraded.push(`handoffs unavailable (${safeErrorMessage(handoffsResult.reason)})`);
          }

          // decisions
          let decisions: Array<Record<string, unknown>> = [];
          const decisionsResult = settled[3];
          if (decisionsResult.status === "fulfilled") {
            decisions = decisionsResult.value.decisions
              .map(mapDecisionEntity)
              .sort((a, b) => b.waitingMinutes - a.waitingMinutes) as Array<
              Record<string, unknown>
            >;
          } else {
            degraded.push(`decisions unavailable (${safeErrorMessage(decisionsResult.reason)})`);
          }

          // agents
          let agents: Array<Record<string, unknown>> = [];
          const agentsResult = settled[4];
          if (agentsResult.status === "fulfilled") {
            agents = Array.isArray(agentsResult.value.agents)
              ? (agentsResult.value.agents as Array<Record<string, unknown>>)
              : [];
          } else {
            degraded.push(`agents unavailable (${safeErrorMessage(agentsResult.reason)})`);
            try {
              const local = toLocalLiveAgents(
                await ensureLocalSnapshot(Math.max(sessionsLimit, 240))
              );
              let localAgents = local.agents;
              if (initiative && initiative.trim().length > 0) {
                localAgents = localAgents.filter(
                  (agent) => agent.initiativeId === initiative
                );
              }
              if (includeIdle === false) {
                localAgents = localAgents.filter((agent) => agent.status !== "idle");
              }
              agents = localAgents as Array<Record<string, unknown>>;
            } catch (localErr: unknown) {
              degraded.push(`agents local fallback failed (${safeErrorMessage(localErr)})`);
            }
          }

          // Merge locally-launched OpenClaw agent sessions/activity into the snapshot so
          // the UI reflects one-click launches even when the cloud reporting plane is reachable.
          if (scopedAgentIds.size > 0) {
            try {
              const minimum = Math.max(Math.max(sessionsLimit, activityLimit), 240);
              const snapshot = await ensureLocalSnapshot(minimum);
              const scopedSnapshot = {
                ...snapshot,
                sessions: snapshot.sessions.filter(
                  (session) => Boolean(session.agentId && scopedAgentIds.has(session.agentId))
                ),
                agents: snapshot.agents.filter((agent) => scopedAgentIds.has(agent.id)),
              };

              // Sessions
              let localSessions = applyAgentContextsToSessionTree(
                toLocalSessionTree(scopedSnapshot, sessionsLimit),
                agentContexts
              );
              if (initiative && initiative.trim().length > 0) {
                const filteredNodes = localSessions.nodes.filter(
                  (node) => node.initiativeId === initiative || node.groupId === initiative
                );
                const filteredIds = new Set(filteredNodes.map((node) => node.id));
                const filteredGroupIds = new Set(filteredNodes.map((node) => node.groupId));

                localSessions = {
                  nodes: filteredNodes,
                  edges: localSessions.edges.filter(
                    (edge) => filteredIds.has(edge.parentId) && filteredIds.has(edge.childId)
                  ),
                  groups: localSessions.groups.filter((group) => filteredGroupIds.has(group.id)),
                };
              }
              sessions = mergeSessionTrees(sessions, localSessions);

              // Activity
              const localActivity = await toLocalLiveActivity(
                scopedSnapshot,
                Math.max(activityLimit, 240)
              );
              let localItems = applyAgentContextsToActivity(
                localActivity.activities,
                agentContexts
              );
              if (run && run.trim().length > 0) {
                localItems = localItems.filter((item) => item.runId === run);
              }
              if (since && since.trim().length > 0) {
                const sinceEpoch = Date.parse(since);
                if (Number.isFinite(sinceEpoch)) {
                  localItems = localItems.filter(
                    (item) => Date.parse(item.timestamp) >= sinceEpoch
                  );
                }
              }
              activity = mergeActivities(activity, localItems, activityLimit);
            } catch (err: unknown) {
              degraded.push(`local agent merge failed (${safeErrorMessage(err)})`);
            }
          }

          // include locally buffered events so offline-generated actions are visible
          try {
            const buffered = await readAllOutboxItems();
            if (buffered.length > 0) {
              const merged = [...activity, ...buffered]
                .sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp))
                .slice(0, activityLimit);
              const deduped: LiveActivityItem[] = [];
              const seen = new Set<string>();
              for (const item of merged) {
                if (seen.has(item.id)) continue;
                seen.add(item.id);
                deduped.push(item);
              }
              activity = deduped;
            }
          } catch (err: unknown) {
            degraded.push(`outbox unavailable (${safeErrorMessage(err)})`);
          }

          sendJson(res, 200, {
            sessions,
            activity,
            handoffs,
            decisions,
            agents,
            outbox: outboxStatus,
            generatedAt: new Date().toISOString(),
            degraded: degraded.length > 0 ? degraded : undefined,
          });
          return true;
        }

        // Legacy endpoints retained for backwards compatibility.
        case "live/sessions": {
          try {
            const initiative = searchParams.get("initiative");
            const limit = searchParams.get("limit")
              ? Number(searchParams.get("limit"))
              : undefined;
            const data = await client.getLiveSessions({
              initiative,
              limit: Number.isFinite(limit) ? limit : undefined,
            });
            sendJson(res, 200, data);
          } catch (err: unknown) {
            try {
              const initiative = searchParams.get("initiative");
              const limitRaw = searchParams.get("limit")
                ? Number(searchParams.get("limit"))
                : undefined;
              const limit = Number.isFinite(limitRaw) ? Math.max(1, Number(limitRaw)) : 100;

              let local = toLocalSessionTree(
                await loadLocalOpenClawSnapshot(Math.max(limit, 200)),
                limit
              );

              local = applyAgentContextsToSessionTree(local, readAgentContexts().agents);

              if (initiative && initiative.trim().length > 0) {
                const filteredNodes = local.nodes.filter(
                  (node) => node.initiativeId === initiative || node.groupId === initiative
                );
                const filteredIds = new Set(filteredNodes.map((node) => node.id));
                const filteredGroupIds = new Set(filteredNodes.map((node) => node.groupId));

                local = {
                  nodes: filteredNodes,
                  edges: local.edges.filter(
                    (edge) => filteredIds.has(edge.parentId) && filteredIds.has(edge.childId)
                  ),
                  groups: local.groups.filter((group) => filteredGroupIds.has(group.id)),
                };
              }

              sendJson(res, 200, local);
            } catch (localErr: unknown) {
              sendJson(res, 500, {
                error: safeErrorMessage(err),
                localFallbackError: safeErrorMessage(localErr),
              });
            }
          }
          return true;
        }

        case "live/activity": {
          try {
            const run = searchParams.get("run");
            const limit = searchParams.get("limit")
              ? Number(searchParams.get("limit"))
              : undefined;
            const since = searchParams.get("since");
            const data = await client.getLiveActivity({
              run,
              since,
              limit: Number.isFinite(limit) ? limit : undefined,
            });
            sendJson(res, 200, data);
          } catch (err: unknown) {
            try {
              const run = searchParams.get("run");
              const limitRaw = searchParams.get("limit")
                ? Number(searchParams.get("limit"))
                : undefined;
              const since = searchParams.get("since");
              const limit = Number.isFinite(limitRaw) ? Math.max(1, Number(limitRaw)) : 240;

              const localSnapshot = await loadLocalOpenClawSnapshot(Math.max(limit, 240));
              let local = await toLocalLiveActivity(localSnapshot, Math.max(limit, 240));

              if (run && run.trim().length > 0) {
                local = {
                  activities: local.activities.filter((item) => item.runId === run),
                  total: local.activities.filter((item) => item.runId === run).length,
                };
              }

              if (since && since.trim().length > 0) {
                const sinceEpoch = Date.parse(since);
                if (Number.isFinite(sinceEpoch)) {
                  const filtered = local.activities.filter(
                    (item) => Date.parse(item.timestamp) >= sinceEpoch
                  );
                  local = {
                    activities: filtered,
                    total: filtered.length,
                  };
                }
              }

              const activitiesWithContexts = applyAgentContextsToActivity(
                local.activities,
                readAgentContexts().agents
              );
              sendJson(res, 200, {
                activities: activitiesWithContexts.slice(0, limit),
                total: local.total,
              });
            } catch (localErr: unknown) {
              sendJson(res, 500, {
                error: safeErrorMessage(err),
                localFallbackError: safeErrorMessage(localErr),
              });
            }
          }
          return true;
        }

        case "live/activity/detail": {
          const turnId =
            searchParams.get("turnId") ?? searchParams.get("turn_id");
          const sessionKey =
            searchParams.get("sessionKey") ?? searchParams.get("session_key");
          const run = searchParams.get("run");

          if (!turnId || turnId.trim().length === 0) {
            sendJson(res, 400, { error: "turnId is required" });
            return true;
          }

          try {
            const detail = await loadLocalTurnDetail({
              turnId,
              sessionKey,
              runId: run,
            });
            if (!detail) {
              sendJson(res, 404, {
                error: "Turn detail unavailable",
                turnId,
              });
              return true;
            }
            sendJson(res, 200, { detail });
          } catch (err: unknown) {
            sendJson(res, 500, { error: safeErrorMessage(err), turnId });
          }
          return true;
        }

        case "live/activity/headline": {
          if (method !== "POST") {
            sendJson(res, 405, { error: "Use POST /orgx/api/live/activity/headline" });
            return true;
          }

          try {
            const payload = parseJsonBody(req.body);
            const text = pickString(payload, ["text", "summary", "detail", "content"]);
            if (!text) {
              sendJson(res, 400, { error: "text is required" });
              return true;
            }

            const title = pickString(payload, ["title", "name"]);
            const type = pickString(payload, ["type", "kind"]);
            const result = await summarizeActivityHeadline(
              {
                text,
                title,
                type,
              }
            );

            sendJson(res, 200, {
              headline: result.headline,
              source: result.source,
              model: result.model,
            });
          } catch (err: unknown) {
            sendJson(res, 500, {
              error: safeErrorMessage(err),
            });
          }
          return true;
        }

        case "live/agents": {
          try {
            const initiative = searchParams.get("initiative");
            const includeIdleRaw = searchParams.get("include_idle");
            const includeIdle =
              includeIdleRaw === null ? undefined : includeIdleRaw !== "false";
            const data = await client.getLiveAgents({
              initiative,
              includeIdle,
            });
            sendJson(res, 200, data);
          } catch (err: unknown) {
            try {
              const initiative = searchParams.get("initiative");
              const includeIdleRaw = searchParams.get("include_idle");
              const includeIdle =
                includeIdleRaw === null ? undefined : includeIdleRaw !== "false";

              const localSnapshot = await loadLocalOpenClawSnapshot(240);
              const local = toLocalLiveAgents(localSnapshot);

              let agents = local.agents;
              if (initiative && initiative.trim().length > 0) {
                agents = agents.filter((agent) => agent.initiativeId === initiative);
              }
              if (includeIdle === false) {
                agents = agents.filter((agent) => agent.status !== "idle");
              }

              const summary = agents.reduce<Record<string, number>>((acc, agent) => {
                acc[agent.status] = (acc[agent.status] ?? 0) + 1;
                return acc;
              }, {});

              sendJson(res, 200, { agents, summary });
            } catch (localErr: unknown) {
              sendJson(res, 500, {
                error: safeErrorMessage(err),
                localFallbackError: safeErrorMessage(localErr),
              });
            }
          }
          return true;
        }

        case "live/initiatives": {
          try {
            const id = searchParams.get("id");
            const limit = searchParams.get("limit")
              ? Number(searchParams.get("limit"))
              : undefined;
            const data = await client.getLiveInitiatives({
              id,
              limit: Number.isFinite(limit) ? limit : undefined,
            });
            sendJson(res, 200, data);
          } catch (err: unknown) {
            try {
              const id = searchParams.get("id");
              const limitRaw = searchParams.get("limit")
                ? Number(searchParams.get("limit"))
                : undefined;
              const limit = Number.isFinite(limitRaw) ? Math.max(1, Number(limitRaw)) : 100;

              const local = toLocalLiveInitiatives(await loadLocalOpenClawSnapshot(240));
              let initiatives = local.initiatives;
              if (id && id.trim().length > 0) {
                initiatives = initiatives.filter((item) => item.id === id);
              }

              sendJson(res, 200, {
                initiatives: initiatives.slice(0, limit),
                total: initiatives.length,
              });
            } catch (localErr: unknown) {
              sendJson(res, 500, {
                error: safeErrorMessage(err),
                localFallbackError: safeErrorMessage(localErr),
              });
            }
          }
          return true;
        }

        case "live/decisions": {
          try {
            const status = searchParams.get("status") ?? "pending";
            const limit = searchParams.get("limit")
              ? Number(searchParams.get("limit"))
              : 100;
            const data = await client.getLiveDecisions({
              status,
              limit: Number.isFinite(limit) ? limit : 100,
            });
            const decisions = data.decisions
              .map(mapDecisionEntity)
              .sort((a, b) => b.waitingMinutes - a.waitingMinutes);

            sendJson(res, 200, {
              decisions,
              total: data.total,
            });
          } catch {
            sendJson(res, 200, {
              decisions: [],
              total: 0,
            });
          }
          return true;
        }

        case "handoffs": {
          try {
            const data = await client.getHandoffs();
            sendJson(res, 200, data);
          } catch {
            sendJson(res, 200, { handoffs: [] });
          }
          return true;
        }

        case "live/stream": {
          const write = res.write?.bind(res);
          if (!write) {
            sendJson(res, 501, { error: "Streaming not supported" });
            return true;
          }
          const target = `${config.baseUrl.replace(/\/+$/, "")}/api/client/live/stream${queryString ? `?${queryString}` : ""}`;
          const streamAbortController = new AbortController();
          let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
          let closed = false;
          let streamOpened = false;
          let idleTimer: ReturnType<typeof setTimeout> | null = null;

          const clearIdleTimer = () => {
            if (idleTimer) {
              clearTimeout(idleTimer);
              idleTimer = null;
            }
          };

          const closeStream = () => {
            if (closed) return;
            closed = true;
            clearIdleTimer();
            streamAbortController.abort();
            if (reader) {
              void reader.cancel().catch(() => undefined);
            }
            if (streamOpened && !res.writableEnded) {
              res.end();
            }
          };

          const resetIdleTimer = () => {
            clearIdleTimer();
            idleTimer = setTimeout(() => {
              closeStream();
            }, STREAM_IDLE_TIMEOUT_MS);
          };

          try {
            const includeUserHeader =
              Boolean(config.userId && config.userId.trim().length > 0) &&
              !isUserScopedApiKey(config.apiKey);
            const upstream = await fetch(target, {
              method: "GET",
              headers: {
                Authorization: `Bearer ${config.apiKey}`,
                Accept: "text/event-stream",
                ...(includeUserHeader
                  ? { "X-Orgx-User-Id": config.userId }
                  : {}),
              },
              signal: streamAbortController.signal,
            });

            const contentType =
              upstream.headers.get("content-type")?.toLowerCase() ?? "";
            if (!upstream.ok || !contentType.includes("text/event-stream")) {
              const bodyPreview = (await upstream.text().catch(() => ""))
                .replace(/\s+/g, " ")
                .slice(0, 300);
              sendJson(res, upstream.ok ? 502 : upstream.status, {
                error: "Live stream endpoint unavailable",
                status: upstream.status,
                contentType,
                preview: bodyPreview || null,
              });
              return true;
            }

            res.writeHead(200, {
              "Content-Type": "text/event-stream; charset=utf-8",
              "Cache-Control": "no-cache, no-transform",
              Connection: "keep-alive",
              ...SECURITY_HEADERS,
              ...CORS_HEADERS,
            });
            streamOpened = true;

            if (!upstream.body) {
              closeStream();
              return true;
            }

            req.on?.("close", closeStream);
            req.on?.("aborted", closeStream);
            res.on?.("close", closeStream);
            res.on?.("finish", closeStream);

            reader = upstream.body.getReader();
            const streamReader = reader;
            resetIdleTimer();

            const waitForDrain = async (): Promise<void> => {
              if (typeof res.once === "function") {
                await new Promise<void>((resolve) => {
                  res.once?.("drain", () => resolve());
                });
              }
            };

            const pump = async () => {
              try {
                while (!closed) {
                  const { done, value } = await streamReader.read();
                  if (done) break;
                  if (!value || value.byteLength === 0) continue;

                  resetIdleTimer();
                  const accepted = write(Buffer.from(value));
                  if (accepted === false) {
                    await waitForDrain();
                  }
                }
              } catch {
                // Swallow pump errors; client disconnects are expected.
              } finally {
                closeStream();
              }
            };

            void pump();
          } catch (err: unknown) {
            closeStream();
            if (!streamOpened && !res.writableEnded) {
              sendJson(res, 500, {
                error: safeErrorMessage(err),
              });
            }
          }
          return true;
        }

        case "delegation/preflight": {
          sendJson(res, 405, { error: "Use POST /orgx/api/delegation/preflight" });
          return true;
        }

        default: {
          if (runCheckpointsMatch) {
            try {
              const runId = decodeURIComponent(runCheckpointsMatch[1]);
              const data = await client.listRunCheckpoints(runId);
              sendJson(res, 200, data);
            } catch (err: unknown) {
              sendJson(res, 500, {
                error: safeErrorMessage(err),
              });
            }
            return true;
          }

          if (runActionMatch || runCheckpointRestoreMatch) {
            sendJson(res, 405, { error: "Use POST for this endpoint" });
            return true;
          }

          sendJson(res, 404, { error: "Unknown API endpoint" });
          return true;
        }
      }
    }

    // ── Dashboard SPA + static assets ──────────────────────────────────────
    if (!dashboardEnabled) {
      res.writeHead(404, {
        "Content-Type": "text/plain",
        ...SECURITY_HEADERS,
        ...CORS_HEADERS,
      });
      res.end("Dashboard is disabled");
      return true;
    }

    // Requests under /orgx/live
    if (url === "/orgx/live" || url.startsWith("/orgx/live/")) {
      const subPath = url.replace(/^\/orgx\/live\/?/, "");

      // Static assets: /orgx/live/assets/* → dashboard/dist/assets/*
      // Hashed filenames get long-lived cache
      if (subPath.startsWith("assets/")) {
        const assetPath = resolveSafeDistPath(subPath);
        let isWithinAssetsDir = false;
        if (assetPath) {
          isWithinAssetsDir =
            assetPath === RESOLVED_DIST_ASSETS_DIR ||
            assetPath.startsWith(`${RESOLVED_DIST_ASSETS_DIR}${sep}`);
        }
        if (assetPath && isWithinAssetsDir && existsSync(assetPath)) {
          sendFile(
            res,
            assetPath,
            "public, max-age=31536000, immutable"
          );
        } else {
          send404(res);
        }
        return true;
      }

      // Check for an exact file match (e.g. favicon, manifest)
      if (subPath) {
        const filePath = resolveSafeDistPath(subPath);
        if (filePath && existsSync(filePath)) {
          sendFile(res, filePath, "no-cache");
          return true;
        }
      }

      // SPA fallback: serve index.html for all other routes under /orgx/live
      sendIndexHtml(res);
      return true;
    }

    // Catch-all for /orgx but not /orgx/live or /orgx/api
    if (url === "/orgx" || url === "/orgx/") {
      // Redirect to dashboard
      res.writeHead(302, {
        Location: "/orgx/live",
        ...SECURITY_HEADERS,
        ...CORS_HEADERS,
      });
      res.end();
      return true;
    }

    send404(res);
    return true;
  };
}
