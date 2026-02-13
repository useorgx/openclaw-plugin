#!/usr/bin/env node

import { resolve } from "node:path";

import { runSeoPipeline } from "./pipeline.mjs";

function parseArgs(argv) {
  const out = {};
  for (const arg of argv.slice(2)) {
    if (!arg.startsWith("--")) continue;
    const [k, ...rest] = arg.slice(2).split("=");
    const v = rest.length > 0 ? rest.join("=") : "true";
    out[k] = v;
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv);
  const configPath = resolve(String(args.config ?? "docs/seo/seo.config.example.json"));
  const mode = String(args.mode ?? "all");
  const outBase = String(args.out ?? "artifacts/seo");
  const dryRun = String(args["dry-run"] ?? args.dryRun ?? "false") === "true";

  const result = await runSeoPipeline({
    configPath,
    mode,
    outBase,
    dryRun,
  });

  console.log(JSON.stringify({ ok: true, ...result }, null, 2));
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(JSON.stringify({ ok: false, error: message }, null, 2));
  process.exit(1);
});

