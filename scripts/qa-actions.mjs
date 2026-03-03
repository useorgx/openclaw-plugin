import { applyWorkspaceScope } from './qa-components-lib.mjs';

async function waitForAny(page, locators, timeoutMs = 15000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    for (const locatorFactory of locators) {
      try {
        const locator = locatorFactory(page);
        if (await locator.first().isVisible()) return true;
      } catch {
        // Keep probing until timeout.
      }
    }
    await page.waitForTimeout(200);
  }
  return false;
}

async function clickIfVisible(locator, timeout = 2500) {
  if (!(await locator.count())) return false;
  try {
    await locator.first().click({ timeout });
    return true;
  } catch {
    return false;
  }
}

async function setActivityTimeRangeAll(page) {
  const triggerCandidates = [
    page.locator('[aria-label="Activity time range"]').first(),
    page.getByRole('button', { name: /Last hour|Today|This week|All/i }).first(),
  ];
  for (const trigger of triggerCandidates) {
    if (!(await clickIfVisible(trigger, 2000))) continue;
    const allOptionCandidates = [
      page.getByRole('button', { name: /^All$/i }).first(),
      page.locator('button').filter({ hasText: /^All$/i }).first(),
    ];
    for (const option of allOptionCandidates) {
      if (await clickIfVisible(option, 2000)) return;
    }
    await page.keyboard.press('Escape').catch(() => {});
  }
}

export async function disableAnimations(page) {
  await page.addStyleTag({
    content: `
      *, *::before, *::after {
        animation: none !important;
        transition: none !important;
        scroll-behavior: auto !important;
      }
    `,
  });
}

export async function dismissFirstRunChecklist(page) {
  const started = Date.now();
  while (Date.now() - started < 5000) {
    const candidates = [
      page.getByRole('button', { name: /Not now/i }),
      page.getByRole('button', { name: /Don't show again/i }),
      page.getByRole('button', { name: /Dismiss/i }),
      page.getByRole('button', { name: /Close checklist/i }),
    ];
    let clicked = false;
    for (const candidate of candidates) {
      if (await clickIfVisible(candidate)) {
        clicked = true;
      }
    }
    if (!clicked) break;
    await page.waitForTimeout(150);
  }
  await page.keyboard.press('Escape').catch(() => {});
}

export function buildScopedLiveUrl({
  baseUrl,
  route,
  workspaceId,
  commandCenterId,
  center,
}) {
  const routePath = String(route || '/orgx/live').startsWith('/')
    ? String(route || '/orgx/live')
    : `/${String(route || 'orgx/live')}`;
  const base = `${String(baseUrl).replace(/\/+$/, '')}${routePath}`;
  return applyWorkspaceScope(base, { workspaceId, commandCenterId, center });
}

export async function openActivityDefault(page, context) {
  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const url = buildScopedLiveUrl(context);
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await dismissFirstRunChecklist(page);
      await waitForAny(
        page,
        [
          (p) => p.getByRole('button', { name: /^Activity$/i }),
          (p) => p.locator('[aria-label="Search activity"]'),
        ],
        30000
      );
      await clickIfVisible(page.getByRole('button', { name: /^Activity$/i }), 4000);
      await waitForAny(
        page,
        [
          (p) => p.locator('[aria-label="Search activity"]'),
          (p) => p.locator('[aria-label="Activity status filters"]'),
        ],
        20000
      );
      await setActivityTimeRangeAll(page);
      await disableAnimations(page);
      return;
    } catch (error) {
      lastError = error;
      await page.waitForTimeout(400);
    }
  }
  throw lastError ?? new Error('Unable to open Activity view');
}

async function openFirstActivityCard(page) {
  const card = page.locator('button[aria-label^="Open activity details for"]').first();
  await card.waitFor({ state: 'visible', timeout: 12000 });
  await card.click({ timeout: 5000 });
}

export async function openMissionControlDefault(page, context) {
  await openActivityDefault(page, context);
  await clickIfVisible(page.getByRole('button', { name: /^Mission Control$/i }));
  await waitForAny(page, [
    (p) => p.locator('[aria-label="Next Up scope"]'),
    (p) => p.locator('text=Current context'),
    (p) => p.locator('text=Active'),
  ]);
  await disableAnimations(page);
}

export async function openMissionControlQueue(page, context) {
  await openMissionControlDefault(page, context);
  const queueTriggers = [
    page.getByRole('button', { name: /^Open Queue$/i }),
    page.getByRole('button', { name: /^Open queue$/i }),
    page.getByLabel(/next up scope/i),
  ];
  for (const trigger of queueTriggers) {
    if (await clickIfVisible(trigger, 5000)) break;
  }
  await waitForAny(page, [
    (p) => p.locator('[aria-label="Next Up scope"]'),
    (p) => p.locator('[aria-label="Select queue row"]'),
    (p) => p.locator('text=Next Up'),
  ]);
}

export async function openMissionControlHierarchy(page, context) {
  await openMissionControlDefault(page, context);
  const activeSectionToggle = page
    .locator('button')
    .filter({ hasText: /^Active\s+\d+/i });
  await clickIfVisible(activeSectionToggle);
  await page.waitForTimeout(300);
}

export async function openSettingsModal(page, context) {
  await openActivityDefault(page, context);
  await dismissFirstRunChecklist(page);
  const settingsCandidates = [
    page.getByLabel(/settings/i),
    page.getByRole('button', { name: /settings/i }),
    page.locator('button[title="Settings"]'),
    page.locator('button[title*="Setting" i]'),
    page.locator('[aria-label*="settings" i]'),
  ];
  let opened = false;
  for (const candidate of settingsCandidates) {
    if (!(await candidate.count().catch(() => 0))) continue;
    try {
      await candidate.first().click({ timeout: 3000, force: true });
      opened = true;
    } catch {
      opened = false;
    }
    if (opened) break;
  }
  if (!opened) {
    const fallbackSettingsButtons = [
      page.getByRole('button', { name: /^Settings$/i }),
      page.getByRole('button', { name: /^Open settings$/i }),
      page.getByText(/^Settings$/i).first(),
    ];
    for (const candidate of fallbackSettingsButtons) {
      if (await clickIfVisible(candidate, 2000)) {
        opened = true;
        break;
      }
    }
  }
  if (!opened) throw new Error('Unable to open Settings modal');
  await waitForAny(page, [
    (p) => p.locator('[aria-label="Settings tabs"]'),
    (p) => p.getByText(/^Settings$/i),
    (p) => p.locator('text=OrgX connection'),
  ]);
}

export async function openActivityChatDock(page, context) {
  await openActivityDefault(page, context);
  await clickIfVisible(page.locator('[aria-label="Open chat"]'));
  await waitForAny(page, [
    (p) => p.locator('[data-testid="chat-dock"]'),
    (p) => p.locator('[data-testid="thread-drawer"]'),
    (p) => p.locator('[data-testid="thread-sidebar"]'),
    (p) => p.locator('[aria-label="Add files and more"]'),
  ]);
}

export async function openActivityChatThreads(page, context) {
  await openActivityChatDock(page, context);
  const threadButton = page
    .locator('button[aria-label*="thread" i], button[aria-label*="threads" i]')
    .first();
  await clickIfVisible(threadButton);
  await waitForAny(page, [
    (p) => p.locator('[data-testid="thread-drawer"]'),
    (p) => p.locator('[data-testid="thread-sidebar"]'),
  ]);
}

export async function openActivityFiltersMenu(page, context) {
  await openActivityDefault(page, context);
  const trigger = page.locator('[aria-label="Activity filters"]').first();
  await trigger.waitFor({ state: 'visible', timeout: 10000 });
  await trigger.click({ timeout: 5000 });
  await page.locator('[aria-label="Activity view controls"]').first().waitFor({ state: 'visible', timeout: 8000 });
}

export async function openActivityTimeRangeMenu(page, context) {
  await openActivityDefault(page, context);
  const triggerCandidates = [
    page.locator('[aria-label="Activity time range"]').first(),
    page.getByRole('button', { name: /Last hour|Today|This week|All/i }).first(),
  ];
  let opened = false;
  for (const candidate of triggerCandidates) {
    if (await clickIfVisible(candidate, 5000)) {
      opened = true;
      break;
    }
  }
  if (!opened) throw new Error('Unable to open activity time-range menu');
  await page.locator('[aria-label="Activity time range"]').first().waitFor({ state: 'visible', timeout: 5000 });
}

export async function openActivityDetailModal(page, context) {
  await openActivityDefault(page, context);
  await openFirstActivityCard(page);
  await page.locator('[aria-label="Close activity detail"]').first().waitFor({ state: 'visible', timeout: 10000 });
}

export async function openActivityDetailMoreMenu(page, context) {
  await openActivityDetailModal(page, context);
  const more = page.locator('[aria-label="More actions"]').first();
  await more.waitFor({ state: 'visible', timeout: 8000 });
  await more.click({ timeout: 5000 });
}

export async function openNeedsAttentionDetail(page, context) {
  await openActivityDefault(page, context);
  const chip = page.getByRole('button', { name: /Needs attention/i }).first();
  if (await chip.isVisible().catch(() => false)) {
    await chip.click({ timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(500);
  }
  await openFirstActivityCard(page);
  await page.locator('[aria-label="Close activity detail"]').first().waitFor({ state: 'visible', timeout: 10000 });
}

export const ACTIONS = {
  openActivityDefault,
  openMissionControlDefault,
  openMissionControlQueue,
  openMissionControlHierarchy,
  openSettingsModal,
  openActivityChatDock,
  openActivityChatThreads,
  openActivityFiltersMenu,
  openActivityTimeRangeMenu,
  openActivityDetailModal,
  openActivityDetailMoreMenu,
  openNeedsAttentionDetail,
};
