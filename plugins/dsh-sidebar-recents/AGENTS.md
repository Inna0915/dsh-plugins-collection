# DSH sidebar recents

Read docs/development-plan.md before implementation. The user transferred remaining fixes and installation to Codex on 2026-10-27; the user performs final visual acceptance.

- Do not modify installed official DSH packages or app.asar. Keep the plugin removable and preserve existing sidebar actions.
- Use explicit command timeouts and clean the entire owned process tree in finally. Never terminate processes by image name. The user's existing Desktop host is not a test-owned process.
- Temporary work belongs in .task-temp/; remove task-owned unused scripts, caches and fixtures before completion. Keep only minimal verification evidence in docs/.
- Do not expose credentials, user conversation contents or private configuration in deliverables.
- Do not publish packages or push repositories. Never alter model, credentials, proxies or security settings.
