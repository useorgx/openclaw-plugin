export type ConnectionStatus = 'connected' | 'reconnecting' | 'disconnected';

import type {
  HandoffSummary,
  LiveActivityItem,
  LiveActivityType,
  LiveDecision,
  LiveDecisionOption,
  OnboardingState,
  OnboardingStatus,
  RunPhase,
  RuntimeInstance,
  RuntimeProviderLogo,
  RuntimeSourceClient,
  SessionTreeNode,
  SessionTreeResponse,
} from '@shared/shared-types';

export type {
  HandoffEvent,
  HandoffSummary,
  LiveActivityItem,
  LiveActivityType,
  LiveDecision,
  LiveDecisionOption,
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
} from '@shared/shared-types';

export interface LiveData {
  connection: ConnectionStatus;
  lastActivity: string | null;
  lastSnapshotAt: string | null;
  sessions: SessionTreeResponse;
  activity: LiveActivityItem[];
  handoffs: HandoffSummary[];
  decisions: LiveDecision[];
  sliceRuns: SliceRunProjection[];
  outbox: OutboxStatus;
  runtimeInstances?: RuntimeInstance[];
  agentSuite?: AgentSuitePlan;
  workSliceProjections?: WorkSliceProjectionV2[];
  timelineNarrative?: SliceTimelineNarrativeProjectionV2[];
  nextUpByInitiative?: NextUpInitiativeProjection[];
  runningWorkSlices?: number;
  needsInputTotal?: number;
  failedActionableTotal?: number;
  completedTodayTotal?: number;
  consistencyFlags?: string[];
  dataHealth?: SliceDataHealthSummary;
}

export interface OutboxStatus {
  pendingTotal: number;
  pendingByQueue: Record<string, number>;
  oldestEventAt: string | null;
  newestEventAt: string | null;
  replayStatus: 'idle' | 'running' | 'success' | 'error';
  lastReplayAttemptAt: string | null;
  lastReplaySuccessAt: string | null;
  lastReplayFailureAt: string | null;
  lastReplayError: string | null;
}

export type SliceScope = 'task' | 'milestone' | 'workstream';

export type SliceRunLifecycleState =
  | 'queued'
  | 'dispatching'
  | 'running'
  | 'awaiting_input'
  | 'completed'
  | 'needs_review'
  | 'failed'
  | 'archived';

export type SliceRunPrimaryAction =
  | 'none'
  | 'open_artifact'
  | 'resolve_decision'
  | 'retry_slice'
  | 'review_output';

export interface SliceRunArtifactSummary {
  id: string | null;
  type: string | null;
  title: string;
  url: string | null;
  createdAt: string | null;
}

export interface SliceRunDecisionOption {
  id: string;
  label: string;
  description: string | null;
  impliedStatus: string | null;
  requiresNote: boolean;
}

export interface SliceRunProjection {
  id: string;
  sliceRunId: string;
  runId: string | null;
  initiativeId: string | null;
  initiativeIds?: string[];
  workstreamId: string | null;
  workstreamIds?: string[];
  iwmtId?: string | null;
  iwmtIds?: string[];
  workstreamTitle: string | null;
  taskIds: string[];
  milestoneIds: string[];
  status: SliceRunLifecycleState;
  statusExplainer: string;
  primaryAction: SliceRunPrimaryAction;
  hasArtifact: boolean;
  artifactCount: number;
  artifacts: SliceRunArtifactSummary[];
  decisionCount: number;
  blockingDecisionCount: number;
  decisionOptions: SliceRunDecisionOption[];
  sourceClient: string | null;
  runtimeState: string | null;
  startedAt: string | null;
  updatedAt: string | null;
  completedAt: string | null;
  failedAt: string | null;
  archivedAt: string | null;
  lastEventAt: string | null;
  lastEventSummary: string | null;
  correlationId: string | null;
  confidence: 'low' | 'medium' | 'high';
  scope?: SliceScope;
  scopeMilestoneIds?: string[];
  scopeProgress?: {
    totalTasks: number;
    completedTasks: number;
    milestones?: Array<{ id: string; title: string; total: number; done: number }>;
  };
}

export type SliceKind = 'work_slice' | 'runtime_reporting' | 'system_maintenance';
export type SliceLifecycleStateV2 =
  | 'queued'
  | 'dispatching'
  | 'running'
  | 'awaiting_input'
  | 'completed'
  | 'failed'
  | 'archived';
export type SliceOutcomeState =
  | 'succeeded_with_artifacts'
  | 'succeeded_without_artifacts'
  | 'failed_actionable'
  | 'failed_non_actionable'
  | 'needs_input';
export type SliceActionType =
  | 'approve'
  | 'reject'
  | 'retry'
  | 'resume'
  | 'open_artifact'
  | 'provide_context';

export interface SliceActorProvenance {
  actorType: 'agent' | 'user' | 'orgx' | 'system';
  actorId: string;
  displayName: string;
  avatarKey: string;
}

export interface SliceLineageRef {
  initiativeIds: string[];
  initiativeTitles: string[];
  workstreamIds: string[];
  workstreamTitles: string[];
  taskIds: string[];
  milestoneIds: string[];
  iwmtIds: string[];
  sliceRunId: string;
  sessionId: string | null;
}

export interface SliceArtifactEnvelope {
  artifactId: string;
  sliceRunId: string;
  type: string;
  title: string;
  url: string | null;
  preview: string | null;
  validation: 'present' | 'missing' | 'invalid';
  confidence: number;
  producedAt: string | null;
  producer: 'agent' | 'system' | 'user';
}

export interface SliceActionContract {
  actionType: SliceActionType;
  label: string;
  payloadSchema: Record<string, unknown>;
  primary: boolean;
}

export interface WorkSliceProjectionV2 {
  projectionVersion: number;
  lastEventId: string | null;
  consistencyFlags: string[];
  sliceRunId: string;
  runId: string | null;
  sliceKind: SliceKind;
  lifecycleState: SliceLifecycleStateV2;
  outcomeState: SliceOutcomeState;
  statusExplainer: string;
  actorProvenance: SliceActorProvenance;
  lineage: SliceLineageRef;
  artifacts: SliceArtifactEnvelope[];
  artifactCount: number;
  hasArtifact: boolean;
  actionContract: SliceActionContract | null;
  updatedAt: string | null;
  completedAt: string | null;
  failedAt: string | null;
  archivedAt: string | null;
  runtimeState: string | null;
  sourceClient: string | null;
  confidence: 'low' | 'medium' | 'high';
  scope?: SliceScope;
  scopeProgress?: { totalTasks: number; completedTasks: number };
}

export interface SliceTimelineNarrativeProjectionV2 {
  projectionVersion: number;
  sliceRunId: string;
  title: string;
  occurredAt: string | null;
  actorProvenance: SliceActorProvenance;
  intent: string;
  dispatch: string;
  highlights: string[];
  outcome: {
    state: SliceOutcomeState;
    summary: string;
    artifactCount: number;
  };
  nextAction: SliceActionContract | null;
  technicalTrace: {
    eventCount: number;
    eventIds: string[];
  };
}

export interface NextUpInitiativeProjection {
  initiativeId: string | null;
  initiativeTitle: string;
  pendingCount: number;
  queue: Array<{
    workstreamId: string | null;
    workstreamTitle: string;
    queueState: string;
    priorityNum: number | null;
    dependencySummary: string | null;
    tasksRemaining: number | null;
  }>;
}

export interface SliceDataHealthSummary {
  status: 'healthy' | 'degraded';
  totals: {
    slices: number;
    missingTerminal: number;
    lineageGap: number;
    artifactMismatch: number;
    invalidActor: number;
  };
}

export interface LiveSnapshotAgent {
  id: string;
  name: string | null;
  status: string;
  currentTask: string | null;
  runId: string | null;
  initiativeId: string | null;
  startedAt: string | null;
  blockers?: unknown;
}

export interface LiveSnapshotResponse {
  sessions: SessionTreeResponse;
  activity: LiveActivityItem[];
  handoffs: HandoffSummary[];
  decisions: LiveDecision[];
  sliceRuns?: SliceRunProjection[];
  agents: LiveSnapshotAgent[];
  runtimeInstances?: RuntimeInstance[];
  outbox?: OutboxStatus;
  generatedAt: string;
  degraded?: string[];
  projections?: WorkSliceProjectionV2[];
  inProgress?: WorkSliceProjectionV2[];
  needsInputItems?: WorkSliceProjectionV2[];
  failedItems?: WorkSliceProjectionV2[];
  nextUpByInitiative?: NextUpInitiativeProjection[];
  timelineNarrative?: SliceTimelineNarrativeProjectionV2[];
  runningWorkSlices?: number;
  needsInput?: number;
  failedActionable?: number;
  completedToday?: number;
  consistencyFlags?: string[];
  dataHealth?: SliceDataHealthSummary;
}

// -----------------------------------------------------------------------------
// Agent Suite Provisioning (OpenClaw-local)
// -----------------------------------------------------------------------------

export type AgentSuiteDomain =
  | 'engineering'
  | 'product'
  | 'design'
  | 'marketing'
  | 'sales'
  | 'operations'
  | 'orchestration';

export interface AgentSuiteAgent {
  id: string;
  name: string;
  domain: AgentSuiteDomain;
  workspace: string;
  configuredInOpenclaw: boolean;
  workspaceExists: boolean;
  configHealth: {
    status: 'healthy' | 'needs_apply' | 'conflict';
    lastChangedAt: string | null;
    evalPassRate: number;
    totalChecks: number;
    passedChecks: number;
    failedChecks: number;
  };
}

export interface AgentSuiteWorkspaceFile {
  agentId: string;
  file: string;
  managedPath: string;
  localPath: string;
  compositePath: string;
  action: 'create' | 'update' | 'noop' | 'conflict';
}

export interface AgentRuntimeSettings {
  decisionV2Enabled: boolean;
  decisionDedupeEnabled: boolean;
  decisionEvidenceRequiredForBlocking: boolean;
  decisionAutoResolveGuardedEnabled: boolean;
  customRunInstructions: string;
}

export interface AgentRuntimeSettingsAgent {
  id: string;
  name: string;
  type: string;
  status: string;
  model: string | null;
  runtimeSettings: AgentRuntimeSettings;
}

export interface AgentRuntimeSettingsData {
  projectId: string | null;
  agents: AgentRuntimeSettingsAgent[];
}

export interface AgentSuitePlan {
  packId: string;
  packVersion: string;
  openclawConfigPath: string;
  suiteWorkspaceRoot: string;
  skillPack?: {
    source: 'builtin' | 'server';
    name: string;
    version: string;
    checksum: string;
    etag?: string | null;
    updated_at?: string | null;
  } | null;
  skillPackRemote?: {
    name: string;
    version: string;
    checksum: string;
    updated_at?: string | null;
  } | null;
  skillPackPolicy?: {
    frozen: boolean;
    pinnedChecksum: string | null;
  } | null;
  skillPackUpdateAvailable?: boolean;
  agents: AgentSuiteAgent[];
  openclawConfigWouldUpdate: boolean;
  openclawConfigAddedAgents: string[];
  workspaceFiles: AgentSuiteWorkspaceFile[];
}

// -----------------------------------------------------------------------------
// Legacy dashboard types (kept for compatibility with existing components)
// -----------------------------------------------------------------------------

export type AgentStatus =
  | 'working'
  | 'planning'
  | 'waiting'
  | 'blocked'
  | 'idle'
  | 'done';

export type ActivityType =
  | 'artifact'
  | 'progress'
  | 'decision'
  | 'handoff'
  | 'completed'
  | 'started'
  | 'blocked';

export interface Phase {
  name: string;
  status: 'completed' | 'current' | 'upcoming' | 'warning';
}

export interface Initiative {
  id: string;
  name: string;
  status: 'active' | 'paused' | 'blocked' | 'completed';
  rawStatus?: string | null;
  priority?: string | null;
  category?: string;
  health: number;
  phases?: Phase[];
  currentPhase?: number;
  daysRemaining: number;
  targetDate?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  activeAgents: number;
  totalAgents: number;
  avatars?: string[];
  description?: string;
  workstreams?: { id: string; name: string; status: string }[];
}

export interface InitiativeWorkstream {
  id: string;
  name: string;
  summary?: string | null;
  status: string;
  progress: number | null;
  initiativeId: string;
  createdAt: string | null;
}

export interface InitiativeMilestone {
  id: string;
  title: string;
  description?: string | null;
  status: string;
  dueDate: string | null;
  initiativeId: string;
  workstreamId: string | null;
  createdAt: string | null;
}

export interface InitiativeTask {
  id: string;
  title: string;
  description?: string | null;
  status: string;
  priority: string | null;
  dueDate: string | null;
  initiativeId: string;
  milestoneId: string | null;
  workstreamId: string | null;
  createdAt: string | null;
}

export interface InitiativeDetails {
  initiativeId: string;
  workstreams: InitiativeWorkstream[];
  milestones: InitiativeMilestone[];
  tasks: InitiativeTask[];
}

export type MissionControlNodeType =
  | 'initiative'
  | 'workstream'
  | 'milestone'
  | 'task';

export interface AssignedAgent {
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
  assignedAgents: AssignedAgent[];
  updatedAt: string | null;
}

export interface MissionControlEdge {
  from: string;
  to: string;
  kind: 'depends_on';
}

export interface MissionControlGraphResponse {
  initiative: {
    id: string;
    title: string;
    status: string;
    summary: string | null;
    assignedAgents: AssignedAgent[];
  };
  nodes: MissionControlNode[];
  edges: MissionControlEdge[];
  recentTodos: string[];
  degraded?: string[];
}

export type NextUpRunnerSource = 'assigned' | 'inferred' | 'fallback';
export type NextUpQueueState = 'queued' | 'running' | 'blocked' | 'idle';
export type NextUpPlaybackState = 'queued' | 'running' | 'blocked' | 'paused' | 'idle';
export type NextUpAutoRuntimeState = 'idle' | 'running' | 'stopping' | 'error';
export type NextUpQueueOrigin = 'hierarchy' | 'initiative_modal' | 'timeline' | 'system';

export interface NextUpQueueItem {
  initiativeId: string;
  initiativeTitle: string;
  initiativeStatus: string;
  workstreamId: string;
  workstreamTitle: string;
  workstreamStatus: string;
  nextTaskId: string | null;
  nextTaskTitle: string | null;
  nextTaskPriority: number | null;
  nextTaskDueAt: string | null;
  runnerAgentId: string;
  runnerAgentName: string;
  runnerSource: NextUpRunnerSource;
  queueState: NextUpQueueState;
  blockReason: string | null;
  isPinned?: boolean;
  pinnedRank?: number | null;
  playbackState?: NextUpPlaybackState;
  autoIntentEnabled?: boolean;
  autoRuntimeState?: NextUpAutoRuntimeState;
  queueOrigin?: NextUpQueueOrigin;
  autoContinue: {
    status: AutoContinueStatus;
    activeTaskId: string | null;
    activeRunId: string | null;
    activeTaskIds?: string[];
    activeRunIds?: string[];
    laneState?:
      | 'idle'
      | 'running'
      | 'blocked'
      | 'waiting_dependency'
      | 'rate_limited'
      | 'completed'
      | null;
    laneBlockedReason?: string | null;
    laneWaitingOnWorkstreamIds?: string[];
    laneRetryAt?: string | null;
    maxParallelSlices?: number;
    parallelMode?: 'iwmt';
    stopReason: AutoContinueStopReason | null;
    updatedAt: string;
  } | null;
}

export interface NextUpQueueResponse {
  ok: boolean;
  generatedAt: string;
  total: number;
  items: NextUpQueueItem[];
  degraded?: string[];
  error?: string;
}

export type NextUpQueueBulkAction = 'move_top' | 'move_bottom' | 'remove';

export interface NextUpQueueBulkResultItem {
  initiativeId: string;
  workstreamId: string;
  ok: boolean;
  error?: string | null;
}

export interface NextUpQueueBulkResponse {
  ok: boolean;
  action: NextUpQueueBulkAction;
  requested: number;
  updated: number;
  failed: number;
  results: NextUpQueueBulkResultItem[];
  updatedAt: string;
}

export type AutoContinueStopReason =
  | 'budget_exhausted'
  | 'blocked'
  | 'completed'
  | 'stopped'
  | 'error';

export type AutoContinueStatus = 'running' | 'stopping' | 'stopped';

export interface AutoContinueRun {
  initiativeId: string;
  agentId: string;
  agentName?: string | null;
  tokenBudget: number | null;
  tokensUsed: number;
  maxParallelSlices?: number;
  parallelMode?: 'iwmt';
  status: AutoContinueStatus;
  stopReason: AutoContinueStopReason | null;
  stopRequested: boolean;
  startedAt: string;
  stoppedAt: string | null;
  updatedAt: string;
  lastError: string | null;
  lastTaskId: string | null;
  lastRunId: string | null;
  activeTaskId: string | null;
  activeRunId: string | null;
  activeTaskIds?: string[];
  activeSliceRunIds?: string[];
  blockedWorkstreamIds?: string[];
  laneByWorkstreamId?: Record<
    string,
    {
      workstreamId: string;
      state:
        | 'idle'
        | 'running'
        | 'blocked'
        | 'waiting_dependency'
        | 'rate_limited'
        | 'completed';
      activeRunId: string | null;
      activeTaskIds: string[];
      blockedReason: string | null;
      waitingOnWorkstreamIds: string[];
      retryAt: string | null;
      updatedAt: string;
    }
  >;
}

export interface AutoContinueStatusResponse {
  ok: boolean;
  initiativeId: string | null;
  run: AutoContinueRun | null;
  defaults: {
    tokenBudget: number | null;
    maxParallelSlices?: number;
    tickMs: number;
  };
  error?: string;
}

export type ByokKeySource = 'stored' | 'env' | 'none';

export interface ByokProviderStatus {
  configured: boolean;
  source: ByokKeySource;
  masked: string | null;
}

export interface ByokSettingsResponse {
  ok: boolean;
  updatedAt: string | null;
  providers: {
    openai: ByokProviderStatus;
    anthropic: ByokProviderStatus;
    openrouter: ByokProviderStatus;
  };
  error?: string;
}

export interface ByokProviderHealth {
  ok: boolean;
  modelCount?: number;
  sample?: string[];
  error?: string;
}

export interface ByokHealthResponse {
  ok: boolean;
  agentId: string;
  providers: {
    openai: ByokProviderHealth;
    anthropic: ByokProviderHealth;
    openrouter: ByokProviderHealth;
  };
  error?: string;
}

export interface Decision {
  id: string;
  title: string;
  agent: string;
  waitingMinutes: number;
  context: string;
  artifactPreview?: boolean;
  options?: { label: string; action: string }[];
}

export interface Agent {
  id: string;
  name: string;
  role: string;
  status: AgentStatus;
  task: string | null;
  progress: number | null;
  lastActive: string;
  lastActiveMinutes: number;
  blockedBy?: string;
  error?: string;
}

export interface Artifact {
  id: string;
  type: 'pull_request' | 'email_draft' | 'document' | 'other';
  label: string;
  agent?: string;
  time?: string;
  content?: string;
  url?: string;
}

export interface ActivityItem {
  id: string;
  type: ActivityType;
  agent: string;
  agentId?: string;
  title: string;
  time: string;
  timeGroup: 'today' | 'earlier';
  isNew: boolean;
  error?: boolean;
  artifact?: Artifact;
}
