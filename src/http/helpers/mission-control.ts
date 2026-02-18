import type { OrgXClient } from "../../api.js";
import type { Entity } from "../../types.js";
import { pickNumber, pickString, toIsoString } from "./value-utils.js";

export type MissionControlNodeType = "initiative" | "workstream" | "milestone" | "task";

export interface MissionControlAssignedAgent {
  id: string;
  name: string;
  domain: string | null;
}

export interface MissionControlNode {
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

export interface MissionControlEdge {
  from: string;
  to: string;
  kind: "depends_on";
}

export const ORGX_SKILL_BY_DOMAIN: Record<string, string> = {
  engineering: "orgx-engineering-agent",
  product: "orgx-product-agent",
  marketing: "orgx-marketing-agent",
  sales: "orgx-sales-agent",
  operations: "orgx-operations-agent",
  design: "orgx-design-agent",
  orchestration: "orgx-orchestrator-agent",
};

function safeErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  return "Unexpected error";
}

interface BudgetEnvBounds {
  min?: number;
  max?: number;
}

export function readBudgetEnvNumber(name: string, fallback: number, bounds: BudgetEnvBounds = {}): number {
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

export const DEFAULT_TOKEN_BUDGET_ASSUMPTIONS = {
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

const DEFAULT_DURATION_HOURS: Record<MissionControlNodeType, number> = {
  initiative: 40,
  workstream: 16,
  milestone: 6,
  task: 2,
};

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

export function pickStringArray(
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

export function dedupeStrings(items: string[]): string[] {
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

export function isTodoStatus(status: string): boolean {
  const normalized = status.toLowerCase();
  return (
    normalized === "todo" ||
    normalized === "not_started" ||
    normalized === "planned" ||
    normalized === "backlog" ||
    normalized === "pending"
  );
}

export function isInProgressStatus(status: string): boolean {
  const normalized = status.toLowerCase();
  return (
    normalized === "in_progress" ||
    normalized === "active" ||
    normalized === "running" ||
    normalized === "queued"
  );
}

export function isDispatchableWorkstreamStatus(status: string): boolean {
  const normalized = status.toLowerCase();
  if (!normalized) return true;
  return !(
    normalized === "blocked" ||
    normalized === "done" ||
    normalized === "completed" ||
    normalized === "cancelled" ||
    normalized === "archived" ||
    normalized === "deleted"
  );
}

export function isDoneStatus(status: string): boolean {
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

export async function listEntitiesSafe(
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

export async function buildMissionControlGraph(
  client: OrgXClient,
  initiativeId: string,
  options?: {
    initiativeEntity?: Entity | null;
  }
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
  const preloadedInitiative = options?.initiativeEntity ?? null;
  const [initiativeResult, workstreamResult, milestoneResult, taskResult] = await Promise.all([
    preloadedInitiative
      ? Promise.resolve<{ items: Entity[]; warning: string | null }>({
          items: [preloadedInitiative],
          warning: null,
        })
      : listEntitiesSafe(client, "initiative", { limit: 300 }),
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

export function normalizeEntityMutationPayload(
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

export async function resolveAutoAssignments(input: {
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

export function normalizeExecutionDomain(value: string | null | undefined): string | null {
  const raw = (value ?? "").trim().toLowerCase();
  if (!raw) return null;
  if (raw === "orchestrator") return "orchestration";
  if (raw === "ops") return "operations";
  return Object.prototype.hasOwnProperty.call(ORGX_SKILL_BY_DOMAIN, raw)
    ? raw
    : null;
}

export function inferExecutionDomainFromText(...values: Array<string | null | undefined>): string {
  const text = values
    .map((value) => (value ?? "").trim().toLowerCase())
    .filter((value) => value.length > 0)
    .join(" ");
  if (!text) return "engineering";
  if (/\b(marketing|campaign|copy|ad|content)\b/.test(text)) return "marketing";
  if (/\b(sales|meddic|pipeline|deal|outreach)\b/.test(text)) return "sales";
  if (/\b(design|ui|ux|brand|wcag)\b/.test(text)) return "design";
  if (/\b(product|prd|roadmap|prioritization)\b/.test(text)) return "product";
  if (/\b(ops|operations|incident|reliability|oncall|slo)\b/.test(text)) return "operations";
  if (/\b(orchestration|dispatch|handoff)\b/.test(text)) return "orchestration";
  return "engineering";
}

export function deriveExecutionPolicy(
  taskNode: MissionControlNode,
  workstreamNode: MissionControlNode | null
): { domain: string; requiredSkills: string[] } {
  const domainCandidate =
    taskNode.assignedAgents
      .map((agent) => normalizeExecutionDomain(agent.domain))
      .find((domain): domain is string => Boolean(domain)) ??
    (workstreamNode
      ? workstreamNode.assignedAgents
          .map((agent) => normalizeExecutionDomain(agent.domain))
          .find((domain): domain is string => Boolean(domain))
      : null) ??
    inferExecutionDomainFromText(taskNode.title, workstreamNode?.title ?? null);

  const domain = normalizeExecutionDomain(domainCandidate) ?? "engineering";
  const requiredSkill = ORGX_SKILL_BY_DOMAIN[domain] ?? ORGX_SKILL_BY_DOMAIN.engineering;
  return { domain, requiredSkills: [requiredSkill] };
}

export function spawnGuardIsRateLimited(result: unknown): boolean {
  if (!result || typeof result !== "object") return false;
  const record = result as Record<string, unknown>;
  const checks = record.checks;
  if (!checks || typeof checks !== "object") return false;
  const rateLimit = (checks as Record<string, unknown>).rateLimit;
  if (!rateLimit || typeof rateLimit !== "object") return false;
  return (rateLimit as Record<string, unknown>).passed === false;
}

export function summarizeSpawnGuardBlockReason(result: unknown): string {
  if (!result || typeof result !== "object") return "Spawn guard denied dispatch.";
  const record = result as Record<string, unknown>;
  const blockedReason = pickString(record, ["blockedReason", "blocked_reason"]);
  if (blockedReason) return blockedReason;
  if (spawnGuardIsRateLimited(result)) {
    return "Spawn guard rate limit reached.";
  }
  return "Spawn guard denied dispatch.";
}
