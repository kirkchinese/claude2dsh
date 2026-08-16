# awesome-dsh-plugins（自动雷达）提交方案

## 实测现状

- 雷达仓库 `AdamPlatin123/awesome-dsh-plugins` 主 README/PLUGINS 均无
  `claude2dsh`；`data/repo-map.json` 无 `kirkchinese` 条目。
- 我们的仓库已打 `dsh-plugin` topic；政策文件显示 auto-discovery 只会
  保持候选，**listed 目录需要 curation PR**，不会自动晋升。
- PR 模板与 13 类标准：`docs/CATALOGING.md`。预归类器按关键词顺序，
  描述里出现 `skill` 会首先命中 🎓 技能包，因此提交描述应强调会话与
  上下文迁移（真实主能力），避免被误归为纯技能包。

## 拟提交 PR（待用户确认后执行）

标题：`docs: 登记 claude2dsh`

插件信息：

| 项         | 值                                                                                                                |
| ---------- | ----------------------------------------------------------------------------------------------------------------- |
| 插件名     | `claude2dsh`（npm 包 `@claude2dsh/plugin`）                                                                       |
| 仓库       | https://github.com/kirkchinese/claude2dsh                                                                         |
| 分类       | 🤖 Agent 能力                                                                                                     |
| 一句话说明 | 将 Claude Code 会话与上下文导入 DSH 原生会话，支持导出/同步回 Claude Code JSONL，并带双向冲突检测与显式三路合并。 |

自检清单：

- [x] 使用自有 `@claude2dsh/*` scope，未占用 `@deepseek-ai/*`。
- [x] 仓库有 `dsh-plugin` topic。
- [x] 提交 PR 时勾选 Allow edits from maintainers。
- [x] 运行时依赖在 `dependencies`/`peerDependencies` 声明。
- [x] 加载级实测：npm 发布包 `dsh plugin add @claude2dsh/plugin@0.1.0` + 空环境导入会话 + inspect 通过（见 docs/validation.md R8/R12）；
      本地命令等价：
      `dsh --profile headless --patch <(printf -- '- insert:\n    - id: claude2dsh-import\n      name: @claude2dsh/plugin\n') "hi"`

改动内容（`PLUGINS.md` 追加一行）：

| 插件       | 仓库                                      | 说明                                                                                                              |
| ---------- | ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| claude2dsh | https://github.com/kirkchinese/claude2dsh | 将 Claude Code 会话与上下文导入 DSH 原生会话，支持导出/同步回 Claude Code JSONL，并带双向冲突检测与显式三路合并。 |

备注（可选）：

- 已收录于 curated `awesome-dsh-plugin`（Sessions & Messages）。
- 不声称雷达运行级验证；请雷达按其 k8s 实测流程给出独立状态。

## 用户决定与执行结果（2026-08-16 更新）

用户后续确认「刚刚获得同意，可以提交 radar PR」。已按主仓库当前
`PLUGINS.md` 实际格式（🔌 单插件表，含运行级列）提交：

- PR：https://github.com/AdamPlatin123/awesome-dsh-plugins/pull/205
- 标题：`docs: 登记 claude2dsh`
- 分支：`kirkchinese:register-claude2dsh`
- `maintainer_can_modify=true`；只改 `PLUGINS.md` 一行，运行级填
  `待测`，未声称验证通过。

## 纪律

对外 PR 前由用户确认；被驳回/分类调整不追加争论评论，按模板修正后
重新提交。
