# 架构

[English](overview.md) · 中文

## 包

```text
packages/
  core/     @kirkchinese/harness-forge-core：纯逻辑，不依赖 DSH 运行时
  plugin/   @kirkchinese/harness-forge：DSH 插件，一个包、多个行
  testkit/  私有的端到端冒烟测试，跑在真实 DSH 上
```

**core** 只依赖 Node 标准库和少量纯工具库（`yaml`、`smol-toml`、`ajv`），包含：

- **方言**（`src/dialects/`）：每个工具一个文件夹，共用一个 `Dialect` 接口和一个注册表。方言声明自己的标记（清单、无清单的目录结构或通用格式兜底）、扫描插件根目录，并可选地给出默认发现文件夹、用户自己的资产、工具自己记录的插件、项目资产和会话来源。内置方言按识别顺序为：Claude Code（`.claude-plugin/plugin.json`、`~/.claude`、`.claude/`、会话记录）、Codex（`.codex-plugin/plugin.json`、`~/.codex`、`.codex/`）、OpenCode（`opencode.json`、代码插件），以及两种通用格式：Agent Plugins（可移植的 `plugin.json`）和 Agent Skills（列出的文件夹，内含 `<name>/SKILL.md`，可附带 `.mcp.json`；默认是 Gemini CLI 的 `~/.gemini/skills`）。`discoverPlugins`、`detectSource` 和 `scanRoot` 只经过注册表；`registerDialect` 可以再加一个；
- **组件模型**（`ForeignPlugin`、`ForeignComponent`）：每个部分都是技能、命令、智能体、hook、MCP 服务、设置、代码、界面或“其他”组件之一。无法映射的部分带着缺口留在模型里，不会被丢掉；
- **计划**（`planPlugin`）与 **评估**（`assess`、`collectGaps`）：插件需要什么、实际做到了什么、有哪些缺口；
- **指令文件发现**（`loadInstructions`）：DSH 自己不读的指令文件；
- **会话解析**：把 Claude Code 的会话记录读成统一模型，再写成 DSH 会话日志；
- **移植说明**（`portBrief`）：**用 AI 补上** 使用的 Markdown 任务；
- 插件市场、命名、许可证、指纹。

**plugin** 依赖 core 和 DSH 的服务。**testkit** 把两者打包，在真实 DSH 里运行。

## 行

插件包为每一行提供一个 [Cordis](https://www.npmjs.com/package/@deepseek-ai/cordis) 插件；安装时由 [`cordis.patch.yml`](../../packages/plugin/cordis.patch.yml) 把它们全部插入 profile。每一行是包的一个 `exports` 入口，在 DSH 的 **插件** 页面里显示为单独的一行，可以单独关闭。

| 行 id | 导出 | 源码 | 作用 |
|---|---|---|---|
| `harness-forge` | `.` | `src/index.ts` | 提供共享服务：账本、导入的设置、项目资产、轮次效果；`/harness`、`harness_*` 模型工具和随包技能 |
| `harness-forge-skills` | `./skills` | `src/skills/row.ts` | 为导入的 `SKILL.md` 提供一个 DSH 技能源；调用时应用 frontmatter |
| `harness-forge-commands` | `./commands` | `src/commands/row.ts` | 导入的斜杠命令和输出风格 |
| `harness-forge-agents` | `./agents` | `src/agents/row.ts` | 导入的智能体作为 DSH 智能体预设，通过一个委派工具提供 |
| `harness-forge-hooks` | `./hooks` | `src/hooks/row.ts` | hook broker；Codex 的 `notify` 和全局指令 |
| `harness-forge-mcp` | `./mcp` | `src/mcp/row.ts` | MCP 服务：stdio、Streamable HTTP、SSE、OAuth |
| `harness-forge-mods` | `./mods` | `src/mods/row.ts` | Claude Code mods 引擎 |
| `harness-forge-opencode` | `./opencode` | `src/opencode/row.ts` | 在 Bun 中运行的 OpenCode 插件 |
| `harness-forge-context` | `./context` | `src/context/row.ts` | 把指令文件加进系统提示；让位给 Recollect |
| `harness-forge-sessions` | `./sessions` | `src/sessions/row.ts` | 会话导入；dsh-chat-import 运行时让位给它 |
| `harness-forge-porter` | `./porter` | `src/porting/row.ts` | 移植说明与创造模式会话 |
| `harness-forge-workbench` | `./workbench` | `src/workbench/row.ts` | 工作台页面调用的 Remote 方法（`harnessCompat` 命名空间） |

另外两个导出 `./preset-tool-filter` 和 `./preset-fs-search` 不是 profile 里的行：它们挂在为导入智能体生成的预设里，用来落实智能体的工具列表。

工作台页面本身是一个 DSH Web 客户端（`./client`，用 tsdown 构建），只通过 `harnessCompat` Remote 命名空间调用主机端，不注册自己的 HTTP 路由。

## 源码布局

每一行在 `packages/plugin/src` 下有一个文件夹，放它的入口（`row.ts`）和只有它用到的代码：

```text
index.ts     主行（harness-forge）：共享服务、/harness、模型工具
forge/       共享服务、契约、账本、状态、行辅助（rowEffect、Parts）、轮次效果、市场安装
skills/      技能行：技能源、随包技能
commands/    命令行：命令定义、输出风格
agents/      智能体行：智能体预设、委派工具、智能体配置
hooks/       hook 行：broker、执行器、工具名词表；Codex notify 和指令
mcp/         MCP 行：挂载、远程（HTTP/SSE）服务、OAuth、能力目录
mods/        mods 行：Claude Code mods 引擎
opencode/    OpenCode 行：Bun 运行时
context/     上下文行：指令文件
sessions/    会话行：Claude Code、Codex、OpenCode 会话导入，登记到运行中的 DSH；dsh-chat-import 运行时让位
porting/     移植行：移植说明与创造模式会话
workbench/   工作台行：Remote 服务、总览、设置、适配器覆盖、模型工具
presets/     ./preset-tool-filter 和 ./preset-fs-search 两个导出
shared/      多行共用：util、正文渲染、调用（frontmatter 指令）
dsh/         从 DSH 取用的一切（见下）
client/      工作台页面（浏览器包）
```

## 共享契约

各行之间从不互相 import，而是通过共享服务 `harnessForge`（[`src/forge/service.ts`](../../packages/plugin/src/forge/service.ts)）和 [`src/forge/contract.ts`](../../packages/plugin/src/forge/contract.ts) 里的契约协作：

- **挂载器。** 每类组件（`skill`、`command`、`output-style`、`mcp`、`hooks`、`agent`、`claude-mod`、`opencode-plugin`……）有一个挂载器，由负责它的行注册（`registerMounter`）。账本把计划里的每个动作映射到一类挂载（`mountKindOf`），再调用对应的挂载器。
- **行 API。** 一行可以向另一行请求的东西是一个小的可选 API（`HooksApi`、`SkillsApi`、`AgentsApi`、`CommandsApi`、`McpApi`、`ModsApi`、`SessionsApi`、`ContextApi`、`PorterApi`）。行用 `provide` 提供；别的行用 `lookup` 读取（那一行关闭时返回 `undefined`），或用 `watch`（现在运行一次，那一行每次启动时再运行，停止时释放）。例如 mods 行把 `tool.check` 加到钩子行的权限决定里、OpenCode 行加上 `shell.env`，都只在钩子行运行时生效。
- **运行证据。** 各行用 `observe(componentId, signal, ok, detail)` 报告运行结果，账本据此得出每个部分的状态。

## 隔离

- 每一行在 `rowEffect`（[`src/forge/row.ts`](../../packages/plugin/src/forge/row.ts)）里启动：启动时抛错只会记日志并记为这一行的故障，其他行照常运行；监听器的失败也同样记录。
- 行内由 `Parts` 分别启动各部分，一部分失败不影响其余部分；拆除时按启动的逆序执行每个 disposer，各自隔离。
- 所在行关闭的组件以 `inactive` 等待，行的挂载器一注册就挂载；行停止时把它的组件撤回为 `inactive`。
- 记录下的故障显示在工作台的 **诊断** 里。

## 状态

Harness Forge 把自己的状态放在 profile 目录的 `.harness-forge/` 下：账本（`state.json`）、用于撤销的回执，以及 `data/` 目录（插件数据、MCP 登录令牌、安装的 Bun）。它不修改 profile 的配置和已安装的包，插件从原工具安装的位置运行。

## 与 DSH 的接口

DSH 还在 1.0 之前，插件接口在版本之间会变。Harness Forge 从 DSH 取用的一切都经过 [`src/dsh/`](../../packages/plugin/src/dsh)，升级 DSH 时在这里核对：

| 模块 | 内容 |
|---|---|
| `host.ts` | 用到的所有 DSH 服务和事件，各注明声明它的 DSH 包；各行读服务、订阅事件只能经过它 |
| `session-records.ts` | 写进会话日志的记录：插件记录和 hook 记录（与 DSH 自己的 hook 写的 `hook/invoked` / `hook/result` 相同） |
| `subagents.ts` | 通过 DSH 的 `subagents` 服务启动委派的智能体 |
| `model-route.ts` | 为技能或智能体的 `model:` / `effort:` 切换智能体的模型 |
| `commands.ts` | 斜杠命令的拦截链 |

其中两处依赖的是 DSH 内部实现，而不是它声明的接口：

1. **命令拦截**（`commands.ts`）。DSH 的 `commands` 服务在 `execute` 周围没有钩子，但 Harness Forge 需要：导入的插件还在挂载时，输入的命令要等待；Claude Code mod 的 `command.run` hook 要能看到、回答或替换输入的命令。所以 `execute` 只包装一次，每个使用者往同一条有序链上加拦截器。DSH 提供钩子后只需改这个模块。
2. **退出检测**（`host.ts` 里的 `hostShuttingDown`）。DSH 没有公开的“正在退出”信号，但 Harness Forge 要区分 DSH 退出（结束每个进行中的会话并运行 `SessionEnd` hook）和自身重载（升级或改配置，会话继续）。它读取自身之上各 fiber 的 Cordis 4 状态（`DISPOSED`、`UNLOADING`），这两个数值由类型检查对照 Cordis 的枚举。

包声明 `engines.dsh: ">=0.2.2-rc.3"`；DSH 的包是可选 peer 依赖，使用宿主自己的那一份。CI 的 e2e 任务在支持的最新 DSH（0.2.2-rc.5）和最旧 DSH（0.2.2-rc.3）上各跑一遍。

## 可选集成

- 装有 [能力目录](https://github.com/kirkchinese/dsh-capability-catalog) 时，stdio MCP 服务经它的索引提供（`src/mcp/catalog.ts`），智能体的工具列表也能识别它的调用；
- 装有 [Recollect](https://github.com/kirkchinese/DSH-Recollect)（服务 `recollect`）时，指令文件行让位。

两者都按可选服务查找，都不是依赖。
