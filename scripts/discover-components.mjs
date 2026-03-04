#!/usr/bin/env node

import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';

import {
  REGISTRY_PATH,
  loadJson,
  slugify,
  toRelative,
  writeJson,
} from './qa-components-lib.mjs';

const COMPONENTS_ROOT = path.resolve(process.cwd(), 'dashboard/src/components');

async function walkTsxFiles(rootDir) {
  const items = await readdir(rootDir, { withFileTypes: true });
  const results = [];
  for (const item of items) {
    const fullPath = path.join(rootDir, item.name);
    if (item.isDirectory()) {
      const nested = await walkTsxFiles(fullPath);
      results.push(...nested);
      continue;
    }
    if (!item.isFile()) continue;
    if (!item.name.endsWith('.tsx')) continue;
    results.push(fullPath);
  }
  return results;
}

function inferOwner(relativePath) {
  const normalized = relativePath.replace(/\\/g, '/');
  const parts = normalized.split('/');
  const componentsIdx = parts.indexOf('components');
  if (componentsIdx >= 0 && parts[componentsIdx + 1]) {
    return parts[componentsIdx + 1];
  }
  return 'shared';
}

function inferName(relativePath) {
  const base = path.basename(relativePath, '.tsx');
  return base
    .replace(/\./g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .trim();
}

function inferComponentId(relativePath) {
  const normalized = relativePath
    .replace(/\\/g, '/')
    .replace(/^dashboard\/src\/components\//, '')
    .replace(/\.tsx$/, '');
  return slugify(normalized.replace(/\//g, '-'));
}

async function main() {
  const registry = await loadJson(REGISTRY_PATH);
  const files = await walkTsxFiles(COMPONENTS_ROOT);

  const existingPathSet = new Set([
    ...registry.components.map((entry) => String(entry.componentPath)),
    ...registry.unmapped.map((entry) => String(entry.componentPath)),
  ]);

  const discovered = [];
  for (const fullPath of files) {
    const relativePath = toRelative(fullPath);
    if (existingPathSet.has(relativePath)) continue;
    discovered.push({
      id: inferComponentId(relativePath),
      name: inferName(relativePath),
      componentPath: relativePath,
      owner: inferOwner(relativePath),
      status: 'unmapped',
    });
  }

  const validFilesSet = new Set(files.map((fullPath) => toRelative(fullPath)));
  const mappedPathSet = new Set(registry.components.map((entry) => String(entry.componentPath)));
  const retainedUnmapped = registry.unmapped.filter(
    (entry) =>
      validFilesSet.has(String(entry.componentPath)) &&
      !mappedPathSet.has(String(entry.componentPath))
  );

  const next = {
    ...registry,
    unmapped: [...retainedUnmapped, ...discovered].sort((a, b) =>
      String(a.componentPath).localeCompare(String(b.componentPath))
    ),
  };

  await writeJson(REGISTRY_PATH, next);

  const mappedCount = registry.components.length;
  const unmappedCount = next.unmapped.length;
  const discoveredCount = discovered.length;
  console.log(
    `[qa:components:discover] mapped=${mappedCount} unmapped=${unmappedCount} discovered=${discoveredCount}`
  );
}

main().catch((error) => {
  console.error(`[qa:components:discover] failed: ${error?.message ?? String(error)}`);
  process.exit(1);
});
