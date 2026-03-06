#!/usr/bin/env node

import { spawn } from "node:child_process";
import { cpSync, existsSync, rmSync, watch } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = resolve(fileURLToPath(new URL(".", import.meta.url)));
const repoRoot = resolve(scriptDir, "..");
const dashboardDir = resolve(repoRoot, "dashboard");
const extensionRoot = resolve(
  process.env.HOME || "~",
  ".openclaw/extensions/openclaw-plugin"
);
const gatewayPort = String(process.env.ORGX_DEV_GATEWAY_PORT || "18890").trim();

function log(message) {
  process.stdout.write(`[dev:live] ${message}\n`);
}

function run(command, args, cwd = repoRoot) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, {
      cwd,
      stdio: "inherit",
      env: process.env,
    });
    child.once("error", rejectRun);
    child.once("exit", (code) => {
      if (code === 0) {
        resolveRun();
        return;
      }
      rejectRun(
        new Error(
          `${command} ${args.join(" ")} failed with exit code ${code ?? "unknown"}`
        )
      );
    });
  });
}

function safeReplaceDir(fromPath, toPath) {
  if (!existsSync(fromPath)) return;
  rmSync(toPath, { recursive: true, force: true, maxRetries: 4, retryDelay: 50 });
  cpSync(fromPath, toPath, { recursive: true, force: true });
}

function syncCoreArtifacts() {
  safeReplaceDir(resolve(repoRoot, "dist"), resolve(extensionRoot, "dist"));
  cpSync(
    resolve(repoRoot, "openclaw.plugin.json"),
    resolve(extensionRoot, "openclaw.plugin.json"),
    { force: true }
  );
  cpSync(resolve(repoRoot, "package.json"), resolve(extensionRoot, "package.json"), {
    force: true,
  });
}

function syncDashboardArtifacts() {
  safeReplaceDir(
    resolve(repoRoot, "dashboard/dist"),
    resolve(extensionRoot, "dashboard/dist")
  );
}

async function buildCoreAndSync() {
  log("building core...");
  await run("npm", ["run", "build:core"]);
  syncCoreArtifacts();
  log("core synced to extension");
}

async function buildDashboardAndSync() {
  log("building dashboard...");
  await run("node", ["./node_modules/vite/bin/vite.js", "build"], dashboardDir);
  await run("node", ["scripts/compress-dashboard-assets.mjs"], repoRoot);
  syncDashboardArtifacts();
  log("dashboard synced to extension");
}

let pendingCore = false;
let pendingDashboard = false;
let flushRunning = false;

async function flushQueue() {
  if (flushRunning) return;
  flushRunning = true;
  try {
    while (pendingCore || pendingDashboard) {
      const runCore = pendingCore;
      const runDashboard = pendingDashboard;
      pendingCore = false;
      pendingDashboard = false;

      try {
        if (runCore) await buildCoreAndSync();
        if (runDashboard) await buildDashboardAndSync();
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "unknown build error";
        log(`build failed: ${message}`);
      }
    }
  } finally {
    flushRunning = false;
  }
}

let debounceTimer = null;
function scheduleFlush() {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    void flushQueue();
  }, 250);
}

function watchPath(path, onChange) {
  if (!existsSync(path)) return null;
  return watch(
    path,
    { recursive: true },
    (_eventType, filename) => {
      const name = String(filename || "");
      if (!name) return;
      if (name.includes("/dist/") || name.startsWith("dist/")) return;
      if (name.endsWith(".map")) return;
      onChange(name);
    }
  );
}

function startGateway() {
  log(`starting gateway on ${gatewayPort}...`);
  const child = spawn(
    "openclaw",
    ["gateway", "run", "--port", gatewayPort, "--force"],
    {
      cwd: repoRoot,
      stdio: "inherit",
      env: process.env,
    }
  );
  child.once("exit", (code) => {
    if (code !== 0) {
      log(`gateway exited with code ${code ?? "unknown"}`);
    }
  });
  return child;
}

async function main() {
  if (!existsSync(extensionRoot)) {
    throw new Error(`extension path not found: ${extensionRoot}`);
  }

  await buildCoreAndSync();
  await buildDashboardAndSync();

  const gateway = startGateway();
  const watchers = [];

  const registerWatcher = (watcher) => {
    if (watcher) watchers.push(watcher);
  };

  registerWatcher(
    watchPath(resolve(repoRoot, "src"), () => {
      pendingCore = true;
      scheduleFlush();
    })
  );
  registerWatcher(
    watchPath(resolve(repoRoot, "scripts"), (filename) => {
      if (!filename.endsWith(".ts") && !filename.endsWith(".mts")) return;
      pendingCore = true;
      scheduleFlush();
    })
  );
  registerWatcher(
    watchPath(resolve(repoRoot, "dashboard/src"), () => {
      pendingDashboard = true;
      scheduleFlush();
    })
  );
  registerWatcher(
    watchPath(resolve(repoRoot, "dashboard/index.html"), () => {
      pendingDashboard = true;
      scheduleFlush();
    })
  );
  registerWatcher(
    watchPath(resolve(repoRoot, "dashboard/tailwind.config.ts"), () => {
      pendingDashboard = true;
      scheduleFlush();
    })
  );
  registerWatcher(
    watchPath(resolve(repoRoot, "dashboard/postcss.config.js"), () => {
      pendingDashboard = true;
      scheduleFlush();
    })
  );

  log("watching for changes (core + dashboard).");
  log(`live URL: http://127.0.0.1:${gatewayPort}/orgx/live`);

  const shutdown = (signal) => {
    log(`shutting down (${signal})...`);
    for (const watcher of watchers) watcher.close();
    if (debounceTimer) clearTimeout(debounceTimer);
    gateway.kill("SIGINT");
    process.exit(0);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : "unknown error";
  process.stderr.write(`[dev:live] fatal: ${message}\n`);
  process.exit(1);
});
