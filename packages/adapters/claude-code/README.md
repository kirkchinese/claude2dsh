# @dsh2claude/adapter-claude-code

Claude Code target adapter for DSH2Claude. It serializes a `ForeignSessionView` into a Claude Code JSONL transcript with a contiguous `parentUuid` chain, native `tool_result` parenting, a `session/title` → `ai-title` mapping, and a headless tail serializer for appends. `target.ts` provides deterministic Claude session UUIDs, project-directory slugs, transcript validation, and staging writes.
