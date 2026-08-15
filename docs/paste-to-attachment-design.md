# 设计方案：大段粘贴内容自动转为附件文件（Paste → Attachment）

> 状态：**Phase 1（MVP）已实现**（2026-02 实现，见下方实现记录）；Phase 2/3 待实施
> 目标读者：Look 前端 / Electron 主进程 / pi SDK 集成开发者
> 相关代码锚点见文末「改动文件清单」

> **实现记录（Phase 1）**：look-storage 附件目录 + `AttachmentService`（落盘/读取/内联注入）+ `attachment:*` IPC（create/read/update/delete）+ preload/LookAPI 契约 + 渲染端阈值判定（`lib/pasteAttachment.ts`，2000 字符/60 行/代码特征）+ `PendingAttachmentBar` 附件栏（点击卡片 → Dock 查看器、还原为文本、移除）+ `sendMessage` 透传与主进程 `buildPrompt` 内联注入（>32KB 降级引用+摘要）+ `FileViewerDialog` 附件模式（read/update、任意类型可编辑、Cmd+S）+ zh/en/ja 文案 + 单测（`test/main/attachment-service.test.ts`）。

> **实现记录（Phase 2 第一梯队）**：① 历史消息附件块渲染 — `buildPrompt` 标记统一为可解析格式（`[Attachment: name]\n内容\n[/Attachment]` / `[Attachment: name — note]\n预览\n[/Attachment]`），渲染端 `parseAttachmentMessage` 切成 text/attachment 段落，新增 `AttachmentBlock`（卡片 + 折叠内容 + 点击经 `attachment:resolve` 打开 Dock 查看器），`MessageItem`/`MessageBlockList`/`blockTypes` 打通 unified block 新 kind；② 级联清理 — `destroyAgent` 挂钩 `deleteSessionAttachments`、`ProjectDeletionService` 挂钩 `deleteProjectAttachments`（附件不再只增不减）；③ 新增 `attachment:resolve` IPC（历史卡片解析真实路径，缺失时返回明确错误）。未实现（Phase 2 其余）：Cmd+Z 撤销转换；Phase 3：设置项（阈值/开关）、`FileContentSource` 抽象、拖拽转附件。

---

## 1. 背景与现状

### 1.1 用户诉求

用户在输入框粘贴（Ctrl/Cmd+V / 右键粘贴）大量内容时，目前会**原样进入 contenteditable 输入框**：

- 输入框被撑到 `maxHeight: 16rem` 后开始滚动，长内容几乎无法审阅与编辑；
- contenteditable 每次击键都触发全量 `renderToDOM` + chip 正则扫描（`contentEditableUtils.ts` 的 `COMBINED_RE`），大文本下输入/粘贴明显卡顿；
- 发送时整段内容作为 prompt 文本全量进上下文，token 膨胀、格式（缩进/换行）可能被模型误读；
- 用户在发送前**没有机会**对粘贴内容做结构化编辑（改错、补注释、整理格式）。

期望的行为：

1. 粘贴大量内容时**自动识别**，把内容转成一个**附件文件**，输入框只保留简短说明 + 附件引用（输入框不再变长）；
2. 用户可以在**文件查看器**（已有的 `FileViewerDialog`）里编辑该附件，发送时带上编辑后的最新内容；
3. 附件随消息发送，模型能读到内容（历史回放一致）。

### 1.2 现状链路（已核实）

```
粘贴事件
  └─ useContentEditablePaste.ts
       ├─ 图片 → FileReader → ImageContent[]（base64）
       │        └─ ChatInput.pendingImages → ImagePreviewBar（缩略图栏）
       └─ 文本 → 插入 contenteditable → renderToDOM（chip 化）
                    └─ onChange → ChatInput 的 input state
发送
  ChatInput.handleSend(text, images?)
    └─ onSend → useAgentActions.handleSendMessage
         └─ api.sendMessage(agentId, text, images, sendMode)   ← IPC agent:send-message
              └─ agent-router.ts → SessionMessagingService.sendMessage
                   └─ session.prompt(text, { images, source:"rpc", streamingBehavior, preflightResult })
```

### 1.3 已有可复用能力

| 能力 | 位置 | 说明 |
|---|---|---|
| 图片附件栏 | `ImagePreviewBar.tsx` + `ChatInput.pendingImages` | 「待发送附件」交互先例：缩略图 + 移除按钮 |
| 文件查看器/编辑器 | `FileViewerDialog.tsx`（windowMode / dockMode） | textarea 编辑 + Cmd+S、markdown 预览、shiki 高亮、diff、`viewingFileAtom` 驱动 |
| `@path` 文件引用 chip | `contentEditableUtils.ts` | 输入框内 `@path` 渲染为 file chip；聊天内路径/`@` 引用芯片可点击打开查看器 |
| 文件读写 IPC | `file-router.ts` | `file:read`（任意非敏感路径）、`file:write`（**仅项目根 + 共享区白名单**）、`file:stat` |
| 会话工作区目录 | `look-storage.ts` | `workspaces/<projectId>/sessions/<sessionId>/*.jsonl`（pi JSONL）、`shared/<projectId>/`（共享区） |

---

## 2. 关键约束（设计的前提）

### 2.1 pi SDK 没有「文件附件」消息部件（硬约束）

已核实 pi SDK 类型（`@earendil-works/pi-ai`）：

- `UserMessage.content = string | (TextContent | ImageContent)[]` —— **只有文本与图片两种 part**；
- `PromptOptions = { images?: ImageContent[]; streamingBehavior?; preflightResult?; source? }` —— prompt 只接受**图片**附件；
- `ImageContent = { type:"image"; data:string; mimeType:string }`（base64 内联）。

结论：**“把内容转成附件”在本项目中 ≠ 给消息增加一种 file part**（那需要改 pi SDK 上游）。可行的传输模型是：

> **附件 = 磁盘上的真实文件 + 消息文本中的文件引用（`@path` / 内联内容）**

模型读取路径：agent 的 `read_file` 工具支持绝对路径（受权限模式控制，可询问）；同时发送时默认**内联注入**内容兜底（见 §5.5），保证模型必然看到内容。

### 2.2 `file:write` 有项目白名单守卫（硬约束）

`file-router.ts`：`file:write` 只允许写入**项目 cwd 或共享区**（`guardProjectPath`），且禁止敏感路径、防 symlink 逃逸。这意味着：

- 若附件存放在项目外（如 `~/.look/attachments/`），**不能复用 `file:write`** 让查看器保存；
- 需要新增专有 IPC（`attachment:create/read/update/list`），或把附件放进项目共享区走现有守卫。

### 2.3 附件内容必须可编辑、可保存、可随会话回放

- 编辑链路：`FileViewerDialog` 保存目前走 `file:write`（项目守卫）→ 附件模式需要新的读写通道或白名单扩展；
- 回放链路：pi 将 user 消息内容（string）写入 JSONL。附件若只以「磁盘路径 + 引用」存在，JSONL 回放时内容仍在磁盘（附件区），引用文本不变，历史一致；若内联注入，则 JSONL 天然携带内容（更简单但膨胀）。

---

## 3. 核心设计决策

### 决策 D1：附件存储位置 → `$LOOK_HOME/attachments/<projectId>/<sessionId>/`

| 候选 | 是否可写（file:write 守卫） | 是否污染用户仓库 | 数据归属 | 结论 |
|---|---|---|---|---|
| A. `<cwd>/.pi/attachments/` | 是（在项目根内） | 是（git 可见） | pi CLI 区，Look 不该写（AGENTS.md） | ✗ |
| B. `<cwd>/.look-attachments/` | 是 | 是 | 自定义隐藏目录，污染仓库 | ✗ |
| C. `$LOOK_HOME/shared/<projectId>/attachments/` | 是（共享区在白名单） | 否 | 语义是「项目共享文件」，自动写入会弄脏用户共享区 | △ |
| **D. `$LOOK_HOME/attachments/<projectId>/<sessionId>/`** | 需新 IPC | 否 | 会话级 Look 管理数据，与 JSONL 同区，清理策略一致 | ✅ 推荐 |

选择 D 的理由：

1. 附件是 **Look 管理的会话级状态**（与 `session-drafts.json` 同级），不属于项目内容；
2. 与 pi JSONL（`workspaces/<id>/sessions/`）同处 `$LOOK_HOME`，生命周期/清理逻辑一致（会话销毁可级联清理，`resetLegacySessionsOnce` 同类机制可扩展）；
3. 目录含 `<projectId>/<sessionId>`，天然隔离多项目多会话；
4. 不触碰用户 git 仓库，无提交噪音；
5. 代价是新增少量 IPC —— 这正是 §2.2 的必然推论。

> **明确澄清：附件保存路径不是共享区（`shared/<projectId>/`）**。共享区虽然在 `file:write` 白名单内（省 IPC 是它唯一的优点），但它是用户手动共享项目文件的地方，自动写入会弄脏共享区；且附件是会话级数据，放共享区会跨会话混杂、无法跟随会话生命周期清理。若产品上接受这些代价，备选 F（共享区）可作为省 IPC 的变体。

### 决策 D2：附件怎么“发给”模型 → 默认内联注入，超大文件降级为引用

| 路线 | 做法 | 优点 | 缺点 |
|---|---|---|---|
| A. 文件引用 | prompt 文本含 `@<绝对路径>`，模型按需 `read_file` | 不占 token、超大文件可行 | 依赖模型主动读文件，存在被忽略的风险 |
| **B. 内联注入（推荐默认）** | prompt = 用户说明 + `[附件 paste-1.md 内容]\n<内容>` | 模型必然看到，行为可预期 | token 膨胀（但粘贴本来就是用户想让模型看到的内容） |
| C. 混合 | ≤ 阈值内联；> 阈值（建议 32KB）只引用 + 提示模型读文件 | 兼顾可靠与成本 | 两套路径都要测 |

推荐 **B + C 兜底**：默认内联注入；超过内联上限（建议 32KB，`FILE_READ_MAX_BYTES` 4MB 之下）自动降级为「引用 + 截断摘要 + 提示模型用 read_file 读全文」。

### 决策 D3：附件编辑 → 扩展 `FileViewerDialog`，增加「附件模式」

不复刻新编辑器（`FileViewerDialog` 已含预览/高亮/编辑/保存/差分）。做法：

- 新增 prop：`attachment?: { id: string; path: string; name: string }`；
- 读写/保存走**新 attachment IPC**（`attachment:read/update`），不走 `file:write`（附件不在项目白名单内）；
- 复用全部现有编辑交互（Cmd+S、dirty 确认、markdown 预览、窗口/Dock 模式）。

> 重构提示（可选，Phase 3）：将 `FileViewerDialog` 的文件访问抽象为 `FileContentSource { read(); save(content); reload() }` 接口，普通文件与附件各实现一个，避免 1049 行的组件里散落条件分支。

### 决策 D4：输入框交互 → 顶部附件栏（复用 ImagePreviewBar 模式）+ 输入框保持短

粘贴大文本触发转换后：

```
┌─────────────────────────────────────────────┐
│ [📄 paste-20260210-0930.md · 12.4 KB]        │ ← 附件栏（可多附件）
│    [✎ 编辑] [↩ 还原为文本] [✕ 移除]            │
│                                             │
│ 请分析这份错误日志的根因…                      │ ← 输入框只留说明（可空）
│ ─────────────────────────────────────────── │
│ [发送]                                      │
└─────────────────────────────────────────────┘
```

- 附件栏与 `ImagePreviewBar` 同区（可并存：图片 + 文本附件混合）；
- **点击卡片本体 = 打开查看器预览**（`FileViewerDialog` 默认预览视图，未发送也能看），查看器内「✎ 编辑」按钮切换编辑态 —— 看/改共用同一入口，卡片本体是热区，三个小按钮是快捷动作；
- 「还原为文本」= 撤销转换（内容回填输入框并删除附件文件）；
- 「编辑」= 打开 `FileViewerDialog`（window 或 Dock，沿用现有打开方式），与卡片点击预览共用同一实例；
- 发送时**重新读磁盘最新内容**（用户可能在查看器里改过）再构造 prompt。

### 决策 D5：消息历史渲染 → 新增附件块（AttachmentBlock）

- 发送后消息文本含附件引用/内联内容；
- 历史渲染：解析出附件引用时显示附件卡片（文件名、大小、类型图标），点击重新打开查看器；同时保留内联内容折叠展示（`<details>` 式，避免长消息刷屏）；
- 复用现有「聊天内联路径 / @ 引用芯片 → 打开查看器」的既有入口逻辑。

---

## 4. 自动判定逻辑（“自动判断”的详细设计）

### 4.1 触发信号（任一满足即转换）

| # | 信号 | 建议阈值 | 理由 |
|---|---|---|---|
| 1 | 粘贴文本长度 | > 2,000 字符（≈ 500 tokens） | 低于此值的正常粘贴不该被打断 |
| 2 | 粘贴文本行数 | > 60 行 | 代码/日志/文档片段特征 |
| 3 | 内容特征 | 强代码特征（`{`/`}` 配对、缩进行占比 > 30%）、日志特征（`[ERROR]`/时间戳前缀）、连续重复结构 | 高置信“粘贴素材” |
| 4 | 剪贴板含多文件/HTML 富文本 | `clipboardData.items` 含多个 file / `text/html` 且 `text/plain` 超阈值 | 富文本粘贴优先转附件防格式污染 |

> 阈值全部进入设置（`ui-settings.json`），默认 2,000 字符 / 60 行；设置里可关闭自动转换（只留手动按钮）。

### 4.2 转换动作序列

```
粘贴事件（大文本命中阈值）
 1. preventDefault（不插入输入框）
 2. 生成文件名：paste-<yyyyMMdd-HHmm>-<序号>.<扩展名>
      扩展名猜测：markdown（含 # 标题/列表）→ .md
                  代码（language 嗅探：shebang/关键字/大括号）→ .ts/.py/.json/…
                  日志 → .log；默认 .txt
 3. attachment:create(projectId, sessionId, name, content) → 返回 { id, path, sizeBytes }
 4. ChatInput.pendingAttachments.push({ id, name, sizeBytes, mimeType, editable:true })
 5. 输入框清空，光标停在说明位（placeholder 提示“可补充说明后发送”）
```

### 4.3 用户控制（兜底与撤销）

- 附件卡片：**还原为文本** / **编辑** / **移除**；
- 快捷键：粘贴后立即 Cmd+Z 撤销转换（还原为纯文本粘贴，进 undo 栈）；
- 设置开关：`chat.pasteToAttachment.enabled / thresholdChars / thresholdLines`。

---

## 5. 详细设计（端到端链路）

### 5.1 数据模型（shared 层）

```ts
// packages/shared/src/types.ts
export interface PendingAttachment {
  id: string;            // 附件区内的稳定 id（= 文件名主干的 slug）
  projectId: string;
  sessionId: string;
  name: string;          // 显示名 paste-20260210-0930.md
  path: string;          // 绝对路径（$LOOK_HOME/attachments/<projectId>/<sessionId>/<name>）
  sizeBytes: number;
  mimeType: string;      // 按扩展名推断，text/*
  createdAt: number;
}
```

### 5.2 IPC 契约（扩展 LookAPI）

```ts
// packages/shared/src/contracts/ipc.ts（新增）
createAttachment(projectId: string, sessionId: string, name: string, content: string):
  Promise<IpcResult<{ attachment: PendingAttachment }>>;
readAttachment(id: string, sessionId: string): Promise<IpcResult<{ content: string; sizeBytes: number }>>;
updateAttachment(id: string, sessionId: string, content: string):
  Promise<IpcResult<{ sizeBytes: number }>>;
deleteAttachment(id: string, sessionId: string): Promise<IpcResult>;
listAttachments(sessionId: string): Promise<IpcResult<{ attachments: PendingAttachment[] }>>;

// sendMessage 扩展（向后兼容：attachments 可选）
sendMessage(
  agentId: string,
  message: string,
  images?: ImageContent[],
  attachments?: { id: string; sessionId: string }[],
  sendMode?: "steer" | "followUp",
): Promise<IpcResult>;
```

实现要点：`preload.cts` + `invoke-context.ts` 注册新 router（`attachment-router.ts`）；路径一律由主进程拼接（渲染端只传 id，不传任意路径，避免路径注入），`assertSafeProjectId` / `assertSafeSessionId` 校验 id 字符集。

### 5.3 主进程：AttachmentService（新文件）

```
apps/electron/src/main/session/services/attachment-service.ts
  - createAttachment(projectId, sessionId, name, content)
      dir = LOOK_HOME/attachments/<projectId>/<sessionId>/
      ensureDir → writeFile（UTF-8，上限 10MB 与 file:write 对齐）
      → PendingAttachment
  - readAttachment / updateAttachment / deleteAttachment / listAttachments
  - deleteSessionAttachments(sessionId)   // 会话销毁时级联清理（挂到 runtime 生命周期）
  - resolvePromptPayload(text, attachments) // §5.5 的内联/引用组装
```

### 5.4 渲染端：附件栏 + 发送

- `ChatInput.tsx`：新增 `pendingAttachments: PendingAttachment[]` state（与 `pendingImages` 并列）；`handleSend` 发送成功后清空两者；
- `useContentEditablePaste.ts`：文本路径增加阈值判定分支 → 调 `api.createAttachment` → 回调 `onAttachmentCreated`；
- `ChatInputToolbar` 的 `hasContent` 计入附件数量；
- `useAgentActions.handleSendMessage`：透传 `attachments`。

### 5.5 主进程：发送组装（SessionMessagingService 扩展）

```ts
async sendMessage(sessionId, text, images, attachments?, sendMode?) {
  // …现有 /agent: chip 展开逻辑不变…
  let payload = text;
  if (attachments?.length) {
    const parts = await attachmentService.resolvePromptPayload(attachments, sessionId);
    // 默认内联：
    //   payload += "\n\n[附件 paste-1.md 内容]\n" + content
    // > 32KB 降级：
    //   payload += "\n\n[附件 paste-1.md 已存于 <绝对路径>，请用 read_file 读取全文]\n" + 前 8KB 摘要
  }
  await session.prompt(payload, { images, source: "rpc", streamingBehavior: sendMode ?? "followUp", preflightResult });
}
```

- 发送时**重新 `readAttachment` 读取磁盘最新内容**（用户在查看器编辑过）→ 编辑天然生效；
- 内联注入的文本进入 JSONL → 历史回放/分支/压缩都一致；
- 附件文件保留在磁盘（供「编辑」「还原」和未来引用），会话销毁时清理。

### 5.6 查看器编辑链路（FileViewerDialog 附件模式）

```
附件卡片 [✎ 编辑]
  └─ setViewingFile({ absolutePath: attachment.path, attachmentId: attachment.id })
       └─ FileViewerDialog 检测到 attachmentId → 走 attachment:read/update
            └─ 编辑（text/plain 或 markdown 预览）+ Cmd+S → attachment:update
```

- `viewingFileAtom` 扩展 `{ absolutePath: string; diffPatch?; attachmentId?: string }`；
- 保存成功后 toast + 更新附件栏的 `sizeBytes`；
- window 模式（独立窗口）同样可用（`FileViewerApp` 透传 attachmentId）。

### 5.7 历史消息渲染（附件块）

- `MessageBlockList` 新增 `AttachmentBlock`：解析消息文本中的 `[附件 <name> 内容]` / `@<path>` 标记 → 渲染附件卡片（点击打开查看器）+ 折叠内联内容；
- 纯引用模式的 `@<绝对路径>` 复用现有路径芯片点击逻辑，无需新能力。

---

## 6. 边界与安全

| 场景 | 处理 |
|---|---|
| 粘贴 < 阈值 | 保持现状（纯文本插入输入框），完全不打扰 |
| 阈值内大内容 | 附件栏 + 输入框留空；用户可「还原为文本」 |
| 超大内容（> 10MB） | `attachment:create` 拒绝（与 file:write 对齐），提示拆小或直接粘贴 |
| 附件编辑中发送 | 发送时重读磁盘内容，编辑必然生效；发送与保存并发用「发送时快照」避免撕裂 |
| 会话销毁 | 级联删除 `<sessionId>/` 附件目录（挂 runtime 生命周期钩子） |
| 路径安全 | 渲染端只传 id；主进程拼接路径；id 走 `assertSafeProjectId/SessionId` 字符白名单 |
| 多项目 | 附件目录含 projectId，互不可见 |
| 图片粘贴 | 走既有 `images` 通道不变；文本附件不抢占图片语义 |
| 富文本粘贴 | 仍取 `text/plain`（与现状一致）；`text/html` 不引入格式 |

---

## 7. 分阶段实施

### Phase 1 — MVP（核心闭环）

1. `look-storage.ts`：`getAttachmentsDir(projectId, sessionId)` + 目录工具；
2. `attachment-router.ts` + `LookAPI`/preload/invoke-context 注册（create/read/update/delete/list）；
3. `useContentEditablePaste.ts` 阈值判定 + `ChatInput.pendingAttachments` + `PendingAttachmentBar`（复用 ImagePreviewBar 布局）；
4. `sendMessage` 扩展 + `SessionMessagingService` 内联注入；
5. `FileViewerDialog` 附件模式（read/update + 编辑 + Cmd+S）；
6. i18n（zh/en/ja）。

### Phase 2 — 历史与体验

- `AttachmentBlock` 历史渲染（折叠内联内容 + 打开查看器）；
- 会话销毁级联清理附件；
- 「还原为文本」/ Cmd+Z 撤销转换；
- 多附件（连续多次大粘贴）排序与管理。

### Phase 3 — 完善

- `FileViewerDialog` 文件访问接口抽象（`FileContentSource`）；
- 设置页（阈值、自动/手动开关）+ `ui-settings.json` 持久化；
- 超大附件降级为引用模式 + 摘要；
- 拖拽文件 → 附件（非仅 `@path` 引用）。

---

## 8. 改动文件清单

| 层 | 文件 | 改动 |
|---|---|---|
| shared | `packages/shared/src/types.ts` | `PendingAttachment` 类型 |
| shared | `packages/shared/src/contracts/ipc.ts` | `LookAPI` 新增 attachment 方法 + `sendMessage` 扩展 |
| shared | `packages/shared/src/look-storage.ts` | `getAttachmentsDir` + 目录树注释 |
| main | `apps/electron/src/main/ipc/routers/attachment-router.ts`（新） | attachment IPC 注册 |
| main | `apps/electron/src/main/preload.cts` | 暴露 `api.createAttachment` 等 |
| main | `apps/electron/src/main/session/services/attachment-service.ts`（新） | 落盘/读取/组装 prompt |
| main | `apps/electron/src/main/session/services/session-messaging-service.ts` | `sendMessage` 接收附件并组装 |
| renderer | `apps/electron/src/renderer/hooks/useContentEditablePaste.ts` | 阈值判定 + `onAttachmentCreated` |
| renderer | `apps/electron/src/renderer/components/chat/ChatInput.tsx` | `pendingAttachments` 状态 + 附件栏 |
| renderer | `apps/electron/src/renderer/components/chat/PendingAttachmentBar.tsx`（新） | 附件卡片 UI（编辑/还原/移除） |
| renderer | `apps/electron/src/renderer/hooks/useAgentActions.ts` | 透传 attachments |
| renderer | `apps/electron/src/renderer/components/dialogs/FileViewerDialog.tsx` | 附件模式（read/update） |
| renderer | `apps/electron/src/renderer/components/chat/block-renderer/MessageBlockList.tsx`（或新 `AttachmentBlock.tsx`） | 历史附件卡片 + 折叠 |
| renderer | `apps/electron/src/renderer/store/projectAtoms.ts` | `viewingFileAtom` 增加 `attachmentId` |
| renderer | `apps/electron/src/renderer/locales/{zh,en,ja}.json` | 新文案 |

---

## 9. 备选方案对比（为何不选）

| 方案 | 优点 | 缺点 | 结论 |
|---|---|---|---|
| A. 大文本直接内联输入框 + 输入框优化 | 零新架构 | 未解决编辑/审阅问题；contenteditable 大文本性能瓶颈仍在 | ✗ |
| B. 无阈值，所有粘贴都转文件 | 逻辑简单 | 打断正常小段粘贴，高频误伤 | ✗ |
| C. 用户手动建文件再 `@` 引用 | 复用现有机制 | 多步骤、不自动，用户诉求就是“自动判断” | ✗ |
| D. 扩展 pi SDK 增加 file part | 消息模型原生支持 | 需上游改动（`@earendil-works/pi-*`），发布节奏不可控，风险高 | ✗（远期可提案） |
| E. 附件存 `<cwd>` 隐藏目录 | file:write 白名单内 | 污染用户 git 仓库 | ✗ |
| F. 附件存 `shared/<projectId>` | 白名单内、零新 IPC | 语义错位（共享区是给用户手动共享用的），跨会话混杂 | △ |

---

## 10. 关键结论（TL;DR）

1. **pi SDK 没有文件附件部件** → 附件 = 磁盘文件 + 文本引用/内联，这是本方案唯一的硬前提；
2. **存储**：`$LOOK_HOME/attachments/<projectId>/<sessionId>/`（Look 管理数据，不污染仓库，随会话清理），配套新增 attachment IPC（因为 `file:write` 白名单不含 LOOK_HOME）；
3. **自动判定**：长度 > 2,000 字符 或 行数 > 60 或 强代码/日志特征 → 转附件；阈值可配置、可完全关闭；「还原为文本」撤销；
4. **输入框保持短**：附件栏卡片（编辑/还原/移除）+ 可写说明，发送后清空；
5. **编辑**：复用 `FileViewerDialog` 增加附件模式，Cmd+S 保存回附件区，发送时重读磁盘内容保证编辑生效；
6. **发送**：默认内联注入内容（模型必见、JSONL 回放一致），> 32KB 降级为引用 + 摘要；
7. **分阶段**：Phase 1 核心闭环（粘贴→附件→编辑→发送），Phase 2 历史渲染与清理，Phase 3 设置与抽象。
