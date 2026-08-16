# 差距清单（对照目标终态的验收基线）

目标终态：Claude Code 与 DSH 双向原生体验——任一端发起/继续/读写会话均不
崩溃、不报错，且对方能按原生会话识别。

| # | 差距 | 竞品现状 | 本项目要求 | 轮次 |
| --- | --- | --- | --- | --- |
| G1 | Claude→DSH 最小闭环 | 均有，但可靠性未覆盖主链分支/中断工具；claude-move 有已知重复 tool/result bug | 用 parentUuid 主链选择 + 每 tool_call 恰一 result；产物经 DSH Session 校验 | R1 |
| G2 | skills→DSH 原生资产 | claude-move 运行时 provider 且有 README 误识别 bug；chat-import 无 Claude skills | 解引用复制到 `$DSH_HOME/skills`，DSH `ctx.skills` 原生发现 | R1 |
| G3 | 会话源适配器抽象 | 无统一抽象（每源一个 convert 函数） | `SessionSourceAdapter` 接口 + registry，Claude 为第一个实现 | R1 |
| G4 | DSH→Claude 反向 | 仅 chat-import 有；默认写 `~/.claude` 且非对称 | 已实现：导出默认 `$DSH_HOME/claude2dsh/exports`，`~/.claude` 需显式授权；Claude Code 经 mock 端点识别 | ✅ R2 |
| G5 | 双向继续对话 | 均需用户手动重跑导入/调用 sync；不自动 | 增量 append 已验收；自动镜像调研结论：可行但代价大（3–5 天），需 watcher/hook + 跨进程锁，建议默认关 | ✅ R3 + 📋 R5 调研 |
| G6 | 两端写入互认 | chat-import 的 Claude 文件与 DSH 日志格式不同，只做复制转换 | 写入只落各自原生格式；DSH 追加轮经 sync 后 Claude Code 真实识别；source 写回更新 registry 前缀指纹 | ✅ R3 |
| G7 | 主链分支/撤回/重写 | 两竞品均未处理 | 主链选择器 + 已导入前缀不变 + 源被改/缩短检测 | R3 |
| G8 | subagents/workflows | 两竞品均跳过 | 已实现：`includeSubagents` 发现 725 个 agent 转录并作为 `origin:subagent` 子会话导入，全部原生 inspect 通过 | ✅ R4 |
| G9 | 插件生态/其他数据 | 仅部分（memory/CLAUDE.md 注入） | 已拆成资产清单（可行，低代价）与运行时能力（不可自动迁移，按插件重写）两种语义，见 docs/research-plugin-ecosystem.md | 📋 R5 结论 |
| G10 | 图片/tool-result sidecar | 竞品未处理 | 数据关系与 DSH 图片通道已核实：存储可行、DeepSeek 文本路由不可消费；推荐"attachment 保存 + 占位符 + sidecar registry" | 📋 R5 调研 |
| G11 | 标准插件发布 | 竞品已发布 npm | 本地发布缺口已全部修复（0.1.0-rc.1、files 白名单、README、tarball 冒烟）；npm 凭据未配置，实际 publish 待用户确认 | ✅ 本地可发布 |
| G12 | 验证基线 | 竞品无真实数据验收证据；测试依赖 mock ctx | 真实副本数据 + DSH 原生 load/list/skills + 双向夹具 + 真实 API 闭环已补齐（R5） | ✅ 每轮 |

## 验收基线（每轮必过）

1. 读原数据只读；写 Claude 侧默认关；实验用备份副本。
2. `Session.create(seed=导入事件)` 重放通过且 `deriveMessages()` 不抛错。
3. DSH profile 启动无 FAILED；导入后 `sessionPersistence.list/inspect` 可读。
4. skills 导入后 `ctx.skills.snapshot` 含迁移技能且可 `get()`。
5. 每轮改动一个变量，验证命令与结果落 docs/validation.md。
