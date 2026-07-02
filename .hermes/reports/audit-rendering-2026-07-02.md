# Look 消息区域渲染管线深度审计报告

**日期**: 2026-07-02
**审计范围**: `src/renderer/components/{ChatPanel, ChatMessageList, MessageBubble, CollapsibleExecutionGroup, ThinkingPanel, ToolCallCard, SkillAwareContent, StreamingMarkdown, SkillTag, AgentTag, SubagentProgressCard, ChatQueueDrawer, PixelAgentAvatar}.tsx` + `src/renderer/lib/{timeline, stableKey, linkify, batchCollapse, highlighter}.ts` + `src/renderer/store/{ipcHandler, sessionTypes}.ts` + `src/main/shared/types.ts` + `src/main/session-runtime-manager.ts` + `src/main/services/auto-title.ts`
**审计方式**: 4 个并行 leaf agent,分别覆盖 ①React key/reconciliation ②流式生命周期竞态 ③Markdown/DOM 安全 ④UI 状态一致性/可访问性

---

## TL;DR

| 严重度 | 数量 | 备注 |
|---|---|---|
| **HIGH** | **7** | 双气泡、悬空流气泡、永远 running、用户消息闪烁、~~~ 围栏、glob 误转义、pendingUserMessage 兜底 |
| **MEDIUM** | **16** | key 形状撕裂、折叠状态丢失、可访问性、Copy 按钮、img 锁死、display:contents、Throttle cleanup、previousStreamLenRef、强制展开覆盖用户态 |
| **LOW** | **~24** | 对比度、memo 失效、ARIA 属性、小 UX 瑕疵 |

**最关键的两个 bug 用户可直接感知**:
1. **B-#3 + A-H1 同源**: `toolcall_end` 在 `assistant_message_start` 之后的回退路径会重复添加 block(同 contentIndex 双卡片)。
2. **A-M5**: 流式→持久化切换时 key 形状不同,`ThinkingPanel.manualOpen` / `ToolCallCard.manualOpen + collapseAfter` / `CollapsibleExecutionGroup.manuallyOpened` 三个本地状态全丢失 → 用户展开的卡片被折叠。

---

## HIGH (7 条)

### H1. `toolcall_end` 在 `assistant_message_start` 后的回退路径产生重复 block → 双卡片
- **文件**: `src/renderer/store/ipcHandler.ts:265-329`
- **根因**:
  - 行 394-397: `assistant_message_start` 触发 `pendingToolcallIndex.clear()`,但**已完成的上轮 block 仍保留在 blocks 数组**
  - 行 301-313: `toolcall_end` 用 `pendingToolcallIndex.get(contentIndex)` 查找;map miss 后走 line 314-329 else 分支,**push 一个新 block**
  - 结果:同一个 contentIndex 有两个 block(旧的 completed + 新的 completed),StreamingBlocksBubble 用不同 uid 渲染两张 ToolCallCard
- **修复**: line 304 替换为线性扫描
  ```ts
  // 替换
  const idx = pendingToolcallIndex.get(ev.contentIndex) ?? -1;
  // 为
  const idx = blocks.findIndex(
    b => b.kind === "toolcall" && b.contentIndex === ev.contentIndex && !b.completed
  );
  ```
  并把 else 分支(line 314-329)也改为 in-place 更新而非 push。

### H2. 非 agent_end snapshot 保留陈旧 uiBlocks → 跨会话 stream 残影
- **文件**: `ipcHandler.ts:127-131`,`timeline.ts:146-156`
- **根因**: `applySnapshot` 仅 `if (isAgentEnd)` 清 uiBlocks。activate/initial/navigate 保留旧 stream 状态块;如果切换 active session 时新 session 拿到旧 uiBlocks,timeline 会同时显示新 entries + 旧 uiBlocks 推的 streaming-live item。
- **修复**:
  ```ts
  // ipcHandler.ts applySnapshot 中,把
  uiBlocks: isAgentEnd ? [] : previous.uiBlocks,
  // 改为
  uiBlocks: [],  // snapshot 是 source of truth,无理由保留
  ```

### H3. `CollapsibleExecutionGroup` `key={block.id}` 无回退 → 空 id 触发 React 重复 key 警告
- **文件**: `CollapsibleExecutionGroup.tsx:244`
- **根因**: SDK 异常可能发出空字符串 id;同组多个空 id → React duplicate key + 折叠状态丢失。
- **修复**:
  ```ts
  key={block.id || `tool-${block.name}-${hashKey(JSON.stringify(block.arguments ?? {}))}`}
  ```

### H4. `pendingUserMessage` 快照硬清 → 用户消息可能闪烁消失
- **文件**: `ipcHandler.ts:134`,`timeline.ts:133-144`
- **场景**: 用户发 A → 发 B。若 A 的 snapshot 迟于 B 的 `user_message` 事件:applySnapshot 无条件 `pendingUserMessage: null`,B 文本从 UI 消失,直到 B 自己的 snapshot 到达才重现。
- **修复**:
  ```ts
  // RendererSessionState 中给 pendingUserMessage 加 id
  pendingUserMessage: { id: string; text: string; images?: ImageContent[] } | null;
  // user_message 事件从 SDK message entry id 填
  // applySnapshot 只清同 id:
  pendingUserMessage:
    previous.pendingUserMessage?.id === lastUserEntryId ? null : previous.pendingUserMessage,
  ```

### H5. `autoCloseCodeFences` 不识别 `~~~` 围栏 → 流式 markdown 解析错位
- **文件**: `StreamingMarkdown.tsx:13-31`
- **根因**: 只识别 `` ``` ``;`escapeGlobAsterisks`(行 38-62)双重跟踪。LLM 输出 `~~~js\ncode\n<截断>` 时不会补关闭符,react-markdown 把后续段落都当围栏内容。
- **修复**: 与 `escapeGlobAsterisks` 共享 fence 状态机,同时识别 `` ``` `` 与 `~~~`:
  ```ts
  function autoCloseCodeFences(text: string): string {
    let openFence: string | null = null;  // "```" | "~~~" | null
    for (const line of text.split("\n")) {
      const t = line.trimStart();
      if (!openFence && (t.startsWith("```") || t.startsWith("~~~"))) {
        openFence = t.startsWith("```") ? "```" : "~~~";
      } else if (openFence && t.startsWith(openFence)) {
        openFence = null;
      }
    }
    return openFence ? `${text}\n${openFence}` : text;
  }
  ```

### H6. `escapeGlobAsterisks` 字符类把 `[`/`(` 当合法前缀 → markdown 链接被转义破坏
- **文件**: `StreamingMarkdown.tsx:59`
- **修复**:
  ```ts
  // 替换
  result.push(line.replace(/(^|\s|[(/])(\*\.\S+)/g, "$1\\$2"));
  // 为
  result.push(line.replace(/(^|\s)(\*\.\S+)/g, "$1\\$2"));
  ```
  同时先剥离 markdown 链接 `[label](url)` 中的 URL 段。

### H7. ToolCallCard memo 被内联对象 prop 旁路 → 每次 delta 都重渲
- **文件**: `ToolCallCard.tsx:414-418` (memo) vs `MessageBubble.tsx:216-223` + `CollapsibleExecutionGroup.tsx:245-253` (call site)
- **根因**: 两个 call site 都用 `toolCall={{...}}` 字面量 → 新引用 → memo 永不 bail out。每次流式 delta 都重渲 ToolCallCard 子树,`useMemo(() => safeJson(toolCall.args), [toolCall.args])` 也失效。
- **修复**: 在 call site 提取为稳定对象:
  ```ts
  // MessageBubble.tsx ContentBlocks 中
  const toolCallView = useMemo(() => ({
    callId: block.id,
    toolName: block.name,
    args: block.arguments,
    status, result, isError: execution?.isError ?? persistedResult?.isError,
  }), [block.id, block.name, block.arguments, status, result, execution?.isError, persistedResult?.isError]);

  <ToolCallCard toolCall={toolCallView} />
  ```

---

## MEDIUM (16 条)

### M1. `toolcall_end` / `tool_exec_end` 事件无对应 start 时静默丢弃 → 永久 running
- **文件**: `ipcHandler.ts:301-329, 339-358`,`MessageBubble.tsx:410-412`
- **修复**: 补一个登记路径:
  ```ts
  // tool_exec_end 在 toolExecs[ev.toolCallId] 不存在时
  if (!toolExecs[ev.toolCallId]) {
    toolExecs = {
      ...toolExecs,
      [ev.toolCallId]: {
        toolCallId: ev.toolCallId, toolName: ev.toolName, args: ev.args ?? {},
        phase: "completed", result: ev.result, isError: ev.isError,
      },
    };
  }
  ```

### M2. 流式 → 持久化 key 形状不同 → 用户展开状态撕裂 ⚠️ 用户可感知
- **文件**: `MessageBubble.tsx:178-194` (持久) vs `381-435` (流式)
- **场景**: 流式 key 是 `txt-${uid}` / `tool-${toolCallId}`;持久 key 是 `text-${hashKey(text)}` / `block.id`。三个 key 类型全换了,ThinkingPanel.manualOpen / ToolCallCard.manualOpen / CollapsibleExecutionGroup.manuallyOpened 全部丢失。
- **修复**: 让持久侧采用与流式一致的 key 形状(uid- 或 toolCallId-based);合并两条 path 使用统一的 `BlockViewModel` 渲染器。

### M3. 相同内容 text/thinking 块触发 hashKey 碰撞
- **文件**: `MessageBubble.tsx:178, 187, 194`
- **场景**: 模型输出两个 "OK" / "Done",hashKey 必碰撞;短重复短语几乎是 100%。
- **修复**: 加 index 消歧:`key={text-${i}-${hashKey(block.text)}}`(流式侧已用 uid,无需改)。

### M4. `SkillAwareContent` 内层 map key 不带索引
- **文件**: `SkillAwareContent.tsx:68-82`
- **修复**: 加双层索引 `key={`s-${i}-${j}-${ss.name}`}`。

### M5. `setCopiedEntryId` setTimeout 无清理
- **文件**: `ChatMessageList.tsx:264`
- **修复**: `copiedTimerRef` + `clearTimeout`,或放 `useEffect([copiedEntryId])` 内。

### M6. Copy 按钮无错误处理 — 剪贴板失败时静默成功
- **文件**: `StreamingMarkdown.tsx:119-124`,`MermaidBlock.tsx:137-142`
- **修复**:
  ```ts
  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error(t("chat.copyFailed"));
    }
  };
  ```

### M7. `MarkdownImg` onError 锁死错误状态,src 变化不重试
- **文件**: `StreamingMarkdown.tsx:281-294`
- **修复**: `useEffect(() => setError(false), [src])` 或 `key={src}`。

### M8. `display: contents` + flex-wrap 的可访问性与布局隐患
- **文件**: `StreamingMarkdown.tsx:341-347`,`SkillAwareContent.tsx:44-50`
- **修复**: inline 内容里产生块级元素时改用 `display: inline-block` + 强制所有 react-markdown 组件为内联;或仅在保证内联时用 `display:contents`。

### M9. `<SkillTag>` / `<AgentTag>` 缺可访问性语义
- **文件**: `SkillTag.tsx:28-42`,`AgentTag.tsx:16-27`
- **修复**: 加 `role="img"` + `aria-label="已调用 skill: foo"`(AgentTag 类似)。

### M10. `MarkdownHr` 用 `<div>` 替代语义 `<hr>`
- **文件**: `StreamingMarkdown.tsx:240-244`
- **修复**: 改 `<hr className="my-2 border-0" />`。

### M11. Throttling cleanup 在 streaming→idle 切换时可能丢失最后一段
- **文件**: `useThrottle.ts:22-63`
- **修复**: cleanup 不在 `isStreaming=false` 分支清 `pending`,或显式 flush 一次。

### M12. 头像与气泡首行基线偏移 ~9px
- **文件**: `MessageBubble.tsx:282-300`
- **修复**: 头像改 `size="xs"`(20px)对齐 header,或 grid 布局 + `self-start`。

### M13. 相邻 assistant 气泡视觉粘连
- **文件**: `MessageBubble.tsx:295`,`App.css:1554-1568`
- **修复**: assistant 气泡加 `rounded-md border border-hairline bg-card/30`,或 `border-l-2 border-hairline` 分隔线。

### M14. 子 agent 进度卡区无 max-height,把输入框顶出视口
- **文件**: `ChatPanel.tsx:117-146`
- **修复**: 加 `max-h-60 overflow-y-auto`。

### M15. 子 agent 自动折叠忽略 failed
- **文件**: `ChatPanel.tsx:95-102`
- **修复**: 改为 `else if (doneCount > 0 && failedCount === 0)`;有 failed 时保持展开。

### M16. ToolCallCard `manualOpen` 与 scheduleCollapse 互锁失效 + CollapsibleExecutionGroup anyRunning 覆盖用户意图
- **文件**: `ToolCallCard.tsx:186, 201-214`,`CollapsibleExecutionGroup.tsx:126-128`
- **修复**: collapseAfter 提升到 manualOpen 之上:`open = (collapseAfter != null && Date.now() < collapseAfter) || (manualOpen ?? isRunning)`;CollapsibleExecutionGroup 改为只 force-open 不清 manuallyOpened。

---

## LOW (~24 条)

| # | 位置 | 问题 |
|---|---|---|
| L1 | `ipcHandler.ts:165` `_nextBlockUid` | 模块级计数器 HMR 重置可能碰撞 |
| L2 | `MessageBubble.tsx:385-435` `block.uid ?? i` | 类型 `uid?: number` 可选,加 fallback 后重排仍可能碰撞 |
| L3 | `MessageBubble.tsx:283` `self-end` | 在 block 父容器里无效,误导 |
| L4 | `MessageBubble.tsx:188-198` `prevStatusRef` | inline mutation 多次跳变只取最后一次 |
| L5 | `linkify.tsx:11` + `ToolCallCard.tsx:343` | linkifyText 不识别围栏 |
| L6 | `StreamingMarkdown.tsx:144` + `App.css:16-27` | Shiki 长行水平滚动(可保留) |
| L7 | `ToolCallCard.tsx:233-239` | `text-red-500` 深色对比勉强 AA fail;aborted `/50` 远低于 AA |
| L8 | `ChatMessageList.tsx:174-180` | `flashTimer` 类型隐式 any |
| L9 | `ChatMessageList.tsx:142-171` | `prevStreamLenRef.current=0` 在 `!isBusy` 重置,phase stale 时漏滚 |
| L10 | `StreamingMarkdown.tsx:72, 207-211` | Mermaid 无 ErrorBoundary |
| L11 | `SkillAwareContent.tsx:23-25` | `stripSystemHints` 只匹配行首,mid-message 漏过滤 |
| L12 | `SkillAwareContent.tsx:33-57` | `hasSkill` 与 `parseSkillSegments` 不一致,代码块内 `/skill:foo` 误生成 chip |
| L13 | `CollapsibleExecutionGroup.tsx:319-335` | badge `pr-2.5 py-1` 与 ToolCallCard `px-2.5 py-2` 视觉不对齐 |
| L14 | `ToolCallCard.tsx:262-308` | ink-wash 主题字重覆盖未下沉到 default 分支 |
| L15 | `ChatMessageList.tsx:76-94` | `buildTimeline` useMemo 因 sessionState 是新对象每次失效 |
| L16 | `linkify.tsx:11` | URL_RE 安全但可加 scheme 二次校验做纵深防御 |
| L17 | `StreamingMarkdown.tsx:350-359` | `prose-sm` 首/末子元素 margin 与外层 gap 叠加 |
| L18 | `ChatMessageList.tsx:448-454` | `flowing-border` 按钮无 border,蒙版边缘可更明确 |
| L19 | `MessageBubble.tsx:259, 297` | bubble-flash 二次进入不重启动画(边界) |
| L20 | `ToolCallCard.tsx:314-329` | else 分支创建的 block 不加入 pendingToolcallIndex(跟随 H1) |
| L21 | `PixelAgentAvatar.tsx:36` | 装饰性 sr-only 文本每个气泡念一次,噪音 |

---

## 修复优先级建议

| 优先级 | 编号 | 范围 | 工时估计 |
|---|---|---|---|
| **P0** | H1, H3, H7 | ipcHandler / ToolCallCard / CollapsibleExecutionGroup | 2-3h |
| **P1** | H2, H4, H5, H6, M1, M2 | ipcHandler / MessageBubble / Timeline / StreamingMarkdown | 4-6h |
| **P2** | M3-M16 | key 形状统一 + a11y + UX | 1 天 |
| **P3** | L1-L21 | 清理 + 加固 | 半天 |

---

## ✅ 安全审计结论

- **XSS 表面干净**: react-markdown v10 默认无 `skipHtml`/`rehypeRaw`,HTML 自动转义;Shiki 输出经 `DOMPurify.sanitize()` 兜底;`linkifyText` 正则天然拒绝 `javascript:`/`data:`/`vbscript:`。
- **未发现**: 代码注入、数据外泄、`dangerouslySetInnerHTML` 滥用(仅 Shiki 一处已 sanitize)。
- **关键架构决策正确**: 双路径(persisted AgentMessage + streaming LookUiStreamBlock)边界清晰,事件流 source of truth 划分合理——但事件层去重数据模型(`pendingToolcallIndex` + `contentIndex`)不完备,导致 P0 三个 HIGH 全部从同一个根因衍生。

---

## 未触及但建议另查

- `dialog-handlers` 中 `agent:send-message` 之后 `session_event` 的 Promise 解析顺序与 IPC 顺序(尤其 abort 路径)
- `refreshProjectSessions` 的 snapshot 触发会覆盖 `applySnapshot` 后由 ui-event 已设定的 `pendingUserMessage`(因 `pendingUserMessage: null` 硬写,见 ipcHandler.ts:134 — 与 H4 同源)
- 主进程 `session-runtime-manager.ts:1897-1922` 的 `agent_end` 顺序是否在所有错误路径上保持 run_status=idle → snapshot

---

报告生成: Claude (Opus 4) × 4 子 agent 并行审计 → Hermes 主 agent 合并