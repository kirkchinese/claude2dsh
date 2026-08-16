# 官方发布建议核对与本项目发布清单

核对来源：DeepSeek Harness 官方仓库
`docs/user/develop/basic/publish.md`（2026-08-16 sparse checkout @47f9438）。

## 官方规定

1. 可安装发布物必须是一个 **bundle**：`package.json` 声明
   `dsh.bundle.patch`，指向 `cordis.patch.yml`；patch 内插件行用包名
   `name` 引用，安装后由 Node 从 profile 解析。
2. 推荐两种分发：
   - 发布到 npm：要求发布时 `lib/` 已构建；用户执行
     `dsh plugin add your-package` 即安装预构建代码，**不需要 build
     allowlist**。
   - tarball：`pnpm pack`；用户执行
     `dsh plugin add ./pkg.tgz`。
3. GitHub 源码安装需要 `prepare` 构建脚本 + 用户 allowBuilds；官方明确
   这是"要求用户在安装时执行代码"的信任决策。本项目未提供 `prepare`，
   故不承诺 `github:` 安装路径。
4. 无 `dsh.bundle` 的包只是普通依赖，不会激活插件层。
5. profile 由 `dsh plugin` 创建维护；`@deepseek-ai/dsh-base` 总是在
   box 内解析。

## 官方未规定项（本项目自定）

- npm 包命名规范未发现强制要求；本项目采用
  `@claude2dsh/core`、`@claude2dsh/adapter-claude-code`、
  `@claude2dsh/plugin`。
- 第三方插件目录 / marketplace 收录流程：官方仓库内未发现公开提交
  规范；是否提交收录需另行调研，本项目不擅自提交。
- 版本策略：官方教程用 `0.1.0`；本项目用 `0.1.0-rc.1`。
- README 最低内容：官方教程只要求 manifest + patch + 入口文件；
  本项目按要求额外提供能力表、quickstart、局限与安全边界。

## 本项目发布清单（当前候选版本）

当前 npm latest：`0.1.0-rc.2`（已发布并在真实 registry 空环境验收）。
下一正式版候选：`0.1.0`（rc.2 的同范围正式化 + 本轮硬化；最终版本号待用户确认）。

发布前检查（本地，不接触 registry）：

- [x] `git grep` 隐私审计：无真实用户主目录路径、真实会话 UUID、
      真实凭据/token 模式（仅命中文档中的匿名化说明与测试脚本中的
      `ANTHROPIC_API_KEY=dummy`）。
- [x] 三包 `pnpm -r build`，确认 `lib/` 已生成。
- [x] 根 `pnpm run check`；`pnpm -r build/typecheck/test`；
      四个 `scripts/e2e-round*.sh` 全绿（core 4、adapter 11、plugin 18）。
- [x] `pnpm pack` 三包并解包核对：files 白名单无 src/test/tsconfig；
      manifest 中 workspace 协议已转换为 `^<version>`（core/adapter/plugin
      互依赖）与精确 `@deepseek-ai/dsh-hooks-claude-code@0.1.0-rc.6`。
- [x] `npm whoami` = `kirkchinese`。
- [x] `node scripts/check-dsh-compat.mjs` = `DSH_COMPAT_OK ... rc.6`。

发布动作（仅凭用户确认后执行；npm publish 不能直接发布 workspace
manifest，必须走 `pnpm pack` 后的 tarball）：

- [ ] 三包版本号从 `0.1.0-rc.2` 升到确认的正式版本号，CHANGELOG 的
      Unreleased 段改为该版本并填日期；提交并打 tag。
- [ ] `pnpm -r build` 后按 core → adapter → plugin 顺序：
      `pnpm --dir <pkg> pack --pack-destination <tmp>` →
      `npm publish <tmp>/<pkg>-<version>.tgz --access public`；
      每发布一包立即 `npm view <name>@<version>`。
- [ ] 全新临时目录执行 quickstart：
      `dsh plugin --profile smoke add @claude2dsh/plugin@<version>`，
      导入一个备份样本并 `sessionPersistence.inspect` 通过。
- [ ] GitHub 创建 release（tag 与发布 commit 一致），release notes 沿用
      CHANGELOG 并保留诚实局限（hook 7/30、视觉模型未实测）。
