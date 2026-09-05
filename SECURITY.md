# Security policy

## Reporting

Do not publish vulnerability details in an issue. Use GitHub's private
vulnerability reporting for this repository, or contact repository
maintainers privately through the E4B-labs organization.

Include affected version or commit, reproduction steps, impact, and any
required logs with secrets removed.

## Security boundaries

- Expose only the authenticated harness; keep every other listener on loopback.
- Treat bearer tokens, provider keys, connector credentials, browser profiles,
  and transcripts as local secrets.
- Never route user-controlled strings through a shell.
- Review computer-use and agent approval changes as security-sensitive.
- Redact tokens and credentials from issue reports and logs.
