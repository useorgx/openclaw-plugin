#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import process from 'node:process';

import { parseCliArgs } from './qa-components-lib.mjs';

function pushIf(flags, enabled, ...values) {
  if (!enabled) return;
  flags.push(...values);
}

function main() {
  const args = parseCliArgs(process.argv);
  const runId = `critical-${args.runId}`;
  const workers = Math.max(2, args.workers || 4);
  const tags = args.tags.length
    ? args.tags
    : args.tag
      ? [args.tag]
      : ['critical'];

  const flags = [
    './scripts/capture-components.mjs',
    '--all',
    '--run-id',
    runId,
    '--workers',
    String(workers),
    '--tags',
    tags.join(','),
  ];

  pushIf(flags, Boolean(args.baseUrl), '--base-url', args.baseUrl);
  pushIf(flags, Boolean(args.route), '--route', args.route);
  pushIf(flags, Boolean(args.workspaceId), '--workspace-id', args.workspaceId);
  pushIf(flags, Boolean(args.commandCenterId), '--command-center-id', args.commandCenterId);
  pushIf(flags, Boolean(args.center), '--center', args.center);
  pushIf(flags, args.headful, '--headful');
  pushIf(flags, args.desktopOnly, '--desktop-only');
  pushIf(flags, args.dryRun, '--dry-run');
  pushIf(flags, args.verbose, '--verbose');
  pushIf(flags, args.limit > 0, '--limit', String(args.limit));

  const child = spawnSync('node', flags, { stdio: 'inherit' });
  if (child.status && child.status !== 0) process.exit(child.status);
  if (child.error) throw child.error;
}

try {
  main();
} catch (error) {
  console.error(`[qa:live:critical] failed: ${error?.message ?? String(error)}`);
  process.exit(1);
}
