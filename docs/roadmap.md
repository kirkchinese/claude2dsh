# Post-release roadmap

Priorities are judged against the project mainline: Claude users should be able to move into DSH with minimal configuration and near-native continuity.

## Verified fact: DSH already reads CLAUDE.md

Before implementing any CLAUDE.md → AGENTS.md converter, the actual DSH mechanism was checked in the installed package
`@deepseek-ai/dsh-agent-instructions`:

- Default project candidates are exactly `['AGENTS.md', 'CLAUDE.md']`.
- Project root is the nearest ancestor containing `.git`.
- The user-global file is always `$DSH_HOME/AGENTS.md`.
- Sibling files whose trimmed content is identical are deduplicated; distinct `AGENTS.md` and `CLAUDE.md` are both loaded.
- Refresh is touch-driven (filesystem tools/resume), not a watcher.

Consequence: **do not copy project CLAUDE.md to AGENTS.md**. DSH already reads project CLAUDE.md natively. The only useful conversion is the user-global `~/.claude/CLAUDE.md` (when present) → `$DSH_HOME/AGENTS.md`, with preview/conflict rules. There is no need for a self-made injection channel; the mechanism to use is `dsh-agent-instructions` itself.

## Candidate list

| #   | Candidate                                                                                                      | 状态     | Priority            | Notes                                                                                                                       |
| --- | -------------------------------------------------------------------------------------------------------------- | -------- | ------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| 1   | Claude context migration: user-global `~/.claude/CLAUDE.md` → `$DSH_HOME/AGENTS.md` (preview, never overwrite) | 完成     | —                   | `claude2dsh_import_context`；实测 preview/相同跳过/冲突不覆盖。项目级 CLAUDE.md 不迁移。                                    |
| 2   | Claude memory migration: `MEMORY.md` + `memory/*.md` → DSH skill bundle                                        | 完成     | —                   | `claude2dsh_import_memory`；每项目一个 kebab-case 技能包，DSH 原生发现。                                                    |
| 3   | Tool-result .txt sidecar migration                                                                             | 完成     | —                   | 引用发现、可配置大小上限、默认拷贝+保留原引用+映射；`claude2dsh_sidecars`。实测 5 个 sidecar 全部拷贝。                     |
| 4   | Import performance and progress                                                                                | 未开始   | Medium              | 流式解析、批处理与进度 UI 仍可做；当前全量导入规模无阻塞。                                                                  |
| 5   | Bidirectional concurrent conflict merge                                                                        | 完成     | —                   | 底线 + 增强都已实现：`claude2dsh_merge` 两个方向，同轮双改保留双方 + log-only 标记；e2e round7 原生校验。                   |
| 6   | Auto-mirror hardening and exit beta                                                                            | 完成     | —                   | live-session 跳过、队列持久化、重启 drain、状态工具、冲突暂停、失败注入测试。                                               |
| 7   | Hook semantic expansion (upstream or fork)                                                                     | 未开始   | Low                 | wrapper 已形式化；上游仍 7/30 command-only。                                                                                |
| 8   | Vision model real acceptance                                                                                   | 阻塞     | Low now, high later | 需真实视觉 DSH route。                                                                                                      |
| 9   | Codex session-source adapter                                                                                   | 未开始   | Low                 | IR 已预留 `codex` 来源标记。                                                                                                |
| 10  | Plugin directory inclusion                                                                                     | 部分完成 | Low                 | awesome-dsh-plugin 已收录（EN line 384）；radar 提交方案待用户确认。                                                        |
| 11  | First-run migration guide                                                                                      | 未开始   | High                | 用户已确认发布后跟进。                                                                                                      |
| 12  | DSH Settings panel                                                                                             | 完成     | —                   | `claude2dsh` namespace + `/plugins/claude2dsh/settings` + web Settings 页面；坏值 fail loud 实测。                          |
| 13  | Session-list source decoration                                                                                 | 受限     | —                   | DSH `sidebar.workspaces` 为 single slot，无 row 扩展点；已落 sidecar `claude2dsh_session_sources`，前端替代方案待用户选择。 |
| 14  | DSH-Session-Move interop                                                                                       | 完成     | —                   | 评估见 `docs/research-session-move.md`：不合并，做互操作入口与联合验收。                                                    |
