#!/usr/bin/env node
import { spawn } from "node:child_process";

const testArgs = process.argv.slice(2);

if (testArgs.length === 0) {
  console.error("Usage: node scripts/run-targeted-test.mjs <test-file> [more-test-files...]");
  process.exit(1);
}

const env = { ...process.env };
delete env.NODE_TEST_CONTEXT;

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
