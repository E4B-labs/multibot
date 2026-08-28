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
