export type ConnectionStatus = 'connected' | 'reconnecting' | 'disconnected';

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
  runId: string | null;
  initiativeId: string | null;
  timestamp: string;
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

export interface LiveData {
  connection: ConnectionStatus;
  lastActivity: string | null;
  sessions: SessionTreeResponse;
  activity: LiveActivityItem[];
  handoffs: HandoffSummary[];
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
  category?: string;
  health: number;
  phases?: Phase[];
  currentPhase?: number;
  daysRemaining: number;
  activeAgents: number;
  totalAgents: number;
  avatars?: string[];
  description?: string;
  workstreams?: { id: string; name: string; status: string }[];
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
