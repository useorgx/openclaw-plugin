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
 *   /orgx/api/onboarding → onboarding / config state
 *   /orgx/api/delegation/preflight → delegation preflight
 *   /orgx/api/runs/:id/checkpoints → list/create checkpoints
 *   /orgx/api/runs/:id/checkpoints/:checkpointId/restore → restore checkpoint
 *   /orgx/api/runs/:id/actions/:action → run control action
 */

import { readFileSync, existsSync } from "node:fs";
import { join, extname } from "node:path";
import { fileURLToPath } from "node:url";

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
  toLocalLiveActivity,
  toLocalLiveAgents,
  toLocalLiveInitiatives,
  toLocalSessionTree,
} from "./local-openclaw.js";
import { readAllOutboxItems } from "./outbox.js";

// =============================================================================
// Helpers
// =============================================================================

function safeErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  return "Unexpected error";
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
// CORS headers (for local dev)
// =============================================================================

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PATCH, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

const STREAM_IDLE_TIMEOUT_MS = 60_000;

// =============================================================================
// Resolve the dashboard/dist/ directory relative to this file
// =============================================================================

const __filename = fileURLToPath(import.meta.url);
// src/http-handler.ts → up to plugin root → dashboard/dist
const DIST_DIR = join(__filename, "..", "..", "dashboard", "dist");

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
    DEFAULT_DURATION_HOURS[type];

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

  const recentTodos = nodes
    .filter((node) => node.type === "task" && isTodoStatus(node.status))
    .sort((a, b) => {
      const aEpoch = a.updatedAt ? Date.parse(a.updatedAt) : 0;
      const bEpoch = b.updatedAt ? Date.parse(b.updatedAt) : 0;
      return bEpoch - aEpoch;
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
  onboarding: OnboardingController
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
      res.writeHead(204, CORS_HEADERS);
      res.end();
      return true;
    }

    // ── API endpoints ──────────────────────────────────────────────────────
    if (url.startsWith("/orgx/api/")) {
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

          const userId =
            pickString(payload, ["userId", "user_id"]) ??
            pickHeaderString(req.headers, ["x-orgx-user-id", "x-user-id"]) ??
            undefined;
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
        !(isOnboardingDisconnectRoute && method === "POST")
      ) {
        res.writeHead(405, {
          "Content-Type": "text/plain",
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

        case "agents":
          sendJson(res, 200, formatAgents(getSnapshot()));
          return true;

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

          const degraded: string[] = [];

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

              sendJson(res, 200, {
                activities: local.activities.slice(0, limit),
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
            const upstream = await fetch(target, {
              method: "GET",
              headers: {
                Authorization: `Bearer ${config.apiKey}`,
                Accept: "text/event-stream",
                ...(config.userId
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
        const assetPath = join(DIST_DIR, subPath);
        if (existsSync(assetPath)) {
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
      if (subPath && !subPath.includes("..")) {
        const filePath = join(DIST_DIR, subPath);
        if (existsSync(filePath)) {
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
        ...CORS_HEADERS,
      });
      res.end();
      return true;
    }

    send404(res);
    return true;
  };
}
