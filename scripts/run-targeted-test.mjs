#!/usr/bin/env node
import { spawn } from "node:child_process";

const testArgs = process.argv.slice(2);

if (testArgs.length === 0) {
  console.error("Usage: node scripts/run-targeted-test.mjs <test-file> [more-test-files...]");
  process.exit(1);
}

const env = { ...process.env };
delete env.NODE_TEST_CONTEXT;

const nodeOptions = env.NODE_OPTIONS;
if (typeof nodeOptions === "string" && nodeOptions.trim().length > 0) {
  const tokens = nodeOptions.match(/(?:[^\s"]+|"[^"]*")+/g) ?? [];
  const filtered = tokens.filter((token) => {
    const normalized = token.replace(/^"+|"+$/g, "");
    return (
      normalized !== "--test" &&
      normalized !== "--test-only" &&
      !normalized.startsWith("--test=") &&
      !normalized.startsWith("--test-concurrency=")
    );
  });
  if (filtered.length === 0) {
    delete env.NODE_OPTIONS;
  } else {
    env.NODE_OPTIONS = filtered.join(" ");
  }
}

const child = spawn(process.execPath, ["--test", "--test-concurrency=1", ...testArgs], {
  stdio: "inherit",
  env,
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});

child.on("error", (error) => {
  console.error(`Failed to run node test: ${error.message}`);
  process.exit(1);
});
