# 调研二：图片与 tool-result sidecar

## 数据关系（本机备份实测）

- 479 个 base64 图片块（`user/message.content[]`，`source.type=base64`，
  `media_type=image/jpeg`），base64 字符总量 51,964,748（约 39 MiB 解码）。
  集中在 workflow agent 转录中，且多数记录 `isMeta:true`。
- `tool-results/` 下 847 个文件：479 个 `.jpg`（深度 5，路径形如
  `tool-results/pdf-<uuid>/page-*.jpg`）、368 个 `.txt`（深度 4，总 102 MiB）。
- JSONL 字符串引用：`.jpg` 引用 0 次；`.txt` 引用 507 次（392 个不同
  文件）。引用位于 tool_result 的 text 内容里，形如
  `tool-results/<name>.txt`。即：**jpg 是 PDF 页面产物、未被转录文本
  引用；txt 是工具输出外链、被转录文本引用**。

## DSH 原生承载能力（机制级证据）

- 事件/消息格式支持图片：
  - `dsh-llm` `ContentBlockMap` 有 `image` 块：`{type:'image',
    attachment: ImageAttachmentRef}`。
  - `dsh-attachment` 提供 `ctx.attachments.saveImage({data,mediaType,
    name}) → ImageAttachmentRef`；支持 PNG/JPEG/WebP/GIF。
  - `dsh-attachment-local` 落到 `$DSH_HOME/attachments/v1/...`，内容寻址。
- 但当前 DeepSeek 模型路由拒绝图片：
  - `dsh-llm-deepseek/lib/index.js` 显式
    “The DeepSeek chat-completions adapter does not support image content”
    （`UNSUPPORTED_CONTENT`）。
  - 因此若把图片块放进 model-visible surface，DSH 续聊会在请求组装时
    直接失败——这解释了上一轮实现选择“跳过图片块”。

## 迁移方案

A. 全保真模型可见（不推荐当前做）：base64 → attachment → image block。
   数据面可行，模型面在 DeepSeek 文本路由上不可行；需先有视觉模型路由。

B. 安全保留 + 占位符（可行）：
   - 导入时把 479 个 base64 JPEG 经 `ctx.attachments.saveImage` 保存；
   - surface 消息用 `text: "[image image/jpeg <bytes> bytes]"` 占位，
     另加一条 `ignorable:true` 自定义事件或 registry sidecar 保存
     `ImageAttachmentRef` 与源块索引，供未来视觉路由/反向导出使用；
   - 工具结果中引用的 `.txt` sidecar：文件拷入
     `$DSH_HOME/claude2dsh/sidecars/`，registry 记录映射；消息保留
     可读引用文本。若需要模型读取，可配置“内联 ≤N KiB 的 txt”。

C. 继续跳过（现状）。

代价与风险：
- B 方案约 2–4 天；磁盘增量约 141 MiB；需新增 sidecar registry 与
  反向导出映射；风险主要是 token 增加（若内联）与引用一致性。
- A 方案被 DeepSeek 文本适配器硬阻断，不是工作量问题。

## 结论

**“存储”可行，“模型可见”在当前 DeepSeek 路由不可行；推荐 B 方案
（安全保留 + 占位符），优先级低-中。**

## 补充：模型能力探测（2026-08-16 源码核对）

### DSH 能力面

- `@deepseek-ai/dsh-llm/lib/types/types.d.ts` 定义
  `LlmModelInfo.inputModalities?: readonly ModelModality[]`，
  `ModelModalityMap = { text: 'text', image: 'image' }`；
  语义注释明确“absent means unknown, explicit omission is negative
  capability”。
- `ctx.llm.resolveModelInfo(provider, model)` 返回
  `LlmResolvedModelInfo`，携带 detached `inputModalities`。
- `contentHasImage(content)` 是官方递归图片探测 helper。
- `@deepseek-ai/dsh-llm-deepseek/lib/index.js` 的 `modelInfo()`
  **硬编码 `inputModalities: ["text"]`**；`stream()` 对含 image 的请求
  抛 `UNSUPPORTED_CONTENT`。因此探测结果是明确且可信的：DeepSeek
  当前所有注册模型都不支持图片。

### 结论

**可以做到，且是有条件的自动降级：**

1. 导入时对每个 Claude 图片块生成“双表示”：
   - model-visible 默认文本占位符（任何模型都安全）；
   - attachment 持久化 `ImageAttachmentRef` 存 registry/sidecar。
2. 模型能力探测：`ctx.llm.resolveModelInfo(provider, model)`；
   - `inputModalities` 含 `image` → 可用原生 `ImageBlock`；
   - 显式 `["text"]` 或未知 → 保持/回退占位符。
3. 切换模型时的正确性：在 `agent/session-start`（resume 后、驱动
   开始前）同步执行能力探测；通过 `surfaceOp:'replace'` 用
   `start=end=占位符节点seq` 替换该 surface 节点，实现
   “占位符 ⇄ 原生图片”双向切换。DSH `SessionSurface.nodes` 提供当前
   surface seq，`foldSurface`/`sourceEventSeqs` 约束已在
   `dsh-session` 中定义，机制上可行。

代价：导入双表示约 1–2 天；resume 重投影与模型切换测试约 1–2 天。
风险：DeepSeek 文本路由是当前唯一已装适配器，图片 native 路径只能
用未来视觉适配器验证；`session-start` 重投影需在真实模型路由切换时
做回归。
