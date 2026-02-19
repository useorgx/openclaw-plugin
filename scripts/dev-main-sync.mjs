#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, rmSync } from "node:fs";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";

function run(cmd, args, options = {}) {
  execFileSync(cmd, args, { stdio: "inherit", ...options });
}

function capture(cmd, args, options = {}) {
  return execFileSync(cmd, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  }).trim();
}

function parseFlags(argv) {
  const values = new Set(argv);
  return {
    syncOnly: values.has("--sync-only"),
    noCopy: values.has("--no-copy"),
  };
}

function ensureWorktree({ repoRoot, worktreePath, remoteRef }) {
  if (existsSync(resolve(worktreePath, ".git"))) return;
  run("git", ["worktree", "add", "--detach", worktreePath, remoteRef], {
    cwd: repoRoot,
  });
}

function ensureDependencies({ worktreePath }) {
  if (!existsSync(resolve(worktreePath, "node_modules"))) {
    run("npm", ["ci"], { cwd: worktreePath });
  }
  if (!existsSync(resolve(worktreePath, "dashboard", "node_modules"))) {
    run("npm", ["--prefix", "dashboard", "ci"], { cwd: worktreePath });
  }
}

function copyTree({ from, to }) {
  if (!existsSync(from)) {
    throw new Error(`Missing build output to copy: ${from}`);
  }
  rmSync(to, { recursive: true, force: true, maxRetries: 4, retryDelay: 50 });
  cpSync(from, to, { recursive: true, force: true });
}

function main() {
  const scriptDir = resolve(fileURLToPath(new URL(".", import.meta.url)));
  const repoRoot = resolve(scriptDir, "..");
  const flags = parseFlags(process.argv.slice(2));

  const remote = process.env.ORGX_DEV_MAIN_REMOTE?.trim() || "origin";
  const branch = process.env.ORGX_DEV_MAIN_BRANCH?.trim() || "main";
  const remoteRef = `${remote}/${branch}`;
  const defaultWorktreePath = resolve(
    repoRoot,
    "..",
    `${basename(repoRoot)}-dev-main`
  );
  const worktreePath =
    process.env.ORGX_DEV_MAIN_WORKTREE?.trim() || defaultWorktreePath;

  process.stdout.write(
    `[dev:main] syncing worktree ${worktreePath} -> ${remoteRef}\n`
  );

  run("git", ["fetch", remote, branch], { cwd: repoRoot });
  ensureWorktree({ repoRoot, worktreePath, remoteRef });
  run("git", ["fetch", remote, branch], { cwd: worktreePath });
  run("git", ["reset", "--hard", remoteRef], { cwd: worktreePath });

  if (!flags.syncOnly) {
    ensureDependencies({ worktreePath });
    run("npm", ["run", "build"], { cwd: worktreePath });
  }

  if (!flags.noCopy) {
    copyTree({
      from: resolve(worktreePath, "dist"),
      to: resolve(repoRoot, "dist"),
    });
    copyTree({
      from: resolve(worktreePath, "dashboard", "dist"),
      to: resolve(repoRoot, "dashboard", "dist"),
    });
  }

  const mainHead = capture("git", ["rev-parse", "--short", "HEAD"], {
    cwd: worktreePath,
  });
  process.stdout.write(
    `[dev:main] ready from ${remoteRef} @ ${mainHead}${flags.noCopy ? " (no artifact copy)" : ""}\n`
  );
}

main();
