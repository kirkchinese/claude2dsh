# @dsh2claude/adapter-dsh

DeepSeek Harness source adapter for DSH2Claude.

- Discovers `session.vN.jsonl` and `session.vN.jsonl.zstd` files under `$DSH_HOME/sessions/<workspace>/<session>/`.
- Decodes concatenated Zstandard frames without a native dependency (Node `node:zlib` one-shot decompression per scanned frame) and reports a torn final frame.
- Reads the v3/v4 header record and normalizes the event log into `ForeignSessionView`.
- Rewrites v4 `tool/result` messages into the Anthropic-shaped `{type:"tool_result", tool_use_id, content}` blocks the Claude serializer expects.
- Counts injected user messages, malformed lines, tool calls/results, dropped images, and torn bytes.
