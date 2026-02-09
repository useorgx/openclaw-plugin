import { mkdirSync, readFileSync, writeFileSync, chmodSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

import type { OrgSnapshot } from './types.js';

const SNAPSHOT_DIR = join(homedir(), '.config', 'useorgx', 'openclaw-plugin');
const SNAPSHOT_FILE = join(SNAPSHOT_DIR, 'snapshot.json');

interface PersistedSnapshot {
  snapshot: OrgSnapshot;
  updatedAt: string;
}

function ensureSnapshotDir(): void {
  mkdirSync(SNAPSHOT_DIR, { recursive: true, mode: 0o700 });
  try {
    chmodSync(SNAPSHOT_DIR, 0o700);
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
  try {
    if (!existsSync(SNAPSHOT_FILE)) return null;
    const parsed = parseJson<PersistedSnapshot>(readFileSync(SNAPSHOT_FILE, 'utf8'));
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

  writeFileSync(SNAPSHOT_FILE, JSON.stringify(record, null, 2), {
    mode: 0o600,
    encoding: 'utf8',
  });
  try {
    chmodSync(SNAPSHOT_FILE, 0o600);
  } catch {
    // best effort
  }

  return record;
}

export function clearPersistedSnapshot(): void {
  try {
    rmSync(SNAPSHOT_FILE, { force: true });
  } catch {
    // best effort
  }
}
