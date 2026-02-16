import { mkdirSync, readFileSync, chmodSync, existsSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

import { getOrgxPluginConfigDir, getOrgxPluginConfigPath } from './paths.js';
import { backupCorruptFileSync, writeJsonFileAtomicSync } from './fs-utils.js';

function authDir(): string {
  return getOrgxPluginConfigDir();
}

function authFile(): string {
  return getOrgxPluginConfigPath('auth.json');
}

function installationFile(): string {
  return getOrgxPluginConfigPath('installation.json');
}

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

function isUserScopedApiKey(apiKey: string): boolean {
  return apiKey.trim().toLowerCase().startsWith('oxk_');
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value
  );
}

function ensureAuthDir(): void {
  const dir = authDir();
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

export function getAuthFilePath(): string {
  return authFile();
}

export function readPersistedAuth(): PersistedAuthRecord | null {
  const file = authFile();
  try {
    if (!existsSync(file)) return null;
    const raw = readFileSync(file, 'utf8');
    const parsed = parseJson<PersistedAuthRecord>(raw);
    if (!parsed) {
      backupCorruptFileSync(file);
      return null;
    }
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
  const rawUserId = typeof input.userId === 'string' ? input.userId.trim() : '';
  const normalizedUserId =
    rawUserId.length === 0
      ? null
      : isUserScopedApiKey(input.apiKey)
        ? (isUuid(rawUserId) ? rawUserId : null)
        : rawUserId;
  const next: PersistedAuthRecord = {
    apiKey: input.apiKey,
    source: input.source,
    installationId: input.installationId,
    userId: normalizedUserId,
    workspaceName: input.workspaceName ?? null,
    keyPrefix: input.keyPrefix ?? null,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };

  const file = authFile();
  writeJsonFileAtomicSync(file, next, 0o600);

  return next;
}

export function clearPersistedAuth(): void {
  const file = authFile();
  try {
    rmSync(file, { force: true });
  } catch {
    // best effort
  }
}

function readInstallationRecord(): InstallationRecord | null {
  const file = installationFile();
  try {
    if (!existsSync(file)) return null;
    const raw = readFileSync(file, 'utf8');
    const parsed = parseJson<InstallationRecord>(raw);
    if (!parsed) {
      backupCorruptFileSync(file);
      return null;
    }
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

  const file = installationFile();
  writeJsonFileAtomicSync(file, record, 0o600);

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
