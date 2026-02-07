/**
 * Human-readable display transformations.
 * Strips developer noise (UUIDs, raw model strings, long paths) from dashboard surfaces.
 */

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
