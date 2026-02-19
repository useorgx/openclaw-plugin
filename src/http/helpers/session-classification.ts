import type { LiveActivityItem, SessionTreeNode, SessionTreeResponse } from "../../types.js";
import type { RuntimeInstanceRecord } from "../../runtime-instance-store.js";

const DEFAULT_REPORTING_STALE_MS = 15 * 60_000;

type RunActivitySignals = {
  completedCount: number;
  blockerCount: number;
  hardBlockerCount: number;
  latestCompletedAt: number;
  latestHardBlockerAt: number;
};

function statusKey(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

function toEpoch(value: string | null | undefined): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function nonEmpty(value: string | null | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function metadataString(
  metadata: Record<string, unknown> | null,
  keys: string[]
): string | null {
  if (!metadata) return null;
  for (const key of keys) {
    const value = metadata[key];
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return null;
}

function isLikelyReportingControlSession(node: SessionTreeNode): boolean {
  if (nonEmpty(node.agentId) || nonEmpty(node.agentName)) return false;
  const title = statusKey(node.title);
  return title.startsWith("reporting");
}

function hasActionableBlockerData(node: SessionTreeNode): boolean {
  if (Array.isArray(node.blockers) && node.blockers.length > 0) return true;
  if (nonEmpty(node.blockerReason ?? null)) return true;
  return false;
}

function isBlockedLike(node: SessionTreeNode): boolean {
  const normalizedStatus = statusKey(node.status);
  const normalizedPhase = statusKey(node.phase ?? null);
  const normalizedState = statusKey(node.state ?? null);
  return (
    normalizedStatus === "blocked" ||
    normalizedStatus === "failed" ||
    normalizedPhase === "blocked" ||
    normalizedState === "blocked" ||
    normalizedState === "error"
  );
}

function sessionLastTouchedEpoch(node: SessionTreeNode): number {
  return toEpoch(node.updatedAt ?? node.lastEventAt ?? node.startedAt);
}

function isConsoleRecoveryBlocker(item: LiveActivityItem): boolean {
  if (item.type !== "blocker_created") return false;
  const metadata =
    item.metadata && typeof item.metadata === "object" && !Array.isArray(item.metadata)
      ? (item.metadata as Record<string, unknown>)
      : null;
  const source = statusKey(metadataString(metadata, ["source"]));
  const errorCode = statusKey(metadataString(metadata, ["errorCode", "error_code"]));
  const errorCategory = statusKey(
    metadataString(metadata, ["errorCategory", "error_category"])
  );
  return (
    source === "console_worker" &&
    (errorCode === "state_error" || errorCategory === "state_error")
  );
}

function buildRunActivitySignals(activity: LiveActivityItem[]): Map<string, RunActivitySignals> {
  const byRunId = new Map<string, RunActivitySignals>();

  for (const item of activity) {
    const runId = item.runId?.trim();
    if (!runId) continue;
    const timestamp = toEpoch(item.timestamp);

    const existing = byRunId.get(runId) ?? {
      completedCount: 0,
      blockerCount: 0,
      hardBlockerCount: 0,
      latestCompletedAt: 0,
      latestHardBlockerAt: 0,
    };

    const phase = statusKey(item.phase ?? null);
    const state = statusKey(item.state ?? null);
    const completedLike = item.type === "run_completed" || phase === "completed" || state === "completed";
    if (completedLike) {
      existing.completedCount += 1;
      existing.latestCompletedAt = Math.max(existing.latestCompletedAt, timestamp);
    }

    const blockerLike =
      item.type === "run_failed" ||
      item.type === "blocker_created" ||
      phase === "blocked" ||
      state === "blocked" ||
      state === "error";
    if (blockerLike) {
      existing.blockerCount += 1;
      const isConsoleRecovery = isConsoleRecoveryBlocker(item);
      if (!isConsoleRecovery) {
        existing.hardBlockerCount += 1;
        existing.latestHardBlockerAt = Math.max(existing.latestHardBlockerAt, timestamp);
      }
    }

    byRunId.set(runId, existing);
  }

  return byRunId;
}

function reportingSessionShouldBeCompleted(input: {
  node: SessionTreeNode;
  signal: RunActivitySignals | null;
  hasRuntimeSignal: boolean;
  nowMs: number;
  staleMs: number;
}): boolean {
  const { node, signal, hasRuntimeSignal, nowMs, staleMs } = input;
  const hasCompletedSignal = Boolean(signal && signal.completedCount > 0);
  const hasHardBlocker = Boolean(signal && signal.hardBlockerCount > 0);
  const completedAfterHardBlocker = Boolean(
    signal &&
      signal.latestCompletedAt > 0 &&
      (signal.latestHardBlockerAt === 0 || signal.latestCompletedAt >= signal.latestHardBlockerAt)
  );

  if (hasCompletedSignal && (!hasHardBlocker || completedAfterHardBlocker)) {
    return true;
  }

  const touchedAt = sessionLastTouchedEpoch(node);
  const stale = touchedAt > 0 && nowMs - touchedAt >= staleMs;
  if (stale && !hasRuntimeSignal && !hasHardBlocker) {
    return true;
  }

  return false;
}

function completeReportingSession(node: SessionTreeNode): SessionTreeNode {
  return {
    ...node,
    status: "completed",
    phase: "completed",
    state: "completed",
    blockers: [],
    blockerReason: null,
    lastEventSummary:
      node.lastEventSummary && node.lastEventSummary.trim().length > 0
        ? node.lastEventSummary
        : "Reporting completed.",
  };
}

export function normalizeReportingBlockedSessions(input: {
  sessions: SessionTreeResponse;
  activity: LiveActivityItem[];
  runtimeInstances: RuntimeInstanceRecord[];
  nowMs?: number;
  staleMs?: number;
}): SessionTreeResponse {
  const { sessions } = input;
  if (!Array.isArray(sessions.nodes) || sessions.nodes.length === 0) {
    return sessions;
  }

  const runSignals = buildRunActivitySignals(input.activity ?? []);
  const runtimeRunIds = new Set<string>();
  for (const instance of input.runtimeInstances ?? []) {
    if (nonEmpty(instance.runId)) runtimeRunIds.add(instance.runId!.trim());
    if (nonEmpty(instance.correlationId)) runtimeRunIds.add(instance.correlationId!.trim());
  }

  const nowMs = input.nowMs ?? Date.now();
  const staleMs = Math.max(60_000, input.staleMs ?? DEFAULT_REPORTING_STALE_MS);

  let changed = false;
  const nodes = sessions.nodes.map((node) => {
    if (!isBlockedLike(node)) return node;
    if (!isLikelyReportingControlSession(node)) return node;
    if (hasActionableBlockerData(node)) return node;

    const runId = node.runId?.trim();
    if (!runId) return node;

    const signal = runSignals.get(runId) ?? null;
    const hasRuntimeSignal = runtimeRunIds.has(runId);
    if (
      !reportingSessionShouldBeCompleted({
        node,
        signal,
        hasRuntimeSignal,
        nowMs,
        staleMs,
      })
    ) {
      return node;
    }

    changed = true;
    return completeReportingSession(node);
  });

  return changed ? { ...sessions, nodes } : sessions;
}

