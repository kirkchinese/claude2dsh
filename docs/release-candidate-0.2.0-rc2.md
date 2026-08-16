# 0.2.0-rc.2 发布候选（第八轮）

## 范围

- 傻瓜式开箱即用：默认安装进用户主 `web` profile，不建隔离环境；
  headless 仅高级选项。
- 一键安装器修复 koffi ignored-build 路径并默认启动主环境 Web UI。
- Settings 首屏首次迁移向导（中文默认、双语、预览→执行→结果）。
- README 傻瓜化重写（能力怎么用 + FAQ + 有头/无头解释）。
- 导入报告区分 previewed/skipped。
- round8 空环境有头验收脚本。

## 发布前检查（已完成）

- 根 `pnpm run check`、workspace build/typecheck 全绿。
- tests core 8 / adapter 13 / plugin 30 全绿。
- e2e R1/R2/R3/R4/R7/R8 全绿。
- `DSH_COMPAT_OK` rc.6。
- pack 四包 manifest 0.2.0-rc.2，无 workspace 协议，plugin 含
  `lib/client.js` 与 cordis.patch.yml。
- Playwright 实测首次迁移向导与执行结果；round8 脚本 curl 证据。
- 未发布、未打 tag；npm latest 仍 0.2.0-rc.1。

## 发布状态

- npm 四包已发布且 latest=0.2.0-rc.2；主 `web` profile 空环境验收通过。
- GitHub push/tag/pre-release 随后执行。
