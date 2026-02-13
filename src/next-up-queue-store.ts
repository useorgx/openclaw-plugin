import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
} from "node:fs";

import { getOrgxPluginConfigDir, getOrgxPluginConfigPath } from "./paths.js";
import { backupCorruptFileSync, writeJsonFileAtomicSync } from "./fs-utils.js";

export type NextUpPinnedEntry = {
  initiativeId: string;
  workstreamId: string;
  preferredTaskId: string | null;
  preferredMilestoneId: string | null;
  createdAt: string;
  updatedAt: string;
};

type PersistedNextUpQueue = {
  version: 1;
  updatedAt: string;
  pins: NextUpPinnedEntry[];
};

const MAX_PINS = 240;

function storeDir(): string {
  return getOrgxPluginConfigDir();
}

function storeFile(): string {
  return getOrgxPluginConfigPath("next-up-queue.json");
}

function ensureStoreDir(): void {
  const dir = storeDir();
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

export function readNextUpQueuePins(): PersistedNextUpQueue {
  const file = storeFile();
  try {
    if (!existsSync(file)) {
      return { version: 1, updatedAt: new Date().toISOString(), pins: [] };
    }
    const raw = readFileSync(file, "utf8");
    const parsed = parseJson<PersistedNextUpQueue>(raw);
    if (!parsed || typeof parsed !== "object") {
      backupCorruptFileSync(file);
      return { version: 1, updatedAt: new Date().toISOString(), pins: [] };
    }

    const pins = Array.isArray(parsed.pins) ? parsed.pins : [];
    return {
      version: 1,
      updatedAt:
        typeof parsed.updatedAt === "string"
          ? parsed.updatedAt
          : new Date().toISOString(),
      pins: pins
        .filter((entry): entry is NextUpPinnedEntry => Boolean(entry && typeof entry === "object"))
        .map((entry) => normalizeEntry(entry)),
    };
  } catch {
    return { version: 1, updatedAt: new Date().toISOString(), pins: [] };
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
    (pin) => `${pin.initiativeId}:${pin.workstreamId}` === key
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

  next.pins = [updated, ...next.pins.filter((pin) => `${pin.initiativeId}:${pin.workstreamId}` !== key)].slice(
    0,
    MAX_PINS
  );
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
  const filtered = next.pins.filter((pin) => `${pin.initiativeId}:${pin.workstreamId}` !== key);
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
  next.updatedAt = now;
  try {
    writeJsonFileAtomicSync(storeFile(), next, 0o600);
  } catch {
    // best effort
  }

  return next;
}
