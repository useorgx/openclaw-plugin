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

export type LiveDecisionOptionStatus = 'approved' | 'declined' | 'cancelled';

export interface LiveDecisionOption {
  id: string;
  label: string;
  description: string | null;
  impliedStatus: LiveDecisionOptionStatus | null;
  actionType: string | null;
  requiresNote: boolean;
}

export interface LiveDecision {
  id: string;
  title: string;
  context: string | null;
  status: string;
  agentName: string | null;
  requestedAt: string | null;
  updatedAt: string | null;
  waitingMinutes: number;
  metadata?: Record<string, unknown>;
  options?: LiveDecisionOption[];
  selectedOptionId?: string | null;
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
