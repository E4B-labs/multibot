<h1 align="center">MultiBot</h1>

<p align="center"><strong>Your private team of AI agents, in one workspace.</strong></p>

<p align="center">An open-source workspace for real AI agents — self-hosted, local-first, and built for private work.</p>

<p align="center">Every bot in the sidebar is a real agent — Claude or Codex running locally under the hood — with its own personality, its own model, its own cloud computer, and its own connected apps. Talk to them like contacts. Watch them work. Approve what matters.</p>

<p align="center">
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-5.9-3178C6?logo=typescript&logoColor=white">
  <img alt="React 19" src="https://img.shields.io/badge/React-19-20232A?logo=react&logoColor=61DAFB">
  <img alt="Electron 43" src="https://img.shields.io/badge/Electron-43-47848F?logo=electron&logoColor=white">
  <img alt="Node.js harness" src="https://img.shields.io/badge/Node.js-harness-339933?logo=nodedotjs&logoColor=white">
  <img alt="Python FastAPI engine" src="https://img.shields.io/badge/Python-FastAPI-009688?logo=fastapi&logoColor=white">
  <img alt="Claude and Codex agents" src="https://img.shields.io/badge/Agents-Claude%20%C2%B7%20Codex-D97757">
  <img alt="Release" src="https://img.shields.io/github/v/release/E4B-labs/multibot-desktop-releases?display_name=tag&label=release">
  <img alt="Pull requests welcome" src="https://img.shields.io/badge/PRs-welcome-2EA44F">
</p>

<p align="center">
  <a href="https://github.com/E4B-labs/multibot-desktop-releases/releases/latest/download/MultiBot-Desktop-0.3.12-x64-setup.exe"><img alt="Download for Windows" src="https://img.shields.io/badge/DOWNLOAD%20FOR%20WINDOWS-000000?style=for-the-badge&logo=windows&logoColor=white"></a>
  <a href="https://github.com/E4B-labs/multibot-desktop-releases/releases/latest/download/MultiBot-Mobile-0.3.6.apk"><img alt="Download for Android" src="https://img.shields.io/badge/DOWNLOAD%20FOR%20ANDROID-000000?style=for-the-badge&logo=android&logoColor=white"></a>
</p>

<p align="center"><a href="https://github.com/E4B-labs/multibot-desktop-releases/releases/latest">latest release</a> · Windows: x64 installer · Android: APK · <a href="https://github.com/E4B-labs/multibot-desktop-releases/releases">all releases</a></p>

<p align="center">
  <img src="docs/screenshots/hero.png" alt="MultiBot workspace with multiple AI agents" width="960">
</p>

<p align="center"><strong>Private, secure automations for real businesses and real work.</strong></p>

## What MultiBot does

MultiBot turns AI models and command-line agents into a coordinated workspace:

- Run several independent bots with separate profiles, models, memories, tools, skills, schedules, and permissions.
- Use private bots for one user and team bots for shared work.
- Let agents communicate through agent mail, rooms, delegation, and shared workspace memory.
- Connect MCP servers, browser tools, computer-use sessions, connectors, and local runtimes.
- Keep approval boundaries and autonomy controls visible while agents work.
- Search chat history, organize bots into sections, recover hidden bots, and use the responsive interface on desktop or mobile.
- Run routines from schedules or webhooks.
- Use OpenCode through ACP, including OpenCode Go and free OpenCode Zen models.

## Architecture

```text
React UI  ->  Electron shell / mobile client  ->  Node.js harness
                                                    |-> provider and CLI drivers
                                                    |-> MCP, connectors, browser, computer tools
                                                    |-> auth, events, rooms, routines, agent mail
                                                    `-> optional Python FastAPI engine
```

The harness is the application boundary. The optional Python engine stays on
loopback when used locally. MultiBot can also connect to a separately hosted,
self-hosted workspace server.

## Install

### Windows

Download the Windows installer from the button above and run
`MultiBot-Desktop-<version>-x64-setup.exe`.

### Android

Download the APK from the button above, allow installation from the selected
source when Android asks, and open MultiBot Mobile.

## Development

Requirements: Node.js 24+, Git, and pnpm 10+.

```sh
git clone https://github.com/E4B-labs/multibot-desktop.git
cd multibot-desktop
corepack enable
pnpm install --frozen-lockfile

pnpm dev:server   # Node.js harness
pnpm dev          # Vite UI, in another terminal
pnpm dev:desktop  # Electron shell, in another terminal
```

Optional Python engine:

```sh
pnpm dev:engine
```

Useful checks:

```sh
pnpm typecheck
pnpm test
pnpm build
pnpm build:server
```

## Configuration and security

Start from the checked-in examples:

- [`.env.example`](.env.example) — optional frontend build values
- [`engine/.env.example`](engine/.env.example) — engine values
- [`server/config.ts`](server/config.ts) — runtime configuration behavior

Never commit `.env` files, API keys, access tokens, connector credentials,
browser profiles, local databases, uploads, generated bundles, or transcripts.
Secrets are write-only at API boundaries and must never appear in logs, events,
command arguments, or diagnostics.

Read [`SECURITY.md`](SECURITY.md) before exposing a host to another device.
MultiBot is self-hosted software; operators remain responsible for network
exposure, provider credentials, backups, and access policy.

## Releases

Desktop installers and mobile artifacts live in
[MultiBot Desktop Releases](https://github.com/E4B-labs/multibot-desktop-releases).
Maintainers update the version, run required checks, build artifacts, publish
the updater metadata, and create a GitHub Release there. Use the dedicated
platform command so the release cannot be created in this source repository:

```sh
pnpm release:win
pnpm release:mac
```

These commands create the `v<version>` tag and upload the generated installers
and updater metadata to `E4B-labs/multibot-desktop-releases`.

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md). Small focused pull requests and
tests for behavior changes are preferred.

### Contributors

- [SlafyGH](https://github.com/SlafyGH)

## License

MIT. See [`LICENSE`](LICENSE).
