/**
 * Guards for suppressing null, unknown, or meaningless field values in modal UIs.
 *
 * Prevents rendering confusing placeholders like "unknown", "—", or empty strings
 * that undermine operator confidence. Also provides content deduplication helpers
 * for slice modals where the same string appears in multiple sections.
 */

// ---------------------------------------------------------------------------
// Field suppression
// ---------------------------------------------------------------------------

const EMPTY_VALUES = new Set(['unknown', '\u2014', '-', '', 'null', 'undefined', 'n/a', 'none']);

/**
 * Returns true only when a field has a meaningful, displayable value.
 * Use this to conditionally render metadata rows in modals.
 */
export function shouldRenderField(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') return !EMPTY_VALUES.has(value.trim().toLowerCase());
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

/**
 * Strings that are internal implementation details and should never be shown
 * in user-facing modal surfaces. Remove them entirely.
 */
const INTERNAL_ATTRIBUTION_PATTERNS = [
  /^Based on related activity\b/i,
  /^Reported by slice metadata$/i,
  /^Derived from runtime session$/i,
  /^Estimated from dispatch lifecycle$/i,
];

/**
 * Returns true if a string is an internal attribution label that should
 * be hidden from user-facing display (visible only in Technical Details).
 */
export function isInternalAttribution(text: string): boolean {
  return INTERNAL_ATTRIBUTION_PATTERNS.some((re) => re.test(text.trim()));
}

// ---------------------------------------------------------------------------
// Content deduplication
// ---------------------------------------------------------------------------

/**
 * Normalize a string for dedup comparison:
 * lowercase, trim, strip trailing period, collapse whitespace.
 */
function normalize(s: string): string {
  return s
    .toLowerCase()
    .trim()
    .replace(/\.\s*$/, '')
    .replace(/\s+/g, ' ');
}

export interface DedupedSliceSections {
  /** Primary outcome text (highest priority — always shown if available) */
  outcome: string | null;
  /** "What happened" — only if it adds new information beyond outcome */
  whatHappened: string | null;
  /** "Last activity" — only if it adds new information beyond the above */
  lastActivity: string | null;
}

/**
 * Deduplicate slice modal sections that often repeat the same string.
 * Priority order: OUTCOME > WHAT HAPPENED > LAST ACTIVITY.
 * A section is suppressed if its normalized content matches a higher-priority section.
 */
export function dedupeSliceSections(data: {
  statusExplainer?: string | null;
  summary?: string | null;
  lastEventSummary?: string | null;
}): DedupedSliceSections {
  const seen = new Set<string>();

  const outcome = data.statusExplainer?.trim() || null;
  if (outcome) seen.add(normalize(outcome));

  const whatHappened = data.summary?.trim() || null;
  const whatHappenedIsNew = whatHappened != null && !seen.has(normalize(whatHappened));
  if (whatHappened) seen.add(normalize(whatHappened));

  const lastActivity = data.lastEventSummary?.trim() || null;
  const lastActivityIsNew = lastActivity != null && !seen.has(normalize(lastActivity));

  return {
    outcome,
    whatHappened: whatHappenedIsNew ? whatHappened : null,
    lastActivity: lastActivityIsNew ? lastActivity : null,
  };
}

// ---------------------------------------------------------------------------
// Outcome synthesis
// ---------------------------------------------------------------------------

/**
 * Synthesize a richer outcome description when the slice has sparse content.
 * Uses structured data (artifact count, lifecycle state) to generate
 * context that the raw statusExplainer doesn't provide.
 */
export function synthesizeOutcome(slice: {
  lifecycleState: string;
  artifactCount: number;
  artifacts?: Array<{ title: string; type: string }>;
  statusExplainer?: string;
  confidence?: string;
}): string | null {
  const parts: string[] = [];

  if (slice.lifecycleState === 'completed' && slice.artifactCount === 0) {
    parts.push('Completed but produced no artifacts.');
    parts.push(
      'This may indicate the agent finished analysis without outputting structured results.'
    );
    if (slice.statusExplainer) {
      parts.push(slice.statusExplainer);
    }
  } else if (slice.lifecycleState === 'completed' && slice.artifactCount > 0) {
    parts.push(
      `Completed with ${slice.artifactCount} artifact${slice.artifactCount > 1 ? 's' : ''}.`
    );
    const artifacts = slice.artifacts ?? [];
    for (const a of artifacts.slice(0, 3)) {
      parts.push(`\u00b7 ${a.title} (${a.type})`);
    }
    if (artifacts.length > 3) {
      parts.push(`\u00b7 and ${artifacts.length - 3} more`);
    }
  } else if (slice.lifecycleState === 'failed') {
    parts.push('Failed during execution.');
    if (slice.statusExplainer) parts.push(slice.statusExplainer);
  } else if (slice.lifecycleState === 'awaiting_input') {
    parts.push('Waiting for input before continuing.');
    if (slice.statusExplainer) parts.push(slice.statusExplainer);
  }

  return parts.length > 0 ? parts.join(' ') : null;
}
