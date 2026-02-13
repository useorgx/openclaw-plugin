#!/usr/bin/env node
/**
 * Installs (or updates) the launchd job that runs daily agents refresh.
 *
 * This is intentionally explicit: it copies a plist into ~/Library/LaunchAgents
 * and bootstraps it for the current user.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC_PLIST = path.join(REPO_ROOT, "scripts", "launchd", "useorgx.agents-refresh.plist");
const DST_DIR = path.join(os.homedir(), "Library", "LaunchAgents");
const DST_PLIST = path.join(DST_DIR, "useorgx.agents-refresh.plist");

function run(cmd, args) {
  execFileSync(cmd, args, { stdio: "inherit" });
}

async function main() {
  await fs.mkdir(DST_DIR, { recursive: true });
  const template = await fs.readFile(SRC_PLIST, "utf8");
  const rendered = template
    .replaceAll("__HOME__", os.homedir())
    .replaceAll("__REPO_ROOT__", REPO_ROOT);
  await fs.writeFile(DST_PLIST, rendered, "utf8");

  const uid = String(process.getuid());
  const domain = `gui/${uid}`;
  const label = "useorgx.agents-refresh";

  // Best-effort: unload old, then load fresh.
  try {
    run("launchctl", ["bootout", domain, DST_PLIST]);
  } catch {
    // ignore
  }

  run("launchctl", ["bootstrap", domain, DST_PLIST]);
  run("launchctl", ["enable", `${domain}/${label}`]);

  console.log(JSON.stringify({ ok: true, installed: DST_PLIST, label }, null, 2));
}

main().catch((error) => {
  console.error(error?.stack || String(error));
  process.exit(1);
});
