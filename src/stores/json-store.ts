import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
} from "node:fs";

import { backupCorruptFileSync, writeJsonFileAtomicSync } from "../fs-utils.js";

export function ensureStoreDirSync(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(dir, 0o700);
  } catch {
    // best effort
  }
}

export function parseJsonSafe<T>(value: string): T | null {
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

export function readJsonFileOrDefault<T>(input: {
  file: string;
  fallback: () => T;
  isValid?: (value: unknown) => value is T;
  backupOnInvalid?: boolean;
}): T {
  const {
    file,
    fallback,
    isValid,
    backupOnInvalid = true,
  } = input;
  if (!existsSync(file)) return fallback();
  try {
    const raw = readFileSync(file, "utf8");
    const parsed = parseJsonSafe<T>(raw);
    const valid = parsed !== null && (isValid ? isValid(parsed) : true);
    if (valid) return parsed as T;
    if (backupOnInvalid) backupCorruptFileSync(file);
    return fallback();
  } catch {
    return fallback();
  }
}

export function writeJsonStoreFileSync(
  file: string,
  data: unknown,
  mode = 0o600
): void {
  writeJsonFileAtomicSync(file, data, mode);
}

export function clearStoreFileSync(file: string): void {
  try {
    rmSync(file, { force: true });
  } catch {
    // best effort
  }
}

