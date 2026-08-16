# 双向并发合并设计

## 目标

Claude 源转录与 DSH 会话都可能在同步水印之后继续增长。自动镜像必须先
保证零数据丢失，再考虑自动合并。

## 共同祖先与单位

- Claude → DSH 的共同祖先是 registry 记录：
  `{ sourceSize, sourceMtimeMs, turns, events, prefixHash }`。
- DSH → Claude 的共同祖先是 export mapping：
  `{ lastWrittenSeq, anchorUuid, fileSize, fileMtimeMs }`。
- 单位是完整轮次：源侧以 `turn/start...turn/end` 计；DSH 侧以
  `turn/start...turn/end` 计。半开尾轮不参与任何自动动作。

## 底线策略（本轮实施）

检测规则：
1. Claude→DSH：导入时若目标 DSH 日志长度 `storedEvents > record.events`
   且源指纹变化，判定双端并发增长。
2. DSH→Claude：同步时若源文件解析 turns `> record.turns` 且 DSH
   `storedEvents > mapping.lastWrittenSeq`，判定双端并发增长。
3. 任一命中：自动镜像置为 `paused`，持久化冲突报告（两端计数与路径），
   跳过本次自动动作，不 append、不覆盖任何一侧。
4. live session 跳过：`ctx.sessions.get(id)` 命中 live 会话时不做冷 append。
5. 恢复：显式工具 `claude2dsh_auto_sync_status` / `resume` 查看与解除暂停；
   解除后保留 conflict 记录，由用户选择显式 import/export 处理。
6. 失败注入必须验证：冲突时源文件与 DSH 日志均逐字节不变（或等价长度/哈希）。

## 增强策略（可选，待确认）

- 以共同祖先为三路合并 base。
- Claude 侧新增完整轮次与 DSH 侧新增完整轮次按各自 timestamp 排序，
  轮内记录保持原顺序。
- 同轮双改：两个版本都保留，并在两条记录后注入 `[conflict]` 标记；
  不自动选择任一版本。
- 交错工具调用：工具调用与结果不能跨轮拆开；按声明轮次整轮搬运，
  若结果缺失则沿用既有合成空结果策略。
- 合并产物写入一个新的安全副本或先 dry-run 展示 diff，经确认后才写回。
- 代价估计：3–5 天实现 + 2 天失败注入/恢复测试。

## 当前状态

- 底线已实施于 `packages/plugin/src/auto-sync.ts` 与 sidecar state。
- 增强方案等待用户确认。
