#!/usr/bin/env node

import { spawn } from "node:child_process";
import { mkdirSync, createWriteStream } from "node:fs";
import { resolve } from "node:path";

function parseArgs(argv) {
  const out = {};
  for (const arg of argv) {
    if (!arg.startsWith("--")) continue;
    const [k, ...rest] = arg.slice(2).split("=");
    out[k] = rest.length ? rest.join("=") : "true";
  }
  return out;
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function runToLog(label, cmd, args, { cwd, env, logPath }) {
  return new Promise((resolvePromise, reject) => {
    const out = createWriteStream(logPath, { flags: "a" });
    out.write(`\n===== ${label} (${new Date().toISOString()}) =====\n`);

    const child = spawn(cmd, args, {
      cwd,
      env: { ...process.env, ...(env ?? {}) },
      stdio: ["ignore", "pipe", "pipe"],
    });

    child.stdout.on("data", (chunk) => {
      process.stdout.write(chunk);
      out.write(chunk);
    });
    child.stderr.on("data", (chunk) => {
      process.stderr.write(chunk);
      out.write(chunk);
    });

    child.on("error", (err) => {
      out.end();
      reject(err);
    });

    child.on("close", (code) => {
      out.write(`\n[exit] code=${code}\n`);
      out.end();
      if (code === 0) {
        resolvePromise();
      } else {
        reject(new Error(`${label} failed (exit ${code})`));
      }
    });
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const date = String(args.date || today());
  const root = resolve(new URL("..", import.meta.url).pathname);
  const outDir = resolve(root, "docs", "ops", date);
  mkdirSync(outDir, { recursive: true });

  const logPath = resolve(outDir, "launch-checklist.log");

  await runToLog("typecheck", "npm", ["run", "typecheck"], { cwd: root, logPath });
  await runToLog("test:hooks", "npm", ["run", "test:hooks"], { cwd: root, logPath });
  await runToLog("verify:clean-install", "npm", ["run", "verify:clean-install"], {
    cwd: root,
    logPath,
  });

  if ((process.env.ORGX_API_KEY || "").trim()) {
    await runToLog(
      "verify:billing",
      "npm",
      ["run", "verify:billing"],
      { cwd: root, logPath }
    );
  } else {
    const out = createWriteStream(logPath, { flags: "a" });
    out.write(
      `\n===== verify:billing (${new Date().toISOString()}) =====\n[skip] ORGX_API_KEY not set\n`
    );
    out.end();
  }

  // Optional: QA capture depends on Chrome + ffmpeg.
  if (String(args.capture_qa || "").toLowerCase() === "true") {
    await runToLog(
      "qa:capture",
      "npm",
      ["run", "qa:capture", "--", "--date", date],
      { cwd: root, logPath }
    );
  }

  console.log(`\n[launch-checklist] wrote ${logPath}`);
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`[launch-checklist] failed: ${message}`);
  process.exit(1);
});
