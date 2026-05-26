import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildWorkGraphReport,
  loadHookOutboxRecords,
  main,
  normalizeSourceClient,
  parseArgs,
} from "../../templates/hooks/scripts/orgx-work-graph-reconcile.mjs";

const NOW = "2026-05-07T12:00:00.000Z";

function hookRecord(overrides = {}) {
  return {
    schema_version: "2026-05-07",
    source: "orgx_openclaw_plugin_runtime_hook",
    source_client: "openclaw",
    event: "PostToolUse",
    session_id: "session-1",
    cwd: "/Users/example/Code/orgx",
    timestamp: NOW,
    summary: {
      tool_name: "mcp__orgx__orgx_emit_activity",
      prompt_chars: 42,
      payload_keys: ["tool_name", "cwd"],
    },
    ...overrides,
  };
}

test("work graph reconciler normalizes shared client names", () => {
  assert.equal(normalizeSourceClient("claude_code"), "claude-code");
  assert.equal(normalizeSourceClient("open-claw"), "openclaw");
});

test("work graph reconciler parses split CLI values", () => {
  const args = parseArgs(["--outbox", "/tmp/events.jsonl", "--post"]);
  assert.equal(args.outbox, "/tmp/events.jsonl");
  assert.equal(args.post, "true");
});

test("work graph reconciler reads OpenClaw hook outbox jsonl", async () => {
  const outbox = join(mkdtempSync(join(tmpdir(), "orgx-openclaw-reconcile-")), "events.jsonl");
  writeFileSync(outbox, `${JSON.stringify(hookRecord())}\nnot json\n`, "utf8");

  const loaded = await loadHookOutboxRecords(outbox);
  assert.equal(loaded.records.length, 1);
  assert.equal(loaded.skipped, 1);
  assert.equal(loaded.records[0].source_client, "openclaw");
});

test("work graph reconciler emits summary-only report for OpenClaw hooks", () => {
  const report = buildWorkGraphReport([hookRecord()], {
    generatedAt: NOW,
    workspaceCwd: "/Users/example/Code/orgx",
  });

  assert.match(report.work_graph_fingerprint, /^wgf_[0-9a-f]{24}$/);
  assert.equal(
    report.signup_hydration.hydration_key,
    `orgx:work-graph:${report.work_graph_fingerprint}`
  );
  assert.equal(report.source_client, "wizard");
  assert.equal(report.raw_transcripts_sent, false);
  assert.equal(report.investigation.raw_transcripts_excluded, true);
  assert.equal(report.source_coverage.orgxMcpCalled, true);
  assert.deepEqual(report.missed_orchestration_opportunities, []);
  assert.equal(report.attribution_spine.source_events.length, 1);
});

test("work graph reconciler does not count unrelated MCP tools as OrgX writeback", () => {
  const report = buildWorkGraphReport(
    [
      hookRecord({
        summary: {
          tool_name: "mcp__github__create_issue",
          payload_keys: ["tool_name"],
        },
      }),
    ],
    { generatedAt: NOW, workspaceCwd: "/Users/example/Code/orgx" }
  );

  assert.equal(report.source_coverage.mcpObserved, true);
  assert.equal(report.source_coverage.orgxObserved, true);
  assert.equal(report.source_coverage.orgxMcpCalled, false);
  assert.equal(report.missed_orchestration_opportunities.length, 1);
});

test("work graph reconciler dry-run writes report without credentials", async () => {
  const dir = mkdtempSync(join(tmpdir(), "orgx-openclaw-reconcile-main-"));
  const outbox = join(dir, "events.jsonl");
  const output = join(dir, "report.json");
  writeFileSync(outbox, `${JSON.stringify(hookRecord())}\n`, "utf8");

  const result = await main({
    argv: ["--outbox=" + outbox, "--output=" + output, "--cwd=/repo"],
    env: {},
    now: () => new Date(NOW),
  });

  assert.equal(result.ok, true);
  assert.equal(result.records_read, 1);
  const written = JSON.parse(readFileSync(output, "utf8"));
  assert.equal(written.work_graph_fingerprint, result.work_graph_fingerprint);
  assert.equal(written.report.raw_transcripts_sent, false);
});
