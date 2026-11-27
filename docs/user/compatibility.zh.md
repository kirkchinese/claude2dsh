# 兼容性

[English](compatibility.md) · 中文

Harness Forge 不给整个插件打“支持 / 不支持”的标签，而是看插件的每个部分（一个技能、一条命令、一个智能体、一份 hook 配置、一个 MCP 服务、一段代码、一个界面……），报告它在 DSH 里实际怎样。

## 一个部分怎么判定

迁移前，状态是根据插件文件做的预计；迁移后，状态来自实际发生的事：

| 记录 | 何时写下 |
|---|---|
| 已挂载 | 已在 DSH 里设置好，还没运行过 |
| 已验证 | 在 DSH 里运行过：hook 被执行、工具被调用、技能被加载、命令被派发、智能体跑过 |
| 失败 | 设置时出错，或某次运行失败；保留错误原文 |
| 运行观察 | 之后每次运行的成功或失败，按信号记录（每个信号保留最近一次） |

工作台把这些记录和文件里发现的缺口合成为每个部分的一个状态：

| 状态 | 含义 |
|---|---|
| 可用 | 已设置好，没有已知缺口；在 DSH 里实际运行过之后标为已核对 |
| 部分可用 | 已设置好，但它用到的某些东西 DSH 里没有（例如 DSH 不触发的事件），或部分运行失败 |
| 需要适配器 | DSH 没有对应功能，但适配器可以补上：**用 AI 补上**（[移植](porting.zh.md)） |
| 无法使用 | DSH 没有对应功能，本地也无法替代 |
| 出错 | 设置失败，或每次运行都失败 |
| 未启用 | 负责这类部分的行已关闭 |

由已安装的适配器提供的部分显示为可用，但在它真正运行之前不算已核对。

## 按类型

| 类型 | 能做到什么 |
|---|---|
| 技能 | 从原安装位置直接提供。加载时展开 `${CLAUDE_SKILL_DIR}`、`${CLAUDE_PLUGIN_ROOT}` 和 `` !`command` ``；调用时 `allowed-tools`、`model`、`effort`、`context: fork` 生效；frontmatter 里的 hook 由钩子行执行 |
| 命令 | `/<插件>-<命令>`（你自己的命令保留原名）。`$ARGUMENTS`、`$0`/`$1`、命名参数、`${CLAUDE_PLUGIN_ROOT}`、`!` 命令和 `@文件` 按 Claude Code 的规则处理，出于安全的差别见下文《命令与 skill：参数、`!` 和 `@文件`》。Codex 提示词和 OpenCode 命令也作为命令 |
| 输出风格 | 加到系统提示里，用 `/output-style` 选择。DSH 保留自己的编码指令，`keep-coding-instructions: false` 无法去掉它们 |
| 智能体 | 成为 DSH 智能体预设，通过一个委派工具提供，带提示词、工具列表、`model`、`skills`、`mcpServers`、`maxTurns`、`memory`、`isolation: worktree` 和 `initialPrompt` |
| Hook | 一个 broker 执行 Claude Code 和 Codex 的插件、设置以及技能/智能体/命令 frontmatter 里的 hook。工具名双向转换，匹配器看到的是 `Bash`、`Edit`、`Write`……；`if`、`async`、`updatedInput`、Stop 续写和 `PermissionRequest` 都可用 |
| MCP 服务 | stdio（经 DSH 的 MCP 客户端，装有能力目录时经能力目录）、Streamable HTTP 和 SSE，支持 OAuth 登录（`/harness login <server>` 或工作台）。Claude Code 插件的服务保留工具名 `mcp__plugin_<插件>_<服务>__<工具>`；Codex 和通用格式的服务保留自己的名字 |
| 设置 | Claude Code 的 `settings.json` 和 Codex 配置：环境变量传给 hook、MCP 服务和 shell 命令；权限规则约束工具调用；`disableAllHooks` 和 `outputStyle` 生效 |
| Claude Code mods | 打包后加载进每个会话的引擎，通过兼容层调用宿主 API |
| OpenCode 插件 | 每个在自己的 Bun 进程里，按 OpenCode 的方式加载；它的 `client` 连接一个由 DSH 会话支撑、与 OpenCode 兼容的服务（见下表） |
| 会话 | Claude Code、Codex、OpenCode 的会话导入为可以接着聊的 DSH 会话 |

### Hook 事件

在这些事件上运行 hook：`SessionStart`、`UserPromptSubmit`、`UserPromptExpansion`、`PreToolUse`、`PermissionRequest`、`PostToolUse`、`PostToolUseFailure`、`Notification`、`SubagentStart`、`SubagentStop`、`Stop`、`StopFailure`、`PreCompact`、`PostCompact`、`SessionEnd`。

`PreCompact`、`PostCompact`、`Notification`、`StopFailure` 在 DSH 提交之后才被看到：hook 会运行，但拦截决定会被忽略。其他事件上的 hook 不会运行。

处理器类型 `command`、`http`、`mcp_tool`、`prompt`、`agent` 会在 Claude Code 运行它们的事件上执行；其他类型会报告出来，不执行。

### OpenCode 插件的 hook

| OpenCode | 在 DSH 里何时触发 |
|---|---|
| `tool` | 每项注册为一个 DSH 工具，参数用插件自己的 schema 校验 |
| `chat.message` | 提示进入会话之前 |
| `chat.params` | 发出模型请求时（温度、输出 token） |
| `tool.execute.before` / `.after` | 工具调用前后，使用 OpenCode 的工具名和参数 |
| `permission.ask` | 审批请求时 |
| `shell.env` | shell 工具的环境变量 |
| `command.execute.before` | OpenCode 命令的提示提交之前 |
| `experimental.chat.system.transform` | 组装系统提示时 |
| `config` | 插件添加的命令成为 DSH 命令 |
| `event` | 会话、消息、片段、权限、命令、文件和压缩事件 |

## 已知缺口

以下是工作台给出的原因，都来自插件文件或运行时实际发生的事。

| 原因 | 含义 |
|---|---|
| 没有对应界面 | 状态栏、主题、工作流、监视器、MCP 应用等界面在 DSH 里没有直接位置；适配器可以重建：**用 AI 补上** |
| 事件不会触发 | hook 配置监听了 DSH 不触发的事件，这些 hook 不会运行；适配器有时可以借 DSH 自己的事件触发它们 |
| 无法拦截 | `PreCompact`、`PostCompact`、`Notification`、`StopFailure` 上的 hook 在事后运行 |
| 处理器不执行 | broker 不执行的 hook 处理器类型 |
| 未映射 | LSP 服务、插件的 `bin/` 可执行文件（Claude Code 会把它加到 `PATH`）、安装时的 `userConfig` 选项，以及 `opencode.json` 里按 npm 包名引用的 OpenCode 插件：列出但不运行 |
| 托管连接器 | Codex 应用连接器由 OpenAI 托管，只能登录 ChatGPT 或 Codex 后使用，本地无法替代 |
| 实验性运行时 | Claude Code mods 和 OpenCode 插件通过兼容层调用宿主 API，超出已支持部分的调用会失败；代码成功运行过之后不再显示这条 |
| 未知传输 | 既没有已知类型、也没有命令或 URL 的 MCP 服务会跳过 |
| 输出风格 | 见上文“输出风格” |
| 设置失败 / 运行失败 | 记录下的错误原文 |

没有声明许可证的插件可以在本地使用。评估里仍会记下这一点，因为发布由它派生的东西（例如适配器）需要先决定许可证。

远程 MCP 服务和调用外部程序的 hook 需要网络或本机上有那些程序；缺少时这个部分以对应错误失败。

## 工作区信任

项目会带来它自己的部分：Claude Code 的 `.claude/` 和 `.mcp.json`，Codex 的 `.codex/`。其中一些会在会话开始时就在你的电脑上运行代码或访问网络，因此与 Claude Code 一样，要等你信任该工作区后才启用：

- 钩子（`.claude/settings.json`、`settings.local.json`、`.codex/hooks.json`）；
- `.mcp.json` 和 `.codex/config.toml` 中的 MCP 服务器；
- 含有 `` !`命令` `` 或 ```` ```! ```` 行、frontmatter `hooks` 或 `allowed-tools` 的命令和 skill；
- 带 frontmatter `hooks` 或 `mcpServers` 的 agent；
- 设置文件中授予权限的部分：`permissions.allow`、`env` 和 `disableAllHooks: false`。限制从不等待：即使同一文件还有 `allow` 规则或 `env`，它的 `permissions.deny`、`permissions.ask` 规则和 `disableAllHooks: true` 也会立即生效。

普通的 skill、agent 和命令会立即加载。你自己为该文件夹添加的 MCP 服务器（`claude mcp add --scope local`）属于你，不用等待。

工作区是仓库根目录（worktree 取主检出目录），没有仓库时是工作目录。满足以下任一条件即视为已信任：

- 你在 Claude Code 中接受过它的信任对话框：`~/.claude.json` 里的 `projects["<工作区>"].hasTrustDialogAccepted`。在仓库之外，已信任的上级文件夹也覆盖它，但主目录只覆盖它自己；
- Codex 将它标为可信：`~/.codex/config.toml` 中的 `[projects."<工作区>"] trust_level = "trusted"`；
- 你在 Harness Forge 中信任了它。工作区未受信任且含有上述部分时，“发现”和“已迁移”页面会显示 **信任此文件夹？** 横幅，并列出等待中的部分。**信任此文件夹** 会把选择保存到当前 DSH profile（账本旁的 `.harness-forge/trust.json`），并在该工作区已打开的会话中挂载等待中的部分。**暂不** 会永久隐藏该工作区的横幅：它以 `dismissed` 保存在同一文件中，之后再信任即可结束该状态。**更多 → 设置 → 信任设置** 列出你信任过或选择“暂不”的工作区，并提供 **信任此文件夹** 和 **撤销信任**；撤销会从该工作区已打开的会话中撤下会运行代码的部分（它的 `deny` 和 `ask` 规则保留），横幅也会重新出现。同样的功能也可以通过 Remote 方法 `harnessCompat.workspaceTrust({ cwd })`、`harnessCompat.trustWorkspace({ cwd, trusted })`（返回 `{ decision, stillLive }`：未能撤下的部分仍在运行，再次调用即重试）、`harnessCompat.trustDecisions()` 和 `harnessCompat.dismissTrust({ cwd, dismissed })` 使用。

与 Claude Code 一样，项目 `.mcp.json` 的服务器还需要批准：任何设置文件里的 `disabledMcpjsonServers` 都会拒绝它。工作区只由 Claude Code 的信任覆盖时，还需要 `enabledMcpjsonServers` 或 `enableAllProjectMcpServers`。这些批准来自 `~/.claude.json` 或你的 `~/.claude/settings.json`，项目自己的设置要等文件夹受信任后才算数。在 Harness Forge 中信任文件夹即批准其服务器。未挂载的服务器不会启动，因此它的环境变量不会被展开到命令、请求头或 URL 中。

## 命令与 skill：参数、`!` 和 `@文件`

shell 行（`` !`…` ``、```` ```! ````）和 `@文件` 引用是在命令或 skill 的原文中找出的，此时还没有填入任何参数。命令输出不会再被扫描。有三点与 Claude Code 有意不同：

- **shell 行里的参数只是数据。** Claude Code 把参数文本直接粘进命令，所以像 `"; rm -rf ~"` 这样的参数会变成 shell 语法。Harness Forge 从不把值写进命令文本。每个值（参数，或 `${CLAUDE_PLUGIN_ROOT}` 之类的路径变量）都放进环境变量 `HF_ARG_0`、`HF_ARG_1`……，只有在能确定引用仍是普通数据的位置，占位符才会换成对它的引用。bash 中是不加引号处（`"${HF_ARG_0}"`）或普通双引号内（`${HF_ARG_0}`）；PowerShell 中是引号之外或普通双引号内（`${env:HF_ARG_0}`）。占位符出现在其他任何位置，这一行 shell 都不会执行，原处显示一条 `[Harness Forge: this shell command was not run: …]` 说明。“其他位置”包括单引号、`$'…'`、here-document、PowerShell here-string、反引号、`$(…)`、`${…}`、算术表达式（`((…))`、`let`、`$[…]`）、`[[ … ]]` 和注释。引用还必须是简单命令的参数，否则这一行同样不执行：占位符不能是命令本身（行首，或 `;`、`&`、`&&`、`||`、`|`、`(`、`{`、`if`、`then`、`do`、`else`、`!` 等之后的第一个词），不能是赋值的一部分（`X=$1 cmd`），也不能是会执行、求值或把它当作名字的命令的参数：bash 中的 `eval`、`exec`、`source`、`.`、`command`、`builtin`、`trap`、`declare`/`export`/`read`/`unset` 以及其他所有内建命令，只有 `echo`、`printf`（在固定的格式之后、且无 `-v`）、`cd`、`pushd`、`pwd`、`true`、`false`、`:` 和 `test`/`[`（紧跟 `-f`、`=` 等运算符之后，`-v` 除外）例外；会运行命令或代码的程序，如 `env`、`sudo`、`xargs`、`nohup`、`timeout`、`ssh`、`sh`/`bash`、`python`、`perl`、`node`、`awk`、`sed` 和 `find … -exec`；PowerShell 中的 `&`、`.`、`Invoke-Expression`/`iex`、`Invoke-Command`、`Start-Process`、`Start-Job`、`Add-Type`、`ForEach-Object`，以及跟在 `-Command`/`-c`/`-EncodedCommand`/`-ScriptBlock` 参数之后的任何命令。定义了函数或别名的行也不执行。程序收到的仍是一个普通参数，所以以 `-` 开头的值可能被当作选项。因此写了 `'$1'` 的命令在 Claude Code 中能用，在这里不行，请改写为 `"$1"`。这些规则无法穷尽所有程序：未列出的程序仍可能把参数当作指令（例如 `git --upload-pack=…`）。当技能或命令的参数可能由模型决定时，只迁移那些你愿意用模型给出的值来运行其 shell 行的插件。
- **`@文件` 只在已知位置内生效。** 命令或 skill 原文中的引用只附加该模板能触及位置内的文件（先解析符号链接）。项目的命令或 skill 只能触及工作区；已安装插件的能触及插件自己的目录和工作区；只有你自己的命令和 skill（在 `~/.claude` 中，或你配置的目录中）还能触及 `~/.claude`。其他位置不会附加，并有一条 `[Harness Forge: @… was not attached …]` 说明。你在参数里输入的 `@路径` 只是普通文本；你自己的附件由 DSH 处理。
- **信任按实际要执行的内容检查。** 项目的命令或 skill 每次渲染时，都会读取它当前的内容，并重新检查工作区是否受信任。工作区未受信任（或已撤销信任）时，它的 shell 行一律不执行，加载后才加进去的也一样，原处会有一条说明。

## 模型

智能体、技能或命令里的 `model:` 可以写 Claude 别名（`haiku`、`sonnet`、`opus` 或 `claude-…` id）。模型名看不出哪个 DSH 模型更强，所以没有 `modelAliases` 配置（[快速开始](quickstart.zh.md#配置)）时使用会话的模型。技能的 `model` 或 `effort` 只用于它运行的那一轮，结束后换回原来的模型。

## 指令文件

DSH 自带的指令加载器已经读取从仓库根到工作目录每一层的 `AGENTS.md`、`CLAUDE.md` 及其 `.local.md`，所以 Harness Forge 不重复添加。**指令文件** 行只把 DSH 不读的部分加进系统提示：

- `~/.claude/CLAUDE.md`，以及从仓库根（最近的 `.git`）到工作目录每一层的 `.claude/CLAUDE.md`。没有仓库时：工作目录在主目录里就读到主目录为止，否则只读工作目录；
- 这些文件以及 DSH 加载的 `CLAUDE.md` / `CLAUDE.local.md` 里的 `@path` 导入：相对于导入它的文件、`~/` 开头或绝对路径；最多 5 层；每个文件只导入一次；代码块和行内代码里的不算。项目文件（所有 `CLAUDE.md`、`.claude/CLAUDE.md` 和 `CLAUDE.local.md`）里的导入只能指向工作区内：仓库根目录，没有仓库时为工作目录，先解析符号链接再判断。文件仍会向上*查找*到主目录，但工作目录之上找到的文件也不能从那里导入，克隆来的仓库因此无法把 `~/.ssh/id_rsa` 或其他项目的文件拉进提示。例外是你在 Claude Code 里批准过外部导入的工作区（`~/.claude.json` 中的 `hasClaudeMdExternalIncludesApproved`）：与 Claude Code 一样，它的导入可以指向任何位置，包括 `~/.claude`。你自己的 `~/.claude/CLAUDE.md` 可以导入任何位置。项目指令文件本身若是指向工作区之外的符号链接，则完全不读取；
- Codex 的 `~/.codex/AGENTS.override.md`（没有则 `AGENTS.md`），除非你的 Codex 设置已经迁移并带上了它。

总量上限 65536 字节：先去掉最宽泛的文件，再截断最具体的那个，并写明。装有 [Recollect](https://github.com/kirkchinese/DSH-Recollect) 时这一行整体让位。关闭这一行即停止添加指令文件。
