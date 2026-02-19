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

/**
 * Consumer-friendly warning messages.
 */
export function humanizeWarning(raw: string): string {
  if (/agent catalog unavailable/i.test(raw)) return 'Some agent details are temporarily unavailable';
  if (/timed out/i.test(raw)) return 'Loading agent details...';
  if (/budget.*exhaust/i.test(raw)) return 'Token budget reached';
  return humanizeText(raw);
}

/**
 * Format token counts for display: "1.2M / 6.2M (19%)" or null if hidden.
 */
export function formatTokens(used: number | null, budget: number | null): string | null {
  if (used == null && budget == null) return null;
  if (used === 0 && budget) return null; // hide when no usage
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
