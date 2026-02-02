export type ConnectionStatus = 'connected' | 'reconnecting' | 'disconnected';

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

export interface Phase {
  name: string;
  status: 'completed' | 'current' | 'upcoming' | 'warning';
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

export interface LiveData {
  connection: ConnectionStatus;
  lastActivity: string | null;
  initiatives: Initiative[];
  pendingDecisions: Decision[];
  agents: Agent[];
  activities: ActivityItem[];
}
