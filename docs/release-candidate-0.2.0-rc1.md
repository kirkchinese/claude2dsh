# 0.2.0-rc.1 发布候选（第七轮）

## 范围

- awesome-dsh-plugin curated 收录 badge + `README.zh.md`。
- DSH Settings 页面：auto-mirror、导入默认值、写回、hook 字段；
  session sources 面板；坏值 fail loud。
- 全局 CLAUDE.md → `$DSH_HOME/AGENTS.md`；项目 MEMORY.md/memory/*.md
  → DSH 技能包。
- tool-result .txt sidecar 拷贝 + 映射 + 大小上限。
- 双向显式三路合并（同轮双改保留双方 + log-only 标记），只写安全副本。
- 会话来源 sidecar 与 `claude2dsh_session_sources`。
- `claude2dsh_session_move_inspect` 与 dsh-session-move 互操作入口。
- adapter 修复：字符串 tool_result / 字符串 content array 归一化。
- e2e round7 + 全量回归记录。

## 版本

- 三包及根包版本 `0.2.0-rc.1`；workspace 依赖同步。
- npm latest 当前仍为 `0.1.0`；本次发布需用户确认后执行
  `pnpm pack` + `npm publish <tarball>` 流程，并做空环境验收。

## 发布前检查（已执行）

- 根 `pnpm run check` 全绿。
- workspace build/typecheck 全绿；tests core 8、adapter 13、plugin 30。
- e2e R1/R2/R3/R4/R7 全绿。
- `scripts/check-dsh-compat.mjs` 通过（DSH 0.1.0-rc.6）。
- pack 三包 manifest：0.2.0-rc.1，无 workspace 协议，plugin 含
  `lib/client.js` 与 `dsh.client`。
- 未发布、未打 tag；radar PR 按用户决定暂不提交。

## 发布状态

- npm 四包已发布，`latest=0.2.0-rc.1`，空环境 quickstart 通过。
- GitHub push/tag/pre-release 随后执行。
