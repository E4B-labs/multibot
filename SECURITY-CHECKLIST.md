# Public-release security checklist

Date: 2026-08-18

## Scans

- Gitleaks scanned working tree and all retained Git history.
- Manual review searched tracked files and history for API keys, tokens,
  credentials, `.env` files, private keys, and local database artifacts.
- Tracked-file size review found no file over 5 MB in the public snapshot.

## Removed or sanitized

- Embedded analytics token removed; analytics now requires `VITE_POSTHOG_KEY`.
- Test-only secret-shaped literals replaced with generated test values.
- Local auth/config files, templates, funding files, internal plans, and
  research artifacts moved to the external release archive.
- Build output, dependency directories, local engine data, uploads, and local
  environments excluded from Git.

## History

- History rewrite: yes.
- Public branch contains one clean initial commit authored by Kacper Węcław.
- Pre-squash history is retained only in the local archive bundle and was not
  pushed to the public repository.

No live credential was intentionally retained in the public snapshot.
