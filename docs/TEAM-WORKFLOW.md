# MultiBot team workflow

This document has been folded into the engineering protocol so there is one
source of truth instead of several partly-contradicting ones.

| You were looking for | Now in |
|---|---|
| First clone, daily loop, branch lifecycle | [`engineering/WORKFLOW.md`](engineering/WORKFLOW.md) |
| Branch naming, base branch, rebase, cleanup | [`engineering/BRANCHING.md`](engineering/BRANCHING.md) |
| Ownership matrix (who owns which area) | [`engineering/CODE_OWNERSHIP.md`](engineering/CODE_OWNERSHIP.md) |
| Required checks and the PR contract | [`engineering/PR_POLICY.md`](engineering/PR_POLICY.md) |
| Architecture, ports, storage, collision hotspots | [`engineering/ARCHITECTURE.md`](engineering/ARCHITECTURE.md) |
| Release channels and version numbering | [`engineering/RELEASE.md`](engineering/RELEASE.md) |

The canonical, tool-neutral protocol every contributor and AI agent follows is
[`AGENTS.md`](../AGENTS.md) in the repository root. Read it first.

Two things that changed and are worth calling out:

- The gate commands are now exactly what CI runs — `pnpm lint`,
  `pnpm typecheck`, `pnpm test`, `pnpm exec vite build` — and nothing else.
  The old list mentioned `node scripts/selfhost-check.mjs`, which CI has never
  run.
- The `clients/mobile/` row is gone: that directory does not exist in this
  repository. The mobile app lives in `E4B-labs/multibot-mobile`.
