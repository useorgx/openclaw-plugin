/**
 * Team Context Store — Local cache for cross-agent awareness.
 *
 * Persists recent slice completions and decisions per initiative so the
 * auto-continue engine can provide degraded team context when the server
 * is unreachable (offline fallback for KickoffContext.team_context).
 *
 * Follows the same patterns as agent-context-store.ts: bounded store,
 * atomic writes, corrupt file recovery.
 */
import { existsSync, readFileSync } from "node:fs";

import { getOrgxPluginConfigDir, getOrgxPluginConfigPath } from "./paths.js";
import { backupCorruptFileSync, writeJsonFileAtomicSync } from "./fs-utils.js";
import {
  clearStoreFileSync,
  ensureStoreDirSync,
  parseJsonSafe,
} from "./stores/json-store.js";

export type TeamCompletion = {
  domain: string;
  task_title: string;
  summary: string;
  key_outputs?: string[];
  completed_at: string;
};

export type TeamDecision = {
  title: string;
  resolution: string;
  affected_domains?: string[];
  resolved_at: string;
};

type PersistedTeamContext = {
  updatedAt: string;
  recent_completions: TeamCompletion[];
  recent_decisions: TeamDecision[];
};

type TeamContextIndex = {
  /** Keyed by initiative ID. */
  initiatives: Record<string, PersistedTeamContext>;
};

const MAX_COMPLETIONS = 20;
const MAX_DECISIONS = 20;
const MAX_INITIATIVES = 50;

function storeDir(): string {
  return getOrgxPluginConfigDir();
}

function storeFile(): string {
  return getOrgxPluginConfigPath("team-context.json");
}

function emptyContext(): PersistedTeamContext {
  return { updatedAt: new Date().toISOString(), recent_completions: [], recent_decisions: [] };
}

function emptyIndex(): TeamContextIndex {
  return { initiatives: {} };
}

function isValidIndex(value: unknown): value is TeamContextIndex {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return record.initiatives !== undefined && typeof record.initiatives === "object";
}

function readIndex(): TeamContextIndex {
  const file = storeFile();
  try {
    if (!existsSync(file)) return emptyIndex();
    const raw = readFileSync(file, "utf8");
    const parsed = parseJsonSafe<TeamContextIndex>(raw);
    if (!isValidIndex(parsed)) {
      backupCorruptFileSync(file);
      return emptyIndex();
    }
    return parsed;
  } catch {
    return emptyIndex();
  }
}

function writeIndex(index: TeamContextIndex): void {
  ensureStoreDirSync(storeDir());
  // Prune if too many initiatives.
  const keys = Object.keys(index.initiatives);
  if (keys.length > MAX_INITIATIVES) {
    const sorted = keys
      .map((k) => ({ key: k, updatedAt: index.initiatives[k]?.updatedAt ?? "" }))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    const keep = new Set(sorted.slice(0, MAX_INITIATIVES).map((e) => e.key));
    for (const key of keys) {
      if (!keep.has(key)) delete index.initiatives[key];
    }
  }
  writeJsonFileAtomicSync(storeFile(), index, 0o600);
}

export function readTeamContext(initiativeId: string): PersistedTeamContext {
  const id = initiativeId.trim();
  if (!id) return emptyContext();
  const index = readIndex();
  const ctx = index.initiatives[id];
  return ctx ?? emptyContext();
}

export function appendTeamCompletion(
  initiativeId: string,
  completion: TeamCompletion
): void {
  const id = initiativeId.trim();
  if (!id) return;
  const index = readIndex();
  const ctx = index.initiatives[id] ?? emptyContext();
  ctx.recent_completions.push(completion);
  if (ctx.recent_completions.length > MAX_COMPLETIONS) {
    ctx.recent_completions = ctx.recent_completions.slice(-MAX_COMPLETIONS);
  }
  ctx.updatedAt = new Date().toISOString();
  index.initiatives[id] = ctx;
  writeIndex(index);
}

export function appendTeamDecision(
  initiativeId: string,
  decision: TeamDecision
): void {
  const id = initiativeId.trim();
  if (!id) return;
  const index = readIndex();
  const ctx = index.initiatives[id] ?? emptyContext();
  ctx.recent_decisions.push(decision);
  if (ctx.recent_decisions.length > MAX_DECISIONS) {
    ctx.recent_decisions = ctx.recent_decisions.slice(-MAX_DECISIONS);
  }
  ctx.updatedAt = new Date().toISOString();
  index.initiatives[id] = ctx;
  writeIndex(index);
}

export function clearTeamContext(initiativeId?: string): void {
  if (!initiativeId) {
    clearStoreFileSync(storeFile());
    return;
  }
  const id = initiativeId.trim();
  if (!id) return;
  const index = readIndex();
  delete index.initiatives[id];
  writeIndex(index);
}
