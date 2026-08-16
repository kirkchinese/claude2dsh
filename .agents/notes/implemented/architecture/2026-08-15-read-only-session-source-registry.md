# Read-only bundle skeleton and session-source registry

Date: 2026-08-15

## Status

Implemented by the change that introduces the `claude2dsh` package skeleton.

## Context

The first useful integration will read Claude Code session data, but this stage must not parse, import, or mutate any user data. The package still needs a stable place for source-specific implementations to attach without making the eventual Claude Code implementation the registry itself.

DSH `0.1.0-rc.6` loads JavaScript modules as Cordis plugins and discovers bundles from the `dsh.bundle.patch` package-manifest field. Cordis treats registrations as effects: cleanup belongs to the plugin fiber that created the effect.

## Decision

The package root is a Cordis object plugin represented entirely by named exports. `apply()` provides one `SessionSourceRegistry` service as `ctx.sessionSources`. The required Schemastery configuration accepts only `mode: read-only`; there is no omitted-value default and no write-capable value.

A session-source adapter has only an `id` and `displayName` in this stage. `register()` rejects a duplicate live id, stores the adapter in registration order, and returns the Cordis effect disposer. The service exposes exact lookup and a detached list snapshot. Disposal of either the returned handle or the registering plugin fiber removes the registration.

The DSH bundle patch inserts only the registry plugin with the explicit read-only mode. It contains no source path, adapter row, import command, or persistence plugin.

## Why the adapter is metadata-only

Adding discovery or parsing methods before examining the first implementation would encode assumptions about enumeration, incremental reads, error reporting, and transcript identity. Those decisions belong with the Claude Code adapter stage, where tests can exercise real copied fixtures. Keeping the initial interface metadata-only allows that stage to add the smallest operations justified by observed data.

## Alternatives considered

A Claude-specific service was rejected because it would make other session sources second-class and couple DSH consumers to one on-disk format.

A registry implemented as a module-level map was rejected because entries would survive Cordis plugin unloads and tests could leak state across application instances.

An optional configuration defaulting to read-only was rejected because omission would hide a deployment choice. A boolean write flag was also rejected because it would advertise a mode this release cannot implement.

Mounting the complete file-backed Include plugin in the patch test was unnecessary and would add file-tree lifecycle behavior to a pure patch assertion. The test instead uses Include's exported `entryListSchema` and `applyEntryPatches`, which are the parser and patch semantics used by the production Include path.

## Safety and follow-up constraints

The skeleton must remain side-effect free beyond in-memory Cordis registration. Installing or activating it must not inspect `~/.claude` and must not create or modify `~/.dsh`.

The first source adapter must be a separate lifecycle-owned plugin. Parsing and import execution must remain distinct operations, and write behavior must require a new explicit configuration value rather than changing the meaning of `read-only`.
