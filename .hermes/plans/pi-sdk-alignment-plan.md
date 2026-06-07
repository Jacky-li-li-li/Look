# Look → pi SDK 数据管道对齐改造计划

## 背景

当前 Look renderer 在 `message_update` 事件中手动累加 `text_delta`/`thinking_delta`，维护 `active` 标记体系，
同时用 `ExecutionProcess` 组件把所有 thinking + toolCall 包裹进一个可折叠面板。这导致了两个问题：

1. **内容重复**：`text_end` + 新 `text_start` 边界可能产生多个 text block，ContentBlocks 把它们全部拼接渲染
2. **Markdown 跳变**：`useThrottle(80ms)` 全量替换 ReactMarkdown，DOM 大范围销毁重建

pi SDK 的推荐做法是直接取 `message_update` 事件中 `event.message.content` 的完整快照（provider 层已经累加好了），
不做任何手动 delta 累加。

## 需要处理的问题点

1. **转换逻辑三份副本**：`message_start` / `message_update` / `message_end` 各有一套 block 转换代码。对齐后全部收敛到 `sdkBlockToPiBlock`
2. **ToolExecutionState 类型共享**：App.tsx 定义 -> ChatPanel.tsx 引用，需要共享
3. **toolStates 缺少清理**：随运行时间不断累积，需在 `agent_end` 时清理
4. **两种 toolCall 状态来源的关系**：
   - `attachToolResult`：处理**历史消息**（已完成 turn 的 tool role），填充已完成的结果
   - `mergeToolStates`：处理**流式中的实时执行状态**（tool_execution_* 事件）
   两者不冲突，按先后顺序叠加

## 架构对比

```
改前：
message_update → assistantMessageEvent.text_delta.delta = "Hel"
  ↓
App.tsx: 复制 contentBlocks → 查找 active block → block.text += "Hel"
  ↓
下一帧: delta = "llo"
  ↓
App.tsx: 复制 contentBlocks → 查找 active block → block.text += "llo"
  ↓
text_end → 标记 active = false

改后：
message_update → event.message.content = [{ type: "text", text: "Hel" }]
  ↓
App.tsx: rawContent.map(sdkBlockToPiBlock) → 直接设为 contentBlocks
  ↓
下一帧: message.content = [{ type: "text", text: "Hello" }]
  ↓
App.tsx: rawContent.map(sdkBlockToPiBlock) → 直接设为 contentBlocks
  ↑ 没有 text_end, 没有 active 标记
```

## 改动文件

| 文件 | 改动 | 行数估计 |
|------|------|---------|
| `src/renderer/App.tsx` | 重写 message_update, tool_execution_* handler | -40 / +50 |
| `src/renderer/components/ChatPanel.tsx` | 新增 toolStates prop，displayMessages merge | +30 |
| `src/renderer/components/MessageBubble.tsx` | 重写 ContentBlocks，去掉 ExecutionProcess | -10 / +60 |
| `src/renderer/components/ExecutionProcess.tsx` | **删除** | -64 |
| (可选) `src/renderer/hooks/useSmoothStream.ts` | 新增 | +75 |

## 不变的文件

| 文件 | 原因 |
|------|------|
| `src/main/agent-manager.ts` | 主进程逻辑不变 |
| `src/main/shared/types.ts` | **新增 ToolExecutionState 导出** |
| `src/main/shared/message-convert.ts` | 主进程持久化不变 |
| `src/renderer/components/ThinkingPanel.tsx` | 输入输出不变 |
| `src/renderer/components/ToolCallCard.tsx` | 输入输出不变 |
| `src/renderer/components/SkillAwareContent.tsx` | 输入输出不变 |
| `src/renderer/components/StreamingMarkdown.tsx` | 不再被流式调用 |

---

## Step 1: App.tsx — 简化事件处理

### 1.1 共享类型定义

在 `src/main/shared/types.ts` 中新增（或导出）：

```typescript
/** 工具执行的运行时状态，由 tool_execution_* 事件驱动 */
export interface ToolExecutionState {
  status: "pending" | "running" | "success" | "error";
  result: string;
  isError: boolean;
}
```

App.tsx 和 ChatPanel.tsx 都引用此类型。

### 1.2 新增 state

```typescript
// 在 App() 的 useState 块中加入
const [toolStates, setToolStates] = useState<
  Record<string, Record<string, ToolExecutionState>>
>({});
```

### 1.3 新增纯转换函数（组件外部/共享作用域）

**重要**：此函数放在 App 组件外部（或独立的 util 文件），供 `message_start`/`message_update`/`message_end` 三个 handler 共享。

```typescript
// App 组件外部
function sdkBlockToPiBlock(b: any): PiContentBlock {
  if (b.type === "toolCall") {
    return {
      type: "toolCall",
      id: b.id ?? "",
      name: b.name ?? "unknown",
      arguments: b.arguments ?? {},
      status: "pending",
      result: "",
      isError: false,
    } satisfies PiToolCallBlock;
  }
  return { ...b, active: false } as PiTextBlock | PiThinkingBlock;
}
```

### 1.4 重写 `message_start` handler

**改动**：内联的 `makeContentBlocks` 替换为共享的 `sdkBlockToPiBlock`。

```typescript
case "agent:message_start": {
  const msg = event.message as any;
  setMessages((prev) => {
    const msgs = [...(prev[event.agentId] ?? [])];
    const content = msg.content;
    const contentBlocks: PiContentBlock[] = Array.isArray(content)
      ? content.map(sdkBlockToPiBlock)    // ← 复用共享函数
      : typeof content === "string" && content.length > 0
        ? [{ type: "text", text: content, active: false }]
        : [];
    const ui: PiMessage = {
      id: msg.id ?? `m_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      agentId: event.agentId,
      role: msg.role === "toolResult" ? "tool" : (msg.role ?? "assistant"),
      contentBlocks,
      timestamp: msg.timestamp ?? Date.now(),
      isStreaming: true,
    };
    msgs.push(ui);
    return { ...prev, [event.agentId]: msgs };
  });
  break;
}
```

### 1.5 重写 `message_update` handler（核心改动）

**删除** ~40 行手动 delta 累加逻辑。
**替换为** ~12 行直接从 pi SDK 快照读取。

```typescript
case "agent:message_update": {
  setMessages((prev) => {
    const msgs = [...(prev[event.agentId] ?? [])];
    const msgId = (event.message as any)?.id;
    let idx = msgId ? msgs.findIndex((m) => m.id === msgId) : -1;
    if (idx < 0) {
      idx = msgs.length - 1;
      for (let i = msgs.length - 1; i >= 0; i--)
        if (msgs[i].isStreaming) { idx = i; break; }
    }
    if (idx < 0) return prev;

    // 直接从 pi SDK 的快照取完整 content，不做手动 delta 累加
    const rawContent = (event.message as any)?.content;
    if (!Array.isArray(rawContent)) return prev;

    msgs[idx] = { ...msgs[idx], contentBlocks: rawContent.map(sdkBlockToPiBlock) };
    return { ...prev, [event.agentId]: msgs };
  });
  break;
}
```

**移除以下不再需要的事件处理**：
- `assistantMessageEvent.type === "text_delta"` ❌
- `assistantMessageEvent.type === "text_end"` ❌
- `assistantMessageEvent.type === "thinking_delta"` ❌
- `assistantMessageEvent.type === "thinking_end"` ❌
- `assistantMessageEvent.type === "toolcall_end"` ❌（toolCall 声明已由 content 快照提供；执行状态由独立 map 管理）

### 1.6 重写 `tool_execution_*` handler

**当前**：操作 contentBlocks，push/update toolCall block 的 status/result。
**改为**：更新独立 `toolStates` map。

```typescript
case "agent:tool_execution_start":
case "agent:tool_execution_update":
case "agent:tool_execution_end": {
  setToolStates((prev) => {
    const byAgent = { ...(prev[event.agentId] ?? {}) };
    const current = byAgent[event.toolCallId] ?? { status: "pending", result: "", isError: false };

    if (event.type === "agent:tool_execution_start") {
      byAgent[event.toolCallId] = { ...current, status: "running" };
    } else if (event.type === "agent:tool_execution_update") {
      const partial = (event.partialResult as any)?.content?.[0]?.text ?? "";
      byAgent[event.toolCallId] = {
        ...current,
        result: (current.result ?? "") + partial,
      };
    } else {
      // tool_execution_end
      const resultStr =
        typeof event.result === "string"
          ? event.result
          : ((event.result as any)?.content?.[0]?.text ?? JSON.stringify(event.result));
      byAgent[event.toolCallId] = {
        status: event.isError ? "error" : "success",
        result: resultStr,
        isError: event.isError,
      };
    }
    return { ...prev, [event.agentId]: byAgent };
  });
  break;
}
```

### 1.7 `message_end` handler

**改动**：内联的 block 转换逻辑替换为共享的 `sdkBlockToPiBlock`。

```typescript
case "agent:message_end": {
  const finalMsg = event.message as any;
  setMessages((prev) => {
    const msgs = [...(prev[event.agentId] ?? [])];
    let idx = msgs.length - 1;
    for (let i = msgs.length - 1; i >= 0; i--)
      if (msgs[i].isStreaming) { idx = i; break; }
    if (idx < 0) return prev;
    const blocks: PiContentBlock[] = Array.isArray(finalMsg.content)
      ? finalMsg.content.map(sdkBlockToPiBlock)     // ← 复用共享函数
      : msgs[idx].contentBlocks;
    msgs[idx] = {
      ...msgs[idx],
      contentBlocks: blocks,
      isStreaming: false,
      timestamp: finalMsg.timestamp ?? msgs[idx].timestamp,
    };
    return { ...prev, [event.agentId]: msgs };
  });
  break;
}
```

### 1.8 `agent_end` handler — 清理 toolStates

**新增**：在 `agent_end` 时清除当前 agent 的 toolStates，避免长时间运行累积。

```typescript
case "agent:agent_end": {
  // 清理当前 agent 的 tool 执行状态，避免累积
  setToolStates((prev) => {
    const next = { ...prev };
    delete next[event.agentId];
    return next;
  });
  // 其余的 agent_end 处理（如状态更新）保持现有逻辑
  break;
}
```

### 1.9 将 toolStates 传递给 ChatPanel

```typescript
<ChatPanel
  // ... 现有 props
  toolStates={toolStates[activeAgent.id] ?? {}}
/>
```

---

## Step 2: ChatPanel.tsx — 传递 + 合并 toolStates

### 2.1 接口新增

```typescript
// 从 types.ts 引入
import type { ToolExecutionState } from "@shared/types";

// 在 ChatPanelProps 中加入
toolStates?: Record<string, ToolExecutionState>;
```

### 2.2 新增 mergeToolStates 函数（在 ChatPanel 外部或内部）

```typescript
function mergeToolStates(
  blocks: PiContentBlock[],
  states: Record<string, ToolExecutionState>
): PiContentBlock[] {
  let changed = false;
  const result = blocks.map((b) => {
    if (b.type !== "toolCall") return b;
    const tc = b as PiToolCallBlock;
    const exec = states[tc.id];
    if (!exec) return b;
    if (tc.status === exec.status && tc.result === exec.result && tc.isError === !!exec.isError) return b;
    changed = true;
    return { ...tc, status: exec.status, result: exec.result, isError: exec.isError };
  });
  return changed ? result : blocks;
}
```

### 2.3 在 displayMessages useMemo 末尾 merge

**执行顺序说明**：`displayMessages` useMemo 内部先执行 `attachToolResult`（处理已完成的 tool role 消息，填充历史 tool call 的结果），
然后执行 `mergeToolStates`（处理流式中的实时执行状态）。两者不冲突，顺序叠加：

1. `attachToolResult` 填充 `contentBlocks[i].result`（历史持久化数据）
2. `mergeToolStates` 覆盖 `contentBlocks[i].status/result/isError`（实时执行数据）

```typescript
// 在 return merged; 之前加入
if (toolStates && Object.keys(toolStates).length > 0) {
  return merged.map((msg) => {
    if (msg.role !== "assistant") return msg;
    const newBlocks = mergeToolStates(msg.contentBlocks, toolStates);
    if (newBlocks === msg.contentBlocks) return msg;
    return { ...msg, contentBlocks: newBlocks };
  });
}
return merged;
```

---

## Step 3: MessageBubble.tsx — 重写 ContentBlocks

### 改动点

1. **去掉** `ExecutionProcess` 包裹
2. **去掉** 在 `ContentBlocks` 顶部提前过滤所有 thinking/toolCall/text block
3. **改为** 按 `blocks[]` 数组顺序逐 block 渲染
4. **流式 text** 用纯文本 + 闪烁光标（避免 ReactMarkdown 全量重解析跳变）
5. **非流式 text** 正常用 `SkillAwareContent` → `StreamingMarkdown`

### 代码

```typescript
function ContentBlocks({ blocks, isStreaming }: { blocks: PiContentBlock[]; isStreaming: boolean }) {
  return (
    <div className="flex flex-col gap-2">
      {blocks.map((block, i) => {
        if (block.type === "thinking") {
          const tb = block as PiThinkingBlock;
          if (!tb.thinking) return null;
          return <ThinkingPanel key={`t-${i}`} thinking={tb.thinking} />;
        }
        if (block.type === "toolCall") {
          const tc = block as PiToolCallBlock;
          return (
            <ToolCallCard
              key={tc.id || `tc-${i}`}
              toolCall={{
                callId: tc.id,
                toolName: tc.name,
                args: tc.arguments,
                status: tc.status,
                result: tc.result,
                isError: tc.isError,
              }}
            />
          );
        }
        if (block.type === "text") {
          const tb = block as PiTextBlock;
          if (!tb.text) return null;
          return (
            <div key={`text-${i}`} className="message-prose">
              {isStreaming ? (
                <span className="whitespace-pre-wrap break-words text-[13px] leading-relaxed">
                  {tb.text}
                  <span className="inline-block w-0.5 h-4 bg-primary animate-pulse ml-0.5 align-text-bottom" />
                </span>
              ) : (
                <SkillAwareContent content={tb.text} isStreaming={false} />
              )}
            </div>
          );
        }
        return null;
      })}
    </div>
  );
}
```

---

## Step 4: 删除 ExecutionProcess.tsx

```bash
rm src/renderer/components/ExecutionProcess.tsx
```

确认无其他引用。

---

## Step 5: 验证

### 5.1 编译检查

```bash
npm run check
```

### 5.2 运行时验证清单

| 场景 | 预期 |
|------|------|
| 纯文本回复流式 | 文字逐帧出现，无跳变，无重复 |
| 有 thinking 的回复流式 | ThinkingPanel 独立展开，text 在下方流式 |
| 有 toolCall 的回复流式 | ToolCallCard 独立展示，text 在下方流式 |
| tool 执行中 | status 从 pending → running → success 更新 |
| 多条 assistant 消息合并 | ChatPanel `displayMessages` 正常合并 |
| 历史消息渲染 | content 完成态正常渲染 markdown |
| message_end | 最终 content 替换正确 |

---

## Step 6 (可选): useSmoothStream — 流式中也渲染 markdown

如果希望在流式过程中就显示渲染后的 markdown（粗体、代码块等），从 Proma 移植 `useSmoothStream` 到
`src/renderer/hooks/useSmoothStream.ts`。

### 原理

1. 每次 content 变化，计算 delta（新内容 - 旧内容）
2. 将 delta 按字符（Intl.Segmenter）拆分为队列
3. rAF 循环每帧从队列取出 `queue.length / 8` 个字符追加到 displayedContent
4. displayedContent → ReactMarkdown 渲染

这样每帧只有少量新增字符，React DOM diff 只做极小扩展，不触发大范围重建。

### 改动

在 `MessageBubble.tsx` 中：

```typescript
import { useSmoothStream } from "../hooks/useSmoothStream";

// 在 ContentBlocks 内：
if (block.type === "text" && block.text) {
  const { displayedContent } = useSmoothStream({ content: block.text, isStreaming });
  return (
    <div key={`text-${i}`} className="message-prose">
      {isStreaming ? (
        <>
          <SkillAwareContent content={displayedContent} isStreaming={true} />
          <span className="inline-block w-0.5 h-4 bg-primary animate-pulse ml-0.5" />
        </>
      ) : (
        <SkillAwareContent content={displayedContent} isStreaming={false} />
      )}
    </div>
  );
}
```

---

## 执行顺序

| Step | 文件 | 可独立测试 |
|------|------|-----------|
| 1.1 | `types.ts` | ✅ 仅新增类型导出 |
| 1.3-1.7 | `App.tsx` | ✅ content 不再手动累加 |
| 1.8 | `App.tsx` (agent_end) | ❌ 依赖 toolStates 工作正常后验证 |
| 1.9 | `App.tsx` (JSX) | ❌ 依赖 2 |
| 2 | `ChatPanel.tsx` | ❌ 依赖 toolStates 数据 |
| 3 | `MessageBubble.tsx` | ❌ 最好等 Step 1 确认 content 正确后再改 UI |
| 4 | 删除 `ExecutionProcess.tsx` | ❌ 依赖 3 |
| 5 | 验证 | ✅ |
| 6 (可选) | 新增 `useSmoothStream.ts` + 改 MessageBubble | ✅ 独立 |
