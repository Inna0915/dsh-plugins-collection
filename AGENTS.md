# Confluence Flow

Keep the Confluence client, runtime, CLI and Skills usable without DSH. Read README.md and docs/implementation-plan.md for contracts.

- Never commit credentials, real page bodies, screenshots containing company content, or production response fixtures.
- Credentials belong in the per-user data home. On Windows use DPAPI CurrentUser; never put plaintext credentials in command arguments or tool results.
- Real-server checks are read-only or non-persisting format conversions unless the user identifies a page/write operation. Test creation and updates against synthetic fixtures.
- Preserve original storage outside the selected edit range. Never round-trip an entire existing page through a lossy wiki/Markdown conversion for a partial edit.
- Require the read page version for updates. Do not automatically retry writes with an uncertain result.
- Run installs, builds and verification through scripts/run-bounded.ps1. It owns a Windows Job Object and closes all descendants in finally. Never terminate processes by image name.
- The installed DSH plugin runs inside the user's persistent host; leave that host running. Dispose plugin-owned requests on unload. Isolated test hosts belong to their bounded command.
- Task temporary files belong in .task-temp/<task>/ and must be removed after task processes stop. Keep only redacted verification records; keep packaged releases and user exports as deliverables.

Checks: bounded dependency install, build, tsc --noEmit, node --test --test-timeout=30000 tests/*.test.mjs, Skill validation, read-only connection checks and DSH registration verification.
