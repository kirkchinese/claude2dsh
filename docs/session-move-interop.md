# dsh-session-move 联合验收配方

目标：证明 claude2dsh 导入的 DSH 会话可以被 dsh-session-move 只读
inspect，并在具备其补丁运行时后按 SessionId 不变迁移；任何一步不写
真实 `~/.claude`。

## 步骤

1. 隔离 DSH_HOME 创建 profile，安装
   `@claude2dsh/plugin`（发布包或 link）。
2. 用 claude2dsh 导入一个备份会话：
   `claude2dsh_import({ path: <备份主会话 jsonl>, preview:false })`；
   记录 `sessionId`。
3. 在同一 profile 安装 `dsh-session-move`（未补丁 rc.6 只可 inspect）。
4. 调用互操作工具：
   `claude2dsh_session_move_inspect({ sessionId, targetWorkspaceId })`。
   预期之一：
   - 未安装/未提供 `ctx.sessionMove` → `status:'unsupported'` + 安装提示；
   - rc.6 未补丁 → dsh-session-move 返回其只读 inspect blocker；
   - 打补丁运行时 → inspect 通过后，在官方 Web 侧边栏执行跨工作区 move。
5. 验收不变量：
   - SessionId 不变；
   - `sessionPersistence.inspect` 事件数与 SHA-256 不变；
   - `sessionPersistence.prepare().deriveMessages()` 可续聊；
   - 若曾导出 Claude JSONL，导出锚点与 `claude2dsh_sync` 仍可继续。

## 当前状态

- claude2dsh 侧已提供 `claude2dsh_session_move_inspect` 入口与单测。
- 完整 move 仍受 dsh-session-move 上游补丁限制；本仓库不合并其代码。
