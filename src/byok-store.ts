import { chmodSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { getOpenClawDir } from "./paths.js";
import { backupCorruptFileSync, writeJsonFileAtomicSync } from "./fs-utils.js";

type AuthProfileEntry = {
  type: string;
  provider: string;
  key: string;
};

type AuthProfilesFile = {
  version: number;
  profiles: Record<string, AuthProfileEntry>;
  lastGood?: Record<string, string>;
  usageStats?: Record<string, unknown>;
};

const PROVIDER_PROFILE_MAP = {
  openaiApiKey: { profileId: "openai-codex", provider: "openai-codex" },
  anthropicApiKey: { profileId: "anthropic", provider: "anthropic" },
  openrouterApiKey: { profileId: "openrouter", provider: "openrouter" },
} as const;

function isSafePathSegment(value: string): boolean {
  const normalized = value.trim();
  if (!normalized || normalized === "." || normalized === "..") return false;
  if (normalized.includes("/") || normalized.includes("\\") || normalized.includes("\0")) {
    return false;
  }
  if (normalized.includes("..")) return false;
  return true;
}

function parseJson<T>(value: string): T | null {
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

function readObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function resolveDefaultAgentId(): string {
  try {
    const configPath = join(getOpenClawDir(), "openclaw.json");
    if (!existsSync(configPath)) return "main";
    const raw = parseJson<Record<string, unknown>>(readFileSync(configPath, "utf8"));
    const agents = readObject(raw?.agents);
    const list = Array.isArray(agents.list) ? agents.list : [];

    for (const entry of list) {
      if (!entry || typeof entry !== "object") continue;
      const row = entry as Record<string, unknown>;
      if (row.default !== true) continue;
      const id = typeof row.id === "string" ? row.id.trim() : "";
      if (id && isSafePathSegment(id)) return id;
    }

    for (const entry of list) {
      if (!entry || typeof entry !== "object") continue;
      const row = entry as Record<string, unknown>;
      const id = typeof row.id === "string" ? row.id.trim() : "";
      if (id && isSafePathSegment(id)) return id;
    }
  } catch {
    // fall through
  }
  return "main";
}

function authProfilesDir(): string {
  return join(getOpenClawDir(), "agents", resolveDefaultAgentId(), "agent");
}

function authProfilesFile(): string {
  return join(authProfilesDir(), "auth-profiles.json");
}

function ensureAuthProfilesDir(): void {
  const dir = authProfilesDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(dir, 0o700);
  } catch {
    // best effort
  }
}

function normalizeAuthProfileEntry(value: unknown): AuthProfileEntry | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const type = typeof row.type === "string" ? row.type.trim() : "";
  const provider = typeof row.provider === "string" ? row.provider.trim() : "";
  const key = typeof row.key === "string" ? row.key.trim() : "";
  if (!type || !provider || !key) return null;
  return { type, provider, key };
}

function readAuthProfiles(): { file: string; parsed: AuthProfilesFile | null } {
  const file = authProfilesFile();
  try {
    if (!existsSync(file)) return { file, parsed: null };
    const raw = readFileSync(file, "utf8");
    const parsed = parseJson<Partial<AuthProfilesFile>>(raw);
    if (!parsed || typeof parsed !== "object") {
      backupCorruptFileSync(file);
      return { file, parsed: null };
    }

    const profilesRaw =
      parsed.profiles && typeof parsed.profiles === "object"
        ? (parsed.profiles as Record<string, unknown>)
        : {};
    const profiles: Record<string, AuthProfileEntry> = {};
    for (const [profileId, entry] of Object.entries(profilesRaw)) {
      const normalized = normalizeAuthProfileEntry(entry);
      if (!normalized) continue;
      profiles[profileId] = normalized;
    }

    return {
      file,
      parsed: {
        version:
          typeof parsed.version === "number" && Number.isFinite(parsed.version)
            ? Math.floor(parsed.version)
            : 1,
        profiles,
        lastGood:
          parsed.lastGood && typeof parsed.lastGood === "object"
            ? (parsed.lastGood as Record<string, string>)
            : undefined,
        usageStats:
          parsed.usageStats && typeof parsed.usageStats === "object"
            ? (parsed.usageStats as Record<string, unknown>)
            : undefined,
      },
    };
  } catch {
    return { file, parsed: null };
  }
}

export interface ByokKeysRecord {
  openaiApiKey: string | null;
  anthropicApiKey: string | null;
  openrouterApiKey: string | null;
  createdAt: string;
  updatedAt: string;
}

function normalizeKey(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed;
}

function findProfileKey(
  profiles: Record<string, AuthProfileEntry>,
  provider: "openai" | "anthropic" | "openrouter"
): string | null {
  const entries = Object.entries(profiles);
  if (provider === "openai") {
    const codex = entries.find(([, entry]) => entry.provider === "openai-codex");
    if (codex) return codex[1].key;
    const openai = entries.find(([, entry]) => entry.provider === "openai");
    return openai?.[1].key ?? null;
  }
  return entries.find(([, entry]) => entry.provider === provider)?.[1].key ?? null;
}

export function readByokKeys(): ByokKeysRecord | null {
  const { file, parsed } = readAuthProfiles();
  try {
    if (!parsed) return null;
    const stats = statSync(file);
    const createdAt = stats.birthtime.toISOString();
    const updatedAt = stats.mtime.toISOString();
    return {
      openaiApiKey: normalizeKey(findProfileKey(parsed.profiles, "openai")) ?? null,
      anthropicApiKey: normalizeKey(findProfileKey(parsed.profiles, "anthropic")) ?? null,
      openrouterApiKey: normalizeKey(findProfileKey(parsed.profiles, "openrouter")) ?? null,
      createdAt,
      updatedAt,
    };
  } catch {
    return null;
  }
}

export function writeByokKeys(input: Partial<ByokKeysRecord>): ByokKeysRecord {
  ensureAuthProfilesDir();
  const existingParsed = readAuthProfiles().parsed;
  const next: AuthProfilesFile = existingParsed ?? {
    version: 1,
    profiles: {},
  };

  const has = (key: keyof ByokKeysRecord) =>
    Object.prototype.hasOwnProperty.call(input, key);

  const applyKey = (
    field: keyof typeof PROVIDER_PROFILE_MAP,
    value: unknown
  ) => {
    const mapped = PROVIDER_PROFILE_MAP[field];
    const normalized = normalizeKey(value);
    if (normalized) {
      next.profiles[mapped.profileId] = {
        type: "api_key",
        provider: mapped.provider,
        key: normalized,
      };
      return;
    }

    delete next.profiles[mapped.profileId];
    if (next.lastGood) delete next.lastGood[mapped.profileId];
    if (next.usageStats) delete next.usageStats[mapped.profileId];
  };

  if (has("openaiApiKey")) applyKey("openaiApiKey", input.openaiApiKey);
  if (has("anthropicApiKey")) applyKey("anthropicApiKey", input.anthropicApiKey);
  if (has("openrouterApiKey")) applyKey("openrouterApiKey", input.openrouterApiKey);

  const file = authProfilesFile();
  writeJsonFileAtomicSync(file, next, 0o600);

  const updated = readByokKeys();
  if (updated) return updated;

  const now = new Date().toISOString();
  return {
    openaiApiKey: null,
    anthropicApiKey: null,
    openrouterApiKey: null,
    createdAt: now,
    updatedAt: now,
  };
}

export function clearByokKeys(): void {
  writeByokKeys({
    openaiApiKey: null,
    anthropicApiKey: null,
    openrouterApiKey: null,
  });
}
