#!/usr/bin/env node

import { existsSync } from 'node:fs';
import { readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { RUNS_ROOT, findRunDirectories, loadJson, parseCliArgs, toRelative } from './qa-components-lib.mjs';

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

async function resolveRunDir(runDirArg) {
  if (runDirArg) return path.resolve(runDirArg);
  const dirs = await findRunDirectories(RUNS_ROOT);
  if (!dirs.length) throw new Error('No QA component runs found. Run qa:components first.');
  return dirs[dirs.length - 1];
}

async function renderRunIndex(runDir, manifest) {
  const cards = manifest.captures
    .map((entry) => {
      const image = entry.imagePath
        ? `<img src="${escapeHtml(path.basename(entry.imagePath))}" alt="${escapeHtml(entry.componentId)}" loading="lazy" />`
        : '<div class="placeholder">No component screenshot</div>';
      const statusClass = entry.status === 'ok' ? 'ok' : 'failed';
      const diffClass = `diff-${escapeHtml(entry.diffStatus || 'unknown')}`;
      const meta = [
        `${escapeHtml(entry.componentId)} · ${escapeHtml(entry.scenario)} · ${escapeHtml(entry.viewport)}`,
        `status: ${escapeHtml(entry.status)} · diff: ${escapeHtml(entry.diffStatus || 'unknown')} · ${Math.round(Number(entry.ms || 0))}ms`,
      ];
      const links = [];
      if (entry.imagePath) {
        links.push(`<a href="${escapeHtml(path.basename(entry.imagePath))}" target="_blank" rel="noreferrer">component</a>`);
      }
      if (entry.contextPath) {
        links.push(`<a href="${escapeHtml(path.basename(entry.contextPath))}" target="_blank" rel="noreferrer">context</a>`);
      }
      if (entry.failurePath) {
        links.push(`<a href="${escapeHtml(path.basename(entry.failurePath))}" target="_blank" rel="noreferrer">failure</a>`);
      }
      if (entry.error) {
        links.push(`<span class="error">${escapeHtml(entry.error)}</span>`);
      }
      return `<article class="card ${statusClass} ${diffClass}">
        <div class="media">${image}</div>
        <div class="meta">
          <div class="line">${meta[0]}</div>
          <div class="line muted">${meta[1]}</div>
          <div class="links">${links.join(' · ')}</div>
        </div>
      </article>`;
    })
    .join('\n');

  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>OrgX Component QA – ${escapeHtml(manifest.runId)}</title>
  <style>
    :root { color-scheme: dark; }
    body { margin: 0; font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial; background: #05070d; color: #e8ecf5; }
    header { padding: 20px; border-bottom: 1px solid rgba(255,255,255,0.08); position: sticky; top: 0; background: rgba(5,7,13,0.94); backdrop-filter: blur(6px); }
    h1 { margin: 0; font-size: 18px; }
    .summary { margin-top: 8px; color: rgba(232,236,245,0.72); font-size: 13px; }
    main { padding: 16px; display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 12px; }
    .card { border: 1px solid rgba(255,255,255,0.08); border-radius: 14px; overflow: hidden; background: rgba(255,255,255,0.03); }
    .card.ok { border-color: rgba(116,208,180,0.34); }
    .card.failed { border-color: rgba(255,120,120,0.4); }
    .media { min-height: 180px; background: rgba(255,255,255,0.02); display: flex; align-items: center; justify-content: center; }
    .media img { max-width: 100%; height: auto; display: block; }
    .placeholder { color: rgba(232,236,245,0.56); font-size: 12px; padding: 20px; text-align: center; }
    .meta { padding: 10px 12px 12px; }
    .line { font-size: 12px; line-height: 1.4; }
    .line.muted { color: rgba(232,236,245,0.68); margin-top: 4px; }
    .links { margin-top: 8px; font-size: 12px; color: rgba(232,236,245,0.72); display: flex; gap: 8px; flex-wrap: wrap; }
    a { color: #9de2ff; text-decoration: none; }
    a:hover { text-decoration: underline; }
    .error { color: #ffb7b7; }
  </style>
</head>
<body>
  <header>
    <h1>OrgX Component QA</h1>
    <div class="summary">
      run ${escapeHtml(manifest.runId)} · captured ${manifest.stats.captured}/${manifest.stats.tasks} · failed ${manifest.stats.failed} · duration ${manifest.stats.durationMs}ms
      <br />
      manifest: ${escapeHtml(toRelative(path.join(runDir, 'manifest.components.json')))}
    </div>
  </header>
  <main>${cards}</main>
</body>
</html>`;

  await writeFile(path.join(runDir, 'index.html'), html, 'utf8');
}

async function renderRootIndex() {
  const dirs = await findRunDirectories(RUNS_ROOT);
  const items = [];
  for (const dir of dirs.slice().reverse()) {
    const manifestPath = path.join(dir, 'manifest.components.json');
    if (!existsSync(manifestPath)) continue;
    const manifest = await loadJson(manifestPath).catch(() => null);
    if (!manifest) continue;
    items.push({
      runDir: dir,
      runId: manifest.runId,
      captured: manifest.stats?.captured ?? 0,
      tasks: manifest.stats?.tasks ?? 0,
      failed: manifest.stats?.failed ?? 0,
      durationMs: manifest.stats?.durationMs ?? 0,
    });
  }

  const rows = items
    .map((item) => {
      const rel = toRelative(item.runDir);
      return `<tr>
        <td><a href="./${escapeHtml(path.relative(RUNS_ROOT, item.runDir))}/index.html">${escapeHtml(item.runId)}</a></td>
        <td>${item.captured}/${item.tasks}</td>
        <td>${item.failed}</td>
        <td>${item.durationMs}ms</td>
        <td class="mono">${escapeHtml(rel)}</td>
      </tr>`;
    })
    .join('\n');

  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>OrgX Component QA Runs</title>
  <style>
    :root { color-scheme: dark; }
    body { margin: 0; font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial; background: #05070d; color: #e8ecf5; }
    header { padding: 20px; border-bottom: 1px solid rgba(255,255,255,0.08); }
    table { width: calc(100% - 40px); margin: 20px; border-collapse: collapse; }
    th, td { border-bottom: 1px solid rgba(255,255,255,0.08); padding: 8px; text-align: left; font-size: 13px; }
    .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; color: rgba(232,236,245,0.74); }
    a { color: #9de2ff; text-decoration: none; }
    a:hover { text-decoration: underline; }
  </style>
</head>
<body>
  <header><h1>OrgX Component QA Runs</h1></header>
  <table>
    <thead>
      <tr><th>Run</th><th>Captured</th><th>Failed</th><th>Duration</th><th>Path</th></tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>
</body>
</html>`;

  await writeFile(path.join(RUNS_ROOT, 'index.html'), html, 'utf8');
}

async function main() {
  const args = parseCliArgs(process.argv);
  const runDirArg = (() => {
    const idx = process.argv.indexOf('--run-dir');
    if (idx < 0) return null;
    return process.argv[idx + 1] ?? null;
  })();

  const runDir = await resolveRunDir(runDirArg);
  const manifest = await loadJson(path.join(runDir, 'manifest.components.json'));
  await renderRunIndex(runDir, manifest);
  await renderRootIndex();
  console.log(`[qa:components:index] generated ${toRelative(path.join(runDir, 'index.html'))}`);
  console.log(`[qa:components:index] generated ${toRelative(path.join(RUNS_ROOT, 'index.html'))}`);
}

main().catch((error) => {
  console.error(`[qa:components:index] failed: ${error?.message ?? String(error)}`);
  process.exit(1);
});

