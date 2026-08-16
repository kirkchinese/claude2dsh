# 会话来源展示调研与替代方案

## DSH 前端机制证据

- 会话列表由 `@deepseek-ai/dsh-client-ui-workspace` 通过
  `sidebar.workspaces` slot 渲染；该 slot 在
  `dsh-client-ui-sidebar/lib/types/client/contract/slots.d.ts` 中为
  `kind:'single'`，已被官方 WorkspaceBrowser 独占。
- `ui-workspace` README 明确：subagent 行按 durable summary 的
  `origin:'subagent'` 隐藏，普通行显示于父级；行本身没有
  `session.row` / row-decoration slot（slot ledger 中全部名字见
  `dsh-client-ui-*`：无 session row 级 hole）。
- `SessionHeader`（dsh-session rc.6 types.d.ts）的 `origin` 字段只有
  `'subagent'` 一个值，不能写 `claude`/`codex`；header 没有任意来源字段。
- 因此第三方插件无法在不替换整个浏览器的情况下给会话行加来源徽标；
  替换整个 `sidebar.workspaces` 会复制官方全部行为，风险高。

## 已实施的事实层

- 导入时为每个会话写入 `$DSH_HOME/claude2dsh/session-sources.json`：
  `claude-main` / `claude-subagent` / `claude-merged`（`codex`/`native`
  预留）。
- `claude2dsh_session_sources` 工具可 list/resolve；模型能准确获得来源，
  不依赖前端。
- subagent 来源同时由官方 `origin:'subagent'` header 表达，官方前端
  已按父子归属处理。

## 替代方案（交用户选择）

| 方案                                         | 形态                            | 工作量/代价                               | 效果                                                  |
| -------------------------------------------- | ------------------------------- | ----------------------------------------- | ----------------------------------------------------- |
| A. 向上游提案新增 `sidebar.session.row` slot | DSH 上游 PR                     | 大；需官方合入并等新版本                  | 官方列表原生显示第三方来源徽标，最彻底                |
| B. Settings 页内"Session sources"浏览面板    | 本插件 web client 自绘          | 小；复用现有 `/plugins/claude2dsh/*` 模式 | 清晰列出 claude/native/codex 会话来源，不侵入官方列表 |
| C. 标题前缀标记（如 `[Claude]`）             | 导入时追加 `session/title` 事件 | 小；会固定标题、改动用户可见标题          | 列表中立即可见，但污染标题且 title source 不表达来源  |
| D. 保持工具+文档                             | 现状                            | 无                                        | 模型可查，人不直观                                    |

推荐：先做 B（自绘面板，不越界），同时把 A 写成上游 issue/PR 草案；
C 不建议（标题被固定、无法扩展更多来源）。
