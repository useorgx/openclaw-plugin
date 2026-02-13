import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { writeFileAtomicSync } from "./fs-utils.js";
import { getOpenClawDir } from "./paths.js";
import type { SkillPack } from "./contracts/types.js";
import type { OrgxSkillPackOverrides, OrgxSuiteDomain } from "./agent-suite.js";

const STORE_VERSION = 1;
const STATE_FILENAME = "orgx-skill-pack-state.json";

export type SkillPackState = {
  version: 1;
  updatedAt: string;
  lastCheckedAt: string | null;
  lastError: string | null;
  etag: string | null;
  policy: {
    frozen: boolean;
    pinnedChecksum: string | null;
  };
  pack: {
    name: string;
    version: string;
    checksum: string;
    updated_at: string | null;
  } | null;
  remote: {
    name: string;
    version: string;
    checksum: string;
    updated_at: string | null;
  } | null;
  overrides: OrgxSkillPackOverrides | null;
};

function nowIso(): string {
  return new Date().toISOString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function coerceString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function statePath(openclawDir: string): string {
  return join(openclawDir, STATE_FILENAME);
}

export function readSkillPackState(input?: {
  openclawDir?: string;
}): SkillPackState {
  const openclawDir = input?.openclawDir ?? getOpenClawDir();
  const path = statePath(openclawDir);

  const empty: SkillPackState = {
    version: STORE_VERSION,
    updatedAt: nowIso(),
    lastCheckedAt: null,
    lastError: null,
    etag: null,
    policy: { frozen: false, pinnedChecksum: null },
    pack: null,
    remote: null,
    overrides: null,
  };

  try {
    if (!existsSync(path)) return empty;
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)) return empty;
    if (parsed.version !== STORE_VERSION) return empty;

    const policy = isRecord(parsed.policy) ? parsed.policy : null;
    const pack = isRecord(parsed.pack) ? parsed.pack : null;
    const remote = isRecord(parsed.remote) ? parsed.remote : null;
    const overrides = isRecord(parsed.overrides) ? parsed.overrides : null;

    return {
      version: STORE_VERSION,
      updatedAt: coerceString(parsed.updatedAt) ?? nowIso(),
      lastCheckedAt: coerceString(parsed.lastCheckedAt),
      lastError: coerceString(parsed.lastError),
      etag: coerceString(parsed.etag),
      policy: {
        frozen: Boolean(policy?.frozen),
        pinnedChecksum: coerceString(policy?.pinnedChecksum),
      },
      pack: pack
        ? {
            name: coerceString(pack.name) ?? "",
            version: coerceString(pack.version) ?? "",
            checksum: coerceString(pack.checksum) ?? "",
            updated_at: coerceString(pack.updated_at),
          }
        : null,
      remote: remote
        ? {
            name: coerceString(remote.name) ?? "",
            version: coerceString(remote.version) ?? "",
            checksum: coerceString(remote.checksum) ?? "",
            updated_at: coerceString(remote.updated_at),
          }
        : null,
      overrides: overrides
        ? (overrides as unknown as OrgxSkillPackOverrides)
        : null,
    };
  } catch {
    return empty;
  }
}

export function writeSkillPackState(
  state: SkillPackState,
  input?: { openclawDir?: string }
): void {
  const openclawDir = input?.openclawDir ?? getOpenClawDir();
  const path = statePath(openclawDir);
  writeFileAtomicSync(path, `${JSON.stringify(state, null, 2)}\n`, {
    mode: 0o600,
    encoding: "utf8",
  });
}

export function updateSkillPackPolicy(input: {
  openclawDir?: string;
  frozen?: boolean;
  pinnedChecksum?: string | null;
  pinToCurrent?: boolean;
  clearPin?: boolean;
}): SkillPackState {
  const prev = readSkillPackState({ openclawDir: input.openclawDir });
  const nextPolicy = { ...prev.policy };

  if (typeof input.frozen === "boolean") {
    nextPolicy.frozen = input.frozen;
  }

  if (input.clearPin) {
    nextPolicy.pinnedChecksum = null;
  } else if (input.pinToCurrent) {
    nextPolicy.pinnedChecksum = prev.pack?.checksum ?? prev.remote?.checksum ?? null;
  } else if (typeof input.pinnedChecksum === "string") {
    nextPolicy.pinnedChecksum = input.pinnedChecksum.trim() || null;
  } else if (input.pinnedChecksum === null) {
    nextPolicy.pinnedChecksum = null;
  }

  const next: SkillPackState = {
    ...prev,
    updatedAt: nowIso(),
    policy: nextPolicy,
  };

  writeSkillPackState(next, { openclawDir: input.openclawDir });
  return next;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

function parseOpenclawSkillOverridesFromManifest(
  manifest: Record<string, unknown> | null
): Partial<Record<string, string>> {
  const root = manifest ?? {};
  const candidates = [
    asRecord((root as any).openclaw_skills),
    asRecord((root as any).openclawSkills),
    asRecord(asRecord((root as any).openclaw)?.skills),
  ].filter(Boolean) as Array<Record<string, unknown>>;

  const out: Record<string, string> = {};
  for (const candidate of candidates) {
    for (const [k, v] of Object.entries(candidate)) {
      if (typeof v !== "string") continue;
      const key = k.trim().toLowerCase();
      if (!key) continue;
      out[key] = v;
    }
  }
  return out;
}

export function toOrgxSkillPackOverrides(input: {
  pack: SkillPack;
  etag: string | null;
}): OrgxSkillPackOverrides {
  const manifest = asRecord(input.pack.manifest) ?? {};
  const rawOverrides = parseOpenclawSkillOverridesFromManifest(manifest);

  const openclaw_skills: Partial<Record<OrgxSuiteDomain, string>> = {};
  for (const [k, v] of Object.entries(rawOverrides)) {
    // Domains are normalized to lowercase keys in the manifest.
    openclaw_skills[k as OrgxSuiteDomain] = v;
  }

  return {
    source: "server",
    name: input.pack.name,
    version: input.pack.version,
    checksum: input.pack.checksum,
    etag: input.etag,
    updated_at: input.pack.updated_at ?? null,
    openclaw_skills,
  };
}

export async function refreshSkillPackState(input: {
  getSkillPack: (args: {
    name?: string;
    ifNoneMatch?: string | null;
  }) => Promise<
    | { ok: true; notModified: true; etag: string | null; pack: null }
    | { ok: true; notModified: false; etag: string | null; pack: SkillPack }
    | { ok: false; status: number; error: string }
  >;
  packName?: string;
  openclawDir?: string;
  force?: boolean;
}): Promise<{ state: SkillPackState; changed: boolean }> {
  const packName = (input.packName ?? "").trim() || "orgx-agent-suite";
  const prev = readSkillPackState({ openclawDir: input.openclawDir });

  if (!input.force && prev.policy.frozen) {
    const next: SkillPackState = {
      ...prev,
      updatedAt: nowIso(),
      lastCheckedAt: nowIso(),
      lastError: null,
    };
    writeSkillPackState(next, { openclawDir: input.openclawDir });
    return { state: next, changed: false };
  }

  const result = await input.getSkillPack({
    name: packName,
    ifNoneMatch: input.force ? null : prev.etag,
  });

  if (result.ok && result.notModified) {
    const next: SkillPackState = {
      ...prev,
      updatedAt: nowIso(),
      lastCheckedAt: nowIso(),
      lastError: null,
      etag: result.etag ?? prev.etag,
    };
    writeSkillPackState(next, { openclawDir: input.openclawDir });
    return { state: next, changed: false };
  }

  if (result.ok && !result.notModified && result.pack) {
    const remoteMeta = {
      name: result.pack.name,
      version: result.pack.version,
      checksum: result.pack.checksum,
      updated_at: result.pack.updated_at ?? null,
    };

    if (
      prev.policy.pinnedChecksum &&
      prev.policy.pinnedChecksum !== result.pack.checksum
    ) {
      const next: SkillPackState = {
        ...prev,
        updatedAt: nowIso(),
        lastCheckedAt: nowIso(),
        lastError: null,
        etag: result.etag ?? prev.etag,
        remote: remoteMeta,
      };
      writeSkillPackState(next, { openclawDir: input.openclawDir });
      return { state: next, changed: false };
    }

    const overrides = toOrgxSkillPackOverrides({ pack: result.pack, etag: result.etag ?? null });
    const next: SkillPackState = {
      version: STORE_VERSION,
      updatedAt: nowIso(),
      lastCheckedAt: nowIso(),
      lastError: null,
      etag: result.etag ?? null,
      policy: prev.policy,
      pack: {
        name: result.pack.name,
        version: result.pack.version,
        checksum: result.pack.checksum,
        updated_at: result.pack.updated_at ?? null,
      },
      remote: remoteMeta,
      overrides,
    };
    writeSkillPackState(next, { openclawDir: input.openclawDir });
    return { state: next, changed: prev.pack?.checksum !== next.pack?.checksum };
  }

  const next: SkillPackState = {
    ...prev,
    updatedAt: nowIso(),
    lastCheckedAt: nowIso(),
    lastError: !result.ok ? result.error : prev.lastError,
  };
  writeSkillPackState(next, { openclawDir: input.openclawDir });
  return { state: next, changed: false };
}
