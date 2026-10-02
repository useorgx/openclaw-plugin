#!/usr/bin/env node
/**
 * Vendor the built @useorgx/orgx-ui-kit into dashboard/vendor/orgx-ui-kit/ and
 * copy the agent avatar renders into dashboard/public/avatars/.
 *
 * The kit (github.com/useorgx/orgx-ui-kit) is not published to a registry the
 * dashboard installs from, so the dashboard consumes a vendored copy of the
 * parts of the kit's `dist/` it uses, through path aliases in
 * dashboard/tsconfig.json and dashboard/vite.config.ts
 * (`@useorgx/orgx-ui-kit/react`, `/elements`, `/tokens.css`). This mirrors how
 * the OrgX app vendors the kit (orgx/scripts/sync-orgx-ui-kit.mjs). Edit the
 * kit, rebuild it, and run this script; never edit the vendored files by hand.
 *
 * What it writes:
 *   dashboard/vendor/orgx-ui-kit/
 *     elements/*.js + *.d.ts   framework-free custom elements (ESM)
 *     react/index.js + .d.ts   thin React wrappers over the elements
 *     tokens.css               --ox-* and --agent-* variables (light + dark)
 *     tokens.js + tokens.d.ts  the token object (dashboard/src/lib/tokens.ts reads it)
 *     tailwind-preset.cjs      colors/radii/motion resolving to the variables
 *     VERSION.json             kit name, version and the commit it was built from,
 *                              plus where the avatars came from
 *   dashboard/public/avatars/<agent>-<form>-<size>.webp
 *     the forms the dashboard maps run state to (base, working, asking,
 *     verifying, proactive) at 48/96/192. The dashboard is served locally under
 *     a CSP of img-src 'self', so the renders ship with it instead of loading
 *     from mcp.useorgx.com.
 *
 * Source maps are skipped and their trailing sourceMappingURL comments removed.
 *
 * Kit location: $ORGX_UI_KIT_DIR, else ../orgx-ui-kit (a sibling checkout).
 * Avatar location: $ORGX_AVATARS_DIR, else
 *   ../orgx-mcp/public/widgets/shared/avatars (a sibling checkout).
 *
 * Usage:
 *   node scripts/sync-ui-kit.mjs           # write the vendored copy
 *   node scripts/sync-ui-kit.mjs --check   # exit 1 if it is out of date
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VENDOR_DIR = path.join(ROOT, 'dashboard', 'vendor', 'orgx-ui-kit');
const AVATAR_DIR = path.join(ROOT, 'dashboard', 'public', 'avatars');
const PACKAGE_NAME = '@useorgx/orgx-ui-kit';

/** dist entries the dashboard uses (files, or directories copied whole). */
const KIT_ENTRIES = ['elements', 'react', 'tokens.css', 'tokens.js', 'tokens.d.ts', 'tailwind-preset.cjs'];

/** Forms dashboard/src/lib/agentIdentity.ts can return; keep in sync. */
const AVATAR_FORMS = ['base', 'working', 'asking', 'verifying', 'proactive'];
const AVATAR_SIZES = [48, 96, 192];

function fail(message) {
  console.error(`sync-ui-kit: ${message}`);
  process.exit(1);
}

function git(cwd, args) {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

function resolveDir(envName, fallback, marker) {
  const dir = process.env[envName] ? path.resolve(process.env[envName]) : path.resolve(ROOT, fallback);
  if (!fs.existsSync(path.join(dir, marker))) {
    fail(`${dir} has no ${marker}. Set ${envName} to the right checkout.`);
  }
  return dir;
}

function listFiles(dir, base = dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) return listFiles(abs, base);
    return [path.relative(base, abs)];
  });
}

function stripSourceMapComment(text) {
  return text.replace(/\n?\/\/# sourceMappingURL=\S+\s*$/, '\n');
}

/** Build both trees in memory: relative path -> Buffer. */
function buildTrees(kitDir, avatarsDir) {
  const pkg = JSON.parse(fs.readFileSync(path.join(kitDir, 'package.json'), 'utf8'));
  if (pkg.name !== PACKAGE_NAME) fail(`${kitDir} is ${pkg.name}, not ${PACKAGE_NAME}.`);
  const distDir = path.join(kitDir, 'dist');
  if (!fs.existsSync(path.join(distDir, 'tokens.css'))) {
    fail(`${distDir} is missing or unbuilt. Run \`npm ci && npm run build\` in the kit first.`);
  }

  const kit = new Map();
  for (const entry of KIT_ENTRIES) {
    const abs = path.join(distDir, entry);
    if (!fs.existsSync(abs)) fail(`${abs} is missing.`);
    const files = fs.statSync(abs).isDirectory()
      ? listFiles(abs).map((rel) => path.join(entry, rel))
      : [entry];
    for (const rel of files.filter((f) => !f.endsWith('.map')).sort()) {
      const raw = fs.readFileSync(path.join(distDir, rel), 'utf8');
      kit.set(rel, Buffer.from(/\.(c?js|d\.c?ts)$/.test(rel) ? stripSourceMapComment(raw) : raw));
    }
  }

  const avatars = new Map();
  for (const agent of ['pace', 'eli', 'mark', 'sage', 'orion', 'dana', 'xandy']) {
    for (const form of AVATAR_FORMS) {
      for (const size of AVATAR_SIZES) {
        const name = `${agent}-${form}-${size}.webp`;
        const abs = path.join(avatarsDir, name);
        if (!fs.existsSync(abs)) fail(`avatar render ${abs} is missing.`);
        avatars.set(name, fs.readFileSync(abs));
      }
    }
  }

  const avatarsRepo = git(avatarsDir, ['rev-parse', '--show-toplevel']);
  kit.set(
    'VERSION.json',
    Buffer.from(
      `${JSON.stringify(
        {
          name: pkg.name,
          version: pkg.version,
          repository: 'https://github.com/useorgx/orgx-ui-kit',
          commit: git(kitDir, ['rev-parse', 'HEAD']),
          dirty: Boolean(git(kitDir, ['status', '--porcelain', '--untracked-files=no'])),
          files: kit.size,
          avatars: {
            source: 'https://mcp.useorgx.com/widgets/shared/avatars/',
            repository: 'https://github.com/useorgx/orgx-mcp',
            commit: avatarsRepo ? git(avatarsRepo, ['rev-parse', 'HEAD']) : null,
            forms: AVATAR_FORMS,
            sizes: AVATAR_SIZES,
            files: avatars.size,
            servedFrom: '/orgx/live/avatars/',
          },
          sync: 'node scripts/sync-ui-kit.mjs',
        },
        null,
        2
      )}\n`
    )
  );
  return { kit, avatars };
}

function readTree(dir) {
  if (!fs.existsSync(dir)) return new Map();
  return new Map(listFiles(dir).map((rel) => [rel, fs.readFileSync(path.join(dir, rel))]));
}

function drift(next, dir) {
  const current = readTree(dir);
  return [...new Set([...next.keys(), ...current.keys()])].filter((rel) => {
    const a = next.get(rel);
    const b = current.get(rel);
    return !a || !b || !a.equals(b);
  });
}

function writeTree(tree, dir) {
  // Write to a temp dir first, then swap, so a failed run never leaves a half tree.
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'orgx-ui-kit-'));
  for (const [rel, contents] of tree) {
    fs.mkdirSync(path.dirname(path.join(staging, rel)), { recursive: true });
    fs.writeFileSync(path.join(staging, rel), contents);
  }
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  fs.cpSync(staging, dir, { recursive: true });
  fs.rmSync(staging, { recursive: true, force: true });
}

function main() {
  const check = process.argv.includes('--check');
  const kitDir = resolveDir('ORGX_UI_KIT_DIR', '../orgx-ui-kit', 'package.json');
  const avatarsDir = resolveDir('ORGX_AVATARS_DIR', '../orgx-mcp/public/widgets/shared/avatars', 'README.md');
  const { kit, avatars } = buildTrees(kitDir, avatarsDir);

  if (check) {
    const stale = [...drift(kit, VENDOR_DIR), ...drift(avatars, AVATAR_DIR).map((f) => `avatars/${f}`)];
    if (stale.length > 0) {
      fail(`vendored kit is out of date (${stale.length} files, e.g. ${stale.slice(0, 5).join(', ')}). Run node scripts/sync-ui-kit.mjs.`);
    }
    console.log(`sync-ui-kit: dashboard/vendor/orgx-ui-kit and dashboard/public/avatars are current (${kit.size + avatars.size} files).`);
    return;
  }

  writeTree(kit, VENDOR_DIR);
  writeTree(avatars, AVATAR_DIR);
  const version = JSON.parse(kit.get('VERSION.json').toString('utf8'));
  console.log(
    `sync-ui-kit: vendored ${version.name}@${version.version} (${version.commit?.slice(0, 7) ?? 'unknown commit'}${version.dirty ? ', dirty' : ''}) from ${kitDir}: ${kit.size} files; ${avatars.size} avatar renders from ${avatarsDir}.`
  );
}

main();
