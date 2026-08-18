# MultiBot comparison

This is a capability map, not a benchmark. MultiBot is a self-hosted
multi-provider workspace; Hermes Agent is an agent runtime; OpenClaw is a
self-hosted messaging gateway; Grok is xAI's hosted assistant. Features change,
so external rows were checked against official documentation on 2026-08-13.

Legend: **yes** = documented/current, **partial** = available with a scope or
runtime limitation, **no** = not the product's documented focus.

| Capability | MultiBot | Hermes Agent | OpenClaw | Grok (xAI) |
|---|---|---|---|---|
| Self-hosted core | **yes** — harness, PWA, and engine can run on one device | **yes** — local CLI, gateway, desktop, and profiles | **yes** — self-hosted Gateway | **no** — hosted xAI service/apps |
| Named bot fleet | **yes** — roster, per-bot provider/model/persona | **partial** — independent profiles and delegated agents | **yes** — isolated agents and multi-agent routing | **partial** — product-level modes/agents, not a self-hosted fleet |
| Mix providers in one workspace | **yes** — Claude, Codex, Grok, Gemini, Kimi, Qwen, custom URL | **partial** — provider/model configuration inside Hermes | **partial** — model/provider routing through Gateway | **no** — xAI model family |
| Custom/local model endpoint | **yes** — custom base URL + model id + key | **yes** — configurable model providers | **yes** — provider adapters/configuration | **no** — no local endpoint in hosted app |
| Persistent memory | **yes** — engine facts, graph, markdown | **yes** — persistent memory | **yes** — memory/context features | **partial** — app memory is product-controlled |
| Skills / reusable procedures | **yes** — engine Skills and teach flow | **yes** — Skills System and skill generation | **yes** — skills/plugins ecosystem | **partial** — connectors/tools, not an open local skill filesystem |
| Scheduled routines | **yes** — harness cron; engine cron/webhooks | **yes** — cron jobs, delivery targets, skill injection | **yes** — cron and gateway automation | **partial** — product features vary by plan/surface |
| Browser/computer control | **yes** — persistent per-bot/shared browser, preview, takeover | **yes** — browser automation backends | **yes** — browser Control UI and device nodes | **partial** — hosted agent capabilities are product-controlled |
| Human approval flow | **yes** — allow/deny/question cards and tool allowlists | **yes** — tool policy and gateway controls | **yes** — pairing, access groups, tool policy | **partial** — hosted product controls |
| Messaging channels | **partial** — PWA, desktop, remote browser | **yes** — terminal, desktop, messaging platforms, IDEs | **yes** — Telegram, WhatsApp, Slack, Discord, iMessage, WebChat, and plugins | **yes** — web, iOS, Android, X surfaces |
| MCP / external tools | **yes** — MCP + Composio connectors | **yes** — Tool Gateway, MCP, skills | **yes** — plugins, browser, nodes, channel actions | **yes** — connectors and MCP support |
| One-command install | **yes** — Windows, Linux, Docker, Termux paths | **yes** — documented installer/CLI setup | **yes** — Gateway onboarding/install flow | **not applicable** — hosted app |
| Mobile install | **yes** — PWA, no app-store binary required | **partial** — messaging/mobile surfaces depend on setup | **yes** — mobile nodes and web/control surfaces | **yes** — official mobile apps |

## Where MultiBot fits

MultiBot combines a chat-like bot roster with the persistence and tools of an
agent runtime, while keeping provider choice visible per bot. Its differentiator
is one authenticated workspace for CLI agents, local/custom models, routines,
browser computers, memory, and remote PWA access. Hermes remains the embedded
engine for engine-backed profiles; it is not presented as a separate vendor in
the MultiBot UI.

## Sources

- [Hermes Agent feature overview](https://hermes-agent.nousresearch.com/docs/user-guide/features/overview/)
- [Hermes Agent scheduled tasks](https://hermes-agent.nousresearch.com/docs/user-guide/features/cron)
- [Hermes Agent skills](https://hermes-agent.nousresearch.com/docs/user-guide/features/skills)
- [Hermes Agent official repository](https://github.com/NousResearch/hermes-agent)
- [OpenClaw features](https://docs.openclaw.ai/concepts/features)
- [OpenClaw channels](https://docs.openclaw.ai/channels)
- [OpenClaw multi-agent routing](https://docs.openclaw.ai/multi-agent)
- [xAI Grok overview](https://docs.x.ai/grok/overview)
- [xAI Grok connectors](https://docs.x.ai/grok/connectors)
