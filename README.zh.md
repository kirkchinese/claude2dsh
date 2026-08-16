# Claude2DSH

[![Awesome DSH Plugin](https://awesome-dsh-plugin.com/badge.svg)](https://awesome-dsh-plugin.com)

把 Claude Code 的会话、技能、记忆与插件资产迁移为 DeepSeek Harness（DSH）原生可续聊会话，并可把 DSH 会话导出/同步回 Claude Code JSONL。Claude Code 是多工具迁移层的第一个会话源适配器。

本项目已被社区 [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) 收录在 **Sessions & Messages（会话与消息）** 分类。自动雷达 [awesome-dsh-plugins](https://github.com/AdamPlatin123/awesome-dsh-plugins) 尚未给本项目打"运行级验证"标记；上方 badge 只代表精选列表收录，不代表雷达实测结论。

## 设计原则：傻瓜式开箱即用

默认路径必须不读文档也能用对：一条命令安装、浏览器打开、看到 UI、完成第一次迁移。安全默认绝不因此放松——写回真实 `~/.claude` 仍然默认拒绝，只有用户明确打开带风险提示的开关才允许。完整判据见 `docs/design-philosophy.md`。

## 快速开始（空机器）

要求：Node.js `>=22.19.0`、pnpm 与 `dsh` CLI。

### 推荐：使用 DSH 内置 web profile

```sh
# 1. 把插件装进内置有头 profile
dsh plugin --profile web add @claude2dsh/plugin@0.2.0-rc.1

# 2. 启动浏览器 UI（终端会打印 http://127.0.0.1:3080）
dsh web
```

打开打印出的 URL，进入 **设置 → Claude2DSH**。第一屏就是迁移向导：选择语言（默认中文）、填/确认 Claude 会话目录、点 **预览导入** 看报告、再点 **执行导入** 看到结果。

### 备选：一条命令生成独立有头 profile

克隆本仓库后运行：

```sh
bash scripts/install-claude2dsh.sh
```

脚本把插件装进你的主 `web` profile 并启动浏览器 UI（`http://127.0.0.1:18781`）。默认不创建隔离 profile；只有显式设置 `CLAUDE2DSH_PROFILE` 时，才为自定义 profile 安装 `dsh-web-app`，并在 pnpm 报无害的 `koffi` build script 被忽略时自动补齐 `dsh.profile.bundles`。

### Headless（仅高级用户/自动化）

没有浏览器的自动化环境直接用工具：

```sh
dsh plugin --profile claude2dsh add @claude2dsh/plugin@0.2.0-rc.1
CLAUDE2DSH_TEST_IMPORT=~/.claude/projects dsh --profile claude2dsh
```

**有头 vs 无头一句话：** 有头 profile 包含 `@deepseek-ai/dsh-web-app`，会打开浏览器 UI；无头 profile 运行同一套工具但没有浏览器。旧教程只创建了无头 profile，所以"什么都看不到"——插件其实在工作，只是没有 UI 可显示。

## 能力：什么场景、怎么用

| 能力          | 使用场景                                               | 入口                                                          |
| ------------- | ------------------------------------------------------ | ------------------------------------------------------------- |
| 会话导入      | 首次迁移，或 Claude Code 产生新轮次后                  | 设置 → Claude2DSH → 首次迁移向导，或 `claude2dsh_import` 工具 |
| 技能导入      | 让 Claude 技能进入 DSH 原生发现                        | `claude2dsh_import_skills` 工具                               |
| 全局上下文    | 把用户全局 `~/.claude/CLAUDE.md` 迁到 DSH 全局指令     | `claude2dsh_import_context` 工具                              |
| 项目记忆      | 把一个项目的 `MEMORY.md`/`memory/*.md` 变成 DSH 技能包 | `claude2dsh_import_memory` 工具                               |
| 导出回 Claude | 在 Claude Code 里继续这个会话                          | `claude2dsh_export` 工具                                      |
| 同步回写      | 把 DSH 侧新轮次写进导出副本                            | `claude2dsh_sync` 工具                                        |
| 自动镜像      | 持续双向镜像，冲突自动暂停                             | 设置 → 自动镜像（`autoSync.enabled`）                         |
| 冲突合并      | 双端都在同步点后增长、任一侧都不能丢                   | `claude2dsh_merge` 工具                                       |
| Sidecar 文件  | 找到导入时复制的大工具输出                             | `claude2dsh_sidecars` 工具                                    |
| 会话来源      | 区分 claude 主会话/子会话/合并会话                     | 设置 → 会话来源，或 `claude2dsh_session_sources` 工具         |
| 插件盘点      | 只读查看 Claude 插件，不执行其代码                     | `claude2dsh_plugin_inventory` 工具                            |
| 图片策略      | 老转录里的图片安全进入 DSH                             | 默认 `imageMode:"auto"`；设置 → 导入默认值可改                |

导入对 `~/.claude` 只读且幂等：第二次运行显示"已存在"，不会重复。任何写入前都可先预览；每个动作返回 JSON 报告，UI 会显示 `新导入/已存在/追加/跳过/失败` 数字。

## FAQ

**我按旧教程装完看不到 UI。**
那个 profile 只有 `@deepseek-ai/dsh-base + @claude2dsh/plugin`，是无头 profile。把插件装进 `dsh plugin --profile web`，或用 `scripts/install-claude2dsh.sh`。UI 在 **设置 → Claude2DSH**。

**`dsh plugin add @deepseek-ai/dsh-web-app` 报 "Ignored build scripts: koffi" 失败。**
pnpm 拒绝运行 koffi 的构建脚本，依赖其实已安装，但 dsh 没有完成 bundle 修补。安装脚本会检测该状态并修复 `dsh.profile.bundles`。不要随便批准第三方构建脚本。

**什么是 profile？**
是 `$DSH_HOME/profiles` 下的一个命名目录，记录 bundles 与覆盖。普通用户只需要 `web`（浏览器）或脚本生成的 `claude2dsh`。

**会写我的真实 ~/.claude 吗？**
不会。导入只读；导出/同步只写 `$DSH_HOME/claude2dsh/exports` 安全副本。写原始 `~/.claude` 需要显式 `allowOriginalClaudeDir:true`，默认拒绝。

**为什么 auto mirror 和 hook bridge 默认关？**
为了不产生用户尚未理解的意外。可在设置中开启；自动镜像绝不写真实 `~/.claude`，hook bridge 只支持文档明示的 7/30 command-only 子集。

## 诚实局限

- Claude hook bridge **默认关闭、需显式开启**：wrapper 在上游 `@deepseek-ai/dsh-hooks-claude-code` 之外做启动前配置校验，坏 `hooks.json` 会带路径 fail loud。上游支持 **Claude Code 30 个 hook 事件中的 7 个**，且仅 `type:"command"` handler，各事件语义部分实现；hook 运行会以 `hook/invoked` + `hook/result` 事件对写入会话日志。全兼容是 roadmap 目标，不是现状承诺。
- 原生图片路径已实现，但尚未在真实支持视觉的 DSH 模型路由上验收；随附 DeepSeek adapter 声明仅文本输入。
- Auto mirror **默认关闭、需显式开启**。启用 `autoSync.enabled: true` 后监控 Claude 转录，并把 DSH 轮次镜像到安全导出副本；绝不写真实 `~/.claude`。双端在同步点后同时增长时暂停并报告冲突；用 `claude2dsh_autosync` 查看/恢复。
- 完整插件运行时兼容性是 roadmap 目标。自动合并冲突现在由显式 `claude2dsh_merge` 工具承担；自动镜像仍只暂停报告，不猜测。

## 互操作

- `claude2dsh_session_move_inspect` 在安装了 `dsh-session-move` 时调用其 inspect；本工具自身绝不移动会话。迁移完成后如需跨工作区移动冷会话，请使用 dsh-session-move；完整移动能力依赖该项目 DSH 补丁系列，见 `docs/session-move-interop.md`。

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
