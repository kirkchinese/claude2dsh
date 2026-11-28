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
| 会话 | Claude Code、Codex（包括压缩的 `.jsonl.zst` rollout）、OpenCode 的会话导入为可以立即打开、接着聊的 DSH 会话；装有 [dsh-chat-import](https://github.com/Nwflower/dsh-chat-import) 时交给它导入 |

### Hook 事件

在这些事件上运行 hook：`SessionStart`、`UserPromptSubmit`、`UserPromptExpansion`、`PreToolUse`、`PermissionRequest`、`PostToolUse`、`PostToolUseFailure`、`Notification`、`SubagentStart`、`SubagentStop`、`Stop`、`StopFailure`、`PreCompact`、`PostCompact`、`SessionEnd`。

`PreCompact`、`PostCompact`、`Notification`、`StopFailure` 在 DSH 提交之后才被看到：hook 会运行，但拦截决定会被忽略。其他事件上的 hook 不会运行。

处理器类型 `command`、`http`、`mcp_tool`、`prompt`、`agent` 会在 Claude Code 运行它们的事件上执行；其他类型会报告出来，不执行。插件自己的 hook `matcher` 是插件选定的正则表达式，只用于宿主选定的短名字（工具、事件和代理名），而插件本身就是你安装并信任的代码。

command hook 从文件而不是管道读取输入。这个文件放在 Harness Forge 数据文件夹中的私有文件夹里，hook 一启动就删除；删不掉的会在工作台中报告。在 Linux 和 macOS 上只有你能读它（文件权限 0600，文件夹 0700，且不能经由符号链接到达）。Windows 没有这类权限位：那里的文件依赖数据文件夹从你的用户文件夹继承的访问规则，通常只有你、管理员和系统能读。这不等于“仅所有者可读”：Harness Forge 在 Windows 上不会另设访问规则。如果无法创建这个私有文件（例如文件夹不是私有的或不可写），输入改走管道。要在 Harness Forge 检查之后、hook 启动之前替换这个文件或其文件夹，需要对你自己的数据文件夹有写权限，这本身就意味着已控制你的账户。指令文件在 macOS 和 Windows 上有类似的残余风险：这两个系统没有 `/proc`，求指令文件的真实路径和确认它指向已打开的文件是两个独立步骤，若这台电脑上另一个程序恰在两步之间把某个上级文件夹换成链接，就可能让读取转向别处；Harness Forge 接受这一点，因为改为拒绝会让这两个系统上的指令文件都无法加载（在 Linux 上，真实路径取自已打开的文件本身）。

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

### MCP 服务的设置

Codex 的服务按同一套规则读取，无论来自 `config.toml` 的 `[mcp_servers.<name>]`，还是 Codex 插件的 `.mcp.json`、`mcp.json` 或清单里的 `mcpServers`：

| Codex 设置 | 在 DSH 里 |
|---|---|
| `command`、`args`、`env`、`cwd`、`url`、`type = "http"` | 遵守；`cwd` 相对插件目录，`type = "http"` 即 Streamable HTTP |
| `env_vars`、`bearer_token_env_var`、`http_headers`、`env_http_headers` | 遵守：所列变量从 DSH 的环境传过去 |
| `enabled = false` | 不启动该服务，它的部分显示“disabled in the plugin”（或“in config.toml”）。所有插件的服务都这样处理，包括 Claude Code 的 |
| `auth = "chatgpt"` | 不启动：它需要 ChatGPT 登录，DSH 提供不了。作为缺口报告 |
| `enabled_tools`、`disabled_tools` | 遵守。经能力目录和远程服务时，被过滤的工具不列出；直接挂载的 stdio 服务仍会列出它们，但调用会被拒绝 |
| `default_tools_approval_mode`、`tools.<tool>.approval_mode` | `prompt` 和 Codex 一样，每次调用前先问你。`writes` 每次调用都先问，因为事先不知道哪些工具只读。`auto` 和 `approve` 交给 DSH 自己的审批 |
| `startup_timeout_sec`、`tool_timeout_sec` | 在 DSH 能计时的地方遵守；未设置时，启动限时 120 秒，一次调用限时 10 分钟。远程服务的启动不计时 |
| `omit_tools_from`、`tools.<tool>.output_token_limit` | 忽略：`omit_tools_from` 所指的 Codex 工具界面 DSH 都没有，工具输出也由 DSH 自己限制 |

Codex 给插件服务提供两个变量：`CODEX_HOME`，即你的 Codex 目录（`$CODEX_HOME`，否则是 `~/.codex`）；`CODEX_MCP_NODE_PATH`，即 Codex 自带的 Node.js，在 DSH 里换成运行 DSH 的 Node.js。只有服务的设置用到时才提供。服务的命令或参数用到一个谁都没设置的变量时，不会启动；它的部分显示“needs NAME, which DSH does not provide”，而不是以空程序启动失败。

与 Claude Code 一样，服务的 `command`、`args`、`env`、`url` 和 `headers` 里的 `${VAR}`、`${VAR:-default}` 会按原文替换成变量值，所以展开到 `sh -c '… ${VAR} …'` 这类 shell 脚本参数里的值会成为脚本的一部分：这些值来自插件作者和你自己的环境，Harness Forge 保留这一含义，不对它们加引号。

服务在 DSH 里的名字从不含 `__`，所以工具名 `mcp__<服务>__<工具>` 只属于一个服务：含 `__` 的名字（如 `app__reports`）会把它合并成 `_` 并追加一个短哈希（`app_reports_4880b6d7`），与名为 `app_reports` 的服务区分开。

启动失败的服务在 MCP 这一行重新启动时再试一次，不会因为 Harness Forge 的其他部分各自启动而反复重试。

### 权限规则

权限规则和 hook 的 `if` 条件按 [Claude Code 文档](https://code.claude.com/docs/en/permissions) 的方式匹配。shell 规则只与命令本身的词比较，重定向（`> out`、`2>&1`、`<<< x`）不算在内，所以针对 `Bash(git status)` 的 deny 或 ask 规则同样会匹配 `git status > out` 和 `>out git status`。PowerShell 命令也按同样方式读取，不区分大小写；规则和命令两侧的 PowerShell 默认别名都按其 cmdlet 读取（所以 `PowerShell(Remove-Item *)` 也匹配 `rm`、`del` 和 `ri`；deny、ask 规则和 hook 条件在所有平台上识别全部别名，allow 规则只认当前平台上 PowerShell 确实定义的别名，因此在 Linux 和 macOS 上不会批准原生的 `rm` 或 `ls`）；并识别 PowerShell 自己的重定向：`>`、`>>`，流 `1>`–`6>` 与 `1>>`–`6>>`，`*>` 与 `*>>`，合并 `2>&1`…`*>&1`（不算文件），以及 `<`（PowerShell 7 保留此运算符，拒绝运行）。allow 规则批准的是命令本身，不包括它写到哪里，这一点与 [Claude Code](https://code.claude.com/docs/en/permissions#redirections) 相同：命令通过重定向写入的文件需要针对该文件的 `Edit` allow 规则，从工作目录之外读取的文件需要 `Read` allow 规则。各 shell 的空设备（bash 的 `/dev/null`、PowerShell 的 `$null`、Windows 上的 `NUL`）和 `2>&1` 这类描述符复制不需要任何规则。目标含 `~`、通配符或展开时，一律不批准。重定向读写的每个文件，都按对它的 `Read` 或 `Edit` 调用套用同样的 deny、ask、allow 规则，取最严格的结果：任何一处 deny 就拒绝整条命令，否则任何一处 ask 就询问，否则只有命令本身和每个文件都被允许时才允许。符号链接既按写出的路径、也按它实际指向的位置检查：deny 或 ask 规则匹配其中任一个即生效；allow（以及读取工作目录内文件的豁免）则要求两者都满足，所以项目里的链接无法打开项目外的文件。文件规则使用 gitignore 模式：`x` 这样的裸文件名匹配工作目录下任意深度，`./x`、`sub/x` 和 `/x` 只匹配其锚定的位置。

## 本机能找到什么

- **Claude Code。** 插件来自 `~/.claude/plugins/installed_plugins.json`，每个插件取一份安装：最新的用户范围（user scope）安装。为某个项目做的安装（`--scope project`、`--scope local`）在 Claude Code 里只在那个项目的会话中加载，所以不出现在“发现”和 **全部迁移** 中；想在所有地方用，可以手动添加（**按路径添加插件**）。插件是否开启按 Claude Code 自己的 `enabledPlugins` 优先级判断，[以提到它的最高来源为准](https://code.claude.com/docs/en/plugins/loading#find-where-a-plugin-is-enabled)：先是你的 `~/.claude/settings.json`，再是系统文件夹里的托管设置文件（`managed-settings.json` 和 `managed-settings.d/*.json`）。这份列表不属于某个项目，所以项目设置不参与。MDM 和服务器下发的策略读不到。
- **Codex。** `config.toml` 中 `[plugins]` 列出的插件；`enabled = false` 表示已关闭。
- **OpenCode。** 每个配置文件夹一份清单，[与 OpenCode 加载插件的方式一致](https://opencode.ai/docs/plugins/)：`plugins/`（或 V1 的 `plugin/`）下直接放着的 `.ts`、`.js`、`.mjs` 文件和插件包文件夹，以及 `opencode.json(c)` 里的 `plugins`（或 V1 的 `plugin`）条目。本地条目是相对配置文件解析出的文件夹；npm 条目从 OpenCode 安装它的位置读取，即配置文件夹的 `node_modules` 或缓存 `~/.cache/opencode/node_modules`，那里没有安装的会跳过。`~/.config/opencode` 下的插件文件算作你自己的内容（**OpenCode → user**），每个插件包各算一个插件。更深的文件夹不会搜索。[开关插件的条目](https://opencode.ai/docs/plugins/#control)（`-<id>`、`*`、`<前缀>.*`、后面再写一次 id）按顺序生效，先全局配置、后项目配置，按插件 `Plugin.define({ id })` 声明的 id 匹配。这个 id 从源码中读取，不运行代码：注释、字符串和模板字符串里的不算，而且必须是唯一一处声明里的普通字符串。其中的转义（`\u002e`、`\x2e`、`\n`）按 JavaScript 的规则解码。被 OpenCode 关掉的插件显示为关闭，**全部迁移** 不会带上它。插件的 id 可能没有声明、声明了不止一次、是算出来的，或者用了模块里 JavaScript 不接受的转义写法（比如旧式八进制 `\1`）。这时如果有 `*`、`-*` 以外的条目可能开关它，就无法判断 OpenCode 是否运行它：它显示为“可能已关闭”并说明原因，**全部迁移** 也不会带上它，但你仍可以单独迁移。你自己的插件文件只有全部被关掉时才整体显示为关闭，否则只保留 OpenCode 一定会运行的那几个文件。解析不了的条目（比如带主机名的 `file://` 地址）会跳过，并在 **设置** 页面列出；其他插件照常列出。
- 在原工具里关掉的插件仍会列出，标为已关闭，并且不随 **全部迁移** 一起迁移。

## 账本

Harness Forge 安装过的内容记录在配置档的 `.harness-forge/state.json` 里。其中有部分读不出来时，先把原文件原样保留为旁边的 `state.json.unreadable-<时间>`（不会被覆盖），再修复缺少可补全字段（安装时间）的记录，其余有效记录照常保留。读不出的记录会被略过，**诊断** 里会显示一条故障，写明这些记录和保留副本的位置。由更新版本的 Harness Forge 写下的账本不会被读取，也绝不会被覆盖：Harness Forge 以空的安装列表启动，所有安装都会被拒绝，故障信息会提示你升级。

## 已知缺口

以下是工作台给出的原因，都来自插件文件或运行时实际发生的事。

| 原因 | 含义 |
|---|---|
| 没有对应界面 | 状态栏、主题、工作流、监视器、MCP 应用等界面在 DSH 里没有直接位置；适配器可以重建：**用 AI 补上** |
| 事件不会触发 | hook 配置监听了 DSH 不触发的事件，这些 hook 不会运行；适配器有时可以借 DSH 自己的事件触发它们 |
| 无法拦截 | `PreCompact`、`PostCompact`、`Notification`、`StopFailure` 上的 hook 在事后运行 |
| 处理器不执行 | broker 不执行的 hook 处理器类型 |
| 未映射 | LSP 服务、插件的 `bin/` 可执行文件（Claude Code 会把它加到 `PATH`）、安装时的 `userConfig` 选项，以及项目 `opencode.json` 里按 npm 包名引用的 OpenCode 插件（它们不在项目文件夹里）：列出但不运行 |
| 托管连接器 | Codex 应用连接器由 OpenAI 托管，只能登录 ChatGPT 或 Codex 后使用，本地无法替代 |
| 实验性运行时 | Claude Code mods 和 OpenCode 插件通过兼容层调用宿主 API，超出已支持部分的调用会失败；代码成功运行过之后不再显示这条 |
| 未知传输 | 既没有已知类型、也没有命令或 URL 的 MCP 服务会跳过 |
| 需要 ChatGPT 登录 | `auth = "chatgpt"` 的 Codex MCP 服务使用你的 ChatGPT 会话；DSH 没有，所以不启动 |
| 输出风格 | 见上文“输出风格” |
| 设置失败 / 运行失败 | 记录下的错误原文 |

没有声明许可证的插件可以在本地使用。评估里仍会记下这一点，因为发布由它派生的东西（例如适配器）需要先决定许可证。

远程 MCP 服务和调用外部程序的 hook 需要网络或本机上有那些程序；缺少时这个部分以对应错误失败。

## 从网络获取的插件

**获取插件** 按工具能获取的内容如下。插件都走与本地插件相同的安装路径，所以上面各表同样适用于它的各个部分。

| 工具 | 插件市场 | 市场条目里的插件来源 | 直接粘贴 |
| --- | --- | --- | --- |
| Claude Code | git 仓库中的 `.claude-plugin/marketplace.json`（`owner/repo`、git 地址、`@ref`/`#ref`），或 `marketplace.json` 的网址 | 相对路径（包括 `metadata.pluginRoot` 下的纯名称）、`github`、`url` 和 `git-subdir`（仅 HTTPS，可带 `ref` 或 40 位完整 `sha`，也可写作 `URL#sha`）、`npm`（来自 npm 官方仓库或你配置的仓库）、`archive`（HTTPS 上的 zip，按 `sha256` 校验）；`command` 会列出但不安装 | 插件仓库或其中的子目录 |
| Codex | git 仓库中的 `.agents/plugins/marketplace.json` | `local`、`url`、`git-subdir`、`npm` | 插件仓库（`.codex-plugin/plugin.json`） |
| OpenCode | （OpenCode 没有插件市场） | 无 | npm 包（`name`、`name@version`、`@scope/name`） |

按 Claude Code 的规则，市场条目本身也是一份清单：插件没有 `plugin.json` 时，条目就是清单；有的话，条目里的 `skills`、`commands`、`agents` 和 `hooks` 会加进去，除非条目写了 `"strict": false`。Harness Forge 把合并后的清单写进它自己的插件副本里，所以像 `anthropics/skills` 这种在条目里按路径列出技能的市场，安装后得到的正是条目指定的那些技能。

OpenCode 的 npm 插件在 Bun 运行时中运行，与磁盘上找到的 OpenCode 代码插件相同。确认之前，npm 完全不会运行。Harness Forge 自己从 npm 配置的仓库读取这个包：仓库地址取 `npm_config_registry` 或 `~/.npmrc` 中的 `registry=` 一行，都没有时用 npm 官方仓库。版本只能是确切的版本号或 `latest` 这样的标签，不能是版本范围。它从仓库自己的地址下载该版本的压缩包，并按仓库给出的 sha512 校验值核对。不读取按作用域配置的仓库，也不使用仓库登录凭据。确认界面会显示仓库地址，以及插件声明了多少个依赖。这些依赖在你确认后，像 OpenCode 安装插件那样，用 `npm install --ignore-scripts` 从该仓库安装。插件若直接或间接依赖 git 仓库、网址或本地目录，会被拒绝安装。确认之后，npm 会按它自己的配置解析依赖，过程中可能访问其他主机，例如你的 npm 设置或仓库重定向所指的主机。Harness Forge 检查的是解析结果中记录的包：每个包都必须是来自该仓库、带完整性校验值的压缩包。无论你的 npm 设置如何，Harness Forge 都要求 npm 以第 3 版 lockfile 记录结果；无法这样读取的结果会被拒绝，而不是照装。

### 确认之前来源能做什么

你确认之前，取回的内容一概不会运行：插件和插件市场的钩子、脚本、git 设置、安装步骤都不会。安装的就是你在确认界面看到的内容：如果下载的文件在你看过之后发生变化，或者更新时的版本与“检查更新”找到的不一致，Harness Forge 会拒绝安装。如果“检查更新”比对过的已安装副本之后变了（例如中间又装了另一个更新），这次更新也会被拒绝，需要重新检查。来自这台电脑上已有插件市场或文件夹的插件同样会被复制：打开确认界面时复制一份，你确认的和最终安装的都是这份副本，期间即使原工具刷新了它的插件市场也不受影响，原文件夹保持原样。

- **插件市场只能指向公网 HTTPS 来源。** 其中的 git 条目必须是公网地址上的 `https://` 地址，并且不跟随重定向。`archive` 通过 HTTPS 下载。`npm` 条目只能指定 npm 官方仓库或你配置的仓库。插件市场不能让 Harness Forge 访问这台电脑、你的局域网，也不能让它使用 `ssh`、`file:` 或其他 git 传输方式。你自己粘贴的来源可以是任意主机，可用 `https`、`http`、`ssh`、`git` 或 `file`；但任何重定向，即使来自你粘贴的地址，也必须指向公网地址。
- **不使用代理时，每个连接都发往检查过的地址。** Harness Forge 自己的下载（插件市场文件、GitHub 压缩包、npm 元数据和压缩包）都连接到它检查过的地址。对插件市场里的 git 地址，git 同样只连接到检查过的地址，这需要 git 2.37 或更新版本。没有满足条件的 git 时，GitHub 上的来源改为下载压缩包，其他主机则拒绝获取。
- **使用代理时，只访问已知的主机。** Harness Forge 使用 `HTTPS_PROXY`、`HTTP_PROXY` 或 `ALL_PROXY` 中设置的代理（`http://` 或 `https://` 代理，需要时可带用户名和密码），并跳过 `NO_PROXY` 中的主机，与 git 和 npm 的做法相同。主机名由代理解析，Harness Forge 无法知道它实际指向哪里。因此通过代理时，它只访问 `github.com`, `codeload.github.com`, `api.github.com`, `raw.githubusercontent.com`, `objects.githubusercontent.com`, `registry.npmjs.org`、你配置的 npm 仓库，以及你自己粘贴的来源所在的主机。插件市场条目或重定向如果指向其他主机，会被拒绝，并给出主机名。要从这样的主机安装，请自己粘贴那个来源；如果能直接访问该主机，也可以把它加入 `NO_PROXY`。这依赖于你的代理：主机名由代理解析、连接也由代理建立，所以对上面这些主机，Harness Forge 信任代理的结果。即使经过代理，证书仍按主机名校验。git 使用 Harness Forge 选定的路线（经代理或直连），不自行读取代理变量（代理密码通过环境变量交给 git，这需要 git 2.31 或更新版本），也不跟随 HTTP 重定向；仓库搬迁后，需要粘贴它的新地址。
- **不含链接。** 插件只由普通文件和目录组成。含有链接、硬链接或设备文件的压缩包不会被解压；从仓库或这台电脑上的文件夹复制插件时，其中的链接会被略去，确认界面会列出略去了哪些。插件文件夹本身是链接或要经过链接才能到达时，不会被复制。
- **git 不使用你的 git 配置运行。** 它不读取你的全局和系统设置、钩子、模板、凭据助手和 `GIT_*` 环境变量，也不获取子模块或 LFS 文件。因此不支持通过 HTTPS 访问私有仓库；以 `ssh` 地址（`git@host:owner/repo.git`）粘贴的私有仓库可以使用你自己的 SSH 密钥。
- **有上限。** 每个操作最多 10 分钟。下载、克隆或安装写入的内容一旦超过大小上限就会立即停止，即使服务器无视部分克隆的请求也是如此。固定的提交单独获取；如果服务器不允许这样做，Harness Forge 会报告出来，而不是下载整个历史。

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

- **shell 行里的参数只是数据。** Claude Code 把参数文本直接粘进命令，所以像 `"; rm -rf ~"` 这样的参数会变成 shell 语法。Harness Forge 从不把值写进命令文本。每个值（参数，或 `${CLAUDE_PLUGIN_ROOT}` 之类的路径变量）都放进环境变量 `HF_ARG_0`、`HF_ARG_1`……，只有在能确定引用仍是普通数据的位置，占位符才会换成对它的引用。bash 中是不加引号处（`"${HF_ARG_0}"`）或普通双引号内（`${HF_ARG_0}`）；PowerShell 中是引号之外或普通双引号内（`${env:HF_ARG_0}`）。占位符出现在其他任何位置，这一行 shell 都不会执行，原处显示一条 `[Harness Forge: this shell command was not run: …]` 说明。“其他位置”包括单引号、`$'…'`、here-document、PowerShell here-string、反引号、`$(…)`、`${…}`、算术表达式（`((…))`、`let`、`$[…]`）、`[[ … ]]` 和注释。引用还必须是简单命令的参数，否则这一行同样不执行：占位符不能是命令本身（行首，或 `;`、`&`、`&&`、`||`、`|`、`(`、`{`、`if`、`then`、`do`、`else`、`!` 等之后的第一个词），不能是赋值的一部分（`X=$1 cmd`），也不能是会执行、求值或把它当作名字的命令的参数：bash 中的 `eval`、`exec`、`source`、`.`、`command`、`builtin`、`trap`、`declare`/`export`/`read`/`unset` 以及其他所有内建命令，只有 `echo`、`printf`（在固定的格式之后、且无 `-v`）、`cd`、`pushd`、`pwd`、`true`、`false`、`:` 和 `test`/`[`（紧跟 `-f`、`=` 等运算符之后，`-v` 除外）例外；用来运行所给命令、代码、包、容器、任务或文件的程序：包装器如 `env`、`sudo`、`doas`、`su`、`runuser`、`nohup`、`nice`、`ionice`、`taskset`、`cpulimit`、`timeout`、`time`、`chronic`、`stdbuf`、`setsid`、`chroot`、`flock`、`strace`；监视器 `watch`、`watchexec`、`entr`、`nodemon`；`xargs`、`parallel` 和 `ssh`；`awk` 和 `sed`；包运行器 `npx`、`pnpx`、`bunx`、`uvx`、`corepack`、`tsx`、`ts-node`；构建与任务运行器 `make`、`just`、`task`（值可能选定 makefile、目标或配方展开的变量），以及构建工具和工具版本管理器，如 `mvn`、`gradle`、`cmake`、`dotnet`、`tox`、`nx`、`mise`、`asdf`、`nvm`、`pyenv`；解释器和 shell，如 `sh`/`bash`、`python`、`perl`、`node`（作为脚本解释器时见下文）；以及 `find … -exec`。包管理器和容器工具只在白名单中的子命令里接受值，这些子命令只列出或描述信息，不运行任何包、生命周期或构建脚本、项目任务、容器或插件：`npm view`/`info`/`show`/`v`/`search`/`find`/`s`/`se`/`ls`/`list`/`la`/`ll`/`outdated`/`explain`/`why`；`pnpm list`/`ls`/`ll`/`la`/`why`/`outdated`；`yarn info`/`why`；`uv pip show`/`list`/`freeze`/`tree`；`pip`（`pip3`、`pip3.12` 等）`show`/`list`/`freeze`/`check`；`pipx list`；`poetry show`/`search`；`cargo search`/`tree`/`info`；`go doc`/`list`/`version`；`gem list`/`search`/`info`/`contents`/`dependency`；`bundle list`/`info`；`composer show`/`info`/`search`/`depends`/`why`/`prohibits`/`why-not`/`outdated`/`licenses`；`docker`、`podman` 和 `nerdctl` 的 `ps`/`images`/`logs`/`inspect`/`top`/`port`/`stats`/`history`/`version`/`info`/`search`，以及 `container`、`image`、`volume`、`network` 下列出和查看的子命令；`kubectl get`/`describe`/`logs`/`explain`/`version`/`api-resources`/`api-versions`/`top`/`config view`；`conda`、`mamba`、`micromamba` 的 `list`/`search`/`info`；`apt show`/`search`/`list`/`policy`；`apt-cache show`/`search`/`policy`/`depends`/`rdepends`/`showpkg`；`dnf` 和 `yum` 的 `info`/`list`/`search`。`bun`、`brew`（描述一个 formula 时会运行它的代码）、`pdm`、`hatch`、`rye`、`pixi`、`apt-get`、`pacman`、`apk`、`zypper` 完全不接受值。`npm docs`、`bugs`、`repo`、`help` 不在名单中，因为它们会用浏览器打开包自己指定的地址。子命令必须是紧跟程序的固定词，值必须是其后的操作数：不能是选项或选项的一部分（`--pkg=$1`），不能紧跟在选项之后（`--userconfig "$1"`、`--python "$1"`、`--kubeconfig "$1"` 会选定要运行的代码），并且除非前面有 `--`，值本身不能以 `-` 开头（这样的行不执行，并附说明）。其他任何子命令（`install`、`add`、`ci`、`run`、`exec`、`test`、`build`、`x`、`dlx`、脚本名……）、缺失或动态的子命令、或子命令之前有选项时，整行都不接受值：`npm install; echo "$1"` 同样不执行；PowerShell 中的 `&`、`.`、`Invoke-Expression`/`iex`、`Invoke-Command`、`Start-Process`、`Start-Job`、`Add-Type`、`ForEach-Object`，以及跟在 `-Command`/`-c`/`-EncodedCommand`/`-ScriptBlock` 参数之后的任何命令。宿主设置的路径变量（`${CLAUDE_PLUGIN_ROOT}`、`${CLAUDE_PLUGIN_DATA}`、`${CLAUDE_SKILL_DIR}`、`${CLAUDE_PROJECT_DIR}`）不是你或模型的输入，所以它们还可以作为命令名（PowerShell 中在 `&` 之后）或解释器要运行的脚本。脚本解释器只能按其文档中的脚本形式接收值，即 `<解释器> [选项] <脚本> [参数]`：解释器在脚本之后不再解析选项，之后的每个词都作为参数交给脚本。脚本必须是固定的词或宿主路径变量，值必须在它之后。只认以下形式：`node`，除 `--no-warnings`、`--no-deprecation`、`--enable-source-maps`、`--trace-warnings`、`--trace-uncaught` 外不带选项（不能是 `node inspect`）；`python`、`python3`、`python3.12` 等或 `pypy`，除 `-B`、`-E`、`-I`、`-P`、`-q`、`-s`、`-S`、`-u` 外不带选项；`bash`、`sh`、`zsh`、`perl`、`ruby` 完全不带选项（因此 perl 和 ruby 中会把脚本参数当作开关的 `-s` 不会出现）；以及 bash 的 `source`/`.` 加固定文件。所以 `` !`node "${CLAUDE_PLUGIN_ROOT}/scripts/tool.mjs" status "$ARGUMENTS"` `` 可以执行。值出现在脚本位置或脚本之前、跟在 `-`、`--`、`-e`、`-c`、`-m` 或任何其他选项之后，或出现在由其他解释器、脚本宿主或 shell 运行的行中任何位置，都会被拒绝：`bun`、`deno`、`irb`、`php`、`lua`、`luajit`、`Rscript`、`R`、`osascript`、`tclsh`、`wish`、`jshell`、`jrunscript`、`groovy`、`java`、`awk` 及其同类、`dash`、`ksh`、`mksh`、`fish`、`csh`、`tcsh`、`ash`、`busybox`、`pwsh`、`powershell`、`cmd`、`wscript`、`cscript`、`mshta`，以及会启动 shell 或运行所给命令的 Windows 程序（`wsl`、`wt`、`runas`、`rundll32`、`regsvr32`、`forfiles`、`msiexec`）。无论怎么写都会被识别：带路径、任意大小写、带版本号（`python3.12`、`nodejs22`、`bash5`）、版本号后带后缀（`python3-dbg`）、带 Windows 扩展名（`node.cmd`、`C:\tools\node.exe`），或是 Windows 变体（`py`、`pyw`、`pythonw`、`javaw`、`rubyw`）。名字只是开头相像的程序（`pyright`、`rm`、`shuf`）仍是普通程序。定义了函数或别名的行也不执行；带值的行里若有程序从流中读取代码，也不执行：管道的某一级、`>(…)` 进程替换或输入被重定向的程序，是没有固定脚本的解释器或 shell（`echo "$1" | sh`、`| bash -s`、`| python3 -`），是从标准输入读程序文件的 `sed`/`awk`，是上面列出的任何运行器（`| xargs sh -c`、`| ssh host`），是运行时才确定的程序（`| $SHELL`），或 PowerShell 中的 `Invoke-Expression` 及上面列出的其他运行器（`ForEach-Object`、`Where-Object` 除外）；或者解释器、`source`/`.` 的脚本是进程替换（`bash <(…)`、`source <(…)`）。作为数据读取的进程替换（`diff <(echo "$1") x`）和接到固定脚本的管道（`| python3 tool.py`）不受影响。做这些整行检查时，包装器按它所运行的命令计算：bash 的 `command [-p]`、`builtin`、`exec [-cl] [-a name]`，以及带文档所列选项的 `env`、`nice`、`nohup`、`timeout`、`stdbuf`、`time`、`setsid`；所以 `| command sh`、`| timeout 5 sh` 会被拒绝，`| nice wc -l` 不受影响。带其他选项的包装器（`env -S`、`command -v`）、其他包装器（`sudo`、`doas` 等）以及运行时才确定的程序，都按会读取代码、会运行包管理器处理。程序收到的仍是一个普通参数，所以以 `-` 开头的值可能被当作选项。因此写了 `'$1'` 的命令在 Claude Code 中能用，在这里不行，请改写为 `"$1"`。值也不会经由文件进入代码：命令或技能的任一 shell 行带有参数时，只要其中某行在另一行或另一条命令可能写入文件之后运行文件，它的所有 shell 行都不执行，并分别显示说明 “a value could reach code through a file written earlier in this command”（`echo "$1" > x.sh; bash x.sh`、`printf %s "$1" | tee x.py >/dev/null && python3 x.py`，或在一行写入、在之后某行运行）。“写入”指重定向输出到文件（`/dev/null` 和 `2>&1` 除外），或 `tee`、`cp`、`mv`、`ln`、`install`、`rsync`、`unzip`、`patch`、`wget`、`dd of=`、`sed -i`、`perl -i`、`curl -o`/`-O`、`tar -x`（PowerShell 中为除合并、`$null` 和 `NUL` 之外的上述所有重定向，以及 `Out-File`、`Set-Content`、`Add-Content`、`Tee-Object`、`Copy-Item`、`Move-Item`、`Rename-Item`、`New-Item`、`Expand-Archive`、`Invoke-WebRequest`、`Invoke-RestMethod -OutFile`、`Start-BitsTransfer` 和会写文件的 `Export-*` cmdlet，含其别名）。“运行文件”指解释器或 shell、`source`/`.`/`eval`、以路径（`./x`、`dir/x`）或运行时才确定的程序、运行器、`find -exec`，以及 `$(…)`、反引号或 `<(…)` 替换。在管道、循环、`if`/`case`、命令组或子 shell 内以及后台运行时，先后顺序视为未知，因此运行算作发生在写入之后。单条命令写出自己的输出（`node x.js "$1" > out.txt`）不受影响。这些规则无法穷尽所有程序：未列出的程序仍可能把参数当作指令（例如 `git --upload-pack=…`），或以上述列表之外的方式写入文件；而由同一命令的另一次运行、或由其他命令或技能写入、之后才被运行的文件，超出了单个正文所能检查的范围。当技能或命令的参数可能由模型决定时，只迁移那些你愿意用模型给出的值来运行其 shell 行的插件。
- **`@文件` 只在已知位置内生效。** 命令或 skill 原文中的引用只附加该模板能触及位置内的文件（先解析符号链接）。项目的命令或 skill 只能触及工作区；已安装插件的能触及插件自己的目录和工作区；只有你自己的命令和 skill（在 `~/.claude` 中，或你配置的目录中）还能触及 `~/.claude`。其他位置不会附加，并有一条 `[Harness Forge: @… was not attached …]` 说明。你在参数里输入的 `@路径` 只是普通文本；你自己的附件由 DSH 处理。
- **信任按实际要执行的内容检查。** 项目的命令或 skill 每次渲染时，都会读取它当前的内容，并重新检查工作区是否受信任。工作区未受信任（或已撤销信任）时，它的 shell 行一律不执行，加载后才加进去的也一样，原处会有一条说明。

## 模型

智能体、技能或命令里的 `model:` 可以写 Claude 别名（`haiku`、`sonnet`、`opus` 或 `claude-…` id）。模型名看不出哪个 DSH 模型更强，所以没有 `modelAliases` 配置（[快速开始](quickstart.zh.md#配置)）时使用会话的模型。技能的 `model` 或 `effort` 只用于它运行的那一轮，结束后换回原来的模型。

## 指令文件

DSH 自带的指令加载器已经读取从仓库根到工作目录每一层的 `AGENTS.md`、`CLAUDE.md` 及其 `.local.md`，所以 Harness Forge 不重复添加。**指令文件** 行只把 DSH 不读的部分加进系统提示：

- `~/.claude/CLAUDE.md`，以及从仓库根（最近的 `.git`）到工作目录每一层的 `.claude/CLAUDE.md`。没有仓库时：工作目录在主目录里就读到主目录为止，否则只读工作目录；
- 这些文件以及 DSH 加载的 `CLAUDE.md` / `CLAUDE.local.md` 里的 `@path` 导入：相对于导入它的文件、`~/` 开头或绝对路径；最多 5 层；每个文件只导入一次；代码块和行内代码里的不算。项目文件（所有 `CLAUDE.md`、`.claude/CLAUDE.md` 和 `CLAUDE.local.md`）里的导入只能指向工作区内：仓库根目录，没有仓库时为工作目录，先解析符号链接再判断。文件仍会向上*查找*到主目录，但工作目录之上找到的文件也不能从那里导入，克隆来的仓库因此无法把 `~/.ssh/id_rsa` 或其他项目的文件拉进提示。例外是你在 Claude Code 里批准过外部导入的工作区（`~/.claude.json` 中的 `hasClaudeMdExternalIncludesApproved`）：与 Claude Code 一样，它的导入可以指向任何位置，包括 `~/.claude`。你自己的 `~/.claude/CLAUDE.md` 可以导入任何位置。项目指令文件本身若是指向工作区之外的符号链接，则完全不读取；
- Codex 的 `~/.codex/AGENTS.override.md`（没有则 `AGENTS.md`），除非你的 Codex 设置已经迁移并带上了它。

总量上限 65536 字节：先去掉最宽泛的文件，再截断最具体的那个，并写明。读取本身也有上限，因为无论工作区是否受信任都会读取：一次加载最多读取共 4 MiB（每个文件最多 1 MiB，二进制文件读到的字节同样计入），最多尝试 256 个路径（不存在的导入同样计入），最多列出 32 个未使用的文件。达到上限即停止，不再访问任何文件，提示和工作台中会有说明，写明停在哪里。每个文件只打开一次：是否位于允许位置的检查针对已打开文件的真实路径，内容也从同一个已打开的文件读取，因此检查之后换上的链接不会被跟随。装有 [Recollect](https://github.com/kirkchinese/DSH-Recollect) 时这一行整体让位。关闭这一行即停止添加指令文件。
