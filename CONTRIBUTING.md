# Contributing to MultiBot Desktop

## Development

Requirements: Node.js 24+, Git, and pnpm 10+.

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
```

Run the harness and UI separately during development:

```sh
pnpm dev:server
pnpm dev
pnpm dev:desktop
```

## Change rules

- Keep pull requests focused.
- Reuse existing helpers and dependencies before adding new ones.
- Add or update a test for non-trivial behavior.
- Keep the Node.js harness portable across Windows, macOS, and Linux.
- Keep shell boundaries safe: pass user-controlled values as argv, never as
  interpolated shell commands.
- Do not commit secrets, personal data, host addresses, profiles, databases,
  uploads, transcripts, or generated build output.
- UI changes should include a short verification note and screenshots when
  visual behavior changes.

## Provider and tool changes

Provider drivers must expose clear unavailable/error states, never hang on a
failed process, and preserve the canonical runtime event contract. Changes to
computer-use, connectors, permissions, authentication, or secret handling
need focused tests and explicit security notes in the pull request.

## Pull request checklist

- [ ] `pnpm typecheck` passes
- [ ] `pnpm test` passes
- [ ] `pnpm build` passes when UI or packaging code changed
- [ ] no secrets or private environment data are included
- [ ] generated files are regenerated only when required
