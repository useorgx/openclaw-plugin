import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  escapeShellSingleQuotedArg,
  hasParentTraversalSegment,
  resolveSafeLogPath,
} from "../../dist/http/routes/live-terminal.js";

test("escapeShellSingleQuotedArg wraps values in single quotes", () => {
  assert.equal(escapeShellSingleQuotedArg("/tmp/log.txt"), "'/tmp/log.txt'");
});

test("escapeShellSingleQuotedArg escapes inner single quotes", () => {
  assert.equal(
    escapeShellSingleQuotedArg("/tmp/it's.log"),
    "'/tmp/it'\\''s.log'"
  );
});

test("escapeShellSingleQuotedArg keeps command substitution syntax literal", () => {
  assert.equal(
    escapeShellSingleQuotedArg("/tmp/$(touch pwn).log"),
    "'/tmp/$(touch pwn).log'"
  );
});

test("hasParentTraversalSegment only flags parent-directory segments", () => {
  assert.equal(hasParentTraversalSegment("../logs/run.log"), true);
  assert.equal(hasParentTraversalSegment("safe/../run.log"), true);
  assert.equal(hasParentTraversalSegment("safe\\..\\run.log"), true);
  assert.equal(hasParentTraversalSegment("run..safe.log"), false);
});

test("resolveSafeLogPath allows filenames containing '..' within logs dir", () => {
  const configDir = mkdtempSync(join(tmpdir(), "orgx-live-terminal-safe-"));
  const logsDir = join(configDir, "autopilot-logs");
  mkdirSync(logsDir, { recursive: true });
  const benign = join(logsDir, "run..safe.log");
  writeFileSync(benign, "ok\n", "utf8");

  assert.equal(resolveSafeLogPath(logsDir, "run..safe.log"), benign);
  assert.equal(resolveSafeLogPath(logsDir, "../escape.log"), null);
});
