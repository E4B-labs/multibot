# Repository state snapshot

Audit date: 2026-09-01. This is a baseline for governance migration; live GitHub state and the current commit are authoritative.

- Repository: `E4B-labs/multibot-desktop`
- Remote: `https://github.com/E4B-labs/multibot-desktop`
- Default branch: `main`
- Observed branches during audit: `main` and `feature/plugins-and-bot-routines`; branch lists may change after this snapshot.
- CI: `.github/workflows/ci.yml` runs lint, typecheck, tests, and the renderer build across macOS, Ubuntu, and Windows; `.github/workflows/engine.yml` runs relevant Python engine checks.
- Package manager: pnpm with `pnpm-lock.yaml`; the repository currently targets Node 24 in CI.
- Release repository: `E4B-labs/multibot-desktop-releases`. Production desktop artifacts and updater metadata belong there.
- Protection at audit time: no GitHub main branch protection or ruleset was detected.
- Reviewer integration at audit time: no working `multibot/review` or `multibot/merge-gate` check was detected, so the governance setup documents them without making them required.

Unknown or time-sensitive facts must be checked with Git, GitHub, and CI rather than inferred from this snapshot.
