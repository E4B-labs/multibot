# Development workflow

The source of truth is GitHub, not a shared local directory. Local clone paths, operating systems, and disks may differ.

## Lifecycle

`task → current origin/main → task branch → isolated worktree when needed → inspect → implement → focused commits → validation → push → pull request → CI → independent review → merge`

Before starting, fetch `origin`, inspect `git status`, confirm the task branch, and check active PRs for file or API collisions. Before a PR, reconcile with current `origin/main` according to the branch policy and rerun validation.

Do not push or normally commit on `main`. If an urgent recovery requires bypassing protection, record the reason and restore the normal PR path immediately afterward.

## Desktop validation

Install with `pnpm install --frozen-lockfile`, then run the relevant combination of `pnpm lint`, `pnpm typecheck`, `pnpm test`, and `pnpm build`. Run engine Python tests for engine changes. Do not invent commands for a module that has not been inspected.

## Multi-machine and multi-agent work

GitHub synchronizes independent computers. On one computer, independent write-capable agents must use different branches and worktrees. One task has one write-owner. A reviewer or research agent may inspect and propose changes but must not mutate the owner's worktree.
