# Jira Flow development

Read README.md for usage. Keep the Jira client, CLI and Skills independent of DSH.

- Never put credentials or real issue contents in source, tests, logs or committed fixtures.
- Real Jira verification is read-only unless the user names a write operation. Use synthetic fixtures to test mutations.
- Run builds and tests through `scripts/run-bounded.ps1`. It owns a Windows Job Object and closes the whole process tree in a finally block. Do not kill processes by image name.
- This plugin legitimately registers routes and tools inside the user's persistent DSH host. The host is user-owned; never stop it as part of test cleanup. Test servers belong to their verification command and must be stopped.
- Temporary artifacts belong in `.task-temp/<task>/`; remove task-owned files after verification. Keep only a redacted verification record in docs/verification.md.
- Exported task packages are user deliverables, not disposable verification files. Changes to Jira state must use live transition IDs and report partial failures.

Checks: bounded `npm install`, `node scripts/build.mjs`, `node node_modules/typescript/bin/tsc --noEmit`, `node --test --test-timeout=20000 tests/*.test.mjs`.
