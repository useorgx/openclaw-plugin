// ---------------------------------------------------------------------------
// Canonical state constants for queue, lane, and related enumerations.
// Use these instead of raw string literals throughout the codebase.
// ---------------------------------------------------------------------------

/** Queue state for next-up items (workstream-level). */
export const QueueState = {
  QUEUED: "queued",
  RUNNING: "running",
  BLOCKED: "blocked",
  IDLE: "idle",
  /** Used only in the API normalization layer (mission-control-read.ts). */
  COMPLETED: "completed",
} as const;
/** Core queue states used by the queue builder (excludes "completed"). */
export type CoreQueueState = "queued" | "running" | "blocked" | "idle";
/** Extended queue state including API-only values. */
export type QueueStateValue = (typeof QueueState)[keyof typeof QueueState];

/** Auto-continue lane state (per-workstream within a run). */
export const LaneState = {
  IDLE: "idle",
  RUNNING: "running",
  BLOCKED: "blocked",
  WAITING_DEPENDENCY: "waiting_dependency",
  RATE_LIMITED: "rate_limited",
  COMPLETED: "completed",
} as const;
export type LaneStateValue = (typeof LaneState)[keyof typeof LaneState];

/** Auto-continue run status. */
export const RunStatus = {
  RUNNING: "running",
  STOPPING: "stopping",
  STOPPED: "stopped",
} as const;
export type RunStatusValue = (typeof RunStatus)[keyof typeof RunStatus];

/** Runner source — how the agent was assigned. */
export const RunnerSource = {
  ASSIGNED: "assigned",
  INFERRED: "inferred",
  FALLBACK: "fallback",
} as const;
export type RunnerSourceValue = (typeof RunnerSource)[keyof typeof RunnerSource];
