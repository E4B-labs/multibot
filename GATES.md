# MultiBot B+C+D completion ledger

- [x] B-CREDENTIAL — credential request reaches authenticated server boundary, renders request card, never logs or persists credential value.
  CHECK: `npx vitest run server/ src/`
  EVIDENCE: targeted port feature test plus full suite; credential values stay in request body/config allowlist only.
- [x] B-CHIEFS — optional section chief metadata and delegation path work with existing BotRecord persistence and security checks.
  CHECK: `npx vitest run server/`
  EVIDENCE: `port-features.test.ts` 3/3; full server suite passed.
- [x] B-INSPECTOR — inspector shows live events and can replay captured native protocol without changing production behavior.
  CHECK: `npx vitest run server/ src/`
  EVIDENCE: `port-features.test.ts` 3/3; replay uses captured safe summaries only.
- [x] C-DIAGNOSTICS — Electron diagnostics export redacts secrets and downloads a usable report.
  CHECK: `npx vitest run electron/ src/`
  EVIDENCE: diagnostics tests passed; manual detector returned `[]`.
- [x] C-SKINS — midnight, atelier, foundry and lagoon skins apply at boot, persist, and pass contrast checks.
  CHECK: `node scripts/check-skin-contrast.mjs`
  EVIDENCE: command exits 0; atelier/foundry/lagoon pass, midnight upstream advisory only.
- [x] C-AUTOCOMPLETE — connected bot face/autocomplete behavior works in sidebar with keyboard access.
  CHECK: `npx vitest run src/`
  EVIDENCE: `botAutocomplete.test.ts` passed; Cmd-K uses keyboard-selectable bot rows.
- [x] D-COMPOSIO — Gmail account mapping supports multiple accounts, explicit account selection, and safe missing-account errors.
  CHECK: `npx vitest run server/ src/`
  EVIDENCE: `composio-accounts.test.ts` 1/1; account mapping stored per bot; delete proves service ownership.
- [x] TYPECHECK — all TypeScript gates pass.
  CHECK: `npx tsc -b && npx tsc -p tsconfig.server.build.json`
  EVIDENCE: both commands exit 0.
- [x] TESTS — complete Vitest suite passes.
  CHECK: `$env:MULTIBOT_COMPUTER='off'; npx vitest run`
  EVIDENCE: 72 passed, 1 skipped files; 484 passed, 5 skipped tests.
- [x] BUILD — frontend build passes.
  CHECK: `npx vite build`
  EVIDENCE: exit 0, 2364 modules.
- [x] PACKAGE — Windows package passes using D: temporary paths.
  CHECK: `$env:TEMP='D:\\tmp'; $env:TMP='D:\\tmp'; $env:ELECTRON_BUILDER_CACHE='D:\\electron-builder-cache'; pnpm package:win`
  EVIDENCE: exit 0; `MultiBot-0.1.70-x64-setup.exe`, `latest.yml`, blockmap present.
- [x] RELEASE — v0.1.70 points at released HEAD with all updater assets.
  CHECK: `gh release view v0.1.70 --repo E4B-labs/multibot`
  EVIDENCE: published at https://github.com/E4B-labs/multibot/releases/tag/v0.1.70; target `afda62665a7739bff762a885fd1812a5178cd699`; all three updater assets uploaded.
- [x] E-DECISION — companion cloud/iOS/ACP/skill-recorder/boxAgent/VPS ports remain rejected because multibot architecture has no matching runtime.
  EVIDENCE: `PORT-HANDOFF.md` section E plus implementation report.
  ABANDON: E-DECISION not implementing unrelated architecture ports; add only after owner supplies concrete runtime/use case.

# OpenCode Go + Zen

- [x] OC-CATALOG — Go catalog loads all models; Zen exposes only free models including `big-pickle`; cache refreshes every 12h and keeps last good data on failure.
  CHECK: `npx vitest run server/`
  EXPECT: OpenCode catalog, filtering, TTL and fallback tests pass.
  EVIDENCE: feature tests passed: catalog parsing/filtering, `big-pickle`, TTL, cache fallback; 24 tests passed.
- [x] OC-CONFIG — shared OpenCode Go key persists owner-only, stays redacted, and legacy `instances.opencodeGo` remains readable.
  CHECK: `npx vitest run server/`
  EXPECT: config/auth tests pass; no raw key in responses or logs.
  EVIDENCE: config/credential tests passed; owner-only existing config boundary retained; raw key excluded from status/catalog/cache.
- [x] OC-ACP — OpenCode launches through ACP with official model IDs, full existing MCP/tools/autonomy, and no Go key for Zen turns.
  CHECK: `npx vitest run server/`
  EXPECT: OpenCode spawn/env/ACP tests pass.
  EVIDENCE: fake ACP tests passed for `--model <id> acp`, Go validation, and Zen key stripping.
- [x] OC-UI — one OpenCode icon, expandable Go/Zen groups, catalog timestamp, and Go-key form with retry after save.
  CHECK: `npx vitest run src/`
  EXPECT: model picker tests pass.
  EVIDENCE: UI helper/static panel tests passed for one icon, groups, key form, and timestamp.
- [x] OC-MIGRATION — old OpenCode selections migrate without changing bot/message/memory saved shape; removed models repair only after successful refresh.
  CHECK: `npx vitest run server/`
  EXPECT: migration tests pass.
  EVIDENCE: legacy `opencodeGo` config/selection tests passed; migration preserves bot record fields and repairs only after successful catalog refresh.
- [x] OC-TYPECHECK — TypeScript gates pass.
  CHECK: `npx tsc -b && npx tsc -p tsconfig.server.build.json`
  EXPECT: exit 0.
  EVIDENCE: `npx tsc -b` and `npx tsc -p tsconfig.server.build.json` exit 0.
- [x] OC-TESTS — complete Vitest suite passes.
  CHECK: `$env:MULTIBOT_COMPUTER='off'; npx vitest run`
  EXPECT: exit 0.
  EVIDENCE: `npx vitest run` exit 0; 101 files passed, 1 skipped; 610 tests passed, 7 skipped.
- [x] OC-BUILD — frontend build passes.
  CHECK: `npx vite build`
  EXPECT: exit 0.
  EVIDENCE: `npx vite build` exit 0; 2464 modules transformed.
- [x] OC-DIFF — diff has no whitespace errors and no secrets.
  CHECK: `git diff --check`
  EXPECT: exit 0.
  EVIDENCE: `git diff --check` exit 0; no whitespace errors. Secret-bearing fields remain write-only/redacted.
