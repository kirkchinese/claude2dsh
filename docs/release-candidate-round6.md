# 0.1.0 发布候选（第六轮完成后，用户已确认）

## 用户决定（2026-08-16）

- 合并增强：本轮不实施，先按底线发布；设计保留为发布后 roadmap。
- awesome PR #968：等待维护者反馈，不催更、不改格式。
- UI：`0.1.0` 只含已验证的最小 tool cards；first-run migration guide
  作为发布后跟进项。
- 版本号：`0.1.0`。
- 发布动作：仅准备（版本 bump + CHANGELOG + 全量重测），npm 与
  GitHub release 需再次确认后执行。

## 建议版本与范围

- 版本：`0.1.0`。理由：这是 `0.1.0-rc.2` 的同范围正式化
  （semver 上 `0.1.0 > 0.1.0-rc.2`，npm latest 正常前进），本轮
  新增属于 rc 阶段发现的硬化与补缺，不构成新的 minor 承诺。
- 备选：`0.2.0`（把本轮新增当作 feature minor，节奏更醒目，但会
  跳过 0.1.0 正式版）。`1.0.0` 不建议：DSH 上游仍为 rc.6，hook
  仅 7/30 command-only，视觉模型未实测，1.0 会过度承诺。
- 范围 = 自 `98c97cf` 起全部本轮提交：
  - 中性 README 措辞 + 竞品致谢；
  - 仓库卫生（AGENTS.md、CI、DSH 兼容自检、资产名清洗、CHANGELOG）；
  - 双向并发底线（conflict 检测 → 自动镜像暂停/报告，零数据丢失）；
  - auto-mirror 转正（live-session 跳过、队列持久化/重启 drain、
    状态/恢复工具、失败注入测试，去 beta 标注）；
  - hook bridge 形式化（fail-loud 配置校验、上游精确锁 rc.6、
    hook/result 会话事件证据、测试与如实文档）；
  - 最小 UI（import/sync/autosync 的 generic tool cards，真实 boot
    探针验收）；
  - 发布清单刷新与验证记录 R11。
- 不包含：增强型按轮三路合并（设计完成，待确认后实施）、UI 增强集、
  PR #968 更新动作——这些不阻塞 `0.1.0`。

## 发布前检查（0.1.0 bump 后已全部复跑）

见 `docs/release-checklist.md` 与 `docs/validation.md` R12：隐私 grep、
根 check、workspace build/typecheck/test（core 4 / adapter 11 /
plugin 18）、四个 e2e、`npm whoami=kirkchinese`、
`scripts/check-dsh-compat.mjs=DSH_COMPAT_OK rc.6` 全部通过。
三包 `pnpm pack` 后 manifest 已确认：版本 0.1.0，
core↔adapter↔plugin 依赖为 `^0.1.0`，无 workspace 协议，hook 上游
仍精确锁 `0.1.0-rc.6`。

实际发布动作已获用户确认并开始，但 core 发布被 npm 2FA 策略拒绝
（E403：需要 OTP 或带 bypass-2fa 权限的 granular token）。按失败即停
纪律，未发布任何包、未 push、未打 tag；registry 上三包仍只有
rc.1/rc.2。恢复条件：提供 OTP 或具备 bypass-2fa 权限的 token 后，
从 core → adapter → plugin 依次发布 tarball。

## 待用户拍板的四项

1. 合并增强：按轮三路合并是否实施。
2. awesome PR #968：是否更新到 data-driven-list 新格式。
3. UI 增强集：是否实施以及选哪些。
4. 正式版本号：`0.1.0` / `0.2.0` / `0.2.0-rc.1` / `1.0.0`。
