import { createHash } from "node:crypto";

export function stableHash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function idempotencyKey(parts: Array<string | null | undefined>): string {
  const raw = parts
    .filter((part): part is string => typeof part === "string" && part.length > 0)
    .join(":");
  const cleaned = raw.replace(/[^a-zA-Z0-9:_-]/g, "-").slice(0, 84);
  const prefix = cleaned.length > 0 ? cleaned : "openclaw";
  const suffix = stableHash(raw).slice(0, 20);
  return `${prefix}:${suffix}`.slice(0, 120);
}
