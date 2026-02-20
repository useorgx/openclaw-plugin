import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { writeFileAtomicSync } from "./fs-utils.js";
import { getOpenClawDir } from "./paths.js";
import type { SkillPack } from "./contracts/types.js";
import type { OrgxSkillPackOverrides, OrgxSuiteDomain } from "./agent-suite.js";
import { validateOpenClawSkillPackManifest } from "./contracts/skill-pack-schema.js";

const STORE_VERSION = 1;
const STATE_FILENAME = "orgx-skill-pack-state.json";
const AUDIT_HISTORY_LIMIT = 50;

export type SkillPackPolicy = {
  frozen: boolean;
  pinnedChecksum: string | null;
};

export type SkillPackPolicyDiff = {
  field: "policy.frozen" | "policy.pinnedChecksum";
  before: boolean | string | null;
  after: boolean | string | null;
};

export type SkillPackPolicyAuditEntry = {
  id: string;
  changedAt: string;
  changedBy: string;
  action: "policy.update" | "policy.rollback";
  reason: string | null;
  rollbackOfAuditId: string | null;
  diff: SkillPackPolicyDiff[];
  beforePolicy: SkillPackPolicy;
  afterPolicy: SkillPackPolicy;
};

export type SkillPackState = {
  version: 1;
  updatedAt: string;
  lastCheckedAt: string | null;
  lastError: string | null;
  etag: string | null;
  policy: SkillPackPolicy;
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
  audit: {
    entries: SkillPackPolicyAuditEntry[];
  };
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

function clonePolicy(input: SkillPackPolicy): SkillPackPolicy {
  return {
    frozen: Boolean(input.frozen),
    pinnedChecksum: coerceString(input.pinnedChecksum),
  };
}

function normalizeChangedBy(input: unknown): string {
  if (typeof input !== "string") return "unknown";
  const value = input.trim();
  return value.length > 0 ? value : "unknown";
}

function normalizeReason(input: unknown): string | null {
  return typeof input === "string" && input.trim().length > 0 ? input.trim() : null;
}

function nextAuditId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function computePolicyDiff(before: SkillPackPolicy, after: SkillPackPolicy): SkillPackPolicyDiff[] {
  const diff: SkillPackPolicyDiff[] = [];
  if (before.frozen !== after.frozen) {
    diff.push({
      field: "policy.frozen",
      before: before.frozen,
      after: after.frozen,
    });
  }
  if (before.pinnedChecksum !== after.pinnedChecksum) {
    diff.push({
      field: "policy.pinnedChecksum",
      before: before.pinnedChecksum,
      after: after.pinnedChecksum,
    });
  }
  return diff;
}

function appendPolicyAuditEntry(
  entries: SkillPackPolicyAuditEntry[],
  entry: SkillPackPolicyAuditEntry
): SkillPackPolicyAuditEntry[] {
  return [entry, ...entries].slice(0, AUDIT_HISTORY_LIMIT);
}

function parseAuditEntries(raw: unknown): SkillPackPolicyAuditEntry[] {
  if (!Array.isArray(raw)) return [];
  const entries: SkillPackPolicyAuditEntry[] = [];
  for (const candidate of raw) {
    if (!isRecord(candidate)) continue;
    const beforePolicyRaw = isRecord(candidate.beforePolicy) ? candidate.beforePolicy : null;
    const afterPolicyRaw = isRecord(candidate.afterPolicy) ? candidate.afterPolicy : null;
    if (!beforePolicyRaw || !afterPolicyRaw) continue;

    const diffRaw = Array.isArray(candidate.diff) ? candidate.diff : [];
    const diff: SkillPackPolicyDiff[] = [];
    for (const diffEntry of diffRaw) {
      if (!isRecord(diffEntry)) continue;
      const field = diffEntry.field;
      if (field !== "policy.frozen" && field !== "policy.pinnedChecksum") continue;
      diff.push({
        field,
        before:
          typeof diffEntry.before === "boolean" || diffEntry.before === null
            ? diffEntry.before
            : coerceString(diffEntry.before),
        after:
          typeof diffEntry.after === "boolean" || diffEntry.after === null
            ? diffEntry.after
            : coerceString(diffEntry.after),
      });
    }

    entries.push({
      id: coerceString(candidate.id) ?? nextAuditId(),
      changedAt: coerceString(candidate.changedAt) ?? nowIso(),
      changedBy: normalizeChangedBy(candidate.changedBy),
      action:
        candidate.action === "policy.rollback" ? "policy.rollback" : "policy.update",
      reason: normalizeReason(candidate.reason),
      rollbackOfAuditId: coerceString(candidate.rollbackOfAuditId),
      diff,
      beforePolicy: {
        frozen: Boolean(beforePolicyRaw.frozen),
        pinnedChecksum: coerceString(beforePolicyRaw.pinnedChecksum),
      },
      afterPolicy: {
        frozen: Boolean(afterPolicyRaw.frozen),
        pinnedChecksum: coerceString(afterPolicyRaw.pinnedChecksum),
      },
    });
  }
  return entries.slice(0, AUDIT_HISTORY_LIMIT);
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
    audit: { entries: [] },
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
    const audit = isRecord(parsed.audit) ? parsed.audit : null;

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
      audit: {
        entries: parseAuditEntries(audit?.entries),
      },
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
  changedBy?: string;
  reason?: string;
}): SkillPackState {
  const prev = readSkillPackState({ openclawDir: input.openclawDir });
  const beforePolicy = clonePolicy(prev.policy);
  const nextPolicy = { ...prev.policy };
  const activeChecksum = prev.pack?.checksum ?? null;
  const remoteChecksum = prev.remote?.checksum ?? null;
  const hasInactiveRemoteCandidate = Boolean(
    remoteChecksum && remoteChecksum !== activeChecksum
  );
  const blockedByActivationValidation =
    hasInactiveRemoteCandidate && hasActivationValidationFailure(prev.lastError);

  if (typeof input.frozen === "boolean") {
    nextPolicy.frozen = input.frozen;
  }

  if (input.clearPin) {
    nextPolicy.pinnedChecksum = null;
  } else if (input.pinToCurrent) {
    if (blockedByActivationValidation) {
      throw new Error(
        "Cannot pin_to_current: remote config failed eval/manifest checks and is not active."
      );
    }
    nextPolicy.pinnedChecksum = prev.pack?.checksum ?? prev.remote?.checksum ?? null;
  } else if (typeof input.pinnedChecksum === "string") {
    const requestedChecksum = input.pinnedChecksum.trim() || null;
    if (
      requestedChecksum &&
      remoteChecksum &&
      requestedChecksum === remoteChecksum &&
      blockedByActivationValidation
    ) {
      throw new Error(
        "Cannot pin checksum to remote config: eval/manifest checks are failing for that candidate."
      );
    }
    nextPolicy.pinnedChecksum = requestedChecksum;
  } else if (input.pinnedChecksum === null) {
    nextPolicy.pinnedChecksum = null;
  }

  const next: SkillPackState = {
    ...prev,
    updatedAt: nowIso(),
    policy: nextPolicy,
  };

  const diff = computePolicyDiff(beforePolicy, next.policy);
  if (diff.length > 0) {
    const entry: SkillPackPolicyAuditEntry = {
      id: nextAuditId(),
      changedAt: next.updatedAt,
      changedBy: normalizeChangedBy(input.changedBy),
      action: "policy.update",
      reason: normalizeReason(input.reason),
      rollbackOfAuditId: null,
      diff,
      beforePolicy,
      afterPolicy: clonePolicy(next.policy),
    };
    next.audit = {
      entries: appendPolicyAuditEntry(prev.audit.entries, entry),
    };
  }

  writeSkillPackState(next, { openclawDir: input.openclawDir });
  return next;
}

export function rollbackSkillPackPolicy(input?: {
  openclawDir?: string;
  auditId?: string;
  changedBy?: string;
  reason?: string;
}): SkillPackState {
  const prev = readSkillPackState({ openclawDir: input?.openclawDir });
  const normalizedAuditId =
    typeof input?.auditId === "string" && input.auditId.trim().length > 0
      ? input.auditId.trim()
      : null;
  const target =
    normalizedAuditId
      ? prev.audit.entries.find((entry) => entry.id === normalizedAuditId) ?? null
      : prev.audit.entries[0] ?? null;
  if (!target) {
    throw new Error("No policy audit entry available for rollback");
  }

  const beforePolicy = clonePolicy(prev.policy);
  const afterPolicy = clonePolicy(target.beforePolicy);
  const diff = computePolicyDiff(beforePolicy, afterPolicy);
  if (diff.length === 0) {
    return prev;
  }

  const changedAt = nowIso();
  const rollbackEntry: SkillPackPolicyAuditEntry = {
    id: nextAuditId(),
    changedAt,
    changedBy: normalizeChangedBy(input?.changedBy),
    action: "policy.rollback",
    reason: normalizeReason(input?.reason) ?? `Rollback to audit ${target.id}`,
    rollbackOfAuditId: target.id,
    diff,
    beforePolicy,
    afterPolicy,
  };

  const next: SkillPackState = {
    ...prev,
    updatedAt: changedAt,
    policy: afterPolicy,
    audit: {
      entries: appendPolicyAuditEntry(prev.audit.entries, rollbackEntry),
    },
  };

  writeSkillPackState(next, { openclawDir: input?.openclawDir });
  return next;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

function asBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function asFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function normalizeStatus(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase().replace(/[\s-]+/g, "_");
  return normalized.length > 0 ? normalized : null;
}

function hasActivationValidationFailure(lastError: string | null): boolean {
  if (!lastError) return false;
  const normalized = lastError.toLowerCase();
  return (
    normalized.includes("eval framework checks did not pass") ||
    normalized.includes("eval gate blocked activation") ||
    normalized.includes("manifest validation errors")
  );
}

function evalGateErrorForPack(pack: SkillPack): string | null {
  const manifest = asRecord(pack.manifest);
  if (!manifest) {
    return "SkillPack eval framework checks did not pass: missing manifest object";
  }

  const candidates = [
    { label: "eval_framework", value: asRecord(manifest.eval_framework) },
    { label: "evalFramework", value: asRecord(manifest.evalFramework) },
    { label: "evaluation_result", value: asRecord(manifest.evaluation_result) },
    { label: "evaluationResult", value: asRecord(manifest.evaluationResult) },
    { label: "evaluation", value: asRecord(manifest.evaluation) },
    { label: "quality_gate", value: asRecord(manifest.quality_gate) },
    { label: "qualityGate", value: asRecord(manifest.qualityGate) },
  ];

  for (const candidate of candidates) {
    if (!candidate.value) continue;

    const passed =
      asBoolean(candidate.value.passed) ??
      asBoolean(candidate.value.ok) ??
      asBoolean(candidate.value.success) ??
      asBoolean(candidate.value.allowed);
    if (passed != null) {
      return passed
        ? null
        : `SkillPack eval framework checks did not pass: ${candidate.label}.passed=false`;
    }

    const status = normalizeStatus(candidate.value.status);
    if (status) {
      const passStatuses = new Set(["pass", "passed", "ok", "success", "approved", "green"]);
      const failStatuses = new Set(["fail", "failed", "rejected", "error", "blocked", "red"]);
      if (passStatuses.has(status)) return null;
      if (failStatuses.has(status)) {
        return `SkillPack eval framework checks did not pass: ${candidate.label}.status=${status}`;
      }
    }

    const checksTotal =
      asFiniteNumber(candidate.value.checks_total) ??
      asFiniteNumber(candidate.value.total_checks);
    const checksPassed =
      asFiniteNumber(candidate.value.checks_passed) ??
      asFiniteNumber(candidate.value.passed_checks);
    if (checksTotal != null && checksPassed != null && checksTotal > 0) {
      return checksPassed >= checksTotal
        ? null
        : `SkillPack eval framework checks did not pass: ${candidate.label}.checks=${checksPassed}/${checksTotal}`;
    }
  }

  return "SkillPack eval framework checks did not pass: missing pass signal in manifest";
}

export function toOrgxSkillPackOverrides(input: {
  pack: SkillPack;
  etag: string | null;
}): {
  overrides: OrgxSkillPackOverrides;
  validationErrors: string[];
} {
  const manifest = asRecord(input.pack.manifest);
  const validation = validateOpenClawSkillPackManifest(manifest ?? {});

  const openclaw_skills: Partial<Record<OrgxSuiteDomain, string>> = {};
  for (const [k, v] of Object.entries(validation.openclaw_skills)) {
    openclaw_skills[k as OrgxSuiteDomain] = v;
  }

  return {
    overrides: {
      source: "server",
      name: input.pack.name,
      version: input.pack.version,
      checksum: input.pack.checksum,
      etag: input.etag,
      updated_at: input.pack.updated_at ?? null,
      openclaw_skills,
    },
    validationErrors: validation.errors,
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

    const { overrides, validationErrors } = toOrgxSkillPackOverrides({
      pack: result.pack,
      etag: result.etag ?? null,
    });
    const evalGateError = evalGateErrorForPack(result.pack);
    const activationErrors: string[] = [];
    if (validationErrors.length > 0) {
      activationErrors.push(`SkillPack manifest validation errors: ${validationErrors.join("; ")}`);
    }
    if (evalGateError) {
      activationErrors.push(evalGateError);
    }
    const activationValidationError =
      activationErrors.length > 0 ? activationErrors.join(" | ") : null;
    // Guardrail: never activate a config that fails eval/manifest validation.
    // Keep it staged in `remote` + `lastError` so operators can inspect/fix it.
    if (activationValidationError) {
      const next: SkillPackState = {
        ...prev,
        updatedAt: nowIso(),
        lastCheckedAt: nowIso(),
        lastError: activationValidationError,
        etag: result.etag ?? prev.etag,
        remote: remoteMeta,
      };
      writeSkillPackState(next, { openclawDir: input.openclawDir });
      return { state: next, changed: false };
    }
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
      audit: prev.audit,
    };
    writeSkillPackState(next, { openclawDir: input.openclawDir });
    return { state: next, changed: prev.pack?.checksum !== next.pack?.checksum };
  }

  const next: SkillPackState = {
    ...prev,
    updatedAt: nowIso(),
    lastCheckedAt: nowIso(),
    lastError: result.ok === false ? result.error : prev.lastError,
  };
  writeSkillPackState(next, { openclawDir: input.openclawDir });
  return { state: next, changed: false };
}
