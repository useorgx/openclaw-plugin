import { mkdirSync, readFileSync, writeFileSync, chmodSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';

const AUTH_DIR = join(homedir(), '.config', 'useorgx', 'openclaw-plugin');
const AUTH_FILE = join(AUTH_DIR, 'auth.json');
const INSTALLATION_FILE = join(AUTH_DIR, 'installation.json');

export interface PersistedAuthRecord {
  apiKey: string;
  source: 'manual' | 'browser_pairing';
  installationId: string;
  userId?: string | null;
  workspaceName?: string | null;
  keyPrefix?: string | null;
  createdAt: string;
  updatedAt: string;
}

interface InstallationRecord {
  installationId: string;
  createdAt: string;
  updatedAt: string;
}

function ensureAuthDir(): void {
  mkdirSync(AUTH_DIR, { recursive: true, mode: 0o700 });
  try {
    chmodSync(AUTH_DIR, 0o700);
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

export function getAuthFilePath(): string {
  return AUTH_FILE;
}

export function readPersistedAuth(): PersistedAuthRecord | null {
  try {
    if (!existsSync(AUTH_FILE)) return null;
    const parsed = parseJson<PersistedAuthRecord>(readFileSync(AUTH_FILE, 'utf8'));
    if (!parsed || typeof parsed.apiKey !== 'string' || parsed.apiKey.trim().length === 0) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function writePersistedAuth(
  input: Omit<PersistedAuthRecord, 'createdAt' | 'updatedAt'>
): PersistedAuthRecord {
  ensureAuthDir();
  const now = new Date().toISOString();
  const existing = readPersistedAuth();
  const next: PersistedAuthRecord = {
    apiKey: input.apiKey,
    source: input.source,
    installationId: input.installationId,
    userId: input.userId ?? null,
    workspaceName: input.workspaceName ?? null,
    keyPrefix: input.keyPrefix ?? null,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };

  writeFileSync(AUTH_FILE, JSON.stringify(next, null, 2), {
    mode: 0o600,
    encoding: 'utf8',
  });
  try {
    chmodSync(AUTH_FILE, 0o600);
  } catch {
    // best effort
  }

  return next;
}

export function clearPersistedAuth(): void {
  try {
    rmSync(AUTH_FILE, { force: true });
  } catch {
    // best effort
  }
}

function readInstallationRecord(): InstallationRecord | null {
  try {
    if (!existsSync(INSTALLATION_FILE)) return null;
    const parsed = parseJson<InstallationRecord>(readFileSync(INSTALLATION_FILE, 'utf8'));
    if (!parsed || typeof parsed.installationId !== 'string') return null;
    if (parsed.installationId.trim().length < 6) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function getOrCreateInstallationId(): string {
  const existing = readInstallationRecord();
  if (existing?.installationId) return existing.installationId;

  ensureAuthDir();
  const now = new Date().toISOString();
  const installationId = `ocw_${randomUUID()}`;
  const record: InstallationRecord = {
    installationId,
    createdAt: now,
    updatedAt: now,
  };

  writeFileSync(INSTALLATION_FILE, JSON.stringify(record, null, 2), {
    mode: 0o600,
    encoding: 'utf8',
  });
  try {
    chmodSync(INSTALLATION_FILE, 0o600);
  } catch {
    // best effort
  }

  return installationId;
}

// Backward-compatible aliases used by the runtime.
export function loadAuthStore(): PersistedAuthRecord | null {
  return readPersistedAuth();
}

export function saveAuthStore(
  input: Omit<PersistedAuthRecord, 'createdAt' | 'updatedAt'>
): PersistedAuthRecord {
  return writePersistedAuth(input);
}

export function resolveInstallationId(): string {
  return getOrCreateInstallationId();
}

export function clearPersistedApiKey(): void {
  clearPersistedAuth();
}
