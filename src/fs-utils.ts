import { chmodSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

function isSafeFilePath(path: string): boolean {
  if (!path) return false;
  if (/[\u0000-\u001f\u007f]/.test(path)) return false;
  if (/\\0|\\x00|\\u0000|%00/i.test(path)) return false;
  return true;
}

function hardenPath(path: string, mode: number): void {
  try {
    chmodSync(path, mode);
  } catch {
    // best effort
  }
}

export function backupCorruptFileSync(targetPath: string): string | null {
  if (!isSafeFilePath(targetPath)) return null;
  const suffix = `${Date.now()}-${randomUUID().slice(0, 8)}`;
  const backupPath = `${targetPath}.corrupt.${suffix}`;
  try {
    renameSync(targetPath, backupPath);
    hardenPath(backupPath, 0o600);
    return backupPath;
  } catch {
    return null;
  }
}

export function writeFileAtomicSync(
  targetPath: string,
  content: string,
  options?: { mode?: number; encoding?: BufferEncoding }
): void {
  if (!isSafeFilePath(targetPath)) {
    throw new TypeError("targetPath must be a safe, non-empty file path");
  }
  const mode = options?.mode ?? 0o600;
  const encoding = options?.encoding ?? "utf8";
  const tmpPath = `${targetPath}.tmp.${process.pid}.${randomUUID().slice(0, 8)}`;

  writeFileSync(tmpPath, content, { encoding, mode });
  hardenPath(tmpPath, mode);

  try {
    renameSync(tmpPath, targetPath);
  } catch (err: unknown) {
    const code = err && typeof err === "object" ? (err as any).code : null;
    if (code === "EEXIST" || code === "EPERM" || code === "EACCES") {
      try {
        unlinkSync(targetPath);
      } catch {
        // ignore
      }
      renameSync(tmpPath, targetPath);
    } else {
      try {
        unlinkSync(tmpPath);
      } catch {
        // ignore
      }
      throw err;
    }
  }

  hardenPath(targetPath, mode);
}

export function writeJsonFileAtomicSync(
  targetPath: string,
  data: unknown,
  mode = 0o600
): void {
  writeFileAtomicSync(targetPath, JSON.stringify(data, null, 2), {
    mode,
    encoding: "utf8",
  });
}
