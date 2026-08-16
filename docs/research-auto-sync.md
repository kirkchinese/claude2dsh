# 调研一：自动双向镜像（后台自动同步）

## 现状证据

- 当前同步是显式工具：`claude2dsh_import`（Claude→DSH）与
  `claude2dsh_sync`（DSH→Claude），幂等、带指纹/水印/守卫；见
  `packages/plugin/src/session-import.ts`、`sync-claude.ts`。
- 竞品同样手动：dsh-chat-import 的 `sync_to_claude` 是工具调用；
  dsh-claude-move 无反向（docs/competitor-analysis.md）。

## DSH 侧可监听扩展点（机制级证据）

本机 `@deepseek-ai/dsh-session` 源码/README：
- `session/event`：每次 `Session.append` 提交后的后置通知，载荷是
  `(session, event)`；Cordis `ctx.on('session/event', ...)` 可监听。
- `session/flush`：awaited 耐久性屏障，监听者会等每个 listener settle。
- 日志事件本身有 `turn/start`/`turn/end` 边界；在 listener 里过滤
  `event.type === 'turn/end'` 即可得到“一轮结束”的可靠信号。
- DSH 插件随 profile 进程存活；DSH 进程退出后没有常驻 daemon。
- 冷写入冲突约束：JSONL 后端明确“one live writer per session”
  （dsh-session-persistence-jsonl README）。若一个 DSH 会话仍在 live
  运行，自动从文件侧向同 id 冷 append 会与 live writer 竞争。

## Claude 侧触发源（机制级证据）

- Claude Code 无文档化的“转录文件追加”通知协议；可靠源只有两类：
  1. 文件系统事件：watch `$CLAUDE_CONFIG_DIR/projects/**/*.jsonl`
     （chokidar 或 fs.watch），可被动感知文件增长。
  2. Claude Code hooks：本机已安装插件里就有真实例子
     `openai-codex/plugins/codex/hooks/hooks.json`（SessionStart/
     SessionEnd/Stop）、`i-have-adhd/hooks/hooks.json`（SessionStart）。
     可以挂 SessionEnd hook 调用导入 CLI。hook 配置需写入 Claude 侧
     配置，属于需要用户显式授权的写回。

## 为什么当前是手动

不是技术不可行，而是三个设计选择叠加：
1. 安全边界：写回 Claude 侧默认关，自动镜像会绕过“用户显式触发”这道
   安全闸，必须先解决授权模型。
2. 进程生命周期：DSH 插件只能在 DSH 运行期间工作；Claude 运行期间
   DSH 不一定在线，必须额外引入 watcher 进程或 Claude hook。
3. 并发冲突：两边同时运行时，同一会话的 live writer 与冷 append 会
   冲突；需要会话级锁/延迟队列/冲突仲裁，复杂度明显上升。

## 结论

**可行但代价大。**

实施路径：
1. 保留现有显式工具为底层原语。
2. DSH→Claude：监听 `session/event`（turn/end）+ `session/flush`，
   仅对 registry 中已标记的导入会话调度 `syncClaudeSession`；默认关。
3. Claude→DSH：DSH 插件内 chokidar watch 或独立 CLI 守护，配合可选的
   Claude SessionEnd hook 双触发；文件变更去抖后走现有增量导入。
4. 冲突仲裁：live session 跳过 + registry 水印 + 重试队列。

代价量级：3–5 天实现 + 至少 2 天并发/失败注入测试。
优先级：中。当前显式工具已满足功能验收，自动镜像只减少一次手动调用，
却引入跨进程锁与安全授权面。
