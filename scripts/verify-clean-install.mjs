#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const root = resolve(__dirname, "..");

function run(cmd, args, options = {}) {
  execFileSync(cmd, args, {
    cwd: options.cwd ?? root,
    stdio: "inherit",
    env: { ...process.env, ...(options.env ?? {}) },
  });
}

function newestTgz(artifactsDir) {
  const entries = readdirSync(artifactsDir)
    .filter((name) => name.endsWith(".tgz"))
    .map((name) => {
      const full = join(artifactsDir, name);
      return { name, full, mtimeMs: statSync(full).mtimeMs };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);

  return entries[0]?.full ?? null;
}

function assertExists(pathname, label) {
  if (!existsSync(pathname)) {
    throw new Error(`Missing ${label}: ${pathname}`);
  }
}

async function main() {
  const artifactsDir = join(root, "artifacts");

  console.log("[verify] packing plugin...");
  run("npm", ["run", "pack"]);

  const tgzPath = newestTgz(artifactsDir);
  if (!tgzPath) {
    throw new Error(`No .tgz found in ${artifactsDir}`);
  }

  const tmp = mkdtempSync(join(tmpdir(), "orgx-openclaw-plugin-install-"));
  console.log(`[verify] temp dir: ${tmp}`);

  console.log("[verify] npm init...");
  run("npm", ["init", "-y"], { cwd: tmp });

  console.log("[verify] npm install tgz...");
  run("npm", ["install", "--silent", tgzPath], { cwd: tmp });

  console.log("[verify] import package...");
  run(
    "node",
    [
      "-e",
      "import('@useorgx/openclaw-plugin').then(()=>console.log('import-ok')).catch((e)=>{console.error(e);process.exit(1);})",
    ],
    { cwd: tmp }
  );

  const pkgRoot = join(tmp, "node_modules", "@useorgx", "openclaw-plugin");
  assertExists(pkgRoot, "installed package root");
  assertExists(join(pkgRoot, "openclaw.plugin.json"), "plugin manifest");
  assertExists(join(pkgRoot, "dist", "index.js"), "built dist entry");
  assertExists(join(pkgRoot, "dashboard", "dist", "index.html"), "dashboard build");

  console.log("[verify] ok: clean install + import succeeded");
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`[verify] failed: ${message}`);
  process.exit(1);
});

