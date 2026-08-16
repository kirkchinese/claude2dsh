# DSH-Session-Move 集成评估（2026-08-16）

## 对象与实测事实

仓库：`~/DSH-Session-Move`（`kirkchinese/DSH-Session-Move`），
版本 0.1.1，npm 包 `dsh-session-move` + 补丁包
`dsh-session-move-patches-0.1.1.tar.gz`。

关键机制证据：

- `ctx.sessionMove.inspect({sessionId,targetWorkspaceId})` 只读 dry-run：
  使用 `SessionPersistence.readRaw()`，不改任何状态；输出源/目标工作区、
  JSONL 路径、不可变 header、revision、事件数、SHA-256 与 blocker。
- 完整移动只改 header `cwd` + workspace account；SessionId、创建时间、
  血缘、事件流、外部 `dsh-session:` 引用全部保留；仅支持冷会话与
  POSIX JSONL。
- 完整能力依赖 `patches/deepseek-harness/` 的 8 个补丁，精确 base
  `47f943859bef60e4160492346772ded9b24f765a`；官方安装的 rc.6 未打补丁
  只能 read-only inspect，任何 move 返回 `unsupported`。
- 限制：SQLite/Windows 不支持；跨进程并发以单写者模型为前提；
  `dsh-base`-only profile 会因注入 `workspaceRegistry/messageFeedback`
  而明确拒绝激活。

## 与 claude2dsh 的关系

- 职责互补：claude2dsh 负责"外部 Claude 会话 → DSH 原生会话 + 后续
  同步"；DSH-Session-Move 负责"已进入 DSH 的会话在工作区之间迁移"。
- 定位冲突点：claude2dsh 主线是"无补丁、开箱即用"；DSH-Session-Move
  的完整能力硬依赖未合入上游的补丁系列，直接合并会把"必须自建 DSH"
  传染给 claude2dsh，违背主线。
- 因此不建议合并任何代码。

## 建议形态（不合并，做互操作入口）

1. 文档互指：claude2dsh README/roadmap 写明，会话导入完成后若要换
   工作区，优先使用 `dsh-session-move`（未打补丁先 inspect，打了补丁
   再 move）；DSH-Session-Move 文档反向指向 claude2dsh 作为外部会话
   导入入口。
2. 联合验收：claude2dsh 导入的会话由 session-move inspect 校验
   `SessionId` 与事件哈希不变；打补丁环境再做一次跨工作区 move，
   验证 `SessionId` 不变、`prepare/deriveMessages` 可续聊、Claude 导出
   锚点仍可识别。
3. 发布经验反哺：claude2dsh 的 npm 打包经验（`pnpm pack` 后发布、
   workspace 协议转换、真实 registry 空环境验收）可写进
   DSH-Session-Move 的 distribution 清单；其补丁版本门禁经验则提示
   claude2dsh 把 DSH compat gate 保持 fail-loud。
4. 合并前提：只有当 session relocation/workspace move seam 被 DSH
   上游吸收（不再需要私有补丁）时，才重新评估共享代码；此前双方只做
   互操作与文档引用。

## 结论

不合并代码；作为互补工具做互操作入口 + 联合验收 + 文档互指。
