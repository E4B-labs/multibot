# MultiBot Desktop agent instructions

This file is the canonical, vendor-neutral instruction entrypoint for every human and AI coding tool. Read it before modifying the repository; tools that do not load `AGENTS.md` automatically must read it explicitly.

## Mandatory startup

1. Discover the repository root dynamically.
2. Read this file and the relevant files in [`docs/engineering/`](docs/engineering/).
3. Run `git status`, identify the branch and current commit, and verify the branch is not `main`.
4. Run `git fetch origin`, inspect active PRs and overlapping work, then inspect the affected code and tests.
5. If the current worktree is on `main`, stop and create a task branch/worktree before editing.

## Engineering protocol

- One task uses one branch: `<developer>/<type>/<task-id>-<description>`.
- One active task has exactly one primary write-owner. Concurrent write-capable agents on one computer use separate worktrees; research/review agents do not edit the owner worktree.
- Never push directly to `main`. Use focused commits, push the task branch, open a PR, pass CI, obtain independent review, and merge through GitHub.
- Never commit secrets, `.env` files, personal data, logs, build output, or machine-specific absolute paths.
- Inspect the final diff and run the smallest relevant checks before committing. Do not approve or merge your own work.

## Desktop commands

```text
corepack enable
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

Run the engine's Python tests when changing `engine/`; use the release commands only for an approved release task. Release artifacts and updater metadata are published to `E4B-labs/multibot-desktop-releases`, not this repository's release page.

See [`WORKFLOW.md`](docs/engineering/WORKFLOW.md) for the full lifecycle and [`AI_AGENT_PROTOCOL.md`](docs/engineering/AI_AGENT_PROTOCOL.md) for the startup and collision rules.

## Reference documents

- [`ARCHITECTURE.md`](docs/engineering/ARCHITECTURE.md)
- [`WORKFLOW.md`](docs/engineering/WORKFLOW.md)
- [`BRANCHING.md`](docs/engineering/BRANCHING.md)
- [`AI_AGENT_PROTOCOL.md`](docs/engineering/AI_AGENT_PROTOCOL.md)
- [`PR_POLICY.md`](docs/engineering/PR_POLICY.md)
- [`CODE_OWNERSHIP.md`](docs/engineering/CODE_OWNERSHIP.md)
- [`REPO_STATE.md`](docs/engineering/REPO_STATE.md)
- [`CONTRIBUTING.md`](CONTRIBUTING.md) and [`SECURITY.md`](SECURITY.md), when relevant
