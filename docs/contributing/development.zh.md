# 开发

[English](development.md) · 中文

## 环境

- Node.js 22.19+ 或 24+、pnpm 11（版本固定在 `package.json` 的 `packageManager` 里）、Git；Windows 上运行 hook 需要 Git Bash；
- [Bun](https://bun.sh)：OpenCode 运行时的测试会在其中加载真实插件；
- 仅端到端测试需要：全局安装 DSH 0.2.2-rc.3 或更新，`dsh` 在 `PATH` 上。

```sh
git clone https://github.com/kirkchinese/harness-forge.git
cd harness-forge
pnpm install
```

## 构建、类型检查、测试

```sh
pnpm build        # 依次构建 core、plugin 和工作台客户端 bundle
pnpm typecheck    # core、plugin（主机端和客户端）、testkit
pnpm test         # core、plugin、testkit 的单元测试（vitest）
```

plugin 通过 core 构建出的 `lib/` 引用它，所以新克隆的仓库要先构建一次 core（`pnpm --filter @kirkchinese/harness-forge-core build`），再对 plugin 做类型检查或测试。单独一个包：

```sh
pnpm --filter @kirkchinese/harness-forge-core test
pnpm --filter @kirkchinese/harness-forge test
pnpm --filter @kirkchinese/harness-forge test -- hooks   # 文件名含 "hooks" 的测试
```

CI（[`ci.yml`](../../.github/workflows/ci.yml)）在 Linux、Windows、macOS 上运行这些命令。

## 端到端测试

```sh
pnpm e2e            # 全部检查
pnpm e2e hook       # 名字含 "hook" 的检查
```

它在沙箱里（独立的 `DSH_HOME` 和 `HOME`，不碰你真实的设置）启动 `PATH` 上的 `dsh`，安装打包好的插件，用脚本化的模型和仓库内的测试夹具驱动无界面会话：不需要模型密钥，也不下载第三方插件。检查项包括技能、命令、智能体、hook、MCP、`~/.claude` 设置、Codex 插件、指令文件和会话导入。CI（[`e2e.yml`](../../.github/workflows/e2e.yml)）在 DSH 0.2.2-rc.5 和 0.2.2-rc.3 上运行。选项和排查方法见 [`packages/testkit`](../../packages/testkit/README.md)。

## 在自己的 DSH 里试用

在真实 DSH 里看到改动最快的方法是 `E2E_KEEP=1 pnpm e2e`，它会保留沙箱 profile。要把本地构建装进你自己的 profile，请用一个临时 profile，照端到端测试的做法（[`packages/testkit/src/dsh.ts`](../../packages/testkit/src/dsh.ts) 里的 `createProfile`）：用 `pnpm --filter <package> pack` 打包 core 和 plugin，让 profile 里的 `@kirkchinese/harness-forge-core` 指向 core 的 tarball（plugin 按版本依赖 core），再用 `dsh plugin --profile <name> add` 安装这两个 tarball。重新安装后重启 DSH。

## 约定

- **core 保持纯净**：不引用 DSH，没有进程级状态；需要 DSH 的东西放在 plugin 里。
- **从 DSH 取用的一切都经过 `packages/plugin/src/dsh/`。** 新用到的服务或事件写进 `dsh/host.ts` 的清单，并注明声明它的 DSH 包。见 [架构](../architecture/overview.zh.md#与-dsh-的接口)。
- **各行之间不互相 import。** 它们通过共享服务和 [`forge/contract.ts`](../../packages/plugin/src/forge/contract.ts) 协作。
- **缺口不丢弃。** 无法映射的部分留在组件模型里，并带上说明原因的缺口。
- **工作台只通过 `harnessCompat` Remote 方法调用主机端。** 新方法加进 `src/workbench/remote.ts` 的 `REMOTE_METHODS`（`test/typert.test.ts` 会对照服务核对这份清单）。
- **面向用户的文字中英双语。** 各行的标题和说明在 `packages/plugin/locale/<row>/{en,zh}.json`，工作台的文字在客户端的 locale 文件里。代码和注释用英文。

## 添加一种方言

方言指 Harness Forge 能读取其插件的一种工具。

1. **core：编写方言。** 新建 `packages/core/src/dialects/<id>/index.ts`，导出一个 `Dialect`（`src/dialects/types.ts`）：它的 `id` 和 `label`、识别其插件根目录的 `markers`（清单、无清单的目录结构或通用格式兜底），以及 `scan`：把各部分映射到组件模型（技能、命令、智能体、hook、MCP、设置、代码、界面）。没有映射的成为 `other` 组件，从而显示为缺口。如果它的插件符合已有布局，`scan` 可以调用 `scanPlugin`（`src/manifest.ts`），文件夹没有清单时传入 `manifest` 覆盖；新的约定加进 `ManifestKind`（`src/types.ts`）。可选成员给出它安装插件的位置（`discoveryRoots`）、用户自己的资产（`user`）、它记录的插件（`harnessPlugins`）、项目资产（`projectAssets`）和会话来源（`sessions`）。
2. **core：注册。** 内置方言加进 `src/dialects/registry.ts` 的列表，外部的调用 `registerDialect`。发现、`detectSource`、`scanRoot`、账本、模型工具和工作台都从注册表取用。
3. **core：评估。** 如果它有 DSH 运行不了的部分，确认 `collectGaps`（`src/assess.ts`）会用清楚的说明报告出来。
4. **plugin：处理不同之处。** 如果它的 hook 使用自己的工具名，在 `src/hooks/vocabulary.ts` 里加一个方言；如果它有代码运行时，需要新的挂载类型和一行（见下）。
5. **会话（可选）。** 会话来源实现 `core/src/sessions/adapter.ts` 里的适配器接口，并通过会话行的 API 提供。
6. **测试。** 在 `packages/core/test` 里加扫描测试（测试在临时目录里构造小的插件目录）；一等支持的方言还要在 `packages/testkit/fixtures` 里加夹具和一项端到端检查。

## 添加一行

1. 编写 `packages/plugin/src/<row>/row.ts`：`name`（`harness-forge-<row>`）、`inject = [FORGE_SERVICE]`，`apply` 里调用 `rowEffect(ctx, '<row>', forge => start…(ctx, forge))`。每个部分用 `Parts.add` 启动，一个失败不影响其他，最后返回拆除函数。
2. 如果它挂载某类组件：把类型加进 `MountKind` 和 `ROW_OF_KIND`，在 `mountKindOf` 里把计划动作映射过去（都在 `forge/contract.ts`），并用 `forge.registerMounter` 注册挂载器。挂载结果最多是 `mounted`；只有运行证据（`forge.observe`）能让部分变成已验证。
3. 如果其他行需要它提供东西：在 `RowApis` 里加一个 API 接口并用 `forge.provide` 提供。使用方通过 `forge.lookup` 或 `forge.watch` 获取，并且必须能在它缺席时正常工作。
4. 在 `packages/plugin/package.json` 里导出（`./<row>` 和 `./<row>/locale/*.json`），在 `cordis.patch.yml` 里插入，并添加 `locale/<row>/en.json` 和 `zh.json`，写好 `meta.title` 和 `meta.description`。
5. 把它加进 `test/rows.test.ts` 的表格：这个测试先在所有行开启时挂载一个插件，再依次关闭每一行，检查其他行仍然正常。
6. 在两份 README 的行表格和 [架构](../architecture/overview.zh.md) 文档里写上它。

## 发布

plugin 以 `"workspace:*"` 依赖 core。**请用 pnpm 发布，不要用 `npm publish`**：`pnpm publish` 会在打包后的清单里把 `workspace:*` 换成 core 的真实版本，而 `npm publish` 会把字面的 `workspace:*` 发出去，用户安装会失败。

1. 修改 `packages/core/package.json` 和 `packages/plugin/package.json` 的 `version`（两者保持一致），在 [`CHANGELOG.md`](../../CHANGELOG.md) 里记录这次发布，CI 通过后合并到 `main`。
2. 检查将要发布的内容：`pnpm build && pnpm check:pack`。它会打包两个包，并在以下情况失败：plugin 打包后的清单里仍有 `workspace:` 范围、写的 core 版本与打包出的不一致、某个 `exports` 目标不在 tarball 里。CI 运行同样的检查（[`ci.yml`](../../.github/workflows/ci.yml) 的 `pack` 任务）。
3. 针对支持的各个 DSH 版本运行 `pnpm e2e`。
4. 按依赖顺序发布两个包，先 core 后 plugin：`pnpm publish -r --access public`（pnpm 会先发布被依赖的包；先加 `--dry-run` 试一次，预发布版本加 `--tag next`）。
5. 打标签（`git tag v<version>`）并推送标签。
6. 包改名时，把旧包名标为弃用，让安装者看到新名字：

```sh
npm deprecate @kirkchinese/dsh-harness-compat "renamed to @kirkchinese/harness-forge"
npm deprecate @kirkchinese/dsh-harness-compat-core "renamed to @kirkchinese/harness-forge-core"
npm deprecate @kirkchinese/dsh-claude-suite "replaced by @kirkchinese/harness-forge; the capability catalog and Recollect are separate plugins"
```

## Pull request

改动保持聚焦，运行 `pnpm typecheck` 和 `pnpm test`，为改变的行为加测试。报告某个插件不能用时，附上一个能复现问题的最小夹具最有帮助。
