# MultiBot

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Single owner operating a private fleet of AI agents from desktop or phone. The owner installs MultiBot once on an always-on Windows, Linux, VPS, or Termux host, then uses it locally or through authenticated remote access.

## Product Purpose

MultiBot provides one self-hosted workspace for named agents, conversations, models, memory, skills, routines, groups, integrations, approvals, and per-agent computers. Success means the owner can configure a provider, delegate work, review consequential actions, stop work immediately, and return later without losing durable state.

## Positioning

MultiBot unifies official vendor CLIs and custom/local model endpoints behind one provider-neutral product identity and one local control plane. Provider implementations remain infrastructure details, not separate products in the interface.

## Operating Context

- React/PWA interface served by the authenticated Node harness.
- Optional Electron desktop shell and remote phone access, normally through Tailscale HTTPS.
- Claude Code, Codex, ACP CLIs, and custom OpenAI-compatible endpoints.
- Long-running turns, scheduled routines, tool approvals, browser takeover, and bot-to-bot delegation.
- Polish and English interface; mobile and desktop are both supported surfaces.

## Capabilities and Constraints

- User data, credentials, histories, memories, routines, and attachments stay self-hosted.
- The harness is the sole authenticated network boundary; every other listener stays loopback-only.
- Provider credentials stay in official CLI stores or local write-only configuration and must never appear in API responses or logs.
- MultiBot is the only user-facing agent identity. Do not expose provider branding.
- Full Access remains bounded by OS, container, provider, and network permissions.
- Secure-context browser rules for microphone, PWA, and camera access must not be weakened.

## Brand Commitments

- Product name: MultiBot.
- Voice: concise, direct, technical, calm.
- Preserve the existing compact dark interface, mascot system, familiar native controls, and restrained blue accent.
- New UI must fit existing tokens and components; no visual redesign is part of feature work.

## Evidence on Hand

- Product and architecture handoff supplied with the task.
- Existing implementation and tests under `src/` and `server/`.
- Existing dark-theme tokens in `src/styles.css` and current production components.
- No testimonials, customer claims, pricing claims, or external benchmarks may be invented.

## Product Principles

1. One MultiBot identity across every provider.
2. Durable local state with explicit ownership and deletion.
3. Consequential actions stay inspectable, revocable, and stoppable.
4. Native platform and provider capabilities before custom machinery.
5. Same essential workflow on desktop and phone.

## Accessibility & Inclusion

Maintain keyboard operation, visible focus, semantic labels, sufficient contrast, reduced-motion compatibility, and 44px touch targets on mobile. Polish and English copy must remain understandable without provider-specific jargon.
