#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const root = resolve(__dirname, "..");

function bytesToMb(value) {
  return (value / (1024 * 1024)).toFixed(2);
}

function parseBudgetMb(value) {
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid ORGX_PACKAGE_BUDGET_MB value: ${value}`);
  }
  return parsed;
}

function packDryRun(cacheDir) {
  const stdout = execFileSync("npm", ["pack", "--dry-run", "--json", "--cache", cacheDir], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  const parsed = JSON.parse(stdout);
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error("npm pack did not return package metadata.");
  }
  return parsed[0];
}

function largestFiles(files) {
  if (!Array.isArray(files)) return [];
  return [...files]
    .sort((a, b) => (b.size ?? 0) - (a.size ?? 0))
    .slice(0, 5)
    .map((entry) => `${entry.path} (${bytesToMb(entry.size ?? 0)} MB)`);
}

function main() {
  const budgetMb = parseBudgetMb(process.env.ORGX_PACKAGE_BUDGET_MB ?? "13");
  const budgetBytes = Math.floor(budgetMb * 1024 * 1024);
  const cacheDir = process.env.ORGX_NPM_CACHE ?? join(tmpdir(), ".npm-orgx-cache");
  mkdirSync(cacheDir, { recursive: true });

  const pkg = packDryRun(cacheDir);
  const sizeBytes = Number(pkg.size ?? 0);
  const sizeMb = bytesToMb(sizeBytes);

  console.log(`[verify] package tarball: ${pkg.filename} (${sizeMb} MB)`);
  console.log(`[verify] budget: ${budgetMb.toFixed(2)} MB`);

  if (sizeBytes > budgetBytes) {
    console.error(
      `[verify] failed: tarball size exceeds budget by ${bytesToMb(sizeBytes - budgetBytes)} MB.`
    );
    const offenders = largestFiles(pkg.files);
    if (offenders.length) {
      console.error("[verify] largest packaged files:");
      for (const line of offenders) console.error(`- ${line}`);
    }
    process.exit(1);
  }

  console.log("[verify] ok: package tarball is within budget.");
}

try {
  main();
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`[verify] failed: ${message}`);
  process.exit(1);
}
