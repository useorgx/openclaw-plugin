#!/usr/bin/env node
/**
 * Record a short demo video of OrgX live view after scaffolding + launch.
 *
 * Produces a Playwright-recorded video under ./artifacts/recordings.
 *
 * Env:
 * - ORGX_BASE_URL (default: https://useorgx.com)
 * - ORGX_API_KEY (required, user-scoped oxk_... key)
 */

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { chromium } from 'playwright-core';

const baseUrl = (process.env.ORGX_BASE_URL || 'https://useorgx.com').replace(/\/$/, '');
const apiKey = process.env.ORGX_API_KEY || '';

function fatal(msg) {
  console.error(msg);
  process.exit(1);
}

if (!apiKey.startsWith('oxk_')) {
  fatal('Missing/invalid ORGX_API_KEY (expected user-scoped oxk_... key)');
}

const headers = {
  Authorization: `Bearer ${apiKey}`,
  'Content-Type': 'application/json',
  Accept: 'application/json',
};

async function postJson(path, body) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(payload?.error || `HTTP ${res.status} ${path}`);
  return payload;
}

async function main() {
  const suffix = String(Date.now()).slice(-6);
  const title = `Demo Flow ${suffix}`;

  const initiative = await postJson('/api/entities', {
    type: 'initiative',
    title,
    summary: 'Recorded demo: scaffold -> launch -> live',
    status: 'draft',
    metadata: { seed: 'blocker3-demo-recording', run: randomUUID() },
  });

  const initiativeId = initiative?.data?.id || initiative?.id || null;
  if (!initiativeId) throw new Error('initiative id missing from response');

  const ws = await postJson('/api/entities', {
    type: 'workstream',
    initiative_id: initiativeId,
    name: 'Marketing Research',
    summary: 'Research competitors and positioning',
    status: 'not_started',
    domain: 'marketing',
  });
  const wsId = ws?.data?.id || ws?.id || null;

  await postJson('/api/entities', {
    type: 'task',
    initiative_id: initiativeId,
    workstream_id: wsId,
    title: 'Summarize positioning',
    status: 'todo',
  });

  await postJson(`/api/entities/initiative/${initiativeId}/launch`, {
    note: 'Triggered by scripts/record-demo.mjs',
  });

  const recordingDir = join(process.cwd(), 'artifacts', 'recordings');
  mkdirSync(recordingDir, { recursive: true });

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    recordVideo: { dir: recordingDir, size: { width: 1280, height: 720 } },
  });
  const page = await context.newPage();

  const liveUrl = `${baseUrl}/live/${initiativeId}?view=mission-control`;
  await page.goto(liveUrl, { waitUntil: 'domcontentloaded' });

  // Let the UI settle; in a working auto-continue pipeline, stream status/progress will update.
  await page.waitForTimeout(8000);

  await context.close(); // finalize video file
  await browser.close();

  console.log(
    JSON.stringify(
      {
        ok: true,
        live_url: liveUrl,
        recording_dir: recordingDir,
        note: 'Playwright writes a .webm file per page under recording_dir.',
      },
      null,
      2
    )
  );
}

main().catch((err) => fatal(err?.stack || String(err)));

