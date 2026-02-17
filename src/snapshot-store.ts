import { existsSync, readFileSync } from "node:fs";

import type { OrgSnapshot } from './types.js';

import { getOrgxPluginConfigDir, getOrgxPluginConfigPath } from './paths.js';
import { backupCorruptFileSync, writeJsonFileAtomicSync } from './fs-utils.js';
import {
  clearStoreFileSync,
  ensureStoreDirSync,
  parseJsonSafe,
} from "./stores/json-store.js";

function snapshotDir(): string {
  return getOrgxPluginConfigDir();
}

function snapshotFile(): string {
  return getOrgxPluginConfigPath('snapshot.json');
}

interface PersistedSnapshot {
  snapshot: OrgSnapshot;
  updatedAt: string;
}

function ensureSnapshotDir(): void {
  ensureStoreDirSync(snapshotDir());
}

export function readPersistedSnapshot(): PersistedSnapshot | null {
  const file = snapshotFile();
  try {
    if (!existsSync(file)) return null;
    const raw = readFileSync(file, 'utf8');
    const parsed = parseJsonSafe<PersistedSnapshot>(raw);
    if (!parsed) {
      backupCorruptFileSync(file);
      return null;
    }
    if (!parsed || typeof parsed.updatedAt !== 'string') return null;
    if (!parsed.snapshot || typeof parsed.snapshot !== 'object') return null;
    return parsed;
  } catch {
    return null;
  }
}

export function writePersistedSnapshot(snapshot: OrgSnapshot): PersistedSnapshot {
  ensureSnapshotDir();
  const record: PersistedSnapshot = {
    snapshot,
    updatedAt: new Date().toISOString(),
  };

  const file = snapshotFile();
  writeJsonFileAtomicSync(file, record, 0o600);

  return record;
}

export function clearPersistedSnapshot(): void {
  clearStoreFileSync(snapshotFile());
}
