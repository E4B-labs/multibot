# MultiBot team workflow

Use one GitHub repository, short-lived branches, and pull requests. Keep
`main` releasable. Do not share a working directory or force-push over a
colleague's branch.

## First clone

```sh
git clone https://github.com/E4B-labs/multibot-desktop.git
cd multibot-desktop
corepack enable
pnpm install --frozen-lockfile
```

## Daily loop

```sh
git switch main
git pull --ff-only origin main
git switch -c feat/<name>-<short-topic>
# edit + test
git status
git add <files>
git commit -m "feat: <short Polish description>"
git push -u origin HEAD
gh pr create --base main --fill
```

After merge, delete the branch and refresh before starting next task:

```sh
git switch main
git pull --ff-only origin main
git branch -d feat/<name>-<short-topic>
```

## Parallel ownership

Prefer one owner per area during a task:

| Area | Primary paths | Safe parallel partner |
|---|---|---|
| Frontend | `src/`, `public/` | `server/`, `engine/` |
| Harness | `server/` | `src/`, `engine/` |
| Engine | `engine/` | `src/`, most `server/` |
| Mobile shell | `clients/mobile/` | every other area |
| Install/docs | `scripts/`, `docs/`, root Markdown | any code area |

When two branches must touch one file, agree on order first. Rebase before
opening the PR; resolve conflicts locally, then rerun tests.

## Required checks

```sh
pnpm typecheck
pnpm test
pnpm build
node scripts/selfhost-check.mjs
```

Engine changes also run the full pytest suite. Use `D:\tmp` for temporary
artifacts on Windows and never put API keys, tokens, `.env` files, or generated
user data in the repository.

## PR contract

- Explain user-visible behavior and test evidence.
- Keep `server/contracts.ts` stable unless the change explicitly updates the
  driver SPI.
- Additive upstream edits carry a `// multibot:` marker.
- No generated `dist-server/` churn, secrets, or force-pushes to `main`.
- A reviewer checks security impact, cross-platform behavior, and migration
  compatibility before merge.
