# DSH2Claude

**把 DeepSeek Harness（DSH）的会话、技能、全局指令与 MCP 服务器迁移到 Claude Code，生成可直接续聊的原生会话与资产。**

这是 Claude2DSH 的反向版本：源是 DeepSeek Harness（`$DSH_HOME`），目标是 Claude Code（`~/.claude` 或 `CLAUDE_CONFIG_DIR`）。迁移分两步：先暂存到 `$DSH_HOME/dsh2claude`，再由用户显式确认安装到 Claude Code。

## 迁移内容

| 源                                                                                          | 目标                                          |
| ------------------------------------------------------------------------------------------- | --------------------------------------------- |
| `$DSH_HOME/sessions/...`（`session.v3` / `session.v4` JSONL，明文或拼接 zstd）              | `~/.claude/projects/<slug>/<会话 UUID>.jsonl` |
| `$DSH_HOME/skills/<name>/SKILL.md` 与扁平 `*.md` 技能                                       | `~/.claude/skills/<name>/`                    |
| `$DSH_HOME/AGENTS.md`                                                                       | `~/.claude/CLAUDE.md`                         |
| profile patch 与 `$DSH_HOME/storages/mcp_connector.json` 中的 `@deepseek-ai/dsh-mcp-client` | `~/.claude.json` 的 `mcpServers`              |

会话会变成 Claude Code 原生 JSONL：`parentUuid` 链连续、工具结果挂在其调用所属的 assistant 记录下、保留原始 `cwd`。Claude 侧会话 UUID 由 DSH 会话 id 确定性派生，重复迁移不会产生重复副本。

## 环境要求

- Node.js `>=22.19.0`（使用 `node:zlib` 的 Zstandard）。
- pnpm，以及已经产生 `$DSH_HOME` 数据（默认 `~/.dsh`）的 DSH 安装。
- 用于读取结果的 Claude Code。

## 安装

从当前仓库：

```sh
pnpm install
pnpm -r build
dsh plugin --profile web add ./packages/plugin/.local
dsh web
```

`pnpm -r build` 还会生成 `packages/plugin/.local`：这是一个自包含包，会把 workspace 内的依赖打进 bundle，安装器不会再遇到 `workspace:` 协议。然后打开 **设置 → DSH2Claude**。

发布后的等价命令：

```sh
dsh plugin --profile web add @dsh2claude/plugin@0.4.0
```

## 两阶段迁移

1. **暂存**（`dsh2claude_migrate` 或设置页按钮）。只读 `$DSH_HOME`，只写 `$DSH_HOME/dsh2claude/staging`：
   - `projects/<slug>/<uuid>.jsonl`：转换后的 Claude 会话
   - `skills/<name>/`：复制的 DSH 技能
   - `CLAUDE.md`：来自 `$DSH_HOME/AGENTS.md`
   - `mcp-servers.json`：规范化后的 MCP 声明
   - `manifest.json`：源路径、暂存路径、目标路径、哈希、安装状态

2. **安装**（`dsh2claude_install` 或“确认安装”）。把暂存内容复制进 Claude Code：
   - 默认只预览；必须传 `confirm: true` 才写入。
   - 目标已存在且内容不同时报告冲突。
   - `force: true` 会先把旧副本改名为 `<target>.dsh2claude-backup-<时间戳>`。
   - MCP 合并进 `~/.claude.json`，不改动无关条目。

## 工具

| 工具                  | 用途                                                                |
| --------------------- | ------------------------------------------------------------------- |
| `dsh2claude_migrate`  | 暂存会话与所选资产；`preview:true` 只报告、不写文件。               |
| `dsh2claude_install`  | 把暂存内容安装到 Claude Code；默认 dry-run，`confirm:true` 才写入。 |
| `dsh2claude_status`   | 查看 manifest、安装状态与解析后的 DSH/Claude 路径。                 |
| `dsh2claude_sessions` | 列出 DSH 会话及其标题、cwd、格式版本、暂存/安装状态。               |

## 会话转换规则

- **格式。** DSH 日志首行是 `type:"session"`、`version:3` 或 `4` 的头记录，之后是带 `seq` 的事件。文件可能是明文 `.jsonl`，也可能是每批一个 Zstandard frame 拼接而成的 `.jsonl.zstd`。读取器会扫描 frame 边界并逐个解压；末尾不完整的 frame 会被忽略并计入 `tornBytes`。
- **轮次。** 消费 `turn/start`、`step/start`、`user/message`、`assistant/message`、`tool/call`、`tool/result`、`step/end`、`turn/end`、`session/title`；其余 DSH 事件（`team/*`、`job/*`、`approval/*`、`compaction/*`、请求头、搜索轨迹等）忽略。
- **注入上下文。** `source.kind` 不是 `"user"` 的 user 消息（运行时上下文、时间上下文、技能目录、提醒）只计数、不迁移。只有真实用户提示会变成 Claude user 记录。
- **工具结果。** v4 把 `message.toolCallId` 和内容块直接放在 message 上；适配器会改写成 Claude 的 `{type:"tool_result", tool_use_id, content}` 形状。缺失的结果会补一个空结果，保持 assistant/tool 配对合法。
- **子代理。** DSH 子代理是独立日志，会迁移成独立的 Claude 会话；需要时打开 `includeSubagents`。
- **图片与推理。** 图片块会被计数并丢弃；DSH 的 reasoning 块也会丢弃，因为 Claude Code 的 thinking 块必须携带可验证签名，而 DSH 推理没有对应的签名载荷。可见文本与工具输出完整保留。
- **表面替换。** DSH 的 `surfaceOp: replace/remove` 会在渲染前折叠，被替换的消息只以替换后的形式出现一次。

## 安全模型

- 暂存阶段绝不写 `~/.claude`。
- 安装是唯一写入路径，且总是先预览。
- 目标路径会被解析并限制在 Claude home 内；manifest 中越界的路径会被拒绝。
- 已存在文件与技能目录按哈希比较：相同则跳过，不同则冲突；强制替换会保留带时间戳的备份。
- 原始 DSH 数据永远不会被修改。

## 当前限制

- **图片与推理**会被丢弃。图片包括 base64 与 DSH attachment 引用；推理缺少 Claude 兼容的签名载荷。
- **Agent preset、自定义命令、hooks、插件运行时行为**不迁移。DSH preset 是 Cordis 插件行组合，没有无损的 Claude agent 对应物。
- **DSH 特有事件**（team、jobs、compaction、goal、approval）无法在 Claude Code 中表示，会被省略。
- **MCP `cwd`** 在 Claude Code 的 stdio 配置中没有对应字段；命令会从 Claude Code 自己的工作目录启动。
- **暂不支持增量追加轮次。** 重新暂存会更新暂存文件；哈希变化后，安装会报告冲突，需要 `force` 才会替换已安装副本（并保留时间戳备份）。专门的 turn-append 路径留待后续。
- **MCP 配置路径。** 默认布局下合并到 `~/.claude.json`；自定义 Claude home 会写入 `<home>/.claude.json`。如果 Claude Code 使用其他全局配置文件，请手动合并 `mcp-servers.json`。

## 仓库结构

```
packages/core/                    共享的 foreign-session 类型
packages/adapters/dsh/            DSH 发现、zstd 解码、事件规范化
packages/adapters/claude-code/    Claude JSONL 序列化与目标路径/UUID 辅助
packages/plugin/                  DSH 插件：工具、设置、暂存、安装、UI
scripts/e2e-migration.mjs         合成数据的端到端迁移检查
```

## 开发

```sh
pnpm install
pnpm -r build
pnpm -r typecheck
pnpm -r test
node scripts/e2e-migration.mjs
```

适配器与插件测试会创建合成的 v3/v4 日志、拼接 zstd frame、技能、指令与 MCP profile 行；不会触碰真实的 `~/.claude`。

## License

[MIT](LICENSE)。
