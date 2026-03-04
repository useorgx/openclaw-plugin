// ---------------------------------------------------------------------------
// Shared type-coercion helpers for safe parsing of unknown API data.
// Previously duplicated across 20+ files.
// ---------------------------------------------------------------------------

/** Safely cast unknown to a Record, or null if not a plain object. */
export function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return null;
  return value as Record<string, unknown>;
}

/** Safely cast unknown to a trimmed non-empty string, or null. */
export function asString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** Safely cast unknown to a finite number, or null. */
export function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

/** Safely cast unknown to an array. Attempts JSON parse for string values. */
export function asArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (asRecord(value)) return [value];
  if (typeof value !== "string") return [];
  const trimmed = value.trim();
  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) return parsed;
    if (asRecord(parsed)) return [parsed];
    return [];
  } catch {
    return [];
  }
}

/** Extract a deduplicated string array from unknown. */
export function asStringArray(value: unknown): string[] {
  const entries = asArray(value);
  if (entries.length === 0) {
    const scalar = asString(value);
    if (!scalar) return [];
    const fallbackEntries = scalar.includes(",") ? scalar.split(",") : [scalar];
    const seenFallback = new Set<string>();
    const fallbackValues: string[] = [];
    for (const entry of fallbackEntries) {
      const normalized = asString(entry);
      if (!normalized || seenFallback.has(normalized)) continue;
      seenFallback.add(normalized);
      fallbackValues.push(normalized);
    }
    return fallbackValues;
  }
  const seen = new Set<string>();
  const values: string[] = [];
  for (const entry of entries) {
    const normalized = asString(entry);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    values.push(normalized);
  }
  return values;
}
