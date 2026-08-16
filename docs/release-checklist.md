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

## 本项目发布清单（发布时逐项执行）

- [ ] `git grep` 隐私审计：无 ~、真实项目名、真实会话
      UUID、token 模式。
- [ ] 三包 `pnpm -r build`，确认 `lib/` 已生成。
- [ ] 根 `pnpm run check`；workspace build/typecheck/test；四个 e2e。
- [ ] `pnpm pack --dry-run` 三包，确认 files 白名单。
- [ ] `npm whoami` 确认账号。
- [ ] 按 core → adapter → plugin 依次 `npm publish --access public`，
      每发布一包立即 `npm view <name>@<version>`。
- [ ] 全新临时目录执行 quickstart：
      `dsh plugin --profile smoke add @claude2dsh/plugin`，
      导入一个备份样本并 `sessionPersistence.inspect` 通过。
- [ ] 创建公开 GitHub 仓库并 push 清理后的 main；tag `v0.1.0-rc.1`；
      发布 GitHub release。
