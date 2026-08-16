# DSH 插件收录渠道复查（2026-08-16）

## 复查范围与证据

- DSH 官方仓库 HEAD：`47f943859bef60e4160492346772ded9b24f765a`（master）。
- 本地 sparse checkout 包含 `docs/`、`packages/`、`website/`；本轮新增
  `website/`。
- 命令与结果：
  - `git ls-remote --symref origin HEAD` → master = 47f9438，与上轮相同。
  - `grep -R -n -i -E 'marketplace|plugin director|plugin registr|awesome|third-party plugin|plugin list' docs website packages`：
    无官方第三方插件目录/marketplace/收录清单。
  - `gh api 'repos/deepseek-ai/deepseek-harness/git/trees/master?recursive=1'`
    得到 8617 个路径；按 `awesome|marketplace|plugin.?registr|plugin.?director|plugin.?list`
    过滤为 0。
  - `gh search code` 在官方仓库搜索
    `"third-party plugin"`、`"plugin directory"`、`"awesome-dsh"`、
    `"marketplace"`：无结果（部分请求 EOF，但本地 clone + tree 已覆盖）。
  - 官网 `website/docs.ts` 只有开发教程与 API 参考，没有收录页。

## 结论：官方渠道不存在

DSH 官方仓库、docs、website 均无第三方插件收录目录、marketplace、
plugin registry 或推荐列表。官方只规定插件如何打包/安装
（`docs/user/develop/basic/publish.md`），不维护推荐目录。

## 社区渠道：awesome-dsh-plugin

- 仓库：`https://github.com/awesome-dsh-plugin/awesome-dsh-plugin`
- 本次克隆 HEAD：`df1d87b60bbf368857894312cc76c04822234344`
  （最新 commit 为 PR #863，2026-08-16，维护活跃）。
- 收录要求（contributing.md）：
  1. 仓库 `package.json` 声明 `dsh.bundle`（monorepo 根包或子包均可）。
  2. 有真实可用代码，非 README-only/占位。
  3. 活跃维护；失效会被清理。
  4. 仓库加 `dsh-plugin` topic。
  5. 描述只说功能，不用营销词。
  6. PR 需要同时改 `README.md` 与 `README.zh.md` 各一行。
  7. 推荐（非强制）：发布 npm；官方 `@deepseek-ai/*` 包用
     peerDependencies。

## 我们是否达标

| 要求 | 状态 | 证据 |
| --- | --- | --- |
| `dsh.bundle` | ✅ | 根包与 `packages/plugin/package.json` 均声明 `dsh.bundle.patch` |
| 真实代码 | ✅ | TypeScript monorepo，已发布 npm 并完成真实 registry 验收 |
| 活跃维护 | ✅ | 仓库持续提交；npm 0.1.0-rc.2 与 GitHub release 已发布 |
| `dsh-plugin` topic | ✅ | `gh repo view` 显示 topic 含 `dsh-plugin` |
| npm 发布 | ✅（推荐项） | 三包 latest 0.1.0-rc.2 |
| 官方包 peerDependencies | ⚠️ 部分 | 宿主包为 peer；hook bridge 作为 dependency 引入（因其是自带 bundle 子插件） |
| README 描述规范 | ✅ | 根 README 能力表与诚实局限 |

差距清单：无阻断项。可选优化：GitHub 仓库 description 为空，可补充；
README 已可作 storefront 回退截图来源。

## 建议收录分类与文案

分类：Sessions & Messages（会话与消息）。

英文行：
`- [kirkchinese/claude2dsh](https://github.com/kirkchinese/claude2dsh) - Import Claude Code sessions, skills and plugin assets into DSH as native resumable sessions, and export or sync DSH sessions back to Claude Code JSONL.`

中文行：
`- [kirkchinese/claude2dsh](https://github.com/kirkchinese/claude2dsh) — 将 Claude Code 会话、技能与插件资产导入为 DSH 原生可续聊会话，并支持将 DSH 会话导出或同步回 Claude Code JSONL。`

提交方式：向 `awesome-dsh-plugin/awesome-dsh-plugin` 发起一个 PR，仅修改
上述两个 README 各一行；不修改其他文件。

## 决策状态

PR 已提交：https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/968

## 2026-08-16 晚更新：PR #968 与 data-driven-list 新格式

实测（`gh pr view 968` + API）：

- PR 状态：`OPEN`；`mergedAt:null`；评论数 0；baseRefName=main；
  baseRefOid 仍是旧 main `df1d87b6`。
- main 最新提交 `bccd4d9c`（#970）已将列表迁移为
  `data/plugins/<owner>__<repo>.yml` + 脚本生成两个 README；
  旧的"手工改 README"提交方式已废弃。
- PR 对旧 base 仍显示 `MERGEABLE/CLEAN`，但内容基于旧格式，合并到
  新 main 后不会出现在生成列表的正确位置；条目不在列表的原因 =
  **PR 未合并，且仓库格式已改，旧式 PR 不再适配**。
- `contributing.md` 新要求：一个 PR 只新增一个
  `data/plugins/kirkchinese__claude2dsh.yml`，并运行
  `npm ci && node scripts/generate-readme.mjs` 后提交生成的两个 README；
  CI 自动检查 `dsh.bundle`、仓库年龄/提交数、awesome-lint 与站点构建。

按新格式准备的条目（`data/plugins/kirkchinese__claude2dsh.yml`）：

```yaml
url: https://github.com/kirkchinese/claude2dsh
name: kirkchinese/claude2dsh
category: session
description:
  en: Import Claude Code sessions, skills and plugin assets into DSH as native resumable sessions, and export or sync DSH sessions back to Claude Code JSONL.
  zh: 将 Claude Code 会话、技能与插件资产导入为 DSH 原生可续聊会话，并支持将 DSH 会话导出或同步回 Claude Code JSONL。
```

后续选项与代价：

1. **更新 PR #968 到新格式（推荐）**：rebase 分支到新 main，用上面的
   YAML + 生成的 README 替换旧的两行手工修改，force-push 同一分支。
   代价约 0.5 小时，不新增评论，符合新 contributing 规范。
2. 等待维护者处理：PR 当前对新 main 已过时，等待大概率被要求改格式；
   代价是不确定等待时间。
3. 关闭后重开：会丢失现有 PR 链接与 review 记录（当前 0 评论，
   损失小），不如直接 force-push。

具体动作需用户确认后执行。
