# Changelog

## 0.1.0 — 2026-08-16

### Added

- Bidirectional conflict baseline: when both Claude and DSH sides grew after the last sync watermark, import/sync reports `conflict` and auto-mirror pauses with a persisted record; neither side is overwritten.
- Auto-mirror hardening: live-session skip, persisted pending queue, boot-time queue drain, conflict pause/status/resume tool, and watcher failure-injection tests.
- DSH runtime compatibility gate (`@deepseek-ai/dsh-session` peer + session format version) with CI check against the newest published DSH rc.
- Generic tool cards for import/sync/autosync calls and results.
- Fail-loud hook bridge config validation before bridge activation.
- Plugin asset-name sanitization, project-specific AGENTS.md, GitHub Actions CI and CHANGELOG.

### Changed

- Auto-mirror and hook bridge docs no longer carry the beta label: the integration layer is stable within the documented upstream subset (7/30 command-only hooks).

## 0.1.0-rc.2 — 2026-08-16

### Fixed

- Published npm manifests no longer contain `workspace:` dependency protocols. The rc.1 packages were deprecated because `dsh plugin add @claude2dsh/plugin` failed on a clean machine.

### Added

- Real-registry empty-environment acceptance: fresh profile, npm install, one-session import and skills import all pass.

## 0.1.0-rc.1 — 2026-08-16 (deprecated)

### Added

- Claude Code session import with incremental append.
- Claude Code skill migration.
- DSH -> Claude Code export and incremental sync.
- Image capability detection with placeholder fallback and attachment retention.
- Optional beta auto-mirror (default off).
- Optional Claude hook bridge via the official DSH hook bridge package.
- Read-only Claude Code plugin asset inventory.

### Known issues

- Published manifest contained `workspace:` protocol dependencies; fixed in rc.2.
