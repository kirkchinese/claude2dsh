# ~/.claude 数据结构勘察（2026-08-15，副本可复现）

## 方法与证据

- 原始 `~/.claude` 只读；实验副本：`/tmp/claude2dsh-source-backup`（458 MiB，
  `cp -a --reflink=auto`）。
- 勘察脚本：`inventory_projects_jsonl.py`（隐私保护：不输出消息正文/命令/
  文件内容，只输出结构路径、类型、频次、相对位置与聚合关系）。
- 输出：`projects-structural-inventory.json`（2.1 MB）、
  `projects-structural-inventory.fields.tsv`（逐字段记录）。
- 复现命令：
  `python3 inventory_projects_jsonl.py /tmp/claude2dsh-source-backup/projects /tmp/out.json`
  重跑哈希与仓库内文件一致（SHA-256 见提交内容）。

## projects/ 覆盖

| 指标 | 值 |
| --- | ---: |
| 项目目录 | 8 |
| JSONL 文件 | 864 |
| 字节 | 314,607,584 |
| 物理行 / 解析记录 | 65,762 / 65,762 |
| 空行 / 畸形行 | 0 / 0 |
| 记录类型 | 13 |
| JSON sidecar | 806 |
| tool-results sidecar | 847 |

记录类型分布（全量）：

| type | 条数 | 出现位置 |
| --- | ---: | --- |
| assistant | 38,462 | main / direct agent / workflow agent |
| user | 20,329 | 同上 |
| attachment | 3,227 | 同上 |
| queue-operation | 837 | 仅 main |
| last-prompt | 654 | 仅 main |
| system | 469 | main（468）+ direct agent（1） |
| started | 436 | 仅 workflow journal |
| mode | 404 | 仅 main |
| ai-title | 338 | 仅 main |
| result | 322 | 仅 workflow journal |
| file-history-snapshot | 119 | main |
| file-history-delta | 84 | main |
| permission-mode | 81 | main |

## 会话文件拓扑（关系结论，证据在 JSON relationships）

- 主会话转录 58 个，文件名 = 记录内 `sessionId`（58/58）。
- `subagents/` 下转录 725 个（direct 289 + workflow 436），每个有同名
  `<agent-file>.json` sidecar（725/725 配对），agent 文件名 = 记录内
  `agentId`。
- workflow journal 81 个：`started` 436、`result` 322；114 个 started
  尚无 result；每个 journal 所在 workflow 目录有 `state.json`（81/81）。
- UUID/parentUuid 图：62,487 个 uuid 全部唯一；61,694 条 parent 边全部在
  同一文件内解析；无悬空；19 个父节点有 2 个子节点；40,221 条边标记
  `isSidechain`。
- 主链分支：58 个 main 文件中，13 个"非 sidechain 多子节点"分支点，
  集中在 5 个会话；可见链必须显式选择（last-chain 规则需实现并测试）。
- 压缩/摘要：`last-prompt` 654 条且 leafUuid 全部解析；`isCompactSummary`
  user 记录 12 条，`system` compact boundary 12 条。
- 工具调用配对：assistant tool_use id 14,219 个；user tool_result 块引用
  18,712 次全部解析到 assistant tool_use；另有 `sourceToolUseID` 38 次。
- tool-results sidecar：text 368、image 479；被 JSONL 字符串引用的 507 个
  路径中 505 个能解析到直接条目，2 个缺失。
- queue-operation：50 个会话有队列事件（enqueue/remove/dequeue），dequeue
  无内容，逐事件配对不可精确推断（已记录为结论）。

## 关键记录字段摘要（完整逐字段见 fields.tsv）

### assistant（38,462）
必现：`cwd`、`entrypoint`、`gitBranch`、`isSidechain`、`message`
（`content[]`、`id`、`model`、`role:assistant`、`type:message`、`usage`）、
`parentUuid`、`sessionId`、`timestamp`、`type:assistant`、`userType`、
`uuid`、`version`。
内容块类型：`redacted_thinking` 18,224、`tool_use` 18,712、`text` 1,339、
`thinking` 209。
可选高频：`agentId` 26,370、`attributionAgent` 22,081、
`attributionSkill` 10,450、`attributionPlugin` 2,878、`effort` 37,865。
低频但存在：`isApiErrorMessage` 150、`apiErrorStatus` 1、`error` 101、
`message.container/diagnostics/context_management` 等 null 字段。
- `usage` 字段结构、`message.stop_reason`（string 12,071 / null 61）、
  `message.stop_details` 等已逐字段记录。

### user（20,329）
必现：`cwd`、`entrypoint`、`gitBranch`、`isSidechain`、`message`
（`content` 为 array 19,130 / string 1,199）、`parentUuid`（null 780 /
string 19,549）、`promptId`、`sessionId`、`timestamp`、`type:user`、
`userType`、`uuid`、`version`。
工具结果：`sourceToolAssistantUUID` 18,712、`toolUseResult` 7,597
（对象 6,382 / 字符串 1,215，内含 200+ 子字段路径，已全量记录）。
直连提问：content 为 string 的 1,199 条。
低频：`isCompactSummary` 12、`isMeta` 416、`isVisibleInTranscriptOnly` 12、
`origin` 360、`permissionMode` 317、`toolDenialKind` 33、
`interruptedByShutdown` 15。

### 其他
- `attachment`：`attachment.type` 值域含 `skill_listing`（797）、
  `list`、`content`、`permission_mode`、`hook`、`plan` 等（完整值域在 JSON）。
- `system`、`queue-operation`、`mode`、`permission-mode`、`last-prompt`、
  `file-history-*`：字段路径与出现频次已逐字段记录，样例位置（file+line）
  可复现。
- JSON sidecar schema：main session sidecar（32）、agent meta（725）、
  workflow state（81）等，字段指纹和样例已记录。

## skills/ 拓扑

- 39 个条目，全部为 **指向 Python 包内目录的符号链接**（
  `~/.local/lib/python3.12/site-packages/<wiki-package>/_data/skills/...`）。
- 每目录含 `SKILL.md`；frontmatter 至少含 `name`、`description`。
- 迁移必须解析链接后复制内容（原目录只读）；不能仅复制链接或依赖原路径。

## plugins/、session-env/、history.jsonl

- plugins：`installed_plugins.json`、`known_marketplaces.json`、marketplaces/
  cache/data；不参与本轮会话迁移，架构上作为"插件生态"轮次数据源。
- session-env：43 个 UUID 子目录（会话环境快照）；与 projects 会话 id 关联
  关系待插件生态轮勘察。
- history.jsonl：10 行（最近会话索引）；不是会话正文源。

## 对实现的强制结论

1. Claude 主链必须用 parentUuid 图选择，不能按文件顺序平铺。
2. 仅标准 DSH 事件即可承载模型可见历史；原始 Claude 记录需放侧车
   （本项目 registry），不能依赖自定义事件混入 DSH 日志。
3. subagents/workflows 是独立数据面，按"会话源适配器"扩展点处理，不得
   与主会话混同。
4. skills 是符号链接目录，必须解引用复制到 DSH 技能根。
