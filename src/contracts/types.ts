/**
 * OrgX Clawdbot Plugin — Shared Types
 *
 * Types for the plugin's API client and tool interfaces.
 * Mirrors the server-side types in orgx/lib/client-integration/types.ts
 */

import type { DecisionActionType } from './shared-types.js';
import type { RetroArtifactSchemaVersion } from './retro-schema.js';

export type {
  ActivityEventName,
  HandoffEvent,
  HandoffSummary,
  LiveActivityItem,
  LiveActivityType,
  LiveDecision,
  OnboardingKeySource,
  OnboardingNextAction,
  OnboardingState,
  OnboardingStatus,
  RunPhase,
  RuntimeInstance,
  RuntimeInstanceState,
  RuntimeProviderLogo,
  RuntimeSourceClient,
  SessionBlockerContext,
  SessionBlockerDiagnostics,
  SessionTreeEdge,
  SessionTreeGroup,
  SessionTreeNode,
  SessionTreeResponse,
} from './shared-types.js';

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
  /**
   * When true (default), provision/update the OrgX agent suite automatically
   * after a successful connection/sync.
   *
   * Safe by default: provisioning uses managed/local overlays and skips files
   * that appear to have out-of-band edits ("conflict").
   */
  autoInstallAgentSuiteOnConnect?: boolean;
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
  runtime_settings?: {
    decision_v2_enabled?: boolean;
    decision_dedupe_enabled?: boolean;
    decision_evidence_required_for_blocking?: boolean;
    decision_auto_resolve_guarded_enabled?: boolean;
    question_auto_answer_enabled?: boolean;
    question_auto_answer_timeout_sec?: number;
    question_auto_answer_policy?: "contextual" | "approve_non_blocking" | "defer_non_blocking";
    question_blocking_behavior?: "require_human" | "guarded_auto_resolve_then_human";
    question_policy_version?: number;
    question_auto_answer_delay_seconds?: number;
    question_auto_answer_action?: "approve" | "reject";
    workspace_question_defaults?: {
      question_auto_answer_enabled?: boolean;
      question_auto_answer_timeout_sec?: number;
      question_auto_answer_policy?: "contextual" | "approve_non_blocking" | "defer_non_blocking";
      question_blocking_behavior?: "require_human" | "guarded_auto_resolve_then_human";
    } | null;
    custom_run_instructions?: string | null;
  } | null;

  /** Recent team activity for cross-agent awareness. */
  team_context?: {
    recent_completions?: Array<{
      domain: string;
      task_title: string;
      summary: string;
      key_outputs?: string[];
      completed_at: string;
    }>;
    recent_decisions?: Array<{
      title: string;
      resolution: string;
      affected_domains?: string[];
      resolved_at: string;
    }>;
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

export interface AgentRuntimeSettingsPayload {
  decision_v2_enabled?: boolean;
  decision_dedupe_enabled?: boolean;
  decision_evidence_required_for_blocking?: boolean;
  decision_auto_resolve_guarded_enabled?: boolean;
  question_auto_answer_enabled?: boolean;
  question_auto_answer_timeout_sec?: number;
  question_auto_answer_policy?: "contextual" | "approve_non_blocking" | "defer_non_blocking";
  question_blocking_behavior?: "require_human" | "guarded_auto_resolve_then_human";
  question_policy_version?: number;
  question_auto_answer_delay_seconds?: number;
  question_auto_answer_action?: "approve" | "reject";
  custom_run_instructions?: string | null;
}

export interface ClientRuntimeSettingsAgent {
  id: string;
  name: string;
  type: string;
  status: string;
  model: string | null;
  runtime_settings: AgentRuntimeSettingsPayload;
}

export type ClientRuntimeSettingsResponse =
  | {
      ok: true;
      workspace_id?: string | null;
      /** Legacy alias retained for backward compatibility */
      project_id?: string | null;
      agents?: ClientRuntimeSettingsAgent[];
      agent?: ClientRuntimeSettingsAgent;
    }
  | { ok: false; error: string };

export interface ClientRuntimeSettingsUpdateRequest {
  /** Canonical workspace scope */
  workspace_id?: string;
  /** Legacy alias retained for backward compatibility */
  command_center_id?: string;
  /** Legacy alias retained for backward compatibility */
  project_id?: string;
  agent_id: string;
  runtime_settings: AgentRuntimeSettingsPayload;
}

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
  /** Local OpenClaw agent states to mirror into OrgX */
  agents?: AgentState[];
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
  /** Agent states (optional for backward compatibility with older servers) */
  agents?: AgentState[];
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
// Preferred MCP Read Surfaces
// =============================================================================

export type OrgMemoryScope = 'all' | 'artifacts' | 'decisions' | 'initiatives';

export interface OrgMemoryQueryRequest {
  query: string;
  scope?: OrgMemoryScope;
  limit?: number;
}

export interface OrgMemoryQueryResponse {
  query: string;
  scope: OrgMemoryScope;
  plan?: string | null;
  retention_window_days?: number | null;
  retention_applied?: boolean;
  results: Array<{
    id: string;
    type: string;
    title: string;
    summary?: string | null;
    relevance_score?: number | null;
    created_at?: string | null;
  }>;
  total_found: number;
  message?: string;
  suggested_followups?: string[];
}

export interface RecommendNextActionRequest {
  entity_type?: 'workspace' | 'initiative' | 'workstream' | 'milestone';
  entity_id?: string;
  workspace_id?: string;
  command_center_id?: string;
  limit?: number;
  cascade?: boolean;
}

export interface RecommendNextActionResponse {
  entity_type: string;
  entity_id?: string | null;
  workspace_id?: string | null;
  command_center_id?: string | null;
  recommendations: Array<Record<string, unknown>>;
  next_action?: Record<string, unknown> | null;
  capability_gaps?: Array<Record<string, unknown>>;
  message?: string;
}

export interface MorningBriefResponse {
  workspace_id: string;
  session_summary: Record<string, unknown> | null;
  intelligence?: Record<string, unknown>;
  exceptions?: Array<Record<string, unknown>>;
  trust_events?: Array<Record<string, unknown>>;
  top_receipts?: Array<Record<string, unknown>>;
  brief_markdown?: string | null;
  message?: string;
}

// =============================================================================
// Usage Control Plane (Actual vs Forecast)
// =============================================================================

export type UsageRiskLevel = "safe" | "watch" | "at_risk" | "over_limit";

export type UsageBreakdownBucket = {
  key: string;
  label: string;
  runs: number;
  tokens: number;
  minutes: number;
  costCents: number;
};

export type UsagePrediction = {
  agentRuns: number;
  agentMinutes: number;
  tokens: number;
  costCents: number;
  confidence: number;
  method: string;
  remainingAgentRuns: number;
  remainingAgentMinutes: number;
  remainingTokens: number;
  remainingCostCents: number;
};

export type UsageControlPlaneSummary = {
  generatedAt: string;
  period: {
    start: string;
    end: string;
    daysTotal: number;
    daysElapsed: number;
    daysRemaining: number;
  };
  plan: {
    id: string;
    name: string;
    allowsOverage: boolean;
    includedBudgetCents: number;
    overageBudgetCents: number;
    agentRunsLimit: number;
    agentMinutesLimit: number;
    scaffoldsLimit: number;
  };
  actual: {
    agentRuns: number;
    agentMinutes: number;
    tokens: number;
    costCents: number;
    scaffoldsUsed: number;
    scaffoldsRemaining: number;
  };
  predicted: UsagePrediction;
  utilization: {
    runsPct: number | null;
    minutesPct: number | null;
    budgetPct: number | null;
  };
  headroom: {
    agentRunsRemaining: number;
    agentMinutesRemaining: number;
    budgetRemainingCents: number;
  };
  risk: UsageRiskLevel;
  breakdown: {
    provider: UsageBreakdownBucket[];
    executionTarget: UsageBreakdownBucket[];
    sourceClient: UsageBreakdownBucket[];
    model: UsageBreakdownBucket[];
  };
  velocity: {
    windowDays: number;
    dailyAvgRuns: number;
    dailyAvgMinutes: number;
    dailyAvgTokens: number;
    dailyAvgCostCents: number;
  };
};

// =============================================================================
// RUN PHASES + HANDOFF CONTINUITY
// =============================================================================

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
  offset?: number;
  search?: string;
  id?: string;
  ids?: string[] | string;
  initiative_id?: string;
  project_id?: string;
  /** Canonical workspace scope */
  workspace_id?: string;
  /** Legacy alias for workspace_id */
  command_center_id?: string;
  [key: string]: unknown;
}

export interface WorkstreamReassignmentStatus {
  scheduled: boolean;
  requestId?: string | null;
  dueAt?: string | null;
  reason?: string;
}

export interface InitiativeReassignmentStatus {
  triggered: boolean;
  requested: number;
  scheduled: number;
  skipped: number;
  failures: string[];
}

export interface EntityUpdateResult {
  entity: Entity;
  reassignment?: WorkstreamReassignmentStatus | null;
  initiative_reassignment?: InitiativeReassignmentStatus | null;
}

// =============================================================================
// REPORTING CONTROL PLANE
// =============================================================================

export type ReportingSourceClient = 'openclaw' | 'codex' | 'claude-code' | 'api';
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
export type DecisionOptionImpliedStatus =
  | 'approved'
  | 'declined'
  | 'cancelled'
  | 'rejected';

export interface DecisionCreateOption {
  id?: string;
  label: string;
  description?: string;
  implied_status?: DecisionOptionImpliedStatus;
  action_type?: DecisionActionType;
  requires_note?: boolean;
}

export interface DecisionEvidenceRef {
  evidence_type?: string;
  title?: string;
  summary?: string;
  source_url?: string;
  source_pointer?: string;
  freshness?: string;
  confidence?: number;
  payload?: Record<string, unknown>;
}

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
      options?: Array<string | DecisionCreateOption>;
      blocking?: boolean;
      decision_type?: string;
      workstream_id?: string;
      agent_id?: string;
      due_at?: string;
      source_system?: string;
      conflict_source?: string;
      dedupe_key?: string;
      recommended_action?: string;
      source_run_id?: string;
      source_session_id?: string;
      source_stream_id?: string;
      source_ref?: Record<string, unknown>;
      evidence_refs?: DecisionEvidenceRef[];
      metadata?: Record<string, unknown>;
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
  schema_version: RetroArtifactSchemaVersion;
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
// PROOF LADDER
// =============================================================================

export type ProofLevel =
  | "L1_traceability"
  | "L2_correctness"
  | "L3_completion"
  | "L4_adoption"
  | "L5_impact"
  | "L6_economics"
  | "L7_repeatability";

export type ProofEnforcement = "hard_block" | "soft_warn" | "reporting_only";

export interface ProofLevelStatus {
  level: ProofLevel;
  label: string;
  passed: boolean;
  enforcement: ProofEnforcement;
  missingFields: string[];
  details?: string;
}

export interface ProofChainStatus {
  task_id?: string;
  run_id?: string;
  domain?: OrgxAgentDomain;
  levels: ProofLevelStatus[];
  overall_passed: boolean;
  missing_count: number;
  /** Codes like "no_artifact", "no_quality_gate", "no_outcome" etc. */
  reason_codes: string[];
}

export interface ProofStatusRequest {
  task_id?: string;
  run_id?: string;
}

// =============================================================================
// LIVE SESSION GRAPH + HANDOFFS
// =============================================================================
// Live/session/handoff activity shapes are imported and re-exported from
// ./shared-types.ts to keep dashboard and plugin contracts in lockstep.
