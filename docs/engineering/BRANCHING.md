# Branching

## Naming

Use one task branch per change:

`<developer>/<type>/<task-id>-<description>`

Examples: `kacper/feat/MB-184-billing-dashboard`, `bartek/fix/MB-219-refresh-token`, `mieszko/refactor/MB-241-engine-client`.

Allowed types are `feat`, `fix`, `refactor`, `chore`, `docs`, `test`, and `perf`. Names should identify the task, not a permanent developer branch.

## Rules

- Start from an up-to-date `origin/main` after `git fetch origin`.
- Do not reuse one task branch simultaneously from multiple computers unless explicitly coordinated.
- A worktree is local concurrency infrastructure, not a shared project location. Use one for each simultaneous write-owner on the same computer.
- Before opening or updating a PR, reconcile the branch with current `main` and rerun checks.
- Delete merged or abandoned remote branches after confirming they are no longer needed. Remove local worktrees only after checking for uncommitted work.

Never encode a drive letter, username, home directory, or local path in branch policy or source files.
