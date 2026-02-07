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

const raw = readFileSync(source, 'utf8');
const manifest = JSON.parse(raw);

// The dist manifest should point to files relative to dist/ (not dist/dist).
manifest.entry = './index.js';

writeFileSync(target, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
