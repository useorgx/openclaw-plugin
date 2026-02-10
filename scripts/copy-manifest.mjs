import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const rootDir = resolve(__dirname, '..');
const source = resolve(rootDir, 'openclaw.plugin.json');
const distDir = resolve(rootDir, 'dist');
const target = resolve(distDir, 'openclaw.plugin.json');

if (!existsSync(source)) {
  console.error('Missing openclaw.plugin.json in project root.');
  process.exit(1);
}

if (!existsSync(distDir)) {
  mkdirSync(distDir, { recursive: true });
}

// Copy MCP Apps single-file widgets (served via tool results + ui:// resource URIs).
// These must live under dist/ so they're included in the published package.
const mcpAppsSource = resolve(rootDir, 'templates', 'mcp-apps', 'orgx-live.html');
const mcpAppsDir = resolve(distDir, 'mcp-apps');
const mcpAppsTarget = resolve(mcpAppsDir, 'orgx-live.html');

if (existsSync(mcpAppsSource)) {
  if (!existsSync(mcpAppsDir)) {
    mkdirSync(mcpAppsDir, { recursive: true });
  }
  writeFileSync(mcpAppsTarget, readFileSync(mcpAppsSource, 'utf8'), 'utf8');
}

const raw = readFileSync(source, 'utf8');
const manifest = JSON.parse(raw);

// The dist manifest should point to files relative to dist/ (not dist/dist).
manifest.entry = './index.js';

// Skills live at package root (../skills relative to dist/).
if (Array.isArray(manifest.skills)) {
  manifest.skills = manifest.skills.map((s) => `../${s}`);
}

writeFileSync(target, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
