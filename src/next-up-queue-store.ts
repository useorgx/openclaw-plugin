import {
  existsSync,
  readFileSync,
} from "node:fs";

import { getOrgxPluginConfigDir, getOrgxPluginConfigPath } from "./paths.js";
import { backupCorruptFileSync, writeJsonFileAtomicSync } from "./fs-utils.js";
import {
  ensureStoreDirSync,
  parseJsonSafe,
} from "./stores/json-store.js";

export type NextUpPinnedEntry = {
  initiativeId: string;
  workstreamId: string;
  preferredTaskId: string | null;
  preferredMilestoneId: string | null;
  createdAt: string;
  updatedAt: string;
};

export type NextUpSuppressedEntry = {
  initiativeId: string;
  workstreamId: string;
  createdAt: string;
  updatedAt: string;
};

type PersistedNextUpQueue = {
  version: 1 | 2;
  updatedAt: string;
  pins: NextUpPinnedEntry[];
  suppressions: NextUpSuppressedEntry[];
};

const MAX_PINS = 240;
const MAX_SUPPRESSIONS = 2_000;

function storeDir(): string {
  return getOrgxPluginConfigDir();
}

function storeFile(): string {
  return getOrgxPluginConfigPath("next-up-queue.json");
}

function ensureStoreDir(): void {
  ensureStoreDirSync(storeDir());
}

function normalizeNullableString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeEntry(input: NextUpPinnedEntry): NextUpPinnedEntry {
  return {
    initiativeId: input.initiativeId.trim(),
    workstreamId: input.workstreamId.trim(),
    preferredTaskId: normalizeNullableString(input.preferredTaskId),
    preferredMilestoneId: normalizeNullableString(input.preferredMilestoneId),
    createdAt: input.createdAt,
    updatedAt: input.updatedAt,
  };
}

function normalizeSuppression(input: NextUpSuppressedEntry): NextUpSuppressedEntry {
  return {
    initiativeId: input.initiativeId.trim(),
    workstreamId: input.workstreamId.trim(),
    createdAt: input.createdAt,
    updatedAt: input.updatedAt,
  };
}

function entryKey(input: { initiativeId: string; workstreamId: string }): string {
  return `${input.initiativeId}:${input.workstreamId}`;
}

function createEmptyStore(): PersistedNextUpQueue {
  return {
    version: 2,
    updatedAt: new Date().toISOString(),
    pins: [],
    suppressions: [],
  };
}

export function readNextUpQueuePins(): PersistedNextUpQueue {
  const file = storeFile();
  try {
    if (!existsSync(file)) {
      return createEmptyStore();
    }
    const raw = readFileSync(file, "utf8");
    const parsed = parseJsonSafe<PersistedNextUpQueue>(raw);
    if (!parsed || typeof parsed !== "object") {
      backupCorruptFileSync(file);
      return createEmptyStore();
    }

    const pins = Array.isArray(parsed.pins) ? parsed.pins : [];
    const suppressions = Array.isArray((parsed as { suppressions?: unknown }).suppressions)
      ? ((parsed as { suppressions?: unknown }).suppressions as NextUpSuppressedEntry[])
      : [];
    return {
      version: 2,
      updatedAt:
        typeof parsed.updatedAt === "string"
          ? parsed.updatedAt
          : new Date().toISOString(),
      pins: pins
        .filter((entry): entry is NextUpPinnedEntry => Boolean(entry && typeof entry === "object"))
        .map((entry) => normalizeEntry(entry)),
      suppressions: suppressions
        .filter(
          (entry): entry is NextUpSuppressedEntry =>
            Boolean(entry && typeof entry === "object")
        )
        .map((entry) => normalizeSuppression(entry)),
    };
  } catch {
    return createEmptyStore();
  }
}

export function upsertNextUpQueuePin(input: {
  initiativeId: string;
  workstreamId: string;
  preferredTaskId?: string | null;
  preferredMilestoneId?: string | null;
}): PersistedNextUpQueue {
  const initiativeId = input.initiativeId.trim();
  const workstreamId = input.workstreamId.trim();
  if (!initiativeId || !workstreamId) {
    return readNextUpQueuePins();
  }

  ensureStoreDir();
  const now = new Date().toISOString();
  const next = readNextUpQueuePins();

  const key = `${initiativeId}:${workstreamId}`;
  const existing = next.pins.find(
    (pin) => entryKey(pin) === key
  );

  const updated: NextUpPinnedEntry = normalizeEntry({
    initiativeId,
    workstreamId,
    preferredTaskId: input.preferredTaskId ?? existing?.preferredTaskId ?? null,
    preferredMilestoneId:
      input.preferredMilestoneId ?? existing?.preferredMilestoneId ?? null,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  });

  next.pins = [updated, ...next.pins.filter((pin) => entryKey(pin) !== key)].slice(0, MAX_PINS);
  next.suppressions = next.suppressions.filter((suppression) => entryKey(suppression) !== key);
  next.updatedAt = now;

  try {
    writeJsonFileAtomicSync(storeFile(), next, 0o600);
  } catch {
    // best effort
  }

  return next;
}

export function removeNextUpQueuePin(input: {
  initiativeId: string;
  workstreamId: string;
}): PersistedNextUpQueue {
  const initiativeId = input.initiativeId.trim();
  const workstreamId = input.workstreamId.trim();
  if (!initiativeId || !workstreamId) {
    return readNextUpQueuePins();
  }

  ensureStoreDir();
  const next = readNextUpQueuePins();
  const key = `${initiativeId}:${workstreamId}`;
  const filtered = next.pins.filter((pin) => entryKey(pin) !== key);
  if (filtered.length === next.pins.length) return next;

  next.pins = filtered;
  next.updatedAt = new Date().toISOString();
  try {
    writeJsonFileAtomicSync(storeFile(), next, 0o600);
  } catch {
    // best effort
  }
  return next;
}

export function setNextUpQueuePinOrder(input: {
  order: Array<{ initiativeId: string; workstreamId: string }>;
}): PersistedNextUpQueue {
  ensureStoreDir();
  const next = readNextUpQueuePins();
  const now = new Date().toISOString();

  type PinKey = `${string}:${string}`;
  const byKey = new Map(
    next.pins.map((pin) => [`${pin.initiativeId}:${pin.workstreamId}` as PinKey, pin] as const)
  );

  const ordered: NextUpPinnedEntry[] = [];
  const seen = new Set<PinKey>();
  for (const entry of input.order) {
    const initiativeId = (entry.initiativeId ?? "").trim();
    const workstreamId = (entry.workstreamId ?? "").trim();
    if (!initiativeId || !workstreamId) continue;
    const key = `${initiativeId}:${workstreamId}` as PinKey;
    if (seen.has(key)) continue;
    seen.add(key);
    const pin = byKey.get(key);
    if (pin) {
      ordered.push(pin);
    } else {
      ordered.push({
        initiativeId,
        workstreamId,
        preferredTaskId: null,
        preferredMilestoneId: null,
        createdAt: now,
        updatedAt: now,
      });
    }
  }

  for (const pin of next.pins) {
    const key = `${pin.initiativeId}:${pin.workstreamId}` as PinKey;
    if (seen.has(key)) continue;
    ordered.push(pin);
  }

  next.pins = ordered.slice(0, MAX_PINS);
  if (seen.size > 0 && next.suppressions.length > 0) {
    next.suppressions = next.suppressions.filter(
      (suppression) => !seen.has(entryKey(suppression) as PinKey)
    );
  }
  next.updatedAt = now;
  try {
    writeJsonFileAtomicSync(storeFile(), next, 0o600);
  } catch {
    // best effort
  }

  return next;
}

export function suppressNextUpQueueItem(input: {
  initiativeId: string;
  workstreamId: string;
}): PersistedNextUpQueue {
  const initiativeId = input.initiativeId.trim();
  const workstreamId = input.workstreamId.trim();
  if (!initiativeId || !workstreamId) {
    return readNextUpQueuePins();
  }

  ensureStoreDir();
  const now = new Date().toISOString();
  const next = readNextUpQueuePins();
  const key = `${initiativeId}:${workstreamId}`;
  const existing = next.suppressions.find((suppression) => entryKey(suppression) === key);

  next.suppressions = [
    normalizeSuppression({
      initiativeId,
      workstreamId,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    }),
    ...next.suppressions.filter((suppression) => entryKey(suppression) !== key),
  ].slice(0, MAX_SUPPRESSIONS);
  next.pins = next.pins.filter((pin) => entryKey(pin) !== key);
  next.updatedAt = now;

  try {
    writeJsonFileAtomicSync(storeFile(), next, 0o600);
  } catch {
    // best effort
  }

  return next;
}

export function unsuppressNextUpQueueItem(input: {
  initiativeId: string;
  workstreamId: string;
}): PersistedNextUpQueue {
  const initiativeId = input.initiativeId.trim();
  const workstreamId = input.workstreamId.trim();
  if (!initiativeId || !workstreamId) {
    return readNextUpQueuePins();
  }

  ensureStoreDir();
  const next = readNextUpQueuePins();
  const key = `${initiativeId}:${workstreamId}`;
  const filtered = next.suppressions.filter((suppression) => entryKey(suppression) !== key);
  if (filtered.length === next.suppressions.length) return next;

  next.suppressions = filtered;
  next.updatedAt = new Date().toISOString();
  try {
    writeJsonFileAtomicSync(storeFile(), next, 0o600);
  } catch {
    // best effort
  }
  return next;
}
