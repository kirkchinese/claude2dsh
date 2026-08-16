# 验证记录

## R1 最小闭环：Claude 会话 + skills → DSH 原生读取

复现命令：`bash scripts/e2e-round1.sh`（默认源副本
`/tmp/claude2dsh-source-backup`，可用 `CLAUDE2DSH_SOURCE_BACKUP` 覆盖）。

验证变量（一次只测一个）：

1. 工作区 `pnpm -r build && pnpm -r typecheck && pnpm -r test` 全绿。
2. 隔离 DSH_HOME（mktemp）+ base-only profile + `@claude2dsh/plugin`
   本地 link，`dsh --profile claude2dsh-e2e` 启动，`--dump-config` 能看到
   `claude2dsh-import` 行。
3. env 门控 seam 导入备份 projects 全量 + skills 全量并写报告。

真实数据结果（58 个主转录、39 个技能）：

- 报告 `imported=57 skipped=1 failed=0`；skip 证据为
  `171f5c9a-...jsonl` 仅含 mode/permission-mode/system/last-prompt，
  无 user/assistant 可导入记录。
- DSH 原生 `sessionPersistence.list()` 返回 57 个头；每个导入会话
  `inspect()` 成功，事件总数 22,163，无失败。
- 对 57 个会话逐一调用 DSH resume 路径 `sessionPersistence.prepare()` 并
  `deriveMessages()`，全部 >0 条模型消息，证明可直接续聊。
- 另用 `@deepseek-ai/dsh-session` 的 `Session.create(seed)` 对同一事件流
  重放并 `deriveMessages()`，57/58 通过（1 个无消息跳过），证明模型面可读。
- `ctx.skills.snapshot()` 列出 42 个技能：39 个来自 Claude 副本，另 3 个为
  DSH 自带；39 个迁移技能全部被 DSH 原生发现。
- 重跑同一导入：57 个 `already-imported`，39 个技能
  `skipped-identical`；未新增/覆盖任何文件。

原始目录安全：脚本只读 `SOURCE_BACKUP` 副本，不引用 `~/.claude`；导入写入
仅发生在隔离 `DSH_HOME/sessions`、`DSH_HOME/skills`、`DSH_HOME/claude2dsh`。

## R2 DSH → Claude Code 反向导出（默认安全关闭 + 真机识别）

复现命令：`bash scripts/e2e-round2-claude-recognition.sh`。

真实数据结果（样例会话 `351f7946-...`）：

- 导入 DSH 后经 `claude2dsh_export` 导出到隔离
  `$DSH_HOME/claude2dsh/exports`；`recordCount=57`、toolCalls=22、
  toolResults=22、droppedToolResults=0。
- 对导出 JSONL 逐行 JSON、parentUuid 链、tool_result 挂接校验通过。
- 默认 `outputDir` 指向 `~/.claude/projects` 时返回
  `status:"refused"`，测试 seam 以非零退出，原目录未产生新文件。
- 启动本地 mock Anthropic 端点，`CLAUDE_CONFIG_DIR` 指向仅含导出文件的
  隔离目录，真实 `claude --resume <导出uuid> --print` 向 mock 发出
  `/v1/messages?beta=true` 请求；请求体从导出转录重建出 56 条消息，
  含 assistant tool_use；redacted_thinking 被 Claude Code 按原格式处理，
  重建请求中 thinking 块数为 0（与直接 resume 原始文件行为一致）。
- Claude Code 只与 mock 通信（401 重试后超时），未发生任何真实 API 调用。

## R3 双向继续对话

复现命令：`bash scripts/e2e-round3-bidirectional.sh`。

方向 A（Claude 继续 → DSH 识别）：

- 把样例会话复制到隔离目录并导入（turns=6、events=144、DSH 原生
  inspect 通过）。
- 向复制源追加 1 个完整 Claude 轮次（新 user/assistant、parentUuid 链
  接旧尾），重跑导入。
- 结果 `status=appended`、turns=7、events=150；同一 DSH 会话 id 未变，
  `sessionPersistence.inspect` 原生读取 150 个事件成功。

方向 B（DSH 继续 → Claude Code 识别）：

- 导入 + `claude2dsh_export` 生成安全副本；导出后经测试 seam 向 DSH 日志
  append 1 个完整轮次（6 个事件），再执行 `claude2dsh_sync`（默认
  target=copy）。
- 结果 `status=synced`、appendedTurns=1、appendedEvents=6、
  appendedRecords=2；副本记录从 57 增至 59，锚点推进。
- 用 mock Anthropic 端点让真实 `claude --resume` 加载同步后的副本：
  请求重建 58 条消息，且包含 DSH 侧追加文本
  “This turn was appended by the DSH side…”，证明 Claude Code 正确识别
  DSH 端继续的新轮次。
- 原始 `~/.claude` 写回路径仍受 `allowOriginalClaudeDir` 显式开关保护，
  默认 target=copy 只写 `$DSH_HOME/claude2dsh/exports`。

## R4 子代理/工作流转录

复现命令：`bash scripts/e2e-round4-subagents.sh`。

真实数据结果（58 主转录 + 725 subagent/workflow agent 转录）：

- `includeSubagents:true` 导入报告 total=783，imported=782，skipped=1，
  failed=0。
- DSH 原生 `sessionPersistence.list()` 返回 782；782 个 `inspect()` 全部
  成功，事件总数 86,866。
- 子代理 header 携带 `origin:"subagent"`、`delegationDepth:1` 和
  `parentSession`（如 `claude-a0aaae...` 的父会话为
  `claude-8f2f7ac6-...`），DSH 原生重建了父子归属。
- 另用 `Session.create(seed)` 对全部 783 个文件的事件重放通过（782 有
  消息，1 个无可导入轮次）。

## 插件生态（plugins/）与 session-env/（暂缓）

- plugins：`installed_plugins.json` 记录 codex@openai-codex、
  i-have-adhd 等用户插件及 3 个 marketplace；本轮不迁移插件，避免把
  Claude 插件副作用带进 DSH。
- session-env：43 个会话目录，仅部分含 `sessionstart-hook-0.sh`；是
  hook 环境快照，不是会话正文。后续按"源适配器扩展点"单独处理。

## R5 真实 API 端到端（2026-08-16）

### 密钥与鉴权状态（只报告存在性，不打印值）

- bash 环境：`DEEPSEEK_API_KEY`、`ANTHROPIC_API_KEY`、
  `ANTHROPIC_AUTH_TOKEN` 均 unset。
- Claude Code：默认配置下 `claude auth status` =
  `{"loggedIn":true,"authMethod":"oauth_token","apiProvider":"firstParty"}`。
  隔离 `CLAUDE_CONFIG_DIR` 后默认 `loggedIn:false`；通过
  `claude --settings ~/.claude/settings.json` 恢复登录态
  （由 CLI 读取，未打印任何值）。
- DSH：`~/.dsh/.credentials.yaml` 存在（size=54, mode=600），未读取
  值；隔离 DSH_HOME 的 profile 用 cordis.patch.yml 覆盖 credentials
  插件 `path` 指向该文件，由 DSH 凭据服务读取。

### 隔离核验

- 基线：`find ~/.claude -printf '%y %p %s %T@'` 排序哈希
  `e11c86332b2a64ae59ae7fbd19117ab9f2d2db648009d9b40b1e0ff6b1b845cf`。
- 第一次隔离 Claude 调用后真实 `~/.claude` diff_lines=0、哈希不变；
  真实 resume 调用后再核验 diff_lines=0、哈希不变。

### 实际调用序列与结果

1. 隔离工作区 `/tmp/c2dsh-live-work`、隔离配置
   `/tmp/c2dsh-live-claude-home` 中新建真实 Claude 会话：
   `claude --settings ... -p "Reply with exactly: pong" --max-budget-usd 0.1`
   → `result:"pong"`，`total_cost_usd:0.053424`，session_id
   `<uuid>`，1 次真实 API 轮次。
2. DSH 隔离 home（`/tmp/c2dsh-live-dsh-home2`）中
   `CLAUDE2DSH_TEST_IMPORT=<该jsonl>` → `imported, turns=1, events=7`。
3. `CLAUDE2DSH_TEST_EXPORT` 先导出安全副本（recordCount=4）。
4. `CLAUDE2DSH_TEST_RESUME=1` + provider/model 显式
   `deepseek-official/deepseek-v4-flash` 真实 DSH 续聊：
   prompt `Continue with exactly: dsh-pong` → DSH 会话 events 7→31、
   新增 assistant `"dsh-pong"`，turn/end reason completed；
   assistant usage `{inputTokens:13040,outputTokens:5}`。1 次真实
   DSH API 轮次（此前一次未配 provider/model 的失败尝试在模型调用前
   即错误退出，不计 API 调用）。
5. `CLAUDE2DSH_TEST_SYNC=1` 回写导出副本：`synced, appendedTurns=1,
appendedEvents=24, appendedRecords=2`。
6. 把同步后副本拷入隔离 Claude home
   `/tmp/c2dsh-live-claude-resume-home`，真实
   `claude --resume 4b8eafd1-... --print "Continue with exactly: claude-pong"`
   → `result:"claude-pong"`，`total_cost_usd:0.053025`。1 次真实
   Claude API 轮次。

### 成本与调用次数

- Claude 真实 API：2 轮（新建 1、resume 1），合计
  `0.053424 + 0.053025 = 0.106449 USD`。
- DSH 真实 API：1 轮（续聊），未获得价格字段，usage 见上。
- 无 mock 冒充；上表所有结果来自真实模型响应。

### 复现命令

见 `/tmp` 实验目录与本节字段；核心命令模式：

```sh
# Claude 新建（隔离）
cd /tmp/c2dsh-live-work && CLAUDE_CONFIG_DIR=/tmp/c2dsh-live-claude-home \
  claude --settings ~/.claude/settings.json -p "Reply with exactly: pong" \
  --output-format json --max-budget-usd 0.1

# DSH import/export/real-resume/sync（隔离 DSH_HOME）
DSH_HOME=/tmp/c2dsh-live-dsh-home2 CLAUDE2DSH_TEST_IMPORT=<claude-jsonl> \
  CLAUDE2DSH_TEST_EXPORT=claude-<id> CLAUDE2DSH_TEST_RESUME=1 \
  CLAUDE2DSH_TEST_PROMPT='Continue with exactly: dsh-pong' CLAUDE2DSH_TEST_SYNC=1 \
  CLAUDE2DSH_TEST_REPORT=/tmp/c2dsh-live-report2.json dsh --profile claude2dsh-e2e

# Claude resume（隔离）
CLAUDE_CONFIG_DIR=/tmp/c2dsh-live-claude-resume-home \
  claude --settings ~/.claude/settings.json --resume <export-uuid> \
  -p "Continue with exactly: claude-pong" --output-format json --max-budget-usd 0.1
```

## R6 发布修复 + beta 特性验证（2026-08-16）

### 发布本地修复

- 三包版本 `0.1.0-rc.1`，`private` 移除，publishConfig/license/
  repository/files 齐备。
- pack 白名单实测：core 12 文件、adapter 24 文件、plugin 28 文件，
  均无 src/test/tsconfig；plugin 无 `lib/cordis.patch.yml`。
- tarball manifest 依赖实测：
  `@claude2dsh/core@^0.1.0-rc.1`、`@claude2dsh/adapter-claude-code@^0.1.0-rc.1`。
- 干净 profile tarball 安装（core/adapter 用 overrides 模拟已发布依赖）
  → pnpm install 成功 → `dsh --profile smoke --dump-config` 出现
  `claude2dsh-import` → 导入冒烟 imported/events=7/inspect OK。
- `dsh plugin add -w link:` 冒烟同样通过。
- npm 凭据：`npm whoami` = ENEEDAUTH，NPM_TOKEN unset，~/.npmrc 不存在。
  未执行 npm publish。

### 自动双向镜像 beta

- 默认关：bundle patch `autoSync.enabled: false`；`--dump-config`
  可见该配置。
- Claude→DSH watcher 实测：隔离 DSH_HOME + `autoSync.enabled:true` +
  `claudeProjectsRoot=/tmp/c2dsh-autosync-projects`，进程启动后向目录
  新增一个合法 Claude JSONL，日志出现
  `[claude2dsh] auto-import: 1 session(s) updated`，DSH_HOME/sessions
  生成对应 zstd 会话。
- DSH→Claude 实测：隔离 DSH_HOME + autoSync.dshToClaude + 真实 DSH
  续聊 1 轮（provider/model=deepseek-official/deepseek-v4-flash，
  prompt `Continue with exactly: auto-pong`），日志出现
  `[claude2dsh] auto-sync: ... appended 2 record(s)`；导出副本
  recordCount 4→6。真实 DSH API 调用：1 轮。
- 写回真实 `~/.claude`：auto-sync 固定 target=copy，安全门控不变。

### 图片能力探测 + 自动降级

- 能力面证据：`ctx.llm.resolveModelInfo` 返回 `inputModalities`；
  DeepSeek adapter 声明 `["text"]`。
- 单元测试：text-only 模型 → surface 为 `[image image/jpeg]` 占位，
  attachment 仍保存 1 份；image-capable mock → surface 为原生 image block。
- resume 重投影单元测试：placeholder→native 会 append
  `surfaceOp:{op:'replace'}` + `sourceEventSeqs:[seq]` 且 content[0]
  为 image；由 `image-map/<sessionId>.json` sidecar 驱动。
- 集成：非法 base64 图片导入时 attachment 保存被 DSH 拒绝 → 自动
  降级占位、导入成功，image-map 写入 placeholder 条目，不崩溃。
- 切换模型正确性：pre-step listener 每次 resume 用当前 provider/model
  探测并替换不一致 surface 节点；DeepSeek 当前无视觉模型，native 路径
  由 mock 能力测试覆盖。

### 插件生态迁移（资产清单）

- `claude2dsh_plugin_inventory` 对备份 `installed_plugins.json` 实测：
  2 个插件、3 个 marketplace、4 个 SKILL.md、8 个 commands、1 个 agent、
  2 个 prompts、5 个 hook 文件；dry-run 不写盘。
- `apply:true` 实测迁移 4 个 skills 到 `$DSH_HOME/skills`。
- Claude hook bridge：bundle 中新增可选行
  `@claude2dsh/plugin/hook-bridge`（re-export 上游
  `@deepseek-ai/dsh-hooks-claude-code@0.1.0-rc.6`）。无
  `CLAUDE2DSH_HOOKS_CONFIG` 时禁用；有 fake hooks.json 时 boot 无报错。
  上游限制照写：command-only、7/30 事件、部分语义。

### 回归

- 根 `pnpm run check` 全绿。
- `pnpm -r build/typecheck/test` 全绿。
- 四个 e2e 脚本全绿（ROUND1/2/3/4 OK）。

## R7 公开清理、GitHub release 与 npm 发布尝试（2026-08-16）

### 历史重写（用户选择：压缩为单个公开初始提交）

- 旧历史备份：`/tmp/claude2dsh-history-pre-public.bundle`（308 KB）与
  `pre-public-history` 本地分支。
- 敏感文件本地备份：`/tmp/claude2dsh-sensitive-backup/`。
- 公开分支从 `dbaaa59`（Initial public release）开始，后续仅
  README 定稿与 e2e 匿名化两个公开 commit。
- 旧历史中移除：`docs/prompt-round2/3/4.md`、`premises.md`、
  `projects-structural-inventory.*`、`inventory_projects_jsonl.py`；
  文档中 `/home/misaka` 全部匿名化为 `~`，UUID 匿名化为 `<uuid>`，
  脚本中真实样例 UUID 改为自动选择。
- 审计结果：公开工作树无 `/home/misaka`、无 token 模式、无真实项目名；
  仅测试夹具含合成 UUID（非真实会话）。

### GitHub 远端与 release

- 仓库：`https://github.com/kirkchinese/claude2dsh`（public）。
- 本地 main 与 origin/main 均为 `4bc8398`；tag
  `v0.1.0-rc.1` 指向同一 commit。
- GitHub release 已发布：
  `https://github.com/kirkchinese/claude2dsh/releases/tag/v0.1.0-rc.1`。
- release notes 如实标注 npm 被 2FA 阻塞、hook 7/30、图片视觉路由未
  验证、auto-mirror beta。

### npm 发布尝试（失败即停）

- `npm whoami` = `kirkchinese`；registry 可访问。
- 依次尝试从 core 开始：`npm publish --access public` 返回
  `E403 ... Two-factor authentication or granular access token with
bypass 2fa enabled is required to publish packages.`。
- 失败后立即停止，未尝试 adapter/plugin。
- `npm view` 三包均 404，确认 **没有任何包被发布**。
- 结论：对外 npm 发布与任务 6 的真实 registry 空环境验收当前不可执行；
  需要用户提供 OTP 或带 bypass-2fa 权限的 granular token 后，仍可按
  0.1.0-rc.1 继续。

### 发布后待办

- 解决 npm 2FA → 按 core/adapter/plugin 顺序发布 → 三包 `npm view`
  确认 → 真实 registry 空环境验收（quickstart）。
- 官方插件目录收录：官方未规定第三方收录流程，暂不提交（用户已确认）。

### npm token 重试（仍失败，已停止并删除临时配置）

- 用户提供 token 后，token 通过 `/tmp/claude2dsh-npmrc` 注入，未打印值。
- 第一次验证：`npm whoami` = E401；`npm publish @claude2dsh/core` = E404。
- 用户选择重新生成 token 后重试：`npm whoami` 仍 E401。
- 按"失败即停"停止；临时 npmrc 已删除；registry 上三包仍 404。
- npm 发布与真实 registry 空环境验收保持阻塞，等待有效发布凭据。

## R8 npm 发布修复与真实 registry 空环境验收（2026-08-16）

### 发布修复

- 根因：本地 manifest 使用 `workspace:` 协议；`npm publish` 不会转换，
  导致 rc.1 真实安装读取 `workspace:^0.1.0-rc.1` 失败。
- 处理（用户选择 0.1.0-rc.2）：
  - 三包版本升至 `0.1.0-rc.2`，本地依赖保持 workspace 协议以支持 monorepo。
  - 使用 `pnpm pack` 生成转换后的 tarball（manifest 依赖已变为
    `^0.1.0-rc.2`），再 `npm publish <tarball>` 发布。
  - 发布顺序 core → adapter → plugin，每包发布后 `npm view versions` 确认。
  - `@claude2dsh/{core,adapter-claude-code,plugin}@0.1.0-rc.1` 已
    `npm deprecate`，指向 rc.2。
- 三包 registry 状态：`latest` dist-tag 均为 `0.1.0-rc.2`。

### 陌生用户空环境验收（真实 registry，无 link、无 overrides）

```sh
E2E=$(mktemp -d)
DSH_HOME="$E2E" dsh plugin --profile smoke add @claude2dsh/plugin
DSH_HOME="$E2E" dsh --profile smoke --dump-config
DSH_HOME="$E2E" \
CLAUDE2DSH_TEST_IMPORT=<备份主会话jsonl> \
CLAUDE2DSH_TEST_SKILLS=1 \
CLAUDE2DSH_TEST_SKILLS_ROOT=/tmp/claude2dsh-source-backup/skills \
CLAUDE2DSH_TEST_REPORT=/tmp/report.json \
dsh --profile smoke
```

实测：

- `dsh plugin add` 解析到 `@claude2dsh/plugin@0.1.0-rc.2`，pnpm 从
  registry 安装成功。
- dump-config 出现 `claude2dsh-import` 与 hook bridge 行。
- 导入 1 个主会话：`imported turns=3 events=31 toolCalls=3`，
  DSH `sessionPersistence.inspect` eventCount=31。
- skills：39 个复制成功，`ctx.skills.snapshot()` 共 42 个。
- 全程未使用本地 link，未使用 overrides。

## R9 插件收录渠道调研（2026-08-16）

- 官方渠道复查：DSH master `47f9438`；docs/website/packages 与完整
  tree 搜索均无第三方插件目录/marketplace/registry。结论：官方渠道
  不存在。
- 社区渠道：`awesome-dsh-plugin` HEAD `df1d87b`，维护活跃。我们满足
  全部收录硬要求（dsh.bundle、真实代码、活跃维护、dsh-plugin topic、
  npm 发布）；无阻断差距。
- 待提交 PR 草稿与完整内容见 `docs/research-plugin-directory.md`；
  按约束未发起 PR，等待用户确认。

## R10 awesome-dsh-plugin PR 提交（2026-08-16）

- 用户确认后 fork 并推送分支 `add-claude2dsh`。
- PR：https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/968
- 修改内容：README.md 与 README.zh.md 各新增一行（Sessions & Messages /
  会话与消息），无其他改动。

## R11 第六轮完善：仓库卫生、双向并发底线、镜像转正、hook/UI 形式化（2026-08-16）

### 前提核验与回归

- 轮次开始时 HEAD=`98c97cf`；工作区除未跟踪的
  `docs/prompt-round5.md`/`docs/prompt-round6.md` 外干净。
- README 第 75 行防御性措辞已删除，替换为中性 MIT 许可 +
  对 `dsh-chat-import`（MIT）与 `dsh-claude-move`（Apache-2.0）的致谢；
  全文复查无同类表述。
- 四个 e2e 本轮修改完成后复跑全绿：
  `ROUND1_OK`（57 imported/0 already + skills）、`ROUND2_OK`、
  `ROUND3_OK`、`R4_OK imported=782`。

### awesome-dsh-plugin PR #968 实测（本日最新）

- `gh pr view 968`：state=OPEN、mergedAt=null、评论 0；
  baseRefOid 仍为旧 main `df1d87b6`。
- main 已合并 #970（`bccd4d9c`），列表迁到
  `data/plugins/<owner>__<repo>.yml`，README 由脚本生成。
- 结论：条目不在列表 = 未合并，且旧式"手工改两个 README"的 PR 已
  落后于新格式；新格式候选条目与后续选项记录在
  `docs/research-plugin-directory.md`（动作等用户确认）。

### 仓库卫生五件套

| 项                        | 证据                                                                                                                                                                                                      |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 根 AGENTS.md              | 已替换为 Claude2DSH 项目开发说明；旧 148 行 DSH 官方仓库拷贝不再存在，权限已修复                                                                                                                          |
| GitHub Actions            | `.github/workflows/ci.yml`：push 触发根 check + workspace build/typecheck/test + `scripts/check-dsh-compat.mjs` job                                                                                       |
| DSH 兼容自检              | `compat.ts` 启动时检查 `@deepseek-ai/dsh-session` peer `0.1.x(rc>=6)` 与 `SESSION_FORMAT_VERSION===0`；单测覆盖 fail-loud；`node scripts/check-dsh-compat.mjs` 实测输出 `DSH_COMPAT_OK newest 0.1.0-rc.6` |
| plugin-inventory 路径清洗 | `safeSegment/safeSkillName` 拒绝 `..`、绝对路径与非安全段；新增路径穿越测试通过                                                                                                                           |
| CHANGELOG                 | 自 rc.1 起记录，含 rc.1 deprecate 原因、rc.2 发布、Unreleased 本轮改动                                                                                                                                    |

### 双向并发：底线已实施并测试

- 检测逻辑：源文件相对 registry 水印变化且 DSH 已存事件数
  `> recorded events` → `status=conflict`；`append`/`create` 永不调用。
- 测试证据（`packages/plugin/test/`，共 18/18 pass）：
  - 双端各自增长 → conflict，append 计数保持首次导入的 1；
  - 同轮双改 + 交错 tool_result → conflict；
  - watcher 真实激活注入 conflict → 状态暂停、冲突记录落盘、
    源文件字节不变、append=0；
  - 持久化 pending 队列跨重启，激活后 drain 并转为暂停。
- 自动镜像暂停后 `claude2dsh_autosync` 工具可 `status`/`resume`。
- 增强（按轮三路合并、同轮双改保双方）设计见
  `docs/design-bidirectional-merge.md`，是否实施待用户确认。

### auto-mirror 转正验收

| 验收项            | 结果                                                                                                                                                                                     |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| live-session 跳过 | `isLiveSession` 通过 `ctx.sessions.get` 判断，turn/end 时跳过并记日志                                                                                                                    |
| 队列持久化        | `auto-sync-state.json` 原子写；pending 项重启后由 `processPendingQueue` drain（测试通过）                                                                                                |
| 可观测性          | 启动/暂停/跳过/同步均有 `[claude2dsh] auto-*` 日志；`claude2dsh_autosync status` 输出 paused/reason/conflicts/pending；UI card 实测输出 `paused=false reason=none conflicts=0 pending=0` |
| 失败注入          | 新增 `test/auto-sync.test.ts`：真实 chokidar 路径注入双端增长 → pause + report + 两侧零写入                                                                                              |
| 双端并发          | conflict → 自动镜像暂停，不丢任一侧                                                                                                                                                      |
| 文档              | 代码与 README/plugin README/roadmap/CHANGELOG 均移除 auto-mirror beta 标注                                                                                                               |

### hook bridge 形式化

- 上游版本锁定：`@deepseek-ai/dsh-hooks-claude-code` 固定
  `0.1.0-rc.6`（精确版本，非 range），pnpm-lock 锁定。
- 配置校验 fail loud 实测（真实 DSH boot）：
  `printf '{ bad json' > /tmp/claude2dsh-bad-hooks.json` +
  `CLAUDE2DSH_HOOKS_CONFIG=/tmp/claude2dsh-bad-hooks.json dsh --profile ...`
  → exit=1，输出
  `claude2dsh hook bridge: invalid JSON in /tmp/claude2dsh-bad-hooks.json`。
- 错误浮现会话层机制证据：上游 `dsh-hook-protocol` 的
  `appendHookInvoked/appendHookResult` 把每次 hook 的
  `hook/invoked`+`hook/result`（含 decision/exitCode/stderrSummary/
  durationMs）写入会话日志；见本机 rc.6 安装产物
  `lib/types/events.d.ts` 与 `lib/index.js` 的 `appendHookResult`。
- 测试：坏 JSON/坏结构带路径 fail-loud；合法 hooks 对象通过。
- 文档如实标注 7/30、command-only；全兼容仍在 roadmap #7。

### UI 最小集验收

- 机制证据与候选清单见 `docs/research-ui.md`。
- 最小集 = 官方 `presentCall/presentResult` generic card，无 web client。
- 真实 boot 探针（`CLAUDE2DSH_TEST_PRESENTERS=1`，隔离 DSH_HOME）实测：
  - importCall：`card=generic, title="Import Claude Code sessions"`；
  - importResult：`card=generic, title="Claude Code import"`,
    `text="imported=1 already=0 appended=0 skipped=0 failed=0"`；
  - autoSyncCall/autoSyncResult：`card=generic,
title="Claude2DSH auto-mirror"`，结果摘要解析出 paused/reason/
    conflicts/pending。
- 修复：`presentResult` 收到的第二参数是 `ToolResult`，三张 result card
  均改为解析 `content[0].text` 的 JSON（此前 sync/autosync card 会读错
  对象形状）。

### 本轮最终回归命令与结果

```sh
pnpm run check
pnpm -r build && pnpm -r typecheck && pnpm -r test
node scripts/check-dsh-compat.mjs
bash scripts/e2e-round1.sh
bash scripts/e2e-round2-claude-recognition.sh
bash scripts/e2e-round3-bidirectional.sh
bash scripts/e2e-round4-subagents.sh
```

结果：根 check 全绿；workspace 全绿（core 4/4、adapter 11/11、
plugin 18/18）；DSH_COMPAT_OK；四个 e2e 全绿；真实模型调用 0 轮。

## R12 0.1.0 发布准备（2026-08-16，仅准备，未发布）

### 用户决定

- 双向合并增强：维持已实施底线，先发布 0.1.0；按轮三路合并留作
  发布后 roadmap。
- awesome PR #968：等待维护者反馈，不更新、不催更。
- UI：0.1.0 只含最小 tool cards；first-run migration guide 发布后做。
- 版本：`0.1.0`。
- 发布动作：仅准备并全量重测，npm 与 GitHub release 待再次确认。

### 准备动作与证据

- 提交 `197cbca`：三包 version `0.1.0-rc.2` → `0.1.0`，workspace 依赖
  同步 `workspace:^0.1.0`，pnpm-lock 更新，CHANGELOG Unreleased 段
  改为 `## 0.1.0 — 2026-08-16`。
- 根 `pnpm run check` 全绿。
- workspace：build/typecheck 全绿；tests core 4/4、adapter 11/11、
  plugin 18/18。
- 四个 e2e 复跑：ROUND1_OK、ROUND2_OK、ROUND3_OK、
  R4_OK imported=782 skipped=1。
- `node scripts/check-dsh-compat.mjs` =
  `DSH_COMPAT_OK newest @deepseek-ai/dsh-session 0.1.x = 0.1.0-rc.6`。
- 三包 `pnpm pack` 解包核对：
  `@claude2dsh/core@0.1.0`、
  `@claude2dsh/adapter-claude-code@0.1.0`（依赖 core `^0.1.0`）、
  `@claude2dsh/plugin@0.1.0`（依赖 adapter/core `^0.1.0`，
  hook 上游精确 `0.1.0-rc.6`）；files 白名单仍无 src/test/tsconfig。
- 提交 `ee6c13a`：四包 `repository.url` 修正为真实公开仓库
  `git+https://github.com/kirkchinese/claude2dsh.git`（旧值指向不存在的
  `Claude2DSH/Claude2DSH`），pack 后已复核。
- `npm whoami` = `kirkchinese`；未执行任何 `npm publish`，未创建 tag。
- 隐私 grep：无真实主目录路径/真实会话 UUID/真实凭据；命中仅为
  文档中的匿名化说明与测试脚本里的 `ANTHROPIC_API_KEY=dummy`。

### 待确认后执行

```sh
# core -> adapter -> plugin，每包发布后 npm view 复核
pnpm --dir packages/core pack --pack-destination <tmp>
npm publish <tmp>/claude2dsh-core-0.1.0.tgz --access public
npm view @claude2dsh/core@0.1.0
# ... adapter、plugin 同理 ...
# 空环境验收
DSH_HOME=$(mktemp -d) dsh plugin --profile smoke add @claude2dsh/plugin@0.1.0
# GitHub tag + release（与发布 commit 一致）
```
