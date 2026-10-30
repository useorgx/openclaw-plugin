---
name: ship
description: Commit current local changes, open a PR, and merge it using the GitHub CLI. Use for phrases like "ship this", "commit + PR", "merge it", or "/ship".
version: 1.0.0
user-invocable: true
tags:
  - git
  - github
  - release
---

# Ship (Commit → PR → Merge)

Use this skill when you want Codex to take a dirty working tree and turn it into a merged PR safely.

## Preconditions

- `gh` is installed and authenticated (`gh auth status`).
- You have push + merge rights on the repo, or you’re okay with opening a PR and leaving merge for later.

## Workflow

1. Identify the repo(s) to ship.
   - Use the user's named repos and session context; when they request all repos, process the relevant changed repos. Ask only if the intended scope cannot be reasonably resolved.
   - The ship/merge request supplies authority for these steps. Do not ask again solely because a local skill calls merging consequential; actual access rules and required approvals still apply.

2. Sanity checks (per repo).
   - `git status --porcelain=v1`
   - Review diffs: `git diff --stat`, then spot-check risky files.
   - Run the smallest relevant checks (example):
     - Typecheck: `npm run typecheck` or `npm run type-check`
     - Targeted tests for touched areas (avoid running everything unless needed)

3. Create a branch.
   - `git switch -c codex/ship-<short-topic>-<yyyymmdd>`

4. Stage changes deliberately.
   - Prefer `git add -p` when diffs are risky or wide.
   - Do not include secrets or local-only files.

5. Commit with a scoped message.
   - Example: `feat(blocker3): diagnostics + billing scaffolds limits`

6. Push and open a PR.
   - `git push -u origin HEAD`
   - `gh pr create --fill --base main`
   - If the repo uses a different default branch, detect and use it.

7. Merge.
   - Satisfy required CI and branch protection, using the repo's merge helper when one exists. Otherwise prefer squash merge:
     - `gh pr merge --squash --delete-branch`
   - If branch protection blocks merge, report why and leave the PR open.
   - OrgX reports, receipts, and optional quality scores are not additional merge gates. State any missing optional evidence without claiming it exists.

8. Post-merge cleanup.
   - `git switch main`
   - `git pull --ff-only`

## Output Contract

At the end, report:
- PR URL(s)
- Merge status (merged or blocked, with reason)
- Any follow-ups (failed checks, protection rules, required approvals)

