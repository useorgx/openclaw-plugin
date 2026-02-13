import { readFileSync, existsSync } from "node:fs";

function stripQuotes(value) {
  const raw = String(value ?? "").trim();
  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
    return raw.slice(1, -1);
  }
  return raw;
}

/**
 * Minimal dotenv loader (no deps).
 * - Loads KEY=VALUE pairs from `.env` into process.env if the key is not already set.
 * - Supports quoted values and ignores comments / blank lines.
 */
export function loadDotEnv(pathname = ".env") {
  if (!existsSync(pathname)) return { ok: false, loaded: 0, pathname };
  const raw = readFileSync(pathname, "utf8");
  let loaded = 0;
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf("=");
    if (idx <= 0) continue;
    const key = trimmed.slice(0, idx).trim();
    const value = stripQuotes(trimmed.slice(idx + 1));
    if (!key) continue;
    if (typeof process.env[key] === "string" && process.env[key].length > 0) continue;
    process.env[key] = value;
    loaded += 1;
  }
  return { ok: true, loaded, pathname };
}

