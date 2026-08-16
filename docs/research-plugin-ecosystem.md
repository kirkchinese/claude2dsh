# 调研三：Claude Code 插件生态迁移

## “迁移指什么”必须拆成两种语义

1. 资产清单/技能清单迁移：把 `installed_plugins.json`、
   marketplaces 里的 commands/agents/prompts/skills 等声明性资产
   转成 DSH 的 skills/commands 资产。
2. 运行时能力迁移：让 Claude 插件代码（hooks、app-server、脚本）在
   DSH 里继续执行。

两者可行性完全不同。

## 副本勘察证据

- `installed_plugins.json`（version 2）：2 个插件
  - `codex@openai-codex` 1.0.6
  - `i-have-adhd@i-have-adhd` 0.1.0
- `known_marketplaces.json`：3 个 marketplace（claude-plugins-official、
  openai-codex、i-have-adhd）。
- codex 插件目录实含：`commands/*.md`（9 个）、`agents/*.md`、
  `prompts/*.md`、`skills/*/SKILL.md`（3 个）、`hooks/hooks.json`、
  `scripts/*.mjs`（app-server/broker 等大量运行时代码）。
- i-have-adhd 实含：`hooks/hooks.json`（SessionStart）、
  `hooks/always-on.{sh,ps1,mjs}`、跨工具 manifest（claude/codex/kimi/
  gemini/qwen）。
- `session-env/`：43 个会话目录，仅 12 个 `sessionstart-hook-0.sh`
  文件，是某次会话的 hook 环境快照，不是可重用的插件资产。

## 对照 DSH 机制

- DSH 技能：`$DSH_HOME/skills/<name>/SKILL.md`，frontmatter
  `name/description`（kebab-case）——与 Claude 的
  `plugins/**/skills/*/SKILL.md` 结构高度同构。
- DSH 插件：Cordis bundle/plugin，JS/TS 模块，`ctx.tools`、
  `ctx.sessionPersistence` 等 API；与 Claude 插件 hooks/app-server
  协议完全不同，不存在通用执行器。

## 结论

- 资产清单迁移：**可行，代价低**。可新增 `claude2dsh_import_plugins`
  （dry-run 默认），输出 inventory，并把可映射的 skills/commands/
  agents/prompts 生成 DSH skills。
- 运行时能力迁移：**不可行作为通用自动迁移**。codex 插件依赖 Claude
  Code 的 app-server/hook 协议；i-have-adhd 依赖 SessionStart hook。
  只能按插件逐一用 DSH 插件 API 重写（例如 codex 可作为 DSH subagent
  provider），属于新产品功能而非迁移。
- session-env：只做 inventory，不迁移。

优先级：资产清单+skills 中；运行时移植低（按需单独立项）。


## 补充：统一 hook 适配层（2026-08-16 源码仓库核对）

### 上游事实（GitHub deepseek-ai/deepseek-harness @ 47f9438）

- 仓库已有完整 hooks 子系统：
  - `packages/hooks/hook-protocol`：共享 shell-hook 协议（matcher、
    codec、merge、`hook/*` 事件）。
  - `packages/hooks/hooks-claude-code`：Claude Code hook bridge。
  - `packages/hooks/hooks-codex`：Codex hook bridge。
- `@deepseek-ai/dsh-hooks-claude-code` 与 `@deepseek-ai/dsh-hook-protocol`
  的 npm 版本均已有 `0.1.0-rc.6`（本机 DSH 同版本），可直接依赖。
- 桥接映射：`SessionStart`→`agent/session-start`、
  `UserPromptSubmit`→`agent/pre-step`、`PreToolUse`→`tools/pre-execute`、
  `PostToolUse`→`tools/post-execute`、`Stop`→`agent/turn-stopping`、
  `SubagentStart/Stop`→`subagent/start|end`。
- 官方 Known Limitations 白纸黑字：
  - Claude Code 当前 30 个 hook 事件只支持 7 个；23 个不支持。
  - 只执行 `type:'command'` handler；http/mcp_tool/prompt/agent
    handler 全部跳过。
  - 多个 hook 部分语义：SessionStart 不能 block、PreToolUse 无
    updatedInput、PostToolUse 无 updatedToolOutput、Stop 无连续阻断
    上限、subagent 信息部分缺失等。

### 结论

- **统一适配层不需要从零造轮子：上游 bridge 就是正确底座。**
  “兼容全部旧插件”的真实上界 = **command-only 的 7/30 事件子集 + 每
  事件的部分语义**；它不是全兼容层，但已是可销售的兼容卖点。
- 值得做：作为可选 beta 依赖集成上游 bridge，并自动发现/装载用户
  Claude hooks 配置；不自行重写协议。
- 代价量级：接入与文档约 0.5–1 天；向更多事件扩展需修改上游仓库或
  fork，单个事件 0.5–2 天不等，且部分事件在 DSH 没有对应扩展点。
- 优先级：作为卖点中；但首发版本可只提供“可选桥接开关”，把上游
  限制写进 README。
