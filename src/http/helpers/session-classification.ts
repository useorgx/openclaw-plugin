import type {
  LiveActivityItem,
  SessionBlockerContext,
  SessionBlockerDiagnostics,
  SessionTreeNode,
  SessionTreeResponse,
} from "../../types.js";
import type { RuntimeInstanceRecord } from "../../runtime-instance-store.js";

const DEFAULT_REPORTING_STALE_MS = 15 * 60_000;
const GENERIC_BLOCKER_REASONS = new Set([
  "agent execution failed",
  "execution failed",
  "run failed",
  "failed",
  "blocked",
]);

type RunBlockerSignal = {
  reason: string | null;
  source: string | null;
  errorCode: string | null;
  errorCategory: string | null;
  retryable: boolean | null;
  suggestedActions: string[];
  eventId: string | null;
  eventType: string | null;
  eventTimestamp: string | null;
  isConsoleRecovery: boolean;
};

type RunActivitySignals = {
  completedCount: number;
  blockerCount: number;
  hardBlockerCount: number;
  latestCompletedAt: number;
  latestHardBlockerAt: number;
  latestBlockerAt: number;
  latestBlocker: RunBlockerSignal | null;
  context: SessionBlockerContext;
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

function normalizeReason(value: string | null | undefined): string {
  return (value ?? "").trim().replace(/\s+/g, " ").toLowerCase();
}

function isGenericFailureReason(value: string | null | undefined): boolean {
  const normalized = normalizeReason(value);
  if (!normalized) return false;
  return GENERIC_BLOCKER_REASONS.has(normalized);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function metadataVariants(metadata: Record<string, unknown> | null): Record<string, unknown>[] {
  if (!metadata) return [];
  const variants = [metadata];
  const nested = asRecord(metadata.orgx_context);
  if (nested) variants.push(nested);
  return variants;
}

function metadataString(
  metadata: Record<string, unknown> | null,
  keys: string[]
): string | null {
  for (const source of metadataVariants(metadata)) {
    for (const key of keys) {
      const value = source[key];
      if (typeof value !== "string") continue;
      const trimmed = value.trim();
      if (trimmed.length > 0) return trimmed;
    }
  }
  return null;
}

function metadataStringArray(
  metadata: Record<string, unknown> | null,
  keys: string[]
): string[] {
  for (const source of metadataVariants(metadata)) {
    for (const key of keys) {
      const value = source[key];
      if (Array.isArray(value)) {
        const normalized = value
          .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
          .filter((entry) => entry.length > 0);
        if (normalized.length > 0) return dedupeStrings(normalized);
      }
      if (typeof value === "string") {
        const parsed = value
          .split(/[\n,;]+/g)
          .map((entry) => entry.trim())
          .filter((entry) => entry.length > 0);
        if (parsed.length > 0) return dedupeStrings(parsed);
      }
    }
  }
  return [];
}

function metadataBoolean(
  metadata: Record<string, unknown> | null,
  keys: string[]
): boolean | null {
  for (const source of metadataVariants(metadata)) {
    for (const key of keys) {
      const value = source[key];
      if (typeof value === "boolean") return value;
      if (typeof value === "string") {
        const normalized = value.trim().toLowerCase();
        if (normalized === "true") return true;
        if (normalized === "false") return false;
      }
    }
  }
  return null;
}

function dedupeStrings(values: string[]): string[] {
  const output: string[] = [];
  const seen = new Set<string>();
  for (const entry of values) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(trimmed);
  }
  return output;
}

function firstNonEmpty(values: Array<string | null | undefined>): string | null {
  for (const value of values) {
    if (!nonEmpty(value)) continue;
    return value!.trim();
  }
  return null;
}

function firstSpecificReason(values: Array<string | null | undefined>): string | null {
  for (const value of values) {
    if (!nonEmpty(value)) continue;
    const trimmed = value!.trim();
    if (!isGenericFailureReason(trimmed)) return trimmed;
  }
  return null;
}

function hasBlockerContext(context: SessionBlockerContext): boolean {
  return Boolean(
    nonEmpty(context.initiativeId) ||
      (Array.isArray(context.initiativeIds) && context.initiativeIds.length > 0) ||
      nonEmpty(context.workstreamId) ||
      (Array.isArray(context.workstreamIds) && context.workstreamIds.length > 0) ||
      nonEmpty(context.workstreamTitle) ||
      context.taskIds.length > 0 ||
      context.milestoneIds.length > 0 ||
      nonEmpty(context.iwmtId ?? null) ||
      (Array.isArray(context.iwmtIds) && context.iwmtIds.length > 0) ||
      nonEmpty(context.sliceRunId) ||
      nonEmpty(context.parallelMode) ||
      nonEmpty(context.logPath) ||
      nonEmpty(context.outputPath)
  );
}

function emptyBlockerContext(): SessionBlockerContext {
  return {
    initiativeId: null,
    initiativeIds: [],
    workstreamId: null,
    workstreamIds: [],
    workstreamTitle: null,
    taskIds: [],
    milestoneIds: [],
    iwmtId: null,
    iwmtIds: [],
    sliceRunId: null,
    parallelMode: null,
    logPath: null,
    outputPath: null,
  };
}

function mergeRunContext(
  context: SessionBlockerContext,
  item: LiveActivityItem,
  metadata: Record<string, unknown> | null
): SessionBlockerContext {
  const initiativeIds = dedupeStrings([
    ...(Array.isArray(context.initiativeIds) ? context.initiativeIds : []),
    ...(context.initiativeId ? [context.initiativeId] : []),
    ...(item.initiativeId ? [item.initiativeId] : []),
    ...metadataStringArray(metadata, ["initiative_ids", "initiativeIds"]),
  ]);
  const initiativeId = firstNonEmpty([
    item.initiativeId,
    metadataString(metadata, ["initiative_id", "initiativeId"]),
    initiativeIds[0] ?? null,
  ]);
  if (initiativeIds.length > 0) context.initiativeIds = initiativeIds;
  if (initiativeId) context.initiativeId = initiativeId;

  const workstreamIds = dedupeStrings([
    ...(Array.isArray(context.workstreamIds) ? context.workstreamIds : []),
    ...(context.workstreamId ? [context.workstreamId] : []),
    ...metadataStringArray(metadata, ["workstream_ids", "workstreamIds"]),
  ]);
  const workstreamId = firstNonEmpty([
    metadataString(metadata, ["workstream_id", "workstreamId"]),
    workstreamIds[0] ?? null,
  ]);
  if (workstreamIds.length > 0) context.workstreamIds = workstreamIds;
  if (workstreamId) context.workstreamId = workstreamId;

  const workstreamTitle = metadataString(metadata, ["workstream_title", "workstreamTitle"]);
  if (workstreamTitle) context.workstreamTitle = workstreamTitle;

  const taskIds = metadataStringArray(metadata, [
    "task_ids",
    "taskIds",
    "active_task_ids",
    "activeTaskIds",
  ]);
  if (taskIds.length > 0) {
    context.taskIds = dedupeStrings([...context.taskIds, ...taskIds]);
  }

  const milestoneIds = metadataStringArray(metadata, ["milestone_ids", "milestoneIds"]);
  if (milestoneIds.length > 0) {
    context.milestoneIds = dedupeStrings([...context.milestoneIds, ...milestoneIds]);
  }

  const iwmtIds = dedupeStrings([
    ...(Array.isArray(context.iwmtIds) ? context.iwmtIds : []),
    ...(context.iwmtId ? [context.iwmtId] : []),
    ...metadataStringArray(metadata, ["iwmt_ids", "iwmtIds"]),
  ]);
  const iwmtId = firstNonEmpty([
    metadataString(metadata, ["iwmt_id", "iwmtId"]),
    iwmtIds[0] ?? null,
  ]);
  if (iwmtIds.length > 0) context.iwmtIds = iwmtIds;
  if (iwmtId) context.iwmtId = iwmtId;

  const sliceRunId = metadataString(metadata, [
    "slice_run_id",
    "sliceRunId",
    "active_run_id",
    "activeRunId",
  ]);
  if (sliceRunId) context.sliceRunId = sliceRunId;

  const parallelMode = metadataString(metadata, [
    "parallel_mode",
    "parallelMode",
    "auto_continue_parallel_mode",
    "autoContinueParallelMode",
  ]);
  if (parallelMode) context.parallelMode = parallelMode;

  const logPath = metadataString(metadata, ["log_path", "logPath"]);
  if (logPath) context.logPath = logPath;

  const outputPath = metadataString(metadata, ["output_path", "outputPath"]);
  if (outputPath) context.outputPath = outputPath;

  return context;
}

function deriveBlockerSignal(item: LiveActivityItem): RunBlockerSignal {
  const metadata = asRecord(item.metadata);
  const reason =
    firstSpecificReason([
      metadataString(metadata, ["description", "reason", "error", "error_message"]),
      item.summary ?? null,
      item.description ?? null,
      metadataString(metadata, ["message", "summary", "last_error", "lastError"]),
      item.title,
    ]) ??
    firstNonEmpty([
      metadataString(metadata, ["description", "reason", "error", "error_message"]),
      item.summary ?? null,
      item.description ?? null,
      metadataString(metadata, ["message", "summary", "last_error", "lastError"]),
      item.title,
    ]);

  return {
    reason,
    source: metadataString(metadata, ["source", "runtime_source", "runtimeSource"]),
    errorCode: metadataString(metadata, ["errorCode", "error_code"]),
    errorCategory: metadataString(metadata, ["errorCategory", "error_category"]),
    retryable: metadataBoolean(metadata, [
      "retryable",
      "isRetryable",
      "retry_allowed",
      "retryAllowed",
    ]),
    suggestedActions: metadataStringArray(metadata, [
      "suggestedActions",
      "suggested_actions",
      "next_actions",
      "nextActions",
    ]),
    eventId: item.id ?? null,
    eventType: item.type ?? null,
    eventTimestamp: item.timestamp ?? null,
    isConsoleRecovery: isConsoleRecoveryBlocker(item),
  };
}

function isLikelyReportingControlSession(node: SessionTreeNode): boolean {
  if (nonEmpty(node.agentId) || nonEmpty(node.agentName)) return false;
  const title = statusKey(node.title);
  return title.startsWith("reporting");
}

function hasActionableBlockerData(
  node: SessionTreeNode,
  signal: RunActivitySignals | null
): boolean {
  const blockerEntries = dedupeStrings([
    ...(Array.isArray(node.blockers) ? node.blockers : []),
    node.blockerReason ?? "",
  ]);
  const hasSpecificNodeReason = blockerEntries.some((entry) => !isGenericFailureReason(entry));
  if (hasSpecificNodeReason) {
    const consoleRecoveryOnly =
      Boolean(signal?.latestBlocker?.isConsoleRecovery) && (signal?.hardBlockerCount ?? 0) === 0;
    if (!consoleRecoveryOnly) return true;
  }
  if (signal && signal.hardBlockerCount > 0) return true;
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
  const metadata = asRecord(item.metadata);
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
  const ordered = [...activity].sort((a, b) => toEpoch(a.timestamp) - toEpoch(b.timestamp));

  for (const item of ordered) {
    const runId = item.runId?.trim();
    if (!runId) continue;
    const timestamp = toEpoch(item.timestamp);
    const metadata = asRecord(item.metadata);

    const existing = byRunId.get(runId) ?? {
      completedCount: 0,
      blockerCount: 0,
      hardBlockerCount: 0,
      latestCompletedAt: 0,
      latestHardBlockerAt: 0,
      latestBlockerAt: 0,
      latestBlocker: null,
      context: emptyBlockerContext(),
    };
    existing.context = mergeRunContext(existing.context, item, metadata);

    const phase = statusKey(item.phase ?? null);
    const state = statusKey(item.state ?? null);
    const completedLike =
      item.type === "run_completed" || phase === "completed" || state === "completed";
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
      if (timestamp >= existing.latestBlockerAt) {
        existing.latestBlockerAt = timestamp;
        existing.latestBlocker = deriveBlockerSignal(item);
      }
      if (!isConsoleRecovery) {
        existing.hardBlockerCount += 1;
        existing.latestHardBlockerAt = Math.max(existing.latestHardBlockerAt, timestamp);
      }
    }

    byRunId.set(runId, existing);
  }

  return byRunId;
}

function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function blockerContextsEqual(a: SessionBlockerContext, b: SessionBlockerContext): boolean {
  return (
    a.initiativeId === b.initiativeId &&
    arraysEqual(a.initiativeIds ?? [], b.initiativeIds ?? []) &&
    a.workstreamId === b.workstreamId &&
    arraysEqual(a.workstreamIds ?? [], b.workstreamIds ?? []) &&
    a.workstreamTitle === b.workstreamTitle &&
    arraysEqual(a.taskIds, b.taskIds) &&
    arraysEqual(a.milestoneIds, b.milestoneIds) &&
    (a.iwmtId ?? null) === (b.iwmtId ?? null) &&
    arraysEqual(a.iwmtIds ?? [], b.iwmtIds ?? []) &&
    a.sliceRunId === b.sliceRunId &&
    a.parallelMode === b.parallelMode &&
    a.logPath === b.logPath &&
    a.outputPath === b.outputPath
  );
}

function blockerDiagnosticsEqual(
  a: SessionBlockerDiagnostics | null | undefined,
  b: SessionBlockerDiagnostics | null | undefined
): boolean {
  if (!a && !b) return true;
  if (!a || !b) return false;
  return (
    a.reason === b.reason &&
    a.source === b.source &&
    a.errorCode === b.errorCode &&
    a.errorCategory === b.errorCategory &&
    a.retryable === b.retryable &&
    arraysEqual(a.suggestedActions, b.suggestedActions) &&
    a.eventId === b.eventId &&
    a.eventType === b.eventType &&
    a.eventTimestamp === b.eventTimestamp &&
    blockerContextsEqual(a.context, b.context)
  );
}

function mergeReportingBlockerDetails(
  node: SessionTreeNode,
  signal: RunActivitySignals | null
): SessionTreeNode {
  if (!signal) return node;

  const latest = signal.latestBlocker;
  const resolvedReason =
    firstSpecificReason([
      latest?.reason ?? null,
      node.blockerReason ?? null,
      ...(Array.isArray(node.blockers) ? node.blockers : []),
    ]) ??
    firstNonEmpty([
      latest?.reason ?? null,
      node.blockerReason ?? null,
      ...(Array.isArray(node.blockers) ? node.blockers : []),
    ]);

  const currentBlockers = dedupeStrings(Array.isArray(node.blockers) ? node.blockers : []);
  const hasOnlyGenericBlockers =
    currentBlockers.length > 0 && currentBlockers.every(isGenericFailureReason);
  const nextBlockers = resolvedReason
    ? hasOnlyGenericBlockers
      ? [resolvedReason]
      : dedupeStrings([...currentBlockers, resolvedReason])
    : hasOnlyGenericBlockers
      ? []
      : currentBlockers;

  const context: SessionBlockerContext = {
    ...signal.context,
    initiativeId: signal.context.initiativeId ?? node.initiativeId ?? null,
    workstreamId: signal.context.workstreamId ?? node.workstreamId ?? null,
    initiativeIds: dedupeStrings([
      ...(signal.context.initiativeIds ?? []),
      ...(node.initiativeId ? [node.initiativeId] : []),
    ]),
    workstreamIds: dedupeStrings([
      ...(signal.context.workstreamIds ?? []),
      ...(node.workstreamId ? [node.workstreamId] : []),
    ]),
  };
  const diagnostics: SessionBlockerDiagnostics | null =
    latest || hasBlockerContext(context)
      ? {
          reason: resolvedReason,
          source: latest?.source ?? null,
          errorCode: latest?.errorCode ?? null,
          errorCategory: latest?.errorCategory ?? null,
          retryable: latest?.retryable ?? null,
          suggestedActions: latest?.suggestedActions ?? [],
          eventId: latest?.eventId ?? null,
          eventType: latest?.eventType ?? null,
          eventTimestamp: latest?.eventTimestamp ?? null,
          context,
        }
      : null;

  const nextNode: SessionTreeNode = {
    ...node,
    initiativeId: node.initiativeId ?? context.initiativeId ?? null,
    workstreamId: node.workstreamId ?? context.workstreamId ?? null,
    blockerReason: resolvedReason,
    blockers: nextBlockers,
    blockerDiagnostics: diagnostics,
    lastEventSummary: node.lastEventSummary ?? latest?.reason ?? null,
  };

  const unchanged =
    nextNode.initiativeId === node.initiativeId &&
    nextNode.workstreamId === node.workstreamId &&
    nextNode.blockerReason === node.blockerReason &&
    nextNode.lastEventSummary === node.lastEventSummary &&
    arraysEqual(nextNode.blockers, node.blockers) &&
    blockerDiagnosticsEqual(nextNode.blockerDiagnostics, node.blockerDiagnostics);
  return unchanged ? node : nextNode;
}

function reportingSessionShouldBeCompleted(input: {
  node: SessionTreeNode;
  signal: RunActivitySignals | null;
  hasRuntimeSignal: boolean;
  hasActionableBlocker: boolean;
  nowMs: number;
  staleMs: number;
}): boolean {
  const { node, signal, hasRuntimeSignal, hasActionableBlocker, nowMs, staleMs } = input;
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
  const latestReason = normalizeReason(signal?.latestBlocker?.reason ?? null);
  const consoleRecoveryLike =
    Boolean(signal?.latestBlocker?.isConsoleRecovery) ||
    latestReason.includes("automatically recovered") ||
    latestReason.includes("auto-recovered");
  if (
    stale &&
    !hasRuntimeSignal &&
    !hasHardBlocker &&
    (consoleRecoveryLike || !hasActionableBlocker)
  ) {
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
    blockerDiagnostics: null,
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

    const runId = node.runId?.trim();
    if (!runId) return node;

    const signal = runSignals.get(runId) ?? null;
    const hydrated = mergeReportingBlockerDetails(node, signal);
    if (hydrated !== node) changed = true;

    const hasActionable = hasActionableBlockerData(hydrated, signal);
    const hasRuntimeSignal = runtimeRunIds.has(runId);
    if (
      !reportingSessionShouldBeCompleted({
        node: hydrated,
        signal,
        hasRuntimeSignal,
        hasActionableBlocker: hasActionable,
        nowMs,
        staleMs,
      })
    ) {
      return hydrated;
    }

    changed = true;
    return completeReportingSession(hydrated);
  });

  return changed ? { ...sessions, nodes } : sessions;
}
