#!/usr/bin/env node
import { execFileSync } from 'node:child_process';

function run(cmd, args, options = {}) {
  execFileSync(cmd, args, { stdio: 'inherit', ...options });
}

function capture(cmd, args, options = {}) {
  return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options }).trim();
}

function slugify(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

function resolveDefaultBaseBranch() {
  try {
    const ref = capture('git', ['symbolic-ref', 'refs/remotes/origin/HEAD']);
    const match = ref.match(/refs\/remotes\/origin\/(.+)$/);
    return match?.[1] ?? 'main';
  } catch {
    return 'main';
  }
}

const args = process.argv.slice(2);
const commitMessage = args.join(' ').trim() || null;

const porcelain = capture('git', ['status', '--porcelain=v1']);
if (!porcelain) {
  process.stdout.write('No changes to ship.\n');
  process.exit(0);
}

const currentBranch = capture('git', ['branch', '--show-current']);
let branch = currentBranch;
if (!branch || branch === 'main' || branch === 'master') {
  const base = resolveDefaultBaseBranch();
  const now = new Date();
  const date = now.toISOString().slice(0, 10);
  const suggested = slugify(commitMessage ?? 'changes') || 'changes';
  branch = `ship/${date}-${suggested}`;
  run('git', ['checkout', base]);
  run('git', ['pull', '--ff-only']);
  run('git', ['checkout', '-b', branch]);
}

run('git', ['add', '-A']);

const fallbackMessage = `chore: ship ${new Date().toISOString().slice(0, 10)}`;
try {
  run('git', ['commit', '-m', commitMessage ?? fallbackMessage]);
} catch {
  // If nothing staged (e.g. user has only untracked ignored files), don't hard-fail.
  process.stderr.write('Commit failed. Ensure changes are staged and not ignored.\n');
  process.exit(1);
}

run('git', ['push', '-u', 'origin', branch]);

// GitHub CLI is best-effort; if missing or unauthenticated we still leave the branch pushed.
try {
  const base = resolveDefaultBaseBranch();
  const title = commitMessage ?? fallbackMessage;
  const body = 'Automated ship via scripts/ship.mjs';
  const prUrl = capture('gh', ['pr', 'create', '--base', base, '--head', branch, '--title', title, '--body', body]);
  process.stdout.write(`PR: ${prUrl}\n`);
  run('gh', ['pr', 'merge', prUrl, '--merge', '--delete-branch', '--auto']);
} catch {
  process.stderr.write('Pushed branch; PR/merge step skipped (gh not available or not authenticated).\n');
}

