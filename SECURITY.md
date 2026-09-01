# Security policy

## Reporting

Do not publish vulnerability details in an issue. Use GitHub's private
vulnerability reporting for this repository. Include the affected version,
reproduction steps, impact, and logs with credentials removed.

## Deployment boundaries

- Bind the optional engine to loopback.
- Expose only the authenticated harness to remote clients.
- Use strong, unique credentials and rotate them after suspected exposure.
- Treat bearer tokens, provider keys, connector credentials, browser profiles,
  transcripts, and device pairing data as secrets.
- Do not put secrets in URLs, logs, events, screenshots, diagnostics, or shell
  command strings.
- Review computer-use and autonomy changes as security-sensitive.
- Keep the application and its dependencies updated.
