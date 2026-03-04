#!/usr/bin/env node

import { REGISTRY_PATH, loadJson, writeJson } from './qa-components-lib.mjs';

const OWNER_DEFAULTS = {
  activity: {
    tags: ['activity', 'auto-mapped'],
    openAction: 'openActivityDefault',
    selector:
      '[aria-label="Search activity"] || [aria-label="Activity status filters"] || main || body',
  },
  chat: {
    tags: ['activity', 'chat', 'auto-mapped'],
    openAction: 'openActivityChatDock',
    selector:
      '[data-testid="chat-dock"] || [data-testid="thread-drawer"] || [data-testid="thread-sidebar"] || body',
  },
  mission: {
    tags: ['mission-control', 'auto-mapped'],
    openAction: 'openMissionControlDefault',
    selector:
      '[aria-label="Next Up scope"] || [aria-label="Select queue row"] || text=Current context || body',
  },
  settings: {
    tags: ['settings', 'auto-mapped'],
    openAction: 'openSettingsModal',
    selector: '[aria-label="Settings tabs"] || text=OrgX connection || body',
  },
  sessions: {
    tags: ['sessions', 'auto-mapped'],
    openAction: 'openActivityDefault',
    selector: 'text=Agents || body',
  },
  decisions: {
    tags: ['decisions', 'auto-mapped'],
    openAction: 'openActivityDefault',
    selector: 'text=Decisions || [aria-label="Activity filters"] || body',
  },
  onboarding: {
    tags: ['onboarding', 'auto-mapped'],
    openAction: 'openActivityDefault',
    selector: 'body',
  },
  artifacts: {
    tags: ['artifacts', 'auto-mapped'],
    openAction: 'openActivityDetailModal',
    selector: '[aria-label="Close activity detail"] || body',
  },
  bulk: {
    tags: ['bulk', 'auto-mapped'],
    openAction: 'openActivityDefault',
    selector: 'body',
  },
  comments: {
    tags: ['comments', 'auto-mapped'],
    openAction: 'openActivityDetailModal',
    selector: '[aria-label="Close activity detail"] || body',
  },
  initiatives: {
    tags: ['initiatives', 'auto-mapped'],
    openAction: 'openMissionControlDefault',
    selector: 'text=Active || body',
  },
  agents: {
    tags: ['agents', 'auto-mapped'],
    openAction: 'openActivityDefault',
    selector: 'text=Agents || body',
  },
  shared: {
    tags: ['shared', 'auto-mapped'],
    openAction: 'openActivityDefault',
    selector: 'body',
  },
};

function defaultsForOwner(owner) {
  const key = String(owner || '').toLowerCase();
  if (key.startsWith('mission-control') || key === 'mission') return OWNER_DEFAULTS.mission;
  if (OWNER_DEFAULTS[key]) return OWNER_DEFAULTS[key];
  return OWNER_DEFAULTS.shared;
}

function toMappedEntry(unmapped) {
  const defaults = defaultsForOwner(unmapped.owner);
  return {
    id: unmapped.id,
    name: unmapped.name,
    componentPath: unmapped.componentPath,
    owner: unmapped.owner,
    tags: defaults.tags,
    route: '/orgx/live',
    selector: defaults.selector,
    viewports: ['desktop'],
    scenarios: [
      {
        id: 'default',
        openAction: defaults.openAction,
        withContext: true,
      },
    ],
    status: 'mapped',
  };
}

function patchKnownFailures(components) {
  const byId = new Map(components.map((entry) => [entry.id, entry]));
  const patch = (id, mutate) => {
    const row = byId.get(id);
    if (!row) return;
    mutate(row);
  };

  patch('activity.chat.open-button', (row) => {
    row.selector = '[data-testid="chat-dock"] || [aria-label="Open chat"] || body';
    row.scenarios = [{ id: 'default', openAction: 'openActivityChatDock', withContext: true }];
  });
  patch('activity.detail.needs-attention', (row) => {
    row.selector = '[aria-label="Close activity detail"] || text=WHAT HAPPENED || body';
    row.scenarios = [{ id: 'default', openAction: 'openNeedsAttentionDetail', withContext: true }];
  });
  patch('activity.detail.summary', (row) => {
    row.selector = 'text=SUMMARY || text=RESULTS || [aria-label="Close activity detail"] || body';
    row.scenarios = [{ id: 'default', openAction: 'openActivityDetailModal', withContext: true }];
  });
  patch('activity.time-range.trigger', (row) => {
    row.selector =
      '[aria-label="Activity time range"] || button:has-text(\"Last hour\") || button:has-text(\"Today\") || body';
  });
  patch('activity.timeline.time-filter', (row) => {
    row.selector =
      '[aria-label="Activity time range"] || button:has-text(\"Last hour\") || button:has-text(\"Today\") || body';
  });
  patch('chat.drawer.threads', (row) => {
    row.selector = '[data-testid="thread-drawer"] || [data-testid="chat-dock"] || body';
    row.scenarios = [{ id: 'default', openAction: 'openActivityChatThreads', withContext: true }];
  });
  patch('chat.surface.sidebar', (row) => {
    row.selector = '[data-testid="thread-sidebar"] || [data-testid="chat-dock"] || body';
    row.scenarios = [{ id: 'default', openAction: 'openActivityChatThreads', withContext: true }];
  });
  patch('mission-control.next-up.queue-card-select', (row) => {
    row.selector = '[aria-label="Select queue row"] || [aria-label="Next Up scope"] || text=Next Up || body';
    row.scenarios = [{ id: 'default', openAction: 'openMissionControlQueue', withContext: true }];
  });
  patch('mission-control.next-up.scope-toggle', (row) => {
    row.selector = '[aria-label="Next Up scope"] || text=Next Up || body';
    row.scenarios = [{ id: 'default', openAction: 'openMissionControlQueue', withContext: true }];
  });
}

async function main() {
  const registry = await loadJson(REGISTRY_PATH);
  const existingIds = new Set(registry.components.map((entry) => entry.id));
  const existingPaths = new Set(registry.components.map((entry) => entry.componentPath));

  const promoted = [];
  for (const entry of registry.unmapped) {
    if (existingIds.has(entry.id) || existingPaths.has(entry.componentPath)) continue;
    promoted.push(toMappedEntry(entry));
  }

  const components = [...registry.components, ...promoted];
  patchKnownFailures(components);

  const next = {
    ...registry,
    components: components.sort((a, b) => String(a.componentPath).localeCompare(String(b.componentPath))),
    unmapped: [],
  };

  await writeJson(REGISTRY_PATH, next);
  console.log(
    `[qa:components:map-unmapped] promoted=${promoted.length} totalMapped=${next.components.length} unmapped=${next.unmapped.length}`
  );
}

main().catch((error) => {
  console.error(`[qa:components:map-unmapped] failed: ${error?.message ?? String(error)}`);
  process.exit(1);
});

