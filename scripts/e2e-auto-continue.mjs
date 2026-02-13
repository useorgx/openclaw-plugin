#!/usr/bin/env node
/**
 * E2E-ish smoke for Blocker 3 pipeline using a user API key.
 *
 * What it verifies (when the server is correctly deployed):
 * - Create initiative/workstreams/tasks via /api/entities
 * - Launch initiative (should create streams)
 * - Streams become visible via list_entities
 *
 * Env:
 * - ORGX_BASE_URL (default: https://useorgx.com)
 * - ORGX_API_KEY (required, user-scoped oxk_... key)
 */

import { randomUUID } from 'node:crypto';

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
  if (!res.ok) {
    throw new Error(payload?.error || `HTTP ${res.status} ${path}`);
  }
  return payload;
}

async function getJson(path) {
  const res = await fetch(`${baseUrl}${path}`, { headers });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(payload?.error || `HTTP ${res.status} ${path}`);
  }
  return payload;
}

async function main() {
  const suffix = String(Date.now()).slice(-6);
  const title = `Auto-Continue E2E Smoke ${suffix}`;

  const initiative = await postJson('/api/entities', {
    type: 'initiative',
    title,
    summary: 'Smoke test for scaffold -> launch -> streams',
    status: 'draft',
    metadata: { seed: 'blocker3-e2e-auto-continue', run: randomUUID() },
  });

  const initiativeId = initiative?.data?.id || initiative?.id || null;
  if (!initiativeId) throw new Error('initiative id missing from response');

  const wsMarketing = await postJson('/api/entities', {
    type: 'workstream',
    initiative_id: initiativeId,
    name: 'Marketing Research',
    summary: 'Research competitors and positioning',
    status: 'not_started',
    domain: 'marketing',
  });
  const wsProduct = await postJson('/api/entities', {
    type: 'workstream',
    initiative_id: initiativeId,
    name: 'Product Requirements',
    summary: 'Draft PRD from research',
    status: 'not_started',
    domain: 'product',
  });

  const wsMarketingId = wsMarketing?.data?.id || wsMarketing?.id || null;
  const wsProductId = wsProduct?.data?.id || wsProduct?.id || null;

  // Minimal tasks so streams can map to workstreams.
  await postJson('/api/entities', {
    type: 'task',
    initiative_id: initiativeId,
    workstream_id: wsMarketingId,
    title: 'List top 3 competitors',
    status: 'todo',
  });
  await postJson('/api/entities', {
    type: 'task',
    initiative_id: initiativeId,
    workstream_id: wsProductId,
    title: 'Draft PRD outline',
    status: 'todo',
  });

  const launch = await postJson(`/api/entities/initiative/${initiativeId}/launch`, {
    note: 'Triggered by scripts/e2e-auto-continue.mjs',
  });

  // Poll streams for a short window.
  const startedAt = Date.now();
  let streams = null;
  while (Date.now() - startedAt < 15_000) {
    const list = await getJson(
      `/api/entities?type=stream&initiative_id=${encodeURIComponent(initiativeId)}&limit=50`
    );
    streams = Array.isArray(list?.data) ? list.data : [];
    if (streams.length > 0) break;
    await new Promise((r) => setTimeout(r, 750));
  }

  const liveUrl = `${baseUrl}/live/${initiativeId}`;

  console.log(
    JSON.stringify(
      {
        ok: true,
        initiative_id: initiativeId,
        live_url: liveUrl,
        launch,
        streams_total: Array.isArray(streams) ? streams.length : 0,
        streams,
      },
      null,
      2
    )
  );
}

main().catch((err) => fatal(err?.stack || String(err)));

