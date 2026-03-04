import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

export const DEFAULT_BASE_URL = 'http://127.0.0.1:18789';
export const DEFAULT_ROUTE = '/orgx/live';

export const DESKTOP_VIEWPORT = { id: 'desktop', width: 1440, height: 900 };
export const MOBILE_VIEWPORT = { id: 'mobile', width: 390, height: 844 };

export const VIEWPORTS = {
  desktop: DESKTOP_VIEWPORT,
  mobile: MOBILE_VIEWPORT,
};

export const REGISTRY_PATH = path.resolve(process.cwd(), 'docs/qa/component-registry.json');
export const SCHEMA_PATH = path.resolve(process.cwd(), 'docs/qa/component-registry.schema.json');
export const RUNS_ROOT = path.resolve(process.cwd(), 'docs/qa/components/runs');

export function parseCliArgs(argv) {
  const args = argv.slice(2);
  const has = (flag) => args.includes(flag);
  const get = (flag) => {
    const idx = args.indexOf(flag);
    if (idx < 0) return null;
    return args[idx + 1] ?? null;
  };
  return {
    all: has('--all'),
    changed: has('--changed'),
    dryRun: has('--dry-run'),
    verbose: has('--verbose'),
    headful: has('--headful'),
    desktopOnly: has('--desktop-only'),
    skipIndex: has('--skip-index'),
    baseUrl: (get('--base-url') ?? process.env.ORGX_LIVE_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/+$/, ''),
    route: get('--route') ?? DEFAULT_ROUTE,
    workspaceId: get('--workspace-id') ?? process.env.ORGX_LIVE_WORKSPACE_ID ?? '',
    commandCenterId: get('--command-center-id') ?? process.env.ORGX_LIVE_COMMAND_CENTER_ID ?? '',
    center: get('--center') ?? process.env.ORGX_LIVE_CENTER ?? '',
    tag: get('--tag') ?? '',
    tags: String(get('--tags') ?? '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean),
    runId: get('--run-id') ?? new Date().toISOString().replace(/[:.]/g, '-'),
    limit: Number(get('--limit') ?? 0) || 0,
    workers: Math.max(1, Number(get('--workers') ?? 4) || 4),
    outputDir: get('--output-dir') ? path.resolve(process.cwd(), String(get('--output-dir'))) : null,
  };
}

export function resolveChromeExecutable() {
  if (process.env.PLAYWRIGHT_CHROME_PATH) return process.env.PLAYWRIGHT_CHROME_PATH;
  if (process.platform === 'darwin') {
    const macPath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    if (existsSync(macPath)) return macPath;
  }
  return null;
}

export async function ensureDir(dir) {
  await mkdir(dir, { recursive: true });
  return dir;
}

export async function loadJson(filePath) {
  const raw = await readFile(filePath, 'utf8');
  return JSON.parse(raw);
}

export async function writeJson(filePath, value) {
  const payload = `${JSON.stringify(value, null, 2)}\n`;
  await ensureDir(path.dirname(filePath));
  await writeFile(filePath, payload, 'utf8');
}

export function slugify(input) {
  return String(input)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function toRelative(filePath) {
  return path.relative(process.cwd(), filePath).replace(/\\/g, '/');
}

export function applyWorkspaceScope(urlString, { workspaceId, commandCenterId, center }) {
  const scoped = new URL(urlString);
  const ws = String(workspaceId || '').trim();
  const cc = String(commandCenterId || '').trim() || ws;
  const ctr = String(center || '').trim() || ws;
  if (ws) scoped.searchParams.set('workspace_id', ws);
  if (cc) scoped.searchParams.set('command_center_id', cc);
  if (ctr) scoped.searchParams.set('center', ctr);
  return scoped.toString();
}

export async function hashFileSha1(filePath) {
  const raw = await readFile(filePath);
  const hash = createHash('sha1');
  hash.update(raw);
  return hash.digest('hex');
}

export async function findRunDirectories(rootDir) {
  if (!existsSync(rootDir)) return [];
  const names = await readdir(rootDir);
  const dirs = [];
  for (const name of names) {
    const fullPath = path.join(rootDir, name);
    const row = await stat(fullPath).catch(() => null);
    if (row?.isDirectory()) dirs.push(fullPath);
  }
  dirs.sort();
  return dirs;
}

export async function findLatestManifest(rootDir, currentRunDir) {
  const dirs = await findRunDirectories(rootDir);
  const eligible = dirs.filter((dir) => path.resolve(dir) !== path.resolve(currentRunDir));
  eligible.reverse();
  for (const dir of eligible) {
    const manifestPath = path.join(dir, 'manifest.components.json');
    if (!existsSync(manifestPath)) continue;
    try {
      const manifest = await loadJson(manifestPath);
      if (manifest?.stats?.failed === 0) {
        return { manifestPath, manifest };
      }
    } catch {
      // Skip malformed manifests and continue searching for valid baseline.
    }
  }
  return null;
}

export function matchesTags(entry, tags) {
  if (!tags.length) return true;
  const entryTags = Array.isArray(entry?.tags) ? entry.tags.map((tag) => String(tag).toLowerCase()) : [];
  return tags.every((tag) => entryTags.includes(String(tag).toLowerCase()));
}

export async function gitChangedPaths() {
  const { execSync } = await import('node:child_process');
  const candidates = [
    'origin/main...HEAD',
    'HEAD~1..HEAD',
  ];
  for (const range of candidates) {
    try {
      const raw = execSync(`git diff --name-only ${range}`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      const rows = raw
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);
      if (rows.length) return rows;
    } catch {
      // Try next candidate range.
    }
  }
  return [];
}
