/**
 * Human-readable display transformations.
 * Strips developer noise (UUIDs, raw model strings, long paths) from dashboard surfaces.
 */

const LABEL_DICTIONARY: Record<string, string> = {
  'dispatch session': 'Start',
  'dispatch': 'Start',
  'checkpoint': 'Save progress',
  'rollback': 'Undo last step',
  'continue priority': 'Resume',
  'slice progress': 'Progress',
  'spawn guard rate limit': 'Capacity limit',
  'spawn guard blocked': 'Waiting for capacity',
  'spawn guard': 'Capacity check',
  'failed spawn guard checks': 'Waiting for capacity',
  'domain window': '',
  'tier': '',
  'outbox': '',
  'replay': '',
  'system': 'OrgX',
  'unassigned': 'OrgX',
  'auto_continue_stopped': 'Paused',
  'next_up_manual_dispatch_started': 'Started',
  'dispatch_lifecycle': '',
  'execution context': 'Session status',
  'estimated from dispatch lifecycle': 'Progress',
  'delegation flow': 'Routing',
  'playback context': 'Current context',
  'runner': '',
};

/** Replace internal jargon with consumer-friendly labels. */
export function humanizeLabel(key: string): string {
  const lower = key.toLowerCase().trim();
  const mapped = LABEL_DICTIONARY[lower];
  if (mapped !== undefined) return mapped;
  return key;
}

const MODEL_ALIASES: [test: RegExp, label: string][] = [
  [/opus/i, "Opus"],
  [/sonnet/i, "Sonnet"],
  [/haiku/i, "Haiku"],
  [/kimi/i, "Kimi"],
  [/gemini/i, "Gemini"],
  [/gpt-4o/i, "GPT-4o"],
  [/gpt-4/i, "GPT-4"],
  [/qwen/i, "Qwen"],
  [/deepseek/i, "DeepSeek"],
  [/llama/i, "Llama"],
];

/** "anthropic/claude-opus-4-5" → "Opus" */
export function humanizeModel(raw: string | null | undefined): string {
  if (!raw) return "";
  for (const [re, label] of MODEL_ALIASES) {
    if (re.test(raw)) return label;
  }
  // Strip provider prefix (e.g., "openrouter/foo/bar" → "bar")
  const parts = raw.split("/");
  return parts[parts.length - 1] ?? raw;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX_ID_RE = /^[0-9a-f]{20,}$/i;

/** UUID → "#533a" short tag, or hidden entirely if embedded in text. */
export function humanizeId(raw: string): string {
  if (UUID_RE.test(raw)) return `#${raw.slice(0, 4)}`;
  if (HEX_ID_RE.test(raw)) return `#${raw.slice(0, 4)}`;
  return raw;
}

/** Returns true if a string looks like a UUID or long hex ID. */
export function isOpaqueId(raw: string): boolean {
  return UUID_RE.test(raw) || HEX_ID_RE.test(raw);
}

/**
 * "agent:main:telegram:7507666002" → "Holt via Telegram"
 * Uses agentName when provided. Falls back to label extraction.
 */
export function humanizeSessionKey(
  raw: string,
  agentName?: string | null
): string {
  const parts = raw.split(":");
  const agent = agentName ?? (parts.length >= 2 && parts[0] === "agent" ? parts[1] : null);

  // Extract channel from the session key
  if (parts.length >= 3 && parts[0] === "agent") {
    const rest = parts.slice(2).join(":");
    const channel = extractChannel(rest);
    if (channel && agent) return `${agent} via ${channel}`;
    if (channel) return channel;
    if (agent) return agent;
    return rest || raw;
  }

  if (agent) return agent;
  return raw;
}

function extractChannel(label: string): string | null {
  const lower = label.toLowerCase();
  if (lower.startsWith("telegram:")) return "Telegram";
  if (lower.startsWith("discord:")) return "Discord";
  if (lower.startsWith("slack:")) return "Slack";
  if (lower === "webchat" || lower === "web") return "Web";
  if (lower === "main") return null; // Not a channel — it's the default session
  if (lower.startsWith("cron:")) return "Scheduled";
  return null;
}

/**
 * "/Users/hopeatina/Code/orgx/orgx/lib/server/route.ts" → "orgx/lib/server/route.ts"
 * Collapses home directory and shows last N path segments.
 */
export function humanizePath(raw: string, maxSegments = 4): string {
  // Strip home directory prefix
  let cleaned = raw
    .replace(/^\/Users\/[^/]+\//, "~/")
    .replace(/^~\/Code\//, "")
    .replace(/^~\//, "");

  const segments = cleaned.split("/");
  if (segments.length > maxSegments) {
    cleaned = segments.slice(-maxSegments).join("/");
  }
  return cleaned;
}

/**
 * Clean up a title/description string by replacing known noisy patterns.
 * - Replaces full UUIDs with short tags
 * - Replaces model strings with aliases
 * - Shortens file paths
 */
export function humanizeText(raw: string): string {
  let result = raw;

  // Replace inline UUIDs
  result = result.replace(
    /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
    (match) => `#${match.slice(0, 4)}`
  );

  // Replace model strings
  result = result.replace(
    /(?:anthropic|openrouter|openai)\/[a-z0-9._/-]+/gi,
    (match) => humanizeModel(match)
  );

  // Shorten absolute paths
  result = result.replace(
    /\/Users\/[a-zA-Z0-9_-]+\/[^\s"']+/g,
    (match) => humanizePath(match)
  );

  return result;
}

/**
 * Aggressively clean text for consumer display.
 * Strips UUIDs entirely (not even short tags), file paths, raw IDs.
 */
export function sanitizeDisplayText(text: string): string {
  let result = text;
  // Strip UUIDs entirely
  result = result.replace(/\[?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\]?/gi, '');
  // Strip [workstream ...] wrapper noise
  result = result.replace(/\[workstream\s*\]/gi, '');
  result = result.replace(/\[workstream\b[^\]]*\]/gi, '');
  // Strip file paths
  result = result.replace(/\/var\/folders\/[^\s"']*/g, '(local file)');
  result = result.replace(/\/tmp\/[^\s"']*/g, '(temp file)');
  result = result.replace(/\/Users\/[^\s"']*/g, (m) => humanizePath(m));
  // Strip telegram/discord raw IDs
  result = result.replace(/telegram:\d+/g, 'Telegram session');
  result = result.replace(/discord:\d+/g, 'Discord session');
  // Clean double spaces from removals
  result = result.replace(/\s{2,}/g, ' ').trim();
  return result || 'Untitled session';
}

/**
 * Map raw actor names to consumer-friendly identities.
 * "main" → "You", "system" → "OrgX", etc.
 */
export function humanizeActorName(name: string): string {
  const lower = name.toLowerCase().trim();
  if (lower === 'main') return 'You';
  if (lower === 'system' || lower === 'system / unknown') return 'OrgX';
  if (lower === 'openclaw' || lower === 'local_openclaw') return 'OrgX';
  if (lower === 'not assigned' || lower === 'unassigned') return 'Pending';
  return name;
}

type StructuredErrorDetails = {
  code: string | null;
  message: string | null;
  status: number | null;
  requestId: string | null;
  docsUrl: string | null;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function firstString(record: Record<string, unknown> | null, keys: string[]): string | null {
  if (!record) return null;
  for (const key of keys) {
    const value = record[key];
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return null;
}

function firstFiniteNumber(record: Record<string, unknown> | null, keys: string[]): number | null {
  if (!record) return null;
  for (const key of keys) {
    const value = record[key];
    if (typeof value !== 'number' || !Number.isFinite(value)) continue;
    return value;
  }
  return null;
}

function parseStructuredErrorFromObject(value: unknown): StructuredErrorDetails | null {
  const root = asRecord(value);
  if (!root) return null;
  const nested = asRecord(root.error);
  const envelope = nested ?? root;

  const message =
    firstString(envelope, ['message', 'detail', 'error_description']) ??
    (!nested ? firstString(root, ['error']) : null);
  const code = firstString(envelope, ['code', 'error_code', 'type']);
  const status = firstFiniteNumber(envelope, ['status', 'httpStatusCode']);
  const requestId = firstString(envelope, ['requestId', 'request_id']);
  const docsUrl = firstString(envelope, ['docsUrl', 'docs_url']);

  if (!message && !code && status == null && !requestId && !docsUrl) return null;
  return { code, message, status, requestId, docsUrl };
}

function parseStructuredError(raw: string): StructuredErrorDetails | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const directParsed = (() => {
    try {
      return JSON.parse(trimmed) as unknown;
    } catch {
      return null;
    }
  })();
  const direct = parseStructuredErrorFromObject(directParsed);
  if (direct) return direct;

  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    const body = trimmed.slice(firstBrace, lastBrace + 1);
    try {
      const parsed = JSON.parse(body) as unknown;
      const nested = parseStructuredErrorFromObject(parsed);
      if (nested) return nested;
    } catch {
      // fall through to regex extraction
    }
  }

  const messageMatch = trimmed.match(/"message"\s*:\s*"([^"]+)"/i);
  const codeMatch = trimmed.match(/"code"\s*:\s*"([^"]+)"/i);
  if (!messageMatch && !codeMatch) return null;
  return {
    code: codeMatch?.[1]?.trim() || null,
    message: messageMatch?.[1]?.trim() || null,
    status: null,
    requestId: null,
    docsUrl: null,
  };
}

function stripStructuredNoise(raw: string): string {
  return raw
    .replace(/"requestId"\s*:\s*"[^"]*"/gi, '')
    .replace(/"timestamp"\s*:\s*"[^"]*"/gi, '')
    .replace(/"docsUrl"\s*:\s*"[^"]*"/gi, '')
    .replace(/\brequest[_\s-]?id[:=]\s*[\w-]+/gi, '')
    .replace(/\bdocsUrl[:=]\s*\S+/gi, '')
    .replace(/\btimestamp[:=]\s*\S+/gi, '')
    .replace(/[{}]/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/**
 * Consumer-friendly warning messages.
 */
export function humanizeWarning(raw: string): string {
  const structured = parseStructuredError(raw);
  const structuredCode = structured?.code?.toLowerCase() ?? '';
  const structuredMessage = structured?.message ?? null;
  const normalizedStructuredMessage = structuredMessage?.toLowerCase() ?? '';

  if (
    structuredCode === 'internal_error' ||
    normalizedStructuredMessage.includes('internal server error')
  ) {
    if (/list decision|load decision|decision/i.test(normalizedStructuredMessage)) {
      return 'Decisions are temporarily unavailable. Try refreshing in a moment.';
    }
    return 'OrgX hit a temporary server issue. We will retry automatically.';
  }
  if (
    structuredCode === 'unauthorized' ||
    structuredCode === 'forbidden' ||
    normalizedStructuredMessage.includes('unauthorized') ||
    normalizedStructuredMessage.includes('forbidden')
  ) {
    return 'Authentication needs attention. Reconnect OrgX in Settings.';
  }

  const candidate = structuredMessage ? stripStructuredNoise(structuredMessage) : stripStructuredNoise(raw);
  const normalizedCandidate = candidate.toLowerCase();

  if (/agent catalog unavailable|listagents/i.test(raw)) {
    return 'Agent details are still loading.';
  }
  if (/timed out|timeout|request cancelled|signal is aborted/i.test(normalizedCandidate)) {
    return 'Live sync is taking longer than expected. Data will refresh automatically.';
  }
  if (/budget.*exhaust/i.test(normalizedCandidate)) return 'Token budget reached';
  if (/unknown api endpoint|route is unavailable|missing required live routes/i.test(normalizedCandidate)) {
    return 'This plugin build is missing required routes. Update and restart the plugin.';
  }
  if (/unauthorized|forbidden|authentication|api key/i.test(normalizedCandidate)) {
    return 'Authentication needs attention. Reconnect OrgX in Settings.';
  }
  if (/worker exited without structured output|worker close|signal=null/i.test(normalizedCandidate)) {
    return 'An agent run ended before returning a structured result.';
  }
  if (/mcp handshake failed/i.test(normalizedCandidate)) {
    return 'The agent connection handshake failed. Retry after reconnecting.';
  }
  if (/run not found/i.test(normalizedCandidate)) {
    return 'This session is no longer available.';
  }
  if (/500|internal_error|internal server error/i.test(normalizedCandidate)) {
    return 'Something went wrong on the server. Retrying automatically.';
  }
  if (/econnrefused|network error|fetch failed/i.test(normalizedCandidate)) {
    return 'Connection issue. Retrying automatically.';
  }
  if (/40[13]/.test(normalizedCandidate)) {
    return 'Access issue. You may need to reconnect your workspace.';
  }
  if (/blocked without an explicit reason/i.test(normalizedCandidate)) {
    return 'This item was paused without a specific reason.';
  }
  return sanitizeDisplayText(humanizeText(candidate));
}

/**
 * Format token counts for display: "1.2M / 6.2M (19%)" or null if hidden.
 */
export function formatTokens(used: number | null, budget: number | null): string | null {
  if (used == null && budget == null) return null;
  if (used === 0 && budget) return null; // hide when no usage
  if (used === 0 && !budget) return null; // hide 0 with no budget
  const u = used ?? 0;
  const b = budget ?? 0;
  const fmtNum = (n: number) =>
    n >= 1_000_000
      ? `${(n / 1_000_000).toFixed(1)}M`
      : n >= 1_000
        ? `${Math.round(n / 1_000)}K`
        : `${n}`;
  if (b > 0) return `${fmtNum(u)} / ${fmtNum(b)} (${Math.round((u / b) * 100)}%)`;
  return fmtNum(u);
}

/**
 * Derive a meaningful fallback title from event metadata when the description
 * is empty, instead of falling back to the generic "Untitled session".
 */
export function deriveActivityFallbackTitle(meta: Record<string, unknown> | undefined): string {
  const eventName = (meta?.event_name ?? meta?.event ?? '') as string;
  if (eventName) {
    const humanized = humanizeText(eventName);
    if (humanized && humanized !== 'Untitled session') return humanized;
  }
  const taskTitle = (meta?.task_title ?? meta?.workstream_title ?? meta?.initiative_title ?? '') as string;
  if (taskTitle.trim()) return taskTitle.trim();
  return 'Activity event';
}

// -----------------------------------------------------------------------------
// Activity Summary Humanization
// -----------------------------------------------------------------------------

export interface HumanizedActivitySummary {
  taskDescription: string | null;
  outcomeDescription: string | null;
  nextStep: string | null;
}

export interface HumanizedActivityNarrative {
  update: string | null;
  scope: string | null;
  status: string | null;
  artifacts: string[];
  outcomes: string[];
  nextUp: string[];
}

/**
 * Extract a human-readable 3-part summary from a LiveActivityItem.
 * Returns task description, outcome, and next step by reading structured metadata.
 */
export function humanizeActivitySummary(item: {
  title?: string | null;
  description?: string | null;
  summary?: string | null;
  metadata?: Record<string, unknown>;
}): HumanizedActivitySummary {
  const narrative = humanizeActivityNarrative(item);
  if (narrative.update || narrative.nextUp.length > 0) {
    const taskDescription =
      uniqueStrings([narrative.scope, item.title ?? null])[0] ?? null;
    return {
      taskDescription,
      outcomeDescription: narrative.update,
      nextStep: narrative.nextUp[0] ?? null,
    };
  }
  const meta = item.metadata ?? {};

  // Task description: what was supposed to happen
  const taskTitle = readMeta(meta, 'task_title') ?? readMeta(meta, 'workstream_title');
  const taskDescription = taskTitle
    ? sanitizeDisplayText(String(taskTitle))
    : item.title
      ? sanitizeDisplayText(item.title)
      : null;

  // Outcome: what actually happened
  const userSummary = readMeta(meta, 'user_summary') ?? readMeta(meta, 'summary');
  const outcomeDescription = userSummary
    ? sanitizeDisplayText(String(userSummary))
    : item.summary
      ? sanitizeDisplayText(item.summary)
      : item.description
        ? sanitizeDisplayText(item.description)
        : null;

  // Next step
  const nextStepRaw = readMeta(meta, 'next_step') ?? readMeta(meta, 'nextStep');
  const nextStep = nextStepRaw
    ? sanitizeDisplayText(String(nextStepRaw))
    : null;

  // Deduplicate: if outcome or nextStep repeats task/outcome (exact or substring), suppress it
  const containsMatch = (a: string, b: string): boolean =>
    a === b || a.includes(b) || b.includes(a);
  const dedupedOutcome =
    outcomeDescription && taskDescription && containsMatch(outcomeDescription, taskDescription)
      ? null
      : outcomeDescription;
  const dedupedNextStep =
    nextStep &&
    ((taskDescription && containsMatch(nextStep, taskDescription)) ||
     (outcomeDescription && containsMatch(nextStep, outcomeDescription)))
      ? null
      : nextStep;

  return {
    taskDescription,
    outcomeDescription: dedupedOutcome,
    nextStep: dedupedNextStep,
  };
}

function readMeta(meta: Record<string, unknown>, key: string): string | null {
  const value = meta[key];
  if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  return null;
}

function readFirstString(meta: Record<string, unknown> | null, keys: string[]): string | null {
  if (!meta) return null;
  for (const key of keys) {
    const value = meta[key];
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return null;
}

function readFirstStringArray(meta: Record<string, unknown> | null, keys: string[]): string[] {
  if (!meta) return [];
  for (const key of keys) {
    const raw = meta[key];
    if (!Array.isArray(raw)) continue;
    const values = raw
      .filter((entry): entry is string => typeof entry === 'string')
      .map((entry) => sanitizeDisplayText(entry))
      .filter(Boolean);
    if (values.length > 0) return values;
  }
  return [];
}

function uniqueStrings(values: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const value of values) {
    if (!value) continue;
    const cleaned = sanitizeDisplayText(value);
    if (!cleaned) continue;
    const key = cleaned.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(cleaned);
  }
  return unique;
}

function summarizeEntityUpdates(
  raw: unknown,
  scope: 'Task' | 'Milestone'
): string[] {
  if (!Array.isArray(raw)) return [];
  const updates: string[] = [];
  for (const entry of raw) {
    const record = asRecord(entry);
    if (!record) continue;
    const title =
      readFirstString(record, [`${scope.toLowerCase()}_title`, `${scope.toLowerCase()}Title`, 'title', 'name']) ??
      readFirstString(record, [`${scope.toLowerCase()}_id`, `${scope.toLowerCase()}Id`]);
    const status = readFirstString(record, ['status', 'state']);
    const reason = readFirstString(record, ['reason', 'summary', 'description', 'note']);
    const parts = [
      title ? `${scope}: ${title}` : scope,
      status ? `-> ${humanizeText(status)}` : null,
      reason ? `· ${sanitizeDisplayText(reason)}` : null,
    ].filter(Boolean) as string[];
    if (parts.length > 0) updates.push(parts.join(' '));
  }
  return updates;
}

function collectArtifactLabels(meta: Record<string, unknown> | null): string[] {
  if (!meta) return [];
  const artifacts = meta.artifacts;
  if (Array.isArray(artifacts)) {
    return uniqueStrings(
      artifacts.map((entry) => {
        if (typeof entry === 'string') return entry;
        const record = asRecord(entry);
        if (!record) return null;
        return (
          readFirstString(record, ['title', 'name', 'artifact_title', 'artifactTitle']) ??
          readFirstString(record, ['url', 'path']) ??
          readFirstString(record, ['type', 'artifact_type', 'artifactType'])
        );
      })
    );
  }
  return uniqueStrings([
    readFirstString(meta, ['artifact_title', 'artifactTitle']),
    readFirstString(meta, ['pr_url', 'prUrl']) ? 'Pull request attached' : null,
    readFirstString(meta, ['commit_sha', 'commitSha']) ? 'Commit attached' : null,
  ]);
}

export function humanizeActivityNarrative(item: {
  title?: string | null;
  description?: string | null;
  summary?: string | null;
  metadata?: Record<string, unknown>;
}): HumanizedActivityNarrative {
  const meta = asRecord(item.metadata) ?? {};
  const result = asRecord(meta.result);
  const outcomes = asRecord(meta.outcomes);
  const sources = [meta, result, outcomes].filter((entry): entry is Record<string, unknown> => Boolean(entry));
  const firstString = (keys: string[]): string | null => {
    for (const source of sources) {
      const value = readFirstString(source, keys);
      if (value) return value;
    }
    return null;
  };
  const firstArray = (keys: string[]): string[] => {
    for (const source of sources) {
      const values = readFirstStringArray(source, keys);
      if (values.length > 0) return values;
    }
    return [];
  };

  const scopeHierarchy = firstArray(['scope_hierarchy', 'scopeHierarchy']);
  const scope = uniqueStrings([
    scopeHierarchy.length > 0 ? scopeHierarchy.join(' › ') : null,
    [firstString(['initiative_title', 'initiativeTitle']), firstString(['workstream_title', 'workstreamTitle']), firstString(['task_title', 'taskTitle'])]
      .filter(Boolean)
      .join(' › '),
  ])[0] ?? null;

  const update = uniqueStrings([
    firstString(['user_summary', 'userSummary', 'decision_summary', 'decisionSummary', 'summary', 'description', 'message']),
    item.summary,
    item.description,
  ])[0] ?? null;

  const stopReason = firstString(['stop_reason', 'stopReason']);
  const rawStatus =
    firstString(['parsed_status', 'parsedStatus', 'current_run_state', 'currentRunState', 'runtime_state', 'runtimeState', 'status', 'state']) ??
    stopReason;
  const status = rawStatus ? sanitizeDisplayText(humanizeStopReason(rawStatus) ?? humanizeText(rawStatus)) : null;

  const artifactSources = uniqueStrings(sources.flatMap((source) => collectArtifactLabels(source)));
  const outcomeUpdates = uniqueStrings([
    ...sources.flatMap((source) => summarizeEntityUpdates(source.task_updates ?? source.taskUpdates, 'Task')),
    ...sources.flatMap((source) => summarizeEntityUpdates(source.milestone_updates ?? source.milestoneUpdates, 'Milestone')),
    firstString(['required_action', 'requiredAction']) ? `Required action: ${firstString(['required_action', 'requiredAction'])}` : null,
    firstString(['recommended_action', 'recommendedAction']) ? `Recommended: ${firstString(['recommended_action', 'recommendedAction'])}` : null,
    firstString(['impact_if_delayed', 'impactIfDelayed']) ? `Impact if delayed: ${firstString(['impact_if_delayed', 'impactIfDelayed'])}` : null,
  ]);
  const nextUp = uniqueStrings([
    firstString(['next_step', 'nextStep']),
    ...firstArray(['next_actions', 'nextActions']),
    firstString(['required_action', 'requiredAction']),
  ]);

  return {
    update,
    scope,
    status,
    artifacts: artifactSources.slice(0, 6),
    outcomes: outcomeUpdates.slice(0, 6),
    nextUp: nextUp.slice(0, 5),
  };
}

// ---------------------------------------------------------------------------
// Artifact Type Humanization
// ---------------------------------------------------------------------------

const ARTIFACT_TYPE_MAP: Record<string, string> = {
  // Canonical atomic unit types (from artifact-domain-schemas.ts)
  'engineering.commit': 'Commit',
  'engineering.pr': 'Pull Request',
  'product.spec': 'Specification',
  'product.decision': 'Decision',
  'design.component': 'Design',
  'design.a11y': 'Accessibility Audit',
  'marketing.asset': 'Marketing Asset',
  'marketing.experiment': 'Experiment',
  'sales.qualification': 'Qualification',
  'sales.proposal': 'Proposal',
  'operations.runbook': 'Runbook',
  'operations.incident': 'Incident Report',
  'orchestration.routing': 'Routing',
  'orchestration.decomp': 'Decomposition',
  // Legacy / shorthand aliases
  pull_request: 'Pull Request',
  pr: 'Pull Request',
  document: 'Document',
  doc: 'Document',
  spec: 'Specification',
  code: 'Code',
  implementation: 'Code',
  test: 'Tests',
  design: 'Design',
  config: 'Config',
  decision: 'Decision',
  report: 'Report',
  discovery: 'Discovery',
  commit: 'Commit',
  runbook: 'Runbook',
  incident: 'Incident Report',
  proposal: 'Proposal',
  experiment: 'Experiment',
};

/** Map raw artifact type strings to human-readable labels. */
export function humanizeArtifactType(type: string | null | undefined): string {
  if (!type) return 'Artifact';
  const lower = type.toLowerCase().trim();
  const exact = ARTIFACT_TYPE_MAP[lower];
  if (exact) return exact;
  // Check partial matches
  for (const [key, label] of Object.entries(ARTIFACT_TYPE_MAP)) {
    if (lower.includes(key)) return label;
  }
  return humanizeText(type);
}

// ---------------------------------------------------------------------------
// Stop Reason / Lane State / Blocker Context Humanization
// ---------------------------------------------------------------------------

const STOP_REASON_MAP: Record<string, string> = {
  auto_continue_stopped: 'Autopilot paused',
  budget_exhausted: 'Token budget reached',
  error: 'Encountered an error',
  blocked: 'Waiting for input',
  stopped: 'Manually stopped',
  rate_limited: 'Rate limited — retrying shortly',
  timeout: 'Timed out',
  timed_out: 'Timed out',
  cancelled: 'Cancelled',
  completed: 'Completed',
};

/** Translate internal stop reason enums to human-readable text. */
export function humanizeStopReason(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const lower = raw.trim().toLowerCase().replace(/[\s-]+/g, '_');
  return STOP_REASON_MAP[lower] ?? raw.replace(/_/g, ' ');
}

const LANE_STATE_MAP: Record<string, string> = {
  running: 'Active',
  waiting_for_capacity: 'Waiting for capacity',
  rate_limited: 'Rate limited',
  idle: 'Idle',
  blocked: 'Blocked',
  queued: 'Queued',
};

/** Translate lane state to user-friendly label. */
export function humanizeLaneState(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const lower = raw.trim().toLowerCase().replace(/[\s-]+/g, '_');
  return LANE_STATE_MAP[lower] ?? raw.replace(/_/g, ' ');
}

/** Humanize a value shown in blocker context diagnostics. Strips raw IDs and paths. */
export function humanizeBlockerContextValue(label: string, value: string): string {
  const lower = label.toLowerCase();
  if (lower.includes('path')) {
    return humanizePath(value);
  }
  // For individual IDs
  if (isOpaqueId(value)) {
    return humanizeId(value);
  }
  // For comma-separated lists of IDs
  if (value.includes(',')) {
    return value
      .split(',')
      .map((v) => {
        const trimmed = v.trim();
        return isOpaqueId(trimmed) ? humanizeId(trimmed) : trimmed;
      })
      .join(', ');
  }
  return sanitizeDisplayText(value);
}
