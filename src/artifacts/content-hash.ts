import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";

const MAX_CONTENT_BYTES = 16 * 1024 * 1024;

/** Hash a bounded regular-file snapshot; a locator never substitutes for bytes. */
export async function hashLocalArtifactContent(filePath: string): Promise<string | null> {
  const file = await open(filePath, constants.O_RDONLY | constants.O_NONBLOCK).catch(() => null);
  if (!file) return null;
  try {
    const before = await file.stat();
    if (!before.isFile() || before.size > MAX_CONTENT_BYTES) return null;
    const hash = createHash("sha256");
    const buffer = Buffer.alloc(64 * 1024);
    let total = 0;
    while (true) {
      const { bytesRead } = await file.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      total += bytesRead;
      if (total > MAX_CONTENT_BYTES) return null;
      hash.update(buffer.subarray(0, bytesRead));
    }
    const after = await file.stat();
    if (total !== before.size || after.size !== before.size ||
        after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) return null;
    return `sha256:${hash.digest("hex")}`;
  } catch {
    return null;
  } finally {
    await file.close();
  }
}
