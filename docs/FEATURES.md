# MultiBot feature map

MultiBot is a self-hosted workspace for a fleet of named AI bots. The React
client and the authenticated Node harness ship as one product. Legacy data
identifiers remain only where migration compatibility requires them.

## What is available

| Area | Current behavior | Main code |
|---|---|---|
| Bot roster | Create, rename, duplicate, pin, hide, delete, search, unread state, per-bot persona and icon shape | `src/components/Sidebar.tsx`, `src/components/SettingsPanel.tsx` |
| Provider picker | Claude Code, Codex, Grok, Gemini, Kimi Code, Qwen Code, computer agent, and named custom models; a custom model accepts API key, base URL, and model id | `src/components/ModelPicker.tsx`, `server/config.ts` |
| Custom models | Stored in the local config; keys are write-only in API responses; built-in CLI entries remain when custom entries are added | `server/index.ts`, `server/drivers/grok.ts` |
| Chat runtime | Streaming replies, tool activity, interruptions, approvals, questions, files, screenshots, transcript persistence | `server/index.ts`, `server/harness/`, `src/components/ChatView.tsx` |
| Memory | Facts, search, and a per-bot workspace profile shared by every provider | `server/workspace.ts` |
| Routines | Cron, webhook, and manual runs for every selected driver; CLI routines show their execution limits | `server/routines.ts`, `src/components/RoutinesPanel.tsx` |
| Skills | Shared list, enable, edit, and delete | `server/workspace.ts`, `src/components/SkillsPanel.tsx` |
| Groups | Create from the top `+` menu, select bots, open a shared room | `src/components/Sidebar.tsx`, `src/components/GroupPanel.tsx`, `server/group-store.ts` |
| Computers | One persistent Linux desktop per installation, shared by every bot; live preview, navigation, input takeover, screenshots, and explicit busy handling | `server/hosted-computer.ts`, `server/computer-vnc-proxy.ts`, `src/components/ComputerPanel.tsx` |
| Approvals | Allow/deny cards, per-bot permissions, tool allowlists, attention state for login/CAPTCHA questions | `server/approval-rules.ts`, `server/turn-policy.ts`, `src/components/OptionCard.tsx` |
| Integrations | MCP servers, Composio connector catalog, per-bot connector settings, plugin install/account state | `server/mcp-*.ts`, `server/composio.ts`, `src/components/PluginsPanel.tsx` |
| Voice | Browser dictation on a secure context; native macOS speech helper in the desktop shell; read-aloud TTS with a configured voice key | `src/components/Composer.tsx`, `electron/speech.mjs` |
| Onboarding | Device scan, optional 24/7 provisioning with live progress, CLI detection/install, custom model setup, Electron permissions | `src/components/Onboarding.tsx`, `server/device.ts`, `server/setup-jobs.ts` |
| Remote access | Bearer-token auth for HTTP and WebSocket upgrades, token rotation, one-origin static/PWA hosting | `server/auth.ts`, `server/index.ts`, `public/manifest.webmanifest` |
| Installers | Windows per-user startup task, Linux systemd user service, Docker, and Android/Termux service | `scripts/install-server-windows.mjs`, `scripts/install-linux.sh`, `scripts/install-termux.sh` |
| PWA | Installable shell, cached static assets, network-only API/SSE data, mobile layout, token persistence | `public/manifest.webmanifest`, `public/sw.js`, `src/styles.css` |

## Provider semantics

`openaiCompatible` is an internal driver id for the OpenAI-compatible endpoints
a user configures (Ollama, LM Studio, OpenRouter). It is not a product name
shown to users. A custom model is a named instance using that driver, with its
own base URL, model id, and key.

CLI bots keep their native driver. Memory and Skills use a provider-neutral
workspace profile, so they are available from the same bot header while the
provider conversation remains native. Routines are harness-owned and work
across drivers. Bot-to-bot delegation is always enabled: MCP-capable providers
get live peer tools; Codex/API providers use explicit `@bot` delegation and
receive the peer reply in their prompt.

## Platform matrix

| Platform | Chat/PWA | Browser computer | Always-on mode |
|---|---:|---:|---:|
| Windows | yes | yes | per-user packaged task |
| macOS | yes | yes | desktop/server mode |
| Linux/VPS | yes | yes, headless by default | systemd user service or Docker |
| Android/Termux | yes | headless Chromium via CDP; no Android desktop window | `termux-services` + Termux:Boot |

## Known limits

- Remote access goes through the authenticated harness; use HTTPS/Tailscale for
  full PWA and microphone support.
- Termux uses native X11 Chromium through CDP because Docker cannot run on an
  unrooted phone. The PWA can still show and control the headless browser
  remotely; an Android desktop window needs Termux:X11.
- Native iOS/Android store apps, OAuth for arbitrary MCP servers, and automatic
  Windows updates are intentionally outside this release.

## Verification

```sh
pnpm typecheck
pnpm test
pnpm build
node scripts/selfhost-check.mjs
```
