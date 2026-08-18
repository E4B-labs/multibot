# MultiBot feature map

MultiBot is a self-hosted workspace for a fleet of named AI bots. The React
client, authenticated Node harness, and Python agent runtime ship as one
product. Legacy data identifiers remain only where migration compatibility
requires them.

## What is available

| Area | Current behavior | Main code |
|---|---|---|
| Bot roster | Create, rename, duplicate, pin, hide, delete, search, unread state, per-bot persona and icon shape | `src/components/Sidebar.tsx`, `src/components/SettingsPanel.tsx` |
| Provider picker | Claude Code, Codex, Grok, Gemini, Kimi Code, Qwen Code, computer agent, and named custom models; a custom model accepts API key, base URL, and model id | `src/components/ModelPicker.tsx`, `server/config.ts` |
| Custom models | Stored in the local config; keys are write-only in API responses; built-in CLI entries remain when custom entries are added | `server/index.ts`, `server/drivers/slafy.ts` |
| Chat runtime | Streaming replies, tool activity, interruptions, approvals, questions, files, screenshots, transcript persistence | `server/index.ts`, `server/harness/`, `src/components/ChatView.tsx` |
| Memory | Facts, graph, markdown view, search, and per-bot workspace shadow profile for every provider | `engine/server/memory.py`, `src/components/MemoryPanel.tsx` |
| Routines | Cron and manual runs for every selected driver; engine-backed routines also expose webhook controls; CLI routines show their execution limits | `server/routines.ts`, `engine/server/app.py`, `src/components/RoutinesPanel.tsx` |
| Skills | Shared list, enable, edit, delete, and teach-a-task flow; teaching requires a browser-capable profile | `engine/server/app.py`, `src/components/SkillsPanel.tsx` |
| Groups | Create from the top `+` menu, select bots, open a shared room; selected CLI bots use durable engine shadow ids for group transport | `src/components/Sidebar.tsx`, `src/components/GroupPanel.tsx`, `engine/server/groups.py` |
| Computers | One persistent browser per bot plus one shared browser profile; live preview, navigation, input takeover, screenshots, and explicit busy handling | `engine/server/computer.py`, `src/components/ComputerPanel.tsx` |
| Approvals | Allow/deny cards, per-bot permissions, tool allowlists, attention state for login/CAPTCHA questions | `engine/server/approvals.py`, `src/components/OptionCard.tsx` |
| Integrations | MCP servers, Composio connector catalog, per-bot connector settings, plugin install/account state | `server/mcp-*.ts`, `server/composio.ts`, `src/components/PluginsPanel.tsx` |
| Voice | Browser dictation on a secure context; native macOS speech helper in the desktop shell; optional engine TTS | `src/components/Composer.tsx`, `electron/speech.mjs` |
| Onboarding | Device scan, optional 24/7 provisioning with live progress, profile import, CLI detection/install, custom model setup, Electron permissions | `src/components/Onboarding.tsx`, `server/device.ts`, `server/setup-jobs.ts` |
| Remote access | Bearer-token auth for HTTP and WebSocket upgrades, token rotation, one-origin static/PWA hosting, loopback-only engine | `server/auth.ts`, `server/index.ts`, `public/manifest.webmanifest` |
| Installers | Windows per-user startup task, Linux systemd user service, Docker, and Android/Termux service | `scripts/install-server-windows.mjs`, `scripts/install-linux.sh`, `scripts/install-termux.sh` |
| PWA | Installable shell, cached static assets, network-only API/SSE data, mobile layout, token persistence | `public/manifest.webmanifest`, `public/sw.js`, `src/styles.css` |

## Provider semantics

`slafy` is an internal driver id for the embedded engine. It is not a product
name shown to users. A custom model is a named instance using that driver; the
engine receives `provider=custom`, `base_url`, and `model` at turn start.

CLI bots keep their native driver. Memory and Skills use a provider-neutral
workspace shadow profile, so they are available from the same bot header while
the provider conversation remains native. Routines are harness-owned and work
across drivers. Bot-to-bot delegation is always enabled: MCP-capable providers
get live peer tools; Codex/API providers use explicit `@bot` delegation and
receive the peer reply in their prompt.

## Platform matrix

| Platform | Chat/PWA | Engine memory/routines/skills | Browser computer | Always-on mode |
|---|---:|---:|---:|---:|
| Windows | yes | yes | yes | per-user packaged task |
| macOS | yes | yes | yes | desktop/server mode |
| Linux/VPS | yes | yes | yes, headless by default | systemd user service or Docker |
| Android/Termux | yes | yes | headless Chromium via CDP; no Android desktop window | `termux-services` + Termux:Boot |

## Known limits

- The engine remains bound to loopback. Remote access goes through the
  authenticated harness; use HTTPS/Tailscale for full PWA and microphone
  support.
- A group currently uses the shared engine room transport. A CLI participant is
  represented by a durable engine shadow; native mixed-driver group turns are a
  separate follow-up.
- Termux uses native X11 Chromium through CDP because Playwright's bundled
  desktop browser has no Android build. The PWA can still show and control the
  headless browser remotely; an Android desktop window needs Termux:X11.
- Native iOS/Android store apps, OAuth for arbitrary MCP servers, and automatic
  Windows updates are intentionally outside this release.

## Verification

```sh
pnpm typecheck
pnpm test
pnpm build
node scripts/selfhost-check.mjs
cd engine && .venv/Scripts/python.exe -m pytest -q
```
