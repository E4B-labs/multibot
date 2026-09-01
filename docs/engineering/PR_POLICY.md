# Pull-request policy

Every completed task goes through a focused PR. The PR description must state:

- what changed and why;
- affected modules and risk level;
- exact validation commands and results;
- migration, database, API, authentication, billing, or release implications;
- generated files or lockfile changes;
- screenshots for UI changes;
- known limitations, rollback considerations, and linked issue/task when available.

Keep unrelated cleanup out of the PR. Do not mark checks as passed without running them. Do not approve your own work.

The reviewer checks behavior, security, tests, compatibility, and scope. The reviewer does not merge. A future MultiBot merge gate may enforce policy, but `multibot/review` and `multibot/merge-gate` are not required checks until working integrations exist in GitHub Actions or another declared service.

The protected `main` branch requires a pull request, independent approval, passing real CI, resolved conversations, and an up-to-date branch. Merge only through GitHub after the exact PR head has been validated.
