/**
 * OrgX Clawdbot Plugin — Shared Types
 *
 * Types for the plugin's API client and tool interfaces.
 * Mirrors the server-side types in orgx/lib/client-integration/types.ts
 */

// =============================================================================
// CONFIGURATION
// =============================================================================

export interface OrgXConfig {
  /** OrgX API key */
  apiKey: string;
  /** OrgX user ID for X-Orgx-User-Id header */
  userId: string;
  /** OrgX API base URL */
  baseUrl: string;
  /** Background sync interval in ms */
  syncIntervalMs: number;
  /** Plugin enabled */
  enabled: boolean;
}

// =============================================================================
// ORG SNAPSHOT
// =============================================================================

export interface OrgSnapshot {
  /** Active initiatives */
  initiatives: Initiative[];
  /** Agent states */
  agents: AgentState[];
  /** Active tasks across workstreams */
  activeTasks: TaskSummary[];
  /** Pending decisions needing attention */
  pendingDecisions: Decision[];
  /** Last sync timestamp */
  syncedAt: string;
}

export interface Initiative {
  id: string;
  title: string;
  status: string;
  progress?: number;
  workstreams?: string[];
}

export interface AgentState {
  id: string;
  name: string;
  domain: string;
  status: "active" | "idle" | "throttled";
  currentTask?: string;
  lastActive?: string;
}

export interface TaskSummary {
  id: string;
  title: string;
  status: string;
  domain?: string;
  modelTier?: ModelTier;
  assignee?: string;
}

export interface Decision {
  id: string;
  title: string;
  urgency: "low" | "medium" | "high";
  context?: string;
}

// =============================================================================
// MEMORY SYNC
// =============================================================================

export interface SyncPayload {
  /** Client-side memory snapshot */
  memory?: string;
  /** Today's session log */
  dailyLog?: string;
  /** Decisions made this session */
  decisions?: Array<{
    id: string;
    action: "approved" | "rejected";
    note?: string;
  }>;
}

export interface SyncResponse {
  /** Active initiatives summary */
  initiatives: Array<{
    id: string;
    title: string;
    status: string;
  }>;
  /** In-progress tasks */
  activeTasks: Array<{
    id: string;
    title: string;
    status: string;
    domain?: string;
    modelTier: ModelTier;
  }>;
  /** Pending decisions needing attention */
  pendingDecisions: Array<{
    id: string;
    title: string;
    urgency: "low" | "medium" | "high";
  }>;
  /** Quality stats per domain */
  qualityStats: QualityStats[];
  /** Model routing policy */
  modelPolicy: ModelRoutingPolicy;
  /** Server timestamp */
  syncedAt: string;
}

// =============================================================================
// MODEL ROUTING
// =============================================================================

export type ModelTier = "opus" | "sonnet" | "local";
export type TaskComplexity = "planning" | "execution" | "routine";

export interface ModelRouting {
  tier: ModelTier;
  reason: string;
  complexity: TaskComplexity;
  estimatedTokens: number;
}

export interface ModelRoutingPolicy {
  planningPatterns: string[];
  executionPatterns: string[];
  routinePatterns: string[];
  domainOverrides: Record<string, ModelTier>;
  budget: {
    dailyUsd: number;
    opusMaxPercentage: number;
    localMinPercentage: number;
  };
}

// =============================================================================
// QUALITY GATES
// =============================================================================

export interface QualityScore {
  taskId: string;
  domain: string;
  score: number; // 1-5
  notes?: string;
  scoredBy?: "human" | "auto" | "peer";
}

export interface QualityStats {
  domain: string;
  totalTasks: number;
  avgScore: number;
  recentTrend: "improving" | "stable" | "declining";
  isThrottled: boolean;
  throttleReason?: string;
}

export interface SpawnGuardResult {
  allowed: boolean;
  modelTier: ModelTier;
  checks: {
    rateLimit: { passed: boolean; current: number; max: number };
    qualityGate: { passed: boolean; score: number; threshold: number };
    taskAssigned: { passed: boolean; taskId?: string; status?: string };
  };
  blockedReason?: string;
}

// =============================================================================
// ENTITIES (CRUD)
// =============================================================================

export interface Entity {
  id: string;
  type: string;
  title: string;
  summary?: string;
  status?: string;
  parentId?: string;
  createdAt?: string;
  updatedAt?: string;
  [key: string]: unknown;
}

export interface EntityCreatePayload {
  title: string;
  summary?: string;
  status?: string;
  parentId?: string;
  [key: string]: unknown;
}

export interface EntityUpdatePayload {
  [key: string]: unknown;
}

export interface EntityListFilters {
  status?: string;
  limit?: number;
  [key: string]: unknown;
}
