# Claude2DSH

[![Awesome DSH Plugin](https://awesome-dsh-plugin.com/badge.svg)](https://awesome-dsh-plugin.com)

把 Claude Code 的会话、技能、记忆与插件资产迁移为 DeepSeek Harness（DSH）原生可续聊会话，并可把 DSH 会话导出/同步回 Claude Code JSONL。Claude Code 是多工具迁移层的第一个会话源适配器。

本项目已被社区 [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) 收录在 **Sessions & Messages（会话与消息）** 分类。自动雷达 [awesome-dsh-plugins](https://github.com/AdamPlatin123/awesome-dsh-plugins) 尚未给本项目打"运行级验证"标记；上方 badge 只代表精选列表收录，不代表雷达实测结论。

## 快速开始（空机器）

要求：Node.js `>=22.19.0`、pnpm 与 `dsh` CLI。

```sh
# 1. 创建带本 bundle 的 DSH profile
dsh plugin --profile claude2dsh add @claude2dsh/plugin

# 2. 导入全部 Claude Code 会话（只读）与技能
#    在 DSH 会话（web profile）中调用：
#      claude2dsh_import({ path: "~/.claude/projects" })
#      claude2dsh_import_skills({ path: "~/.claude/skills" })
#    也可以用测试 seam 启动一次：
#      CLAUDE2DSH_TEST_IMPORT=~/.claude/projects dsh --profile claude2dsh
```

profile 会自动安装 `@deepseek-ai/dsh-base`，并把 `@claude2dsh/plugin` 作为 bundle 加入。安装后请重启 DSH。

## 能力

| 工具                          | 行为                                                                                                                                                                                                                               |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `claude2dsh_import`           | 只读读取 Claude Code JSONL，通过 `ctx.sessionPersistence` 写 DSH 原生会话日志。幂等；变长的 Claude 转录只追加新轮次。`preview:true` 零副作用；`includeSubagents:true` 把 subagent/workflow 转录导入为 `origin:"subagent"` 子会话。 |
| `claude2dsh_import_skills`    | 把 kebab-case 命名的 Claude 技能复制到 `$DSH_HOME/skills`；内容相同则跳过，冲突绝不覆盖。                                                                                                                                          |
| `claude2dsh_import_context`   | 把用户全局 `~/.claude/CLAUDE.md` 复制到 `$DSH_HOME/AGENTS.md`。默认 preview，相同内容跳过，目标已有不同内容时报告冲突、绝不覆盖。项目级 CLAUDE.md 不迁移，因为 DSH 原生读取。                                                      |
| `claude2dsh_import_memory`    | 把一个项目的 `MEMORY.md` 与 `memory/*.md` 打包为 `$DSH_HOME/skills` 下的 DSH 原生技能包；preview、相同跳过、绝不覆盖。                                                                                                             |
| `claude2dsh_export`           | 把一个 DSH 会话序列化为 `$DSH_HOME/claude2dsh/exports` 下的 Claude Code JSONL。写真实 `~/.claude` 需显式 `allowOriginalClaudeDir:true`；已存在文件需 `force:true`。                                                                |
| `claude2dsh_sync`             | 把晚于导出水位的 DSH 轮次追加到导出的 Claude 副本（默认 `target:"copy"`）。`target:"source"` 需显式 `allowOriginalClaudeDir:true`；外部改动/缩短有保护，除非 `force:true`。                                                        |
| `claude2dsh_merge`            | 双端都在同步水位后增长时的显式三路合并。完整轮次按时间排序；同一轮双改保留双方并写入 log-only 冲突标记。原始 DSH 会话与 Claude JSONL 都不被修改，产物是新安全副本；`dryRun:true` 只计算不写。                                      |
| `claude2dsh_autosync`         | `status` 查看镜像暂停状态、原因、最近冲突与待处理队列；`resume` 在用户用显式工具解决冲突后解除暂停。                                                                                                                               |
| `claude2dsh_sidecars`         | 列出/解析导入时复制到 `$DSH_HOME/claude2dsh/sidecars` 的 tool-result `.txt` sidecar。Claude 原始路径引用保持不变，映射负责翻译。                                                                                                   |
| `claude2dsh_session_sources`  | 列出/解析每个导入会话的来源标记：`claude-main`、`claude-subagent`、`claude-merged`（预留 `codex`/`native`）。                                                                                                                      |
| `claude2dsh_plugin_inventory` | 只读盘点已安装 Claude Code 插件；`apply:true` 只复制声明式 `SKILL.md` 资产，绝不执行 hooks/app-server 代码。                                                                                                                       |
| 图片策略                      | `claude2dsh_import` 支持 `imageMode:"auto"`（默认）、`"placeholder"`、`"native"`。`auto` 探测目标模型 `inputModalities`：支持图片的模型获得原生 DSH attachment block；纯文本模型获得安全占位符，附件保留并可在切换模型后重投影。   |

Settings 面板：插件在 DSH Settings UI 中提供 **Claude2DSH** 页面，管理 auto-mirror、导入默认值、导出/写回与 hook bridge 字段；保存时校验，坏值会返回 schema 错误。工具参数与 `CLAUDE2DSH_*` 环境变量继续可用，调用时参数优先。

## 诚实局限

- Claude hook bridge **默认关闭、需显式开启**：wrapper 在上游 `@deepseek-ai/dsh-hooks-claude-code` 之外做启动前配置校验，坏 `hooks.json` 会带路径 fail loud。上游支持 **Claude Code 30 个 hook 事件中的 7 个**，且仅 `type:"command"` handler，各事件语义部分实现；hook 运行会以 `hook/invoked` + `hook/result` 事件对写入会话日志。全兼容是 roadmap 目标，不是现状承诺。
- 原生图片路径已实现，但尚未在真实支持视觉的 DSH 模型路由上验收；随附 DeepSeek adapter 声明仅文本输入。
- Auto mirror **默认关闭、需显式开启**。启用 `autoSync.enabled: true` 后监控 Claude 转录，并把 DSH 轮次镜像到安全导出副本；绝不写真实 `~/.claude`。双端在同步点后同时增长时暂停并报告冲突；用 `claude2dsh_autosync` 查看/恢复。
- 完整插件运行时兼容性是 roadmap 目标。自动合并冲突现在由显式 `claude2dsh_merge` 工具承担；自动镜像仍只暂停报告，不猜测。

## 安全边界

- 迁移对 `~/.claude` 只读；导出/同步默认绝不写原始 Claude 目录。
- DSH 写入只经过宿主持久化（`$DSH_HOME/sessions`）、DSH 原生技能根（`$DSH_HOME/skills`）与 sidecar registry（`$DSH_HOME/claude2dsh`）。
- 验证始终使用源数据副本，绝不使用真实原始目录。

## 仓库布局

```
src/                                 根 bundle：sessionSources registry 插件
packages/core/                       归一化会话 IR + DSH 事件合成 + tail 逻辑
packages/adapters/claude-code/       Claude Code adapter
packages/plugin/                     DSH 插件 bundle：@claude2dsh/plugin
scripts/e2e-round*.sh                可复现验收脚本
docs/                                设计、调研与验证记录
```

## 开发验证

```sh
pnpm install
pnpm run check
pnpm -r build && pnpm -r typecheck && pnpm -r test

CLAUDE2DSH_SOURCE_BACKUP=/tmp/claude2dsh-source-backup bash scripts/e2e-round1.sh
CLAUDE2DSH_SOURCE_BACKUP=/tmp/claude2dsh-source-backup bash scripts/e2e-round2-claude-recognition.sh
CLAUDE2DSH_SOURCE_BACKUP=/tmp/claude2dsh-source-backup bash scripts/e2e-round3-bidirectional.sh
CLAUDE2DSH_SOURCE_BACKUP=/tmp/claude2dsh-source-backup bash scripts/e2e-round4-subagents.sh
bash scripts/e2e-round7-merge.sh
```

Round 2 与 Round 3 使用真实 `claude` 二进制连接本地 mock Anthropic 端点，不产生真实 API 请求。

## 许可与致谢

MIT。设计对照了 `dsh-chat-import`（MIT）与 `dsh-claude-move`（Apache-2.0），感谢两个项目的参考价值。Hook 兼容层委托给 DeepSeek Harness 官方 hook bridge 包。
