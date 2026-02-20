#!/usr/bin/env node
import { brotliCompressSync, constants as zlibConstants, gzipSync } from "node:zlib";
import {
  existsSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const rootDir = resolve(__dirname, "..");
const distDir = resolve(rootDir, "dashboard", "dist");

const COMPRESSIBLE_EXTENSIONS = new Set([
  ".css",
  ".html",
  ".js",
  ".json",
  ".map",
  ".svg",
  ".txt",
  ".xml",
]);

function walkFiles(dirPath) {
  const output = [];
  const entries = readdirSync(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = resolve(dirPath, entry.name);
    if (entry.isDirectory()) {
      output.push(...walkFiles(entryPath));
      continue;
    }
    if (entry.isFile()) {
      output.push(entryPath);
    }
  }
  return output;
}

function writeCompressed(filePath, encoding, buffer) {
  const targetPath = `${filePath}.${encoding}`;
  writeFileSync(targetPath, buffer);
}

function removeIfExists(pathname) {
  if (!existsSync(pathname)) return false;
  unlinkSync(pathname);
  return true;
}

function compressAsset(filePath) {
  const source = readFileSync(filePath);
  const sourceBytes = source.byteLength;

  const brotli = brotliCompressSync(source, {
    params: {
      [zlibConstants.BROTLI_PARAM_QUALITY]: 11,
      [zlibConstants.BROTLI_PARAM_SIZE_HINT]: sourceBytes,
    },
  });
  const gzip = gzipSync(source, { level: 9 });

  let wrote = 0;
  let removed = 0;

  if (brotli.byteLength < sourceBytes) {
    writeCompressed(filePath, "br", brotli);
    wrote += 1;
  } else if (removeIfExists(`${filePath}.br`)) {
    removed += 1;
  }

  if (gzip.byteLength < sourceBytes) {
    writeCompressed(filePath, "gz", gzip);
    wrote += 1;
  } else if (removeIfExists(`${filePath}.gz`)) {
    removed += 1;
  }

  return {
    wrote,
    removed,
    sourceBytes,
    bestBytes: Math.min(sourceBytes, brotli.byteLength, gzip.byteLength),
  };
}

function removeStaleSidecars(files) {
  let removed = 0;
  for (const filePath of files) {
    if (filePath.endsWith(".br") || filePath.endsWith(".gz")) {
      const sourcePath = filePath.slice(0, -3);
      const sourceExt = extname(sourcePath).toLowerCase();
      if (!existsSync(sourcePath) || !COMPRESSIBLE_EXTENSIONS.has(sourceExt)) {
        unlinkSync(filePath);
        removed += 1;
      }
    }
  }
  return removed;
}

function main() {
  if (!existsSync(distDir)) {
    console.error(`[compress-dashboard-assets] dist directory not found: ${distDir}`);
    process.exit(1);
  }

  const files = walkFiles(distDir);
  let processed = 0;
  let sidecarsWritten = 0;
  let sidecarsRemoved = 0;
  let sourceBytesTotal = 0;
  let bestBytesTotal = 0;

  for (const filePath of files) {
    if (filePath.endsWith(".br") || filePath.endsWith(".gz")) continue;
    const sourceExt = extname(filePath).toLowerCase();
    if (!COMPRESSIBLE_EXTENSIONS.has(sourceExt)) continue;

    processed += 1;
    const result = compressAsset(filePath);
    sidecarsWritten += result.wrote;
    sidecarsRemoved += result.removed;
    sourceBytesTotal += result.sourceBytes;
    bestBytesTotal += result.bestBytes;
  }

  const staleRemoved = removeStaleSidecars(walkFiles(distDir));
  sidecarsRemoved += staleRemoved;

  const savedBytes = Math.max(0, sourceBytesTotal - bestBytesTotal);
  const savedPct = sourceBytesTotal > 0 ? ((savedBytes / sourceBytesTotal) * 100).toFixed(1) : "0.0";

  console.log(
    [
      "[compress-dashboard-assets]",
      `processed=${processed}`,
      `sidecars_written=${sidecarsWritten}`,
      `sidecars_removed=${sidecarsRemoved}`,
      `saved=${savedBytes}B (${savedPct}%)`,
    ].join(" ")
  );
}

main();
