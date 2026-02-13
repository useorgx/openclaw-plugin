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
  /** Optional legacy user ID for service-key mode (unused for oxk_ keys) */
  userId: string;
  /** OrgX API base URL */
  baseUrl: string;
  /** Background sync interval in ms */
  syncIntervalMs: number;
  /** Plugin enabled */
  enabled: boolean;
}

export type OnboardingStatus =
  | 'idle'
  | 'starting'
  | 'awaiting_browser_auth'
  | 'pairing'
  | 'connected'
  | 'error'
  | 'manual_key';

export type OnboardingNextAction =
  | 'connect'
  | 'wait_for_browser'
  | 'open_dashboard'
  | 'enter_manual_key'
  | 'retry'
  | 'reconnect';

export interface OnboardingState {
  status: OnboardingStatus;
  hasApiKey: boolean;
  connectionVerified: boolean;
  workspaceName: string | null;
  lastError: string | null;
  nextAction: OnboardingNextAction;
  docsUrl: string;
  keySource:
    | 'config'
    | 'environment'
    | 'persisted'
    | 'openclaw-config-file'
    | 'legacy-dev'
    | 'none';
  installationId: string | null;
  connectUrl: string | null;
  pairingId: string | null;
  expiresAt: string | null;
  pollIntervalMs: number | null;
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

// =============================================================================
// KICKOFF CONTEXT (RICH LAUNCH PAYLOADS)
// =============================================================================

export type KickoffContextScope = {
  initiative_id?: string | null;
  workstream_id?: string | null;
  task_id?: string | null;
};

export type KickoffContextEntityRef = {
  id: string;
  title: string;
  status?: string | null;
  summary?: string | null;
  url?: string | null;
  metadata?: Record<string, unknown> | null;
};

export type KickoffContextToolScope = {
  allow?: string[];
  deny?: string[];
  notes?: string | null;
};

export interface KickoffContext {
  /** Deterministic hash of the payload used to render a kickoff message. */
  context_hash: string;
  /** Optional schema version for forward/back compat. */
  schema_version?: string | null;
  /** Human-friendly overview sentence(s). */
  overview?: string | null;

  initiative?: KickoffContextEntityRef | null;
  workstream?: KickoffContextEntityRef | null;
  task?: (KickoffContextEntityRef & { description?: string | null; checklist?: string[] | null }) | null;

  acceptance_criteria?: string[] | null;
  constraints?: string[] | null;
  risks?: string[] | null;

  decisions?: KickoffContextEntityRef[] | null;
  artifacts?: KickoffContextEntityRef[] | null;

  tool_scope?: KickoffContextToolScope | null;
  reporting_expectations?: string[] | null;

  /** Server-provided hints for agent tone/behavior; optional. */
  persona?: {
    voice?: string | null;
    collaboration_style?: string | null;
    defaults?: string[] | null;
  } | null;
}

export type KickoffContextRequest = KickoffContextScope & {
  agent_id?: string | null;
  domain?: string | null;
  required_skills?: string[] | null;
  message?: string | null;
};

export type KickoffContextResponse = { ok: true; data: KickoffContext } | { ok: false; error: string };

// =============================================================================
// AGENT PACKS (OPENCLAW PROVISIONING CONTRACT)
// =============================================================================

export type OrgxAgentDomain =
  | "engineering"
  | "product"
  | "design"
  | "marketing"
  | "sales"
  | "operations"
  | "orchestration";

/**
 * AgentProfile describes the stable agent identity + workspace configuration
 * needed to instantiate OrgX agents in OpenClaw.
 *
 * Note: this is a provisioning contract (what to install/configure), not an
 * execution record (runs/sessions).
 */
export type OrgxAgentProfile = {
  id: string;
  name: string;
  domain: OrgxAgentDomain;
  workspace: string;
  required_skills?: string[] | null;
  tool_scope?: KickoffContextToolScope | null;
  persona?: KickoffContext["persona"] | null;
};

export type OrgxAgentPack = {
  pack_id: string;
  pack_version: string;
  schema_version?: string | null;
  skill_pack?: { name: string; version: string; checksum: string } | null;
  agents: OrgxAgentProfile[];
  managed_files: string[];
};

// =============================================================================
// SKILL PACKS (CANONICAL SKILLS FOR DESKTOP CLIENTS)
// =============================================================================

export type SkillPack = {
  name: string;
  version: string;
  checksum: string;
  status?: "draft" | "pending_review" | "approved" | "rejected" | string;
  manifest: Record<string, unknown>;
  required_scopes?: string[] | null;
  required_tools?: string[] | null;
  updated_at?: string | null;
};

/**
 * Canonical manifest shape expected by the OpenClaw plugin.
 *
 * Stored in `skill_packs.manifest` on the OrgX server.
 */
export type OpenClawSkillPackManifestV1 = {
  schema_version: string;
  openclaw_skills: Partial<Record<OrgxAgentDomain, string>>;
};

export type SkillPackResponse = { ok: true; data: SkillPack } | { ok: false; error: string };

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
  /** Workspace state for local↔cloud handoff continuity */
  workspaceState?: HandoffWorkspaceState;
  /** Decisions made this session */
  decisions?: Array<{
    id: string;
    action: "approved" | "rejected";
    note?: string;
  }>;
  /** Optional sync cursor from client */
  memoryCursor?: {
    lastSyncEventId?: string;
    lastAppliedHandoffId?: string;
  };
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
  /** Workspace state echo and server-side handoff status */
  workspaceState: HandoffWorkspaceState;
  /** Sync cursor for incremental sync */
  memoryCursor: {
    lastSyncEventId: string | null;
    lastAppliedHandoffId: string | null;
  };
  /** Server timestamp */
  syncedAt: string;
}

// =============================================================================
// BILLING (API-KEY CLIENTS)
// =============================================================================

export type BillingPlan = "free" | "starter" | "team" | "enterprise";

export interface BillingStatus {
  plan: BillingPlan;
  hasSubscription: boolean;
  subscriptionStatus: string | null;
  subscriptionCurrentPeriodEnd: string | null;
}

export type BillingCycle = "monthly" | "annual";

export interface BillingCheckoutRequest {
  planId: Exclude<BillingPlan, "free">;
  billingCycle?: BillingCycle;
}

export interface BillingUrlResult {
  url: string | null;
  checkout_url?: string | null;
}

// =============================================================================
// RUN PHASES + HANDOFF CONTINUITY
// =============================================================================

export type RunPhase =
  | 'intent'
  | 'execution'
  | 'blocked'
  | 'review'
  | 'handoff'
  | 'completed';

export interface HandoffWorkspaceState {
  git?: {
    branch?: string | null;
    headSha?: string | null;
    dirtyFiles?: string[];
    untrackedFilesCount?: number;
  };
  handoff?: {
    pendingHandoffIds?: string[];
    lastAppliedHandoffId?: string | null;
  };
  memoryCursor?: {
    lastSyncEventId?: string | null;
  };
}

// =============================================================================
// CHECKPOINTS + RESTORE
// =============================================================================

export interface CheckpointSummary {
  id: string;
  runId: string;
  createdAt: string;
  tokenCount: number;
  stepId?: string | null;
  summary?: string | null;
  payload: Record<string, unknown>;
}

export interface RestoreRequest {
  checkpointId: string;
  reason?: string;
}

// =============================================================================
// DELEGATION PREFLIGHT
// =============================================================================

export interface DelegationPreflightResult {
  scope_quality: 'strong' | 'workable' | 'ambiguous';
  ambiguities: string[];
  eta_range: {
    min_minutes: number;
    max_minutes: number;
    confidence: number;
  };
  cost_estimate: {
    min_usd: number;
    max_usd: number;
    basis: 'heuristic';
  };
  recommended_split: Array<{
    id: string;
    title: string;
    owner_domain: string;
    acceptance_criteria: string[];
  }>;
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

// =============================================================================
// REPORTING CONTROL PLANE
// =============================================================================

export type ReportingSourceClient = 'openclaw' | 'codex' | 'claude-code' | 'api';
export type RuntimeSourceClient = ReportingSourceClient | 'unknown';
export type ReportingPhase =
  | 'intent'
  | 'execution'
  | 'blocked'
  | 'review'
  | 'handoff'
  | 'completed';
export type ReportingLevel = 'info' | 'warn' | 'error';
export type TaskStatus = 'todo' | 'in_progress' | 'done' | 'blocked';
export type MilestoneStatus =
  | 'planned'
  | 'in_progress'
  | 'completed'
  | 'at_risk'
  | 'cancelled';
export type DecisionUrgency = 'low' | 'medium' | 'high' | 'urgent';

export interface EmitActivityRequest {
  initiative_id: string;
  message: string;
  run_id?: string;
  correlation_id?: string;
  source_client?: ReportingSourceClient;
  phase?: ReportingPhase;
  progress_pct?: number;
  level?: ReportingLevel;
  next_step?: string;
  metadata?: Record<string, unknown>;
}

export interface EmitActivityResponse {
  ok: true;
  run_id: string;
  event_id: string | null;
  reused_run: boolean;
  auth_mode?: 'service' | 'api_key';
}

export type ChangesetOperation =
  | {
      op: 'task.create';
      title: string;
      milestone_id?: string;
      workstream_id?: string;
      description?: string;
      priority?: 'low' | 'medium' | 'high';
      due_date?: string;
    }
  | {
      op: 'task.update';
      task_id: string;
      status?: TaskStatus;
      title?: string;
      description?: string;
      priority?: 'low' | 'medium' | 'high';
      due_date?: string;
    }
  | {
      op: 'milestone.update';
      milestone_id: string;
      status?: MilestoneStatus;
      due_date?: string;
      description?: string;
    }
  | {
      op: 'decision.create';
      title: string;
      summary?: string;
      urgency?: DecisionUrgency;
      options?: string[];
      blocking?: boolean;
    };

export interface ApplyChangesetRequest {
  initiative_id: string;
  idempotency_key: string;
  operations: ChangesetOperation[];
  run_id?: string;
  correlation_id?: string;
  source_client?: ReportingSourceClient;
}

export interface ApplyChangesetResponse {
  ok: boolean;
  changeset_id: string;
  replayed: boolean;
  run_id: string;
  applied_count: number;
  results: Record<string, unknown>[];
  event_id: string | null;
  auth_mode?: 'service' | 'api_key';
}

export interface RecordRunOutcomeRequest {
  initiative_id: string;
  execution_id: string;
  execution_type: string;
  agent_id: string;
  task_type?: string;
  domain?: string;
  started_at?: string;
  completed_at?: string;
  inputs?: Record<string, unknown>;
  outputs?: Record<string, unknown>;
  steps?: Array<Record<string, unknown>>;
  success: boolean;
  quality_score?: number;
  duration_vs_estimate?: number;
  cost_vs_budget?: number;
  human_interventions?: number;
  user_satisfaction?: number;
  errors?: string[];
  metadata?: Record<string, unknown>;
  run_id?: string;
  correlation_id?: string;
  source_client?: ReportingSourceClient;
}

export interface RecordRunOutcomeResponse {
  ok: true;
  run_id: string;
  reused_run: boolean;
  execution_id: string;
  event_id: string | null;
  auth_mode?: 'service' | 'api_key';
}

export type RetroFollowUpPriority = 'p0' | 'p1' | 'p2';

export interface RetroJson {
  summary: string;
  what_went_well?: string[];
  what_went_wrong?: string[];
  decisions?: string[];
  follow_ups?: Array<{ title: string; priority?: RetroFollowUpPriority; reason?: string }>;
  signals?: Record<string, unknown>;
}

export type RetroEntityType = 'initiative' | 'workstream' | 'milestone' | 'task';

export interface RecordRunRetroRequest {
  initiative_id: string;
  entity_type?: RetroEntityType;
  entity_id?: string;
  title?: string;
  idempotency_key?: string;
  retro: RetroJson;
  markdown?: string;
  run_id?: string;
  correlation_id?: string;
  source_client?: ReportingSourceClient;
}

export interface RecordRunRetroResponse {
  ok: true;
  run_id: string;
  reused_run: boolean;
  work_artifact_id: string | null;
  run_step_id: string | null;
  run_artifact_id: string | null;
  event_id: string | null;
  auth_mode?: 'service' | 'api_key';
}

// =============================================================================
// LIVE SESSION GRAPH + HANDOFFS
// =============================================================================

export type LiveActivityType =
  | 'run_started'
  | 'run_completed'
  | 'run_failed'
  | 'artifact_created'
  | 'decision_requested'
  | 'decision_resolved'
  | 'handoff_requested'
  | 'handoff_claimed'
  | 'handoff_fulfilled'
  | 'blocker_created'
  | 'milestone_completed'
  | 'delegation';

export type RuntimeInstanceState = 'active' | 'stale' | 'stopped' | 'error';

export interface RuntimeInstance {
  id: string;
  sourceClient: RuntimeSourceClient;
  displayName: string;
  providerLogo: 'openai' | 'anthropic' | 'openclaw' | 'orgx' | 'unknown';
  state: RuntimeInstanceState;
  runId: string | null;
  correlationId: string | null;
  initiativeId: string | null;
  workstreamId: string | null;
  taskId: string | null;
  agentId: string | null;
  agentName: string | null;
  phase: string | null;
  progressPct: number | null;
  currentTask: string | null;
  lastHeartbeatAt: string | null;
  lastEventAt: string;
  lastMessage: string | null;
  metadata: Record<string, unknown> | null;
}

export interface LiveActivityItem {
  id: string;
  type: LiveActivityType;
  title: string;
  description: string | null;
  agentId: string | null;
  agentName: string | null;
  runId: string | null;
  initiativeId: string | null;
  timestamp: string;
  phase?: RunPhase | null;
  state?: string | null;
  kind?: string | null;
  summary?: string | null;
  decisionRequired?: boolean;
  costDelta?: number | null;
  runtimeClient?: RuntimeSourceClient | null;
  runtimeLabel?: string | null;
  runtimeProvider?: RuntimeInstance['providerLogo'] | null;
  instanceId?: string | null;
  lastHeartbeatAt?: string | null;
  metadata?: Record<string, unknown>;
}

export interface SessionTreeNode {
  id: string;
  parentId: string | null;
  runId: string;
  title: string;
  agentId: string | null;
  agentName: string | null;
  status: string;
  progress: number | null;
  initiativeId: string | null;
  workstreamId: string | null;
  groupId: string;
  groupLabel: string;
  startedAt: string | null;
  updatedAt: string | null;
  lastEventAt: string | null;
  lastEventSummary: string | null;
  blockers: string[];
  phase?: RunPhase | null;
  state?: string | null;
  eta?: string | null;
  cost?: number | null;
  checkpointCount?: number | null;
  blockerReason?: string | null;
  runtimeClient?: RuntimeSourceClient | null;
  runtimeLabel?: string | null;
  runtimeProvider?: RuntimeInstance['providerLogo'] | null;
  instanceId?: string | null;
  lastHeartbeatAt?: string | null;
}

export interface SessionTreeEdge {
  parentId: string;
  childId: string;
}

export interface SessionTreeGroup {
  id: string;
  label: string;
  status: string | null;
}

export interface SessionTreeResponse {
  nodes: SessionTreeNode[];
  edges: SessionTreeEdge[];
  groups: SessionTreeGroup[];
}

export interface HandoffEvent {
  id: string;
  handoffId: string;
  eventType: string;
  actorType: string | null;
  actorId: string | null;
  payload: Record<string, unknown> | null;
  createdAt: string;
}

export interface HandoffSummary {
  id: string;
  title: string;
  status: string;
  priority: string | null;
  summary: string | null;
  currentActorType: string | null;
  currentActorId: string | null;
  createdAt: string;
  updatedAt: string;
  events: HandoffEvent[];
}
