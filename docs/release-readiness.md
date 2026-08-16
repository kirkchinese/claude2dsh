# 打包发布评估：能否成为第一个标准 DSH 插件版本

## 当前事实（实测）

1. 根包 `claude2dsh`：
   - `pnpm run check` 全绿（format/lint/typecheck/test/build/package:dry-run）；
   - pack dry-run 内容：cordis.patch.yml、lib/*、LICENSE、package.json、
     README.md。
   - 但根包只是 `sessionSources` registry 骨架，没有迁移功能。
2. 功能包 `@claude2dsh/plugin`：
   - `dsh plugin --profile smoke add -w link:<repo>/packages/plugin`
     **成功**；`--dump-config` 出现 `claude2dsh-import`；一次导入冒烟
     `imported, events=7, inspect OK`。
   - `pnpm pack --dry-run` 可生成 tarball，但**无 `files` 白名单**，
     打进 src/test/tsconfig（证据：pack 列表）。
   - tarball manifest 依赖 `@claude2dsh/core`、`@claude2dsh/adapter-claude-code`
     指向 registry `0.1.0`；干净 profile 用 tarball 安装实测
     **404 `@claude2dsh/core is not in the npm registry`**，安装失败。
   - 两个依赖包同样 `private:true`，当前不能发布。

## 结论（2026-08-16 更新）

**全部 7 项本地缺口已修复；当前状态为"本地可发布、对外发布停在凭据步"。**

## 已修复项

1. 三包 `private` 已移除，均有 `publishConfig.access=public`、
   `license=MIT`、`engines`、`repository`、`files` 白名单。
2. 依赖策略采用 core + adapter 一并发布；依赖声明为
   `workspace:^0.1.0-rc.1`，pack 后 manifest 为 `^0.1.0-rc.1`。
3. 三包 `files` 白名单生效：pack 只含 lib、README、LICENSE、
   package.json（plugin 另有 cordis.patch.yml），不再含 src/test。
4. plugin README 已补，并记录全部工具、beta 开关与安全边界。
5. 三包版本 `0.1.0-rc.1`。
6. plugin build 不再复制 cordis.patch.yml 进 lib；pack 列表已无该文件。
7. 重做验证：
   - 根 `pnpm run check` 全绿；
   - workspace build/typecheck/test 全绿；
   - 四个 e2e 全绿；
   - `dsh plugin add -w link:` 冒烟通过；
   - 三 tarball 干净 profile 安装（core/adapter 以 overrides 模拟已发布
     依赖）+ boot + dump-config + import 冒烟通过。

## 发布结果（2026-08-16 更新）

- npm org `@claude2dsh` 已创建，三包 `0.1.0-rc.2` 已发布且
  `latest` 指向 rc.2。
- rc.1 因 `workspace:` 依赖协议问题已全部 deprecate。
- 真实 registry 空环境安装验收通过（见 docs/validation.md R8）。
- 后续发布必须使用 `pnpm pack` + `npm publish <tarball>`，避免
  workspace 协议进入 registry manifest。

## 最终发布清单（对外发布时）

- `pnpm run check && pnpm -r build && pnpm -r typecheck && pnpm -r test`
- 四个 `scripts/e2e-round*.sh`
- 三包 pack 白名单复核
- 干净 tarball 安装冒烟（core/adapter 发布后无需 overrides）
- `npm publish --dry-run`（无凭据时仅可做这一步）
- 实际 `npm publish`：仅凭据可用且经用户确认。
