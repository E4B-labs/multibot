# Code ownership and collision prevention

Ownership is assigned per active task, not by permanent developer branch. The task owner may be Kacper, Bartek, Mieszko, or an explicitly assigned coding agent acting for one of them.

## Practical boundaries

- Renderer/UI work: `src/` and shared UI packages when the task requires them.
- Desktop shell and native integration: `electron/`.
- Node harness/server behavior: `server/`.
- Python engine behavior: `engine/`.
- Build/release automation: `scripts/`, packaging files, and `.github/`.

These are review boundaries, not permission to bypass the task owner or the PR process. A change crossing boundaries must call out the coupling and validation.

Before substantial work, inspect active branches and PRs for overlapping files, shared types, IPC contracts, host protocols, and migrations. If two tasks collide, coordinate one owner for the shared files or split the work into ordered PRs. Never have independent write-capable agents edit the same worktree concurrently.
