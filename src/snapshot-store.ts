import { mkdirSync, readFileSync, chmodSync, existsSync, rmSync } from 'node:fs';

import type { OrgSnapshot } from './types.js';

import { getOrgxPluginConfigDir, getOrgxPluginConfigPath } from './paths.js';
import { backupCorruptFileSync, writeJsonFileAtomicSync } from './fs-utils.js';

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
  const dir = snapshotDir();
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

export function readPersistedSnapshot(): PersistedSnapshot | null {
  const file = snapshotFile();
  try {
    if (!existsSync(file)) return null;
    const raw = readFileSync(file, 'utf8');
    const parsed = parseJson<PersistedSnapshot>(raw);
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
  const file = snapshotFile();
  try {
    rmSync(file, { force: true });
  } catch {
    // best effort
  }
}
