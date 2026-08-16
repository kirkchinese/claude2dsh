# 竞品分析（核验日期：2026-08-15）

两个仓库均已克隆并核验 HEAD；issue 区经 `gh api` 拉取（含评论）。

## dsh-chat-import（Nwflower）

- HEAD：`8a61dc7055d88dd712c6adb7fddc89cafb10cc60`，License：MIT。
- 测试基线：`node --test` 共 239 例，234 通过；5 例失败均为测试环境缺少
  `@deepseek-ai/dsh-tools` peer 依赖（ERR_MODULE_NOT_FOUND），非断言失败。
- 功能清单：
  - 15 个导入工具：claude/codex/chatgpt/cursor/gemini/reasonix/pi/opencode/
    zcode/grokbuild/openclaw/hermes/kimi/dsh/任意本地 JSONL。
  - 导入产物：通过 host `ctx.sessionPersistence.create/append` 写入 DSH 原生
    事件日志；按源 `cwd` 挂 workspace；预热 projection。
  - 幂等与增量：registry（`$DSH_HOME/dsh-chat-import/imports.json`）以源文件
    路径为键，mtime/size/version 指纹；源文件增长时按 turn 边界 append 新轮。
  - 反向：`export_claude`（DSH 事件 → Claude JSONL）、`sync_to_claude`
    （DSH 新轮增量追加回 Claude 文件，带 size/version/尾 uuid 三闸守卫）。
  - 其他：`scan_discover`、web 面板、`/import` 命令、context-bridge（默认关）。
- 已核实局限：
  - Claude 转换只处理主 transcript（文件名 = sessionId），**跳过全部
    subagents/workflows 转录**（按 auxiliary transcript 返回 skip）。
  - Claude 转换只识别 `user`（字符串直问）/`assistant`/`ai-title`/`summary`
    标题/`permission` 计数；**attachment、system、queue-operation、
    last-prompt、mode、file-history-* 等记录不进入 DSH 日志，也不保留
    原始记录**，无法从 DSH 端无损还原 Claude 文件。
  - `export_claude` 默认写入 `~/.claude/projects`（仅 `createIfAbsent`），
    **没有"写回 Claude 侧默认关闭 + 用户显式授权"的安全边界**；与本项目
    safety_rules 冲突。
  - `sync_to_claude` 只对带 `session/imported` 标记且 registry 有记录的导入
    会话生效，不覆盖 DSH 原生会话 → Claude 的反向通道。
  - 反向同步依赖用户在 DSH 里手动调用工具，**不是自动双向镜像**。
  - Claude Code 技能没有持久迁移工具；`import_agents` 只覆盖 pi/opencode，
    `context-bridge` 只做进程内注入且默认关闭。
  - 无真实 Claude 数据验收记录（README 无本机真实数据测试证据）；未处理
    Claude 主链分支选择（`isSidechain`/多子节点）问题。
  - issue 区：#4 曾出现 peer 依赖版本不一致导致工具调度器崩溃（已随 PR#5
    修复）；#2 为第三方收录致谢。未见与本项目"双向原生体验"相同的要求。

## dsh-claude-move（PerryLink）

- HEAD：`1c00376ba5dab1351d07dbabe81b266fa302ff1b`，License：Apache-2.0。
- 测试基线：`node --test` 共 58 例，53 通过；5 例失败均为测试环境缺少 peer
  依赖（ERR_MODULE_NOT_FOUND），非断言失败。
- 功能清单：
  - Claude 自动发现 + 流式扫描索引（mtime/ctime 增量缓存）。
  - 会话导入为 DSH 原生事件（turn/step/user/assistant/tool call/result）。
  - memory、全局/项目 CLAUDE.md 注入 systemPrompt；Claude skills 注册为
    SkillProvider（进程内）。
  - `/claude-import-all`、`/resume-claude` 命令与 web 面板。
- 已核实局限：
  - **无任何 DSH → Claude 反向能力**（README 明确 copy-only）。
  - issue #1（open，含评论）：把 `~/.claude/skills/README.md` 当技能注册，
    name 推断为 `readme`、description 为空，触发 DSH 技能校验失败；评论追加
    报告"回合中断的工具调用"导入后生成重复 tool/result，会话永久 400。
    截至核验 HEAD 仍未修复（`lib/skills-provider.mjs` 仍
    `description: meta.description ?? ''`）。
  - skills 是运行时 provider（进程内），**不落盘为 DSH 技能资产**，重启后
    依赖每次扫描；不迁移技能资源文件。
  - 不支持 subagents/workflows 转录。
  - 不保留 Claude 原始记录，反向还原不可能。
  - 无多工具源抽象（仅 Claude）。

## 复用评估结论（已交用户决策）

用户选择：**完全自研（仅参考，不复制代码）**。本项目不 vendor、不复制竞品
源码；公开格式事实与 DSH API 行为以本机源码/数据实测为准。
