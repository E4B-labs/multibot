# MultiBot Desktop

MultiBot Desktop is a self-hosted workspace for running and coordinating AI
bots. Each bot can have its own model, memory, tools, skills, schedule,
permissions, and collaboration rules.

The desktop application contains the React interface, Node.js harness, and
optional Python engine. It can run locally or connect to a separately hosted
MultiBot server.

## Features

- Multiple independent bots with per-bot profiles and memory
- Team bots and private bots with access control
- Agent-to-agent mail, rooms, delegation, and shared workspaces
- Model and CLI providers, including OpenCode through ACP
- MCP servers, connectors, browser tools, and computer-use sessions
- Approval boundaries, autonomy controls, and permission-aware tools
- Scheduled and webhook-triggered routines
- Searchable chat history, sections, bot recovery, and responsive UI
- Optional Python engine for extended tools and runtimes
- Windows and macOS packaging through Electron

## Architecture

```text
React UI  ->  Node.js harness  ->  provider / CLI drivers
                         |       ->  MCP and connectors
                         |       ->  browser and computer tools
                         |       ->  events, auth, rooms, routines
                         `-----> Python engine (optional, loopback)
```

The harness is the application boundary. The Python engine is intended to
stay on loopback. Configuration, provider credentials, bot data, and chat
transcripts remain on the operator's machine or chosen self-hosted server.

## Install the desktop app

Download the newest installer from
[MultiBot Desktop Releases](https://github.com/E4B-labs/multibot-desktop-releases/releases), then run
`MultiBot-Desktop-<version>-x64-setup.exe` on Windows.

For macOS, download the DMG or ZIP asset matching the release. Unsigned local
builds may require the operating system's normal security confirmation.

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

## Configuration

Start from the checked-in examples:

- [`.env.example`](.env.example) — optional frontend build values
- [`engine/.env.example`](engine/.env.example) — engine values
- [`server/config.ts`](server/config.ts) — runtime configuration behavior

Never commit `.env` files, API keys, access tokens, connector credentials,
browser profiles, local databases, uploads, generated bundles, or transcripts.
Secrets are write-only at the API boundary and must never appear in logs,
events, command arguments, or diagnostics.

## Release process

Maintainers update the version, run the required checks, build the installer,
and publish matching installer metadata and assets in GitHub Releases.
Release artifacts are also mirrored in the
[MultiBot Desktop Releases](https://github.com/E4B-labs/multibot-desktop-releases) archive.

## Security

Read [`SECURITY.md`](SECURITY.md) before exposing a host to another device.
MultiBot is self-hosted software; operators are responsible for network
exposure, provider credentials, backups, and access policy.

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md). Small focused pull requests and
tests for behavior changes are preferred.

## License

MIT. See [`LICENSE`](LICENSE).
