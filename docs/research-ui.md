# UI/交互扩展点调研与最小实现

## DSH 机制证据

- Tool render intent：`@deepseek-ai/dsh-tools` 的
  `ToolDefinition.presentCall/presentResult`，返回
  `GenericCallView`/`GenericResultView`（`card:'generic'`），UI 据此渲染
  标题、图标、摘要与内容块；见本机
  `dsh-tools/lib/types/presentation.d.ts`。
- Interaction/approval：`ctx.approval` 是 PreToolDecision.ask 的服务端，
  可用于需要用户确认的操作；本项目写回真实 `~/.claude` 已用显式参数门控，
  未额外接入 approval。
- Web 插件机制：`dsh.client` manifest + browser client plugin 可扩展
  侧边栏/settings 面板。这需要单独 client bundle，不在当前 host bundle 内。

## 竞品对照

- dsh-chat-import：提供 Web 侧边栏“导入会话”面板与进度；dsh-claude-move：
  提供 floating migration panel 与进度。两者均实现完整 web client。
- 本项目当前没有 web client 层。

## 本轮最小 UI（已实施）

- `claude2dsh_import`：
  - pending card title `Import Claude Code sessions`
  - result card title `Claude Code import`，摘要显示
    imported/already/appended/skipped/failed。
- `claude2dsh_sync`：
  - pending card title `Sync DSH session to Claude Code`
  - result card 摘要显示 status/records/events/reason。
- 该实现使用官方 render-intent 机制，不依赖 Web client，headless 与
  web 客户端都能消费。

## 候选增强（交用户决定）

1. 首次安装引导：首次导入后注入一条带 quickstart 的 skill 或提示。
   代价 1 天。
2. 迁移进度/统计面板：Web client 插件 + sidebar slot。
   代价 3–5 天。
3. 双端冲突提示：导入/同步 tool result 已有 conflict status；
   UI 面板可扩展红色冲突列表。代价 1–2 天。
4. 会话/状态浏览：Web 面板列出 registry 中的迁移状态。代价 3–5 天。
