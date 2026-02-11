import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { getOrgxPluginConfigDir, getOrgxPluginConfigPath } from "./paths.js";
import { backupCorruptFileSync, writeJsonFileAtomicSync } from "./fs-utils.js";

function configDir(): string {
  return getOrgxPluginConfigDir();
}

function byokFile(): string {
  return getOrgxPluginConfigPath("byok.json");
}

export interface ByokKeysRecord {
  openaiApiKey: string | null;
  anthropicApiKey: string | null;
  openrouterApiKey: string | null;
  createdAt: string;
  updatedAt: string;
}

function ensureConfigDir(): void {
  const dir = configDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(dir, 0o700);
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
  const file = byokFile();
  try {
    if (!existsSync(file)) return null;
    const raw = readFileSync(file, "utf8");
    const parsed = parseJson<Partial<ByokKeysRecord>>(raw);
    if (!parsed) {
      backupCorruptFileSync(file);
      return null;
    }
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

  const file = byokFile();
  writeJsonFileAtomicSync(file, next, 0o600);

  return next;
}

export function clearByokKeys(): void {
  const file = byokFile();
  try {
    rmSync(file, { force: true });
  } catch {
    // best effort
  }
}
