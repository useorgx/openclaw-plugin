import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const CONFIG_DIR = join(homedir(), ".config", "useorgx", "openclaw-plugin");
const BYOK_FILE = join(CONFIG_DIR, "byok.json");

export interface ByokKeysRecord {
  openaiApiKey: string | null;
  anthropicApiKey: string | null;
  openrouterApiKey: string | null;
  createdAt: string;
  updatedAt: string;
}

function ensureConfigDir(): void {
  mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  try {
    chmodSync(CONFIG_DIR, 0o700);
  } catch {
    // best effort
  }
}

function parseJson<T>(value: string): T | null {
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

function normalizeKey(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed;
}

export function readByokKeys(): ByokKeysRecord | null {
  try {
    if (!existsSync(BYOK_FILE)) return null;
    const parsed = parseJson<Partial<ByokKeysRecord>>(readFileSync(BYOK_FILE, "utf8"));
    if (!parsed || typeof parsed !== "object") return null;
    const createdAt =
      typeof parsed.createdAt === "string" && parsed.createdAt.trim().length > 0
        ? parsed.createdAt
        : new Date().toISOString();
    const updatedAt =
      typeof parsed.updatedAt === "string" && parsed.updatedAt.trim().length > 0
        ? parsed.updatedAt
        : createdAt;
    return {
      openaiApiKey: normalizeKey((parsed as any).openaiApiKey) ?? null,
      anthropicApiKey: normalizeKey((parsed as any).anthropicApiKey) ?? null,
      openrouterApiKey: normalizeKey((parsed as any).openrouterApiKey) ?? null,
      createdAt,
      updatedAt,
    };
  } catch {
    return null;
  }
}

export function writeByokKeys(input: Partial<ByokKeysRecord>): ByokKeysRecord {
  ensureConfigDir();
  const now = new Date().toISOString();
  const existing = readByokKeys();
  const has = (key: keyof ByokKeysRecord) =>
    Object.prototype.hasOwnProperty.call(input, key);
  const next: ByokKeysRecord = {
    openaiApiKey: has("openaiApiKey")
      ? normalizeKey(input.openaiApiKey)
      : existing?.openaiApiKey ?? null,
    anthropicApiKey: has("anthropicApiKey")
      ? normalizeKey(input.anthropicApiKey)
      : existing?.anthropicApiKey ?? null,
    openrouterApiKey: has("openrouterApiKey")
      ? normalizeKey(input.openrouterApiKey)
      : existing?.openrouterApiKey ?? null,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };

  writeFileSync(BYOK_FILE, JSON.stringify(next, null, 2), {
    mode: 0o600,
    encoding: "utf8",
  });
  try {
    chmodSync(BYOK_FILE, 0o600);
  } catch {
    // best effort
  }

  return next;
}

export function clearByokKeys(): void {
  try {
    rmSync(BYOK_FILE, { force: true });
  } catch {
    // best effort
  }
}
