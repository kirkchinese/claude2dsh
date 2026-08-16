# Changelog

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
