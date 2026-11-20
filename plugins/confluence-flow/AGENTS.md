# Confluence Flow

Keep the Confluence runtime, CLI, MCP, standalone panel and Skills working. The DSH plugin was removed on 2026-11-20; do not add DSH host or client code back here. Read README.md and docs/implementation-plan.md for contracts.

- Never commit credentials, real page bodies, screenshots containing company content, or production response fixtures.
- Credentials belong in the per-user data home. On Windows use DPAPI CurrentUser; never put plaintext credentials in command arguments or tool results.
- Real-server checks are read-only or non-persisting format conversions unless the user identifies a page/write operation. Test creation and updates against synthetic fixtures.
- Preserve original storage outside the selected edit range. Never round-trip an entire existing page through a lossy wiki/Markdown conversion for a partial edit.
- Require the read page version for updates. Do not automatically retry writes with an uncertain result.
- Run installs, builds and verification through scripts/run-bounded.ps1. It owns a Windows Job Object and closes all descendants in finally. Never terminate processes by image name.
- Task temporary files belong in .task-temp/<task>/ and must be removed after task processes stop. Keep only redacted verification records; keep packaged releases and user exports as deliverables.

Checks: bounded dependency install, build, tsc --noEmit, node --test --test-timeout=30000 tests/*.test.mjs, Skill validation and read-only connection checks.
