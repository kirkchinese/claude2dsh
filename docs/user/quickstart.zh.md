# 快速开始

[English](quickstart.md) · 中文

## 安装

要求：DSH 0.2.2-rc.3 或更新、Node.js 22.19+ 或 24+。Windows 上运行 hook 需要 Git Bash（随 Git for Windows 安装），与 Claude Code 相同。OpenCode 代码插件需要 Bun：优先用 `PATH` 上或 `~/.bun` 里的，没有的话 Harness Forge 会在第一次用到时装一份到自己的数据目录（也可以用 `BUN_PATH` 指定 Bun 可执行文件）。Claude Code 的 mods（hooks 模块）用 rolldown 打包，同样在第一个 mod 加载时由 Harness Forge 用 npm 装到自己的数据目录。

在 DSH 里打开 **插件 › 添加插件**，输入 `@kirkchinese/harness-forge` 并安装，它会装进你正在使用的 profile。

也可以在终端里装到 `dsh web` 使用的主 profile：

```sh
dsh plugin --profile web add @kirkchinese/harness-forge
```

然后重新启动 DSH。要装到其他 profile，把 `web` 换成它的名字；桌面版只能通过 **插件 › 添加插件** 安装。

之后 DSH 侧边栏里会出现 **Harness Forge**。工作台跟随 DSH 的语言（中文或英文）。

## 发现与迁移

![“发现与迁移”，展开“你自己的设置”](../assets/discover.zh.jpg)

第一个页面按来源（Claude Code、Codex、OpenCode）列出这台电脑上有什么：

- **你自己的设置**：`~/.claude` 和 `~/.codex` 下的技能、命令、智能体、MCP 服务、hook 和设置；
- **每个已安装的插件**：它的每个部分标为 **可用**、**部分可用** 或 **无法使用**，并写明原因。迁移前这是根据插件文件做的预计；实际运行过之后，这个部分会标为已核对。

点 **全部迁移** 迁移所有尚未迁移的内容，或者逐个插件迁移。迁移不会改动原工具里的任何东西：插件从原来的安装位置运行。

在同一页面还可以 **浏览插件市场**：输入一个带 `.claude-plugin/marketplace.json` 的文件夹（例如 `~/.claude/plugins/marketplaces` 下的目录），查看并安装其中的插件。

## 已迁移

在 DSH 里生效的所有内容，按插件列出。可以关闭单个部分，为需要登录的远程 MCP 服务登录，或者移除一个插件来撤销它的迁移。

![“已迁移”：展开一个插件，一个部分已关闭，一个因所在行关闭而未生效](../assets/migrated.zh.jpg)

## 缺口

所有无法在 DSH 里完整运行的部分及原因。能由适配器补上的，点 **用 AI 补上** 会直接开一个创造模式的会话来编写适配器并打开它；在智能体验证适配器之前，这个部分显示 **进行中**，验证之后显示 **已完成 — 已验证**。见 [移植](porting.zh.md)。

![“缺口”：状态栏部分正在移植，显示“进行中”](../assets/gaps.zh.jpg)

## 更多

| 页面 | 用途 |
|---|---|
| 导入会话 | 把 Claude Code、Codex、OpenCode 的会话导入为 DSH 会话，导入后可以立即打开，在 DSH 里接着聊。再次导入同一个会话会打开之前导入的那个。装有 [dsh-chat-import](https://github.com/Nwflower/dsh-chat-import) 时，这个页面改为指向侧边栏里它的 **导入会话** 按钮 |
| 设置 | 额外搜索插件的文件夹、是否自动发现，以及哪些 CLAUDE.md / AGENTS.md 文件会加入新会话 |
| 诊断 | 启动失败的行、挂载失败的部分、hook 使用的 shell、Bun，以及 Harness Forge、DSH 和 Node.js 的版本：报告问题时附上这些 |

![导入 DSH 后接着聊的 Claude Code 会话](../assets/continue-session.jpg)

**搭配 dsh-chat-import。** 想导入更多来源（40 多种智能体）、需要更多选项，可以安装 [dsh-chat-import](https://github.com/Nwflower/dsh-chat-import)：首次打开时的提示条或导入会话页面上的 **安装** 会先确认，再通过 DSH 的插件管理器安装。没有插件管理器时，运行 `dsh plugin --profile web add dsh-chat-import`。

## 在对话里使用

模型可以通过工具直接使用 Harness Forge：`harness_status`、`harness_discover`、`harness_capabilities`、`harness_scan`、`harness_plan`、`harness_install` 和 `harness_mcp_login`。随包的 `harness-forge` 技能告诉它何时使用这些工具。你也可以输入命令：

```text
/harness status | list | roots
/harness scan <path> [source] | plan <path> [source] | import <path> [source]
/harness undo <receipt-id> | remove <plugin-id> | login <server>
```

## 配置

全部可选。主行（`harness-forge`）：

| 字段 | 含义 |
|---|---|
| `modelAliases` | Claude 别名（`haiku`、`sonnet`、`opus`）使用哪个模型，写作 `provider/model`。不写时使用会话的模型 |
| `preload` | 启动时自动迁移的插件文件夹 |
| `debug` | 把生命周期诊断写到 Harness Forge 状态旁的 `debug.log`（`<profile>/.harness-forge/`） |

技能行（`harness-forge-skills`）接受 `skillRoots`：额外扫描 `SKILL.md` 技能的文件夹。这类文件夹里的每个技能都会原样提供，不经导入或审核。导入插件的技能则不同：只提供已导入且处于开启状态的技能，即使同一文件夹里还有其他技能。

```yaml
- id: harness-forge
  config:
    modelAliases:
      opus: deepseek-official/deepseek-flash
- id: harness-forge-skills
  config:
    skillRoots: [/home/me/shared-skills]
```

## 安全

迁移来的 hook、MCP 服务和插件代码以你的权限运行，与在原工具里相同。只迁移你信任的插件。
