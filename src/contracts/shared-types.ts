// Canonical shared types consumed by both core plugin code and dashboard code.
// Keep this file dependency-free so it can be imported across build boundaries.

export type OnboardingStatus =
  | 'idle'
  | 'starting'
  | 'awaiting_browser_auth'
  | 'pairing'
  | 'connected'
  | 'error'
  | 'manual_key';

// Superset for dashboard + plugin compatibility.
export type OnboardingNextAction =
  | 'connect'
  | 'wait_for_browser'
  | 'open_dashboard'
  | 'retry'
  | 'start_pairing'
  | 'open_browser'
  | 'poll'
  | 'enter_manual_key'
  | 'reconnect'
  | 'none';

export type OnboardingKeySource =
  | 'config'
  | 'environment'
  | 'persisted'
  | 'openclaw-config-file'
  | 'legacy-dev'
  | 'none';

export interface OnboardingState {
  status: OnboardingStatus;
  hasApiKey: boolean;
  connectionVerified: boolean;
  workspaceName: string | null;
  lastError: string | null;
  nextAction: OnboardingNextAction;
  docsUrl: string;
  keySource?: OnboardingKeySource;
  installationId?: string | null;
  connectUrl: string | null;
  pairingId?: string | null;
  expiresAt: string | null;
  pollIntervalMs: number | null;
}

export type RunPhase =
  | 'intent'
  | 'execution'
  | 'blocked'
  | 'review'
  | 'handoff'
  | 'completed';

export type RuntimeSourceClient =
  | 'openclaw'
  | 'codex'
  | 'claude-code'
  | 'api'
  | 'unknown';

export type RuntimeProviderLogo =
  | 'codex'
  | 'openai'
  | 'anthropic'
  | 'openclaw'
  | 'orgx'
  | 'unknown';

export type RuntimeInstanceState = 'active' | 'stale' | 'stopped' | 'error';

export interface RuntimeInstance {
  id: string;
  sourceClient: RuntimeSourceClient;
  displayName: string;
  providerLogo: RuntimeProviderLogo;
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

/**
 * Canonical event names set in `metadata.event` on activity items.
 * Keep in sync with emitters in auto-continue-engine.ts, autopilot-operations.ts,
 * dispatch-lifecycle.ts, and http/index.ts.
 */
export type ActivityEventName =
  // Autopilot slice lifecycle
  | 'autopilot_slice_dispatched'
  | 'autopilot_slice_started'
  | 'autopilot_slice_heartbeat'
  | 'autopilot_slice_finished'
  | 'autopilot_slice_result'
  | 'autopilot_slice_handoff'
  | 'autopilot_slice_mcp_handshake_failed'
  | 'autopilot_slice_timeout'
  | 'autopilot_slice_log_stall'
  | 'autopilot_slice_artifact_buffered'
  | 'autopilot_slice_status_updates_buffered'
  // Auto-continue lifecycle
  | 'auto_continue_started'
  | 'auto_continue_stopped'
  | 'auto_continue_spawn_guard_blocked'
  | 'auto_continue_spawn_guard_rate_limited'
  | 'auto_continue_spawn_guard_rate_limit_overridden'
  | 'auto_continue_behavior_config_drift_detected'
  | 'auto_continue_behavior_config_approval_required'
  | 'auto_continue_behavior_automation_manual_blocked'
  | 'auto_continue_behavior_automation_supervised_one_shot'
  // Autofix
  | 'autopilot_autofix_scheduled'
  | 'autopilot_autofix_executed'
  | 'autopilot_autofix_skipped'
  // Orchestration
  | 'orchestrator_dispatch'
  | 'autopilot_transition'
  | 'next_up_manual_dispatch_started'
  | 'scope_completed'
  // Session & runtime
  | 'session_start'
  | 'session_stop'
  | 'heartbeat'
  // Decisions & dispatch
  | 'decision_buffered'
  | 'decision_resolved'
  | 'question_asked'
  | 'question_timeout_started'
  | 'question_auto_answered'
  | 'question_answer_applied'
  | 'question_answer_failed'
  | 'review_item_created'
  | 'review_item_resolved'
  | 'decision_auto_answer_scheduled'
  | 'decision_auto_answer_timeout'
  | 'decision_auto_answer_applied'
  | 'decision_auto_answer_skipped'
  | 'spawn_guard_degraded'
  // Dashboard actions
  | 'dashboard_run_mark_completed'
  // Proof & artifacts
  | 'proof_gate_warning'
  | 'artifact_registered';

export interface LiveActivityItem {
  id: string;
  type: LiveActivityType;
  title: string;
  description: string | null;
  agentId: string | null;
  agentName: string | null;
  requesterAgentId: string | null;
  requesterAgentName: string | null;
  executorAgentId: string | null;
  executorAgentName: string | null;
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
  runtimeProvider?: RuntimeProviderLogo | null;
  instanceId?: string | null;
  lastHeartbeatAt?: string | null;
  metadata?: Record<string, unknown>;
}

export const KNOWN_ACTIVITY_ACTION_TYPES = [
  "orchestrator_dispatch",
  "dispatch_slice",
  "spawn_worker",
  "run_heartbeat",
  "run_state_transition",
  "run_started",
  "run_completed",
  "run_failed",
  "slice_handoff",
  "question_asked",
  "question_timeout_started",
  "question_auto_answered",
  "question_answer_applied",
  "question_answer_failed",
  "decision_requested",
  "decision_resolved",
  "review_item_created",
  "review_item_resolved",
  "status_updates_applied",
  "status_updates_buffered",
  "artifact_registered",
  "spawn_guard_blocked",
  "spawn_guard_rate_limited",
  "behavior_config_review",
  "auto_fix",
  "auto_continue_started",
  "auto_continue_stopped",
  "autopilot_resumed",
  "autopilot_paused",
  "autopilot_blocked",
  "milestone_completed",
  "workflow_error",
] as const;

export type KnownActivityActionType = (typeof KNOWN_ACTIVITY_ACTION_TYPES)[number];
export type ActivityActionType = KnownActivityActionType | (string & {});

export const KNOWN_ACTIVITY_ACTION_PHASES = [
  "intent",
  "dispatch",
  "execution",
  "handoff",
  "review",
  "completed",
  "blocked",
  "error",
] as const;

export type ActivityActionPhase = (typeof KNOWN_ACTIVITY_ACTION_PHASES)[number];

const ACTIVITY_ACTION_TYPE_ALIASES: Record<string, KnownActivityActionType> = {
  orchestrator: "orchestrator_dispatch",
  dispatch: "dispatch_slice",
  dispatched: "dispatch_slice",
  question: "question_asked",
  question_timeout: "question_timeout_started",
  question_auto_answer: "question_auto_answered",
  decision_auto_answer: "question_auto_answered",
  decision_auto_answer_applied: "question_answer_applied",
  decision_auto_answer_failed: "question_answer_failed",
  decision_auto_answer_skipped: "review_item_created",
  start: "run_started",
  started: "run_started",
  stop: "auto_continue_stopped",
  stopped: "auto_continue_stopped",
  pause: "autopilot_paused",
  paused: "autopilot_paused",
  resume: "autopilot_resumed",
  resumed: "autopilot_resumed",
  blocked: "autopilot_blocked",
  complete: "run_completed",
  completed: "run_completed",
  fail: "run_failed",
  failed: "run_failed",
};

export function normalizeActivityActionType(value: unknown): ActivityActionType | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return null;
  const alias = ACTIVITY_ACTION_TYPE_ALIASES[normalized];
  if (alias) return alias;
  return normalized.replace(/\s+/g, "_") as ActivityActionType;
}

export function isKnownActivityActionType(value: unknown): value is KnownActivityActionType {
  if (typeof value !== "string") return false;
  return (KNOWN_ACTIVITY_ACTION_TYPES as readonly string[]).includes(value);
}

export function normalizeActivityActionPhase(value: unknown): ActivityActionPhase | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return null;
  if ((KNOWN_ACTIVITY_ACTION_PHASES as readonly string[]).includes(normalized)) {
    return normalized as ActivityActionPhase;
  }
  return null;
}

export const KNOWN_DECISION_ACTION_TYPES = [
  "approve",
  "reject",
  "provide_context",
  "request_info",
  "confirm_scope",
  "retry",
  "resume",
  "start",
  "pause",
  "defer",
  "cancel",
  "queue_top",
  "queue_bottom",
  "remove_from_queue",
  "reassign",
  "assign",
  "notify",
  "escalate",
  "handoff",
  "spawn",
  "execute_task",
  "review_blocker",
  "review_decision",
  "open_artifact",
  "open_logs",
  "open_session",
  "open_run",
  "open_workstream",
  "open_task",
  "open_initiative",
  "open_pr",
  "open_diff",
  "open_branch",
  "open_deal",
  "update_deal",
  "open_settings",
  "open_workspace",
  "connect_provider",
  "refresh_credentials",
  "auto_fix",
  "ignore_once",
] as const;

export type KnownDecisionActionType = (typeof KNOWN_DECISION_ACTION_TYPES)[number];
export type DecisionActionType = KnownDecisionActionType | (string & {});

const DECISION_ACTION_TYPE_ALIASES: Record<string, KnownDecisionActionType> = {
  declined: "reject",
  decline: "reject",
  deny: "reject",
  dismiss: "ignore_once",
  retry_slice: "retry",
  continue: "resume",
  restart: "resume",
  play: "start",
  stop: "pause",
  snooze: "defer",
  queue: "queue_bottom",
  add_to_end: "queue_bottom",
  add_to_queue: "queue_bottom",
  queue_to_end: "queue_bottom",
  queue_to_bottom: "queue_bottom",
  queue_to_top: "queue_top",
  move_to_top: "queue_top",
  move_to_bottom: "queue_bottom",
  remove: "remove_from_queue",
  remove_queue: "remove_from_queue",
  unqueue: "remove_from_queue",
  openartifact: "open_artifact",
  open_artifacts: "open_artifact",
  open_pr_diff: "open_diff",
  open_pull_request: "open_pr",
  open_work_item: "open_task",
  providecontext: "provide_context",
  request_context: "request_info",
  ask_info: "request_info",
  ask_question: "request_info",
  reassign_agent: "reassign",
  assign_agent: "assign",
  spawn_agent: "spawn",
  connect_credentials: "connect_provider",
  fix_credentials: "refresh_credentials",
  refresh_credential: "refresh_credentials",
  autofix: "auto_fix",
  auto_resolve: "auto_fix",
};

const KNOWN_DECISION_ACTION_TYPE_SET = new Set<string>(KNOWN_DECISION_ACTION_TYPES);

export function normalizeDecisionActionType(
  value: unknown
): DecisionActionType | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return null;
  if (KNOWN_DECISION_ACTION_TYPE_SET.has(normalized)) {
    return normalized as KnownDecisionActionType;
  }
  if (DECISION_ACTION_TYPE_ALIASES[normalized]) {
    return DECISION_ACTION_TYPE_ALIASES[normalized];
  }
  return normalized;
}

export function isKnownDecisionActionType(
  value: unknown
): value is KnownDecisionActionType {
  if (typeof value !== "string") return false;
  return KNOWN_DECISION_ACTION_TYPE_SET.has(value.trim().toLowerCase());
}

export type LiveDecisionOptionStatus = 'approved' | 'declined' | 'cancelled';

export interface LiveDecisionOption {
  id: string;
  label: string;
  description: string | null;
  consequences?: string | null;
  impliedStatus: LiveDecisionOptionStatus | null;
  actionType: DecisionActionType | null;
  requiresNote: boolean;
}

export interface LiveDecisionEvidenceRef {
  evidenceType: string | null;
  title: string | null;
  summary: string | null;
  sourceUrl: string | null;
  sourcePointer: string | null;
  freshness: string | null;
  confidence: number | null;
  payload: Record<string, unknown> | null;
}

export interface LiveDecision {
  id: string;
  title: string;
  context: string | null;
  status: string;
  priority?: string | null;
  decisionType?: string | null;
  agentName: string | null;
  agentId?: string | null;
  initiativeId?: string | null;
  workstreamId?: string | null;
  dueAt?: string | null;
  requestedAt: string | null;
  updatedAt: string | null;
  sourceSystem?: string | null;
  conflictSource?: string | null;
  dedupeKey?: string | null;
  recommendedAction?: string | null;
  occurrenceCount?: number | null;
  firstSeenAt?: string | null;
  lastSeenAt?: string | null;
  sourceRunId?: string | null;
  sourceSessionId?: string | null;
  sourceStreamId?: string | null;
  evidenceRefs?: LiveDecisionEvidenceRef[];
  waitingMinutes: number;
  metadata?: Record<string, unknown>;
  options?: LiveDecisionOption[];
  selectedOptionId?: string | null;
}

export interface SessionBlockerContext {
  initiativeId: string | null;
  initiativeIds?: string[];
  workstreamId: string | null;
  workstreamIds?: string[];
  workstreamTitle: string | null;
  taskIds: string[];
  milestoneIds: string[];
  iwmtId?: string | null;
  iwmtIds?: string[];
  sliceRunId: string | null;
  parallelMode: string | null;
  logPath: string | null;
  outputPath: string | null;
}

export interface SessionBlockerDiagnostics {
  reason: string | null;
  source: string | null;
  errorCode: string | null;
  errorCategory: string | null;
  retryable: boolean | null;
  suggestedActions: string[];
  eventId: string | null;
  eventType: string | null;
  eventTimestamp: string | null;
  context: SessionBlockerContext;
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
  runtimeProvider?: RuntimeProviderLogo | null;
  instanceId?: string | null;
  lastHeartbeatAt?: string | null;
  blockerDiagnostics?: SessionBlockerDiagnostics | null;
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

// -----------------------------------------------------------------------------
// Triage Queue (unified decisions + blockers + review items)
// -----------------------------------------------------------------------------

export type TriageItemKind =
  | 'decision_required'
  | 'blocked_intervention'
  | 'review_required'
  | 'failure_diagnostic';

export type TriageItemStatus = 'open' | 'snoozed' | 'resolved' | 'dismissed';

export type TriageSeverity = 'critical' | 'high' | 'medium' | 'low';

export type TriageActionType =
  | 'approve'
  | 'reject'
  | 'retry'
  | 'autofix'
  | 'defer'
  | 'snooze'
  | 'dismiss';

export interface TriageAction {
  action: TriageActionType;
  label: string;
  description: string;
  consequences: string;
  requiresNote: boolean;
  available: boolean;
  optionId?: string | null;
}

export interface ProofBundle {
  artifactRefs: string[];
  fileChanges: string[];
  prRefs: string[];
  logRefs: string[];
  decisionRefs: string[];
}

export interface TriageImpact {
  initiativeCount: number;
  workstreamCount: number;
  downstreamBlockedCount: number;
}

export interface TriageDecisionOptionSummary {
  id?: string | null;
  label: string;
  description?: string | null;
  consequences?: string | null;
  actionType?: string | null;
  impliedStatus?: string | null;
  requiresNote?: boolean;
  recommended?: boolean;
}

export interface TriageEvidenceSummary {
  title: string;
  summary?: string | null;
  url?: string | null;
  pointer?: string | null;
  evidenceType?: string | null;
  confidence?: number | null;
}

export interface TriageInterventionContext {
  blockerReason?: string | null;
  waitingOn?: string | null;
  requiredAction?: string | null;
  requiredActor?: string | null;
  retryable?: boolean | null;
  errorCode?: string | null;
  errorCategory?: string | null;
  suggestedActions?: string[];
  nextActions?: string[];
  decisionIds?: string[];
  taskUpdateCount?: number;
  milestoneUpdateCount?: number;
  decisionPrompt?: string | null;
  decisionSummary?: string | null;
  decisionOptions?: TriageDecisionOptionSummary[];
  recommendedAction?: string | null;
  scopeHierarchy?: string[];
  currentRunState?: string | null;
  impactIfDelayed?: string | null;
  artifacts?: string[];
  evidence?: TriageEvidenceSummary[];
  updatesApplied?: string[];
}

export interface LiveTriageItem {
  id: string;
  kind: TriageItemKind;
  status: TriageItemStatus;
  title: string;
  summary: string;
  // Scope context
  initiativeId: string | null;
  initiativeTitle: string | null;
  workstreamId: string | null;
  workstreamTitle: string | null;
  taskId: string | null;
  taskTitle: string | null;
  // Enrichment
  sourceSystem: string | null;
  conflictSource: string | null;
  dedupeKey: string | null;
  occurrenceCount: number;
  severity: TriageSeverity;
  blocking: boolean;
  recommendedAction: string | null;
  agentId: string | null;
  intervention?: TriageInterventionContext | null;
  // Impact
  impact: TriageImpact;
  // Proof
  proofBundle: ProofBundle;
  // Action contract
  actionContract: TriageAction[];
  // Timestamps
  createdAt: string;
  updatedAt: string;
  firstSeenAt: string;
  lastSeenAt: string;
  snoozedUntil: string | null;
  // Legacy interop
  sourceDecisionId: string | null;
  sourceActivityId: string | null;
}

export interface TriageActionRequest {
  action: string;
  note?: string;
  optionId?: string;
  snoozeDurationMinutes?: number;
}

export interface TriageActionResponse {
  ok: boolean;
  itemStatus: TriageItemStatus;
  continuationPlan: string | null;
  sideEffects: string[];
}

export interface TriageListResponse {
  ok: boolean;
  items: LiveTriageItem[];
  total: number;
  generatedAt: string;
  degraded?: string[];
}
