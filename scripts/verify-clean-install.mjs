#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
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

  console.log("[verify] npm install tgz with scripts disabled...");
  run("npm", ["install", "--silent", "--ignore-scripts", tgzPath], { cwd: tmp });

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

  console.log("[verify] forcing sqlite runtime initialization...");
  const sqliteStateModuleUrl = pathToFileURL(
    join(pkgRoot, "dist", "stores", "sqlite-state.js")
  ).href;
  const { closeStateDb, getStateDb } = await import(sqliteStateModuleUrl);
  const db = getStateDb();
  db.pragma("user_version", { simple: true });
  closeStateDb();
  const requireFromPkg = createRequire(join(pkgRoot, "package.json"));
  const betterSqlitePackageJson = requireFromPkg.resolve("better-sqlite3/package.json");
  assertExists(
    join(
      dirname(betterSqlitePackageJson),
      "build",
      "Release",
      "better_sqlite3.node"
    ),
    "better-sqlite3 native binding"
  );

  console.log("[verify] ok: clean install + import succeeded");
  process.exit(0);
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`[verify] failed: ${message}`);
  process.exit(1);
});
