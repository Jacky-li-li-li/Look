# 消息管道重构：消除 AgentMessage 中间层，直接使用 pi SDK Content Blocks

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** 消除 `AgentMessage` UI 格式转换层，渲染器和主进程直接使用 pi SDK 原生的 content blocks `[{type: "text", text}, {type: "thinking", thinking}, {type: "toolCall", id, name, arguments}]` 作为消息规范格式，toolCall 和 thinking 保持当前 UI 设计样式。

**Architecture:** 核心思路是将 `AgentMessage` (扁平化的 `content: string, thinking: string, toolCalls: ToolCallRecord[]`) 替换为直接存储 `contentBlocks: PiContentBlock[]`（pi SDK 原生格式），在 MessageBubble 中按块类型渲染，不再做 extract/flatten 转换。streaming deltas 通过 contentIndex 定位到具体 block 进行追加，tool_execution 事件直接打补丁到对应 toolCall block 的运行时状态。

**Tech Stack:** TypeScript, React 19, pi SDK (`@earendil-works/pi-*`)

---

## 现状 vs 目标数据流对比

```
【现状】
pi event.content = [{type:"text",text},{type:"thinking",thinking},{type:"toolCall",...}]
  ↓ extractText() / extractThinking() / extractToolCalls()
AgentMessage = { content: string, thinking: string, toolCalls: ToolCallRecord[], assistantChunks }
  ↓ ChatPanel.displayMessages useMemo (合并连续 assistant)
  ↓ MessageBubble (读 content/thinking/toolCalls/assistantChunks)

【目标】
pi event.content = [{type:"text",text},{type:"thinking",thinking},{type:"toolCall",...}]
  ↓ 无转换，直接存储
PiMessage = { role, contentBlocks: PiContentBlock[], usage, ... }
  ↓ ChatPanel.displayMessages useMemo (合并连续 assistant → chunks of contentBlocks)
  ↓ MessageBubble (遍历 contentBlocks，按 type 渲染不同组件)
```

---

## pi SDK Content Block 类型定义 (源)

```ts
// @earendil-works/pi-ai/dist/types.d.ts

interface TextContent {
    type: "text";
    text: string;
    textSignature?: string;
}

interface ThinkingContent {
    type: "thinking";
    thinking: string;
    thinkingSignature?: string;
    redacted?: boolean;
}

interface ToolCall {
    type: "toolCall";
    id: string;
    name: string;
    arguments: Record<string, any>;
    thoughtSignature?: string;
}

type ContentBlock = TextContent | ThinkingContent | ToolCall;

interface AssistantMessage {
    role: "assistant";
    content: ContentBlock[];
    usage: Usage;
    stopReason: StopReason;
    timestamp: number;
    // ... other fields
}
```

---

## 重构任务清单

### Task 1: 定义新的共享类型 — `PiContentBlock` 和运行时扩展

**文件:** `src/main/shared/types.ts`

**目标:** 新增 `PiTextBlock`, `PiThinkingBlock`, `PiToolCallBlock` 类型联合为 `PiContentBlock`，以及携带运行时状态的 `PiMessage`。

**具体改动:**

```ts
// ============ 新增: pi SDK 原生格式 ============

/**
 * pi SDK 原生 text block。直接映射 TextContent。
 */
export interface PiTextBlock {
    type: "text";
    text: string;
    textSignature?: string;
    /** Streaming 阶段: 当前 block 是否还在接收 delta */
    active?: boolean;
}

/**
 * pi SDK 原生 thinking block。直接映射 ThinkingContent。
 */
export interface PiThinkingBlock {
    type: "thinking";
    thinking: string;
    thinkingSignature?: string;
    redacted?: boolean;
    active?: boolean;
}

/**
 * pi SDK 原生 toolCall block + 运行时状态（由 tool_execution 事件注入）。
 * 静态字段 (id, name, arguments) 来自 pi ContentBlock。
 * 动态字段 (status, result, isError) 由事件流补充。
 */
export interface PiToolCallBlock {
    type: "toolCall";
    id: string;
    name: string;
    arguments: Record<string, any>;
    thoughtSignature?: string;
    /** 运行时状态: pending | running | success | error */
    status: "pending" | "running" | "success" | "error";
    /** 工具执行结果文本 */
    result?: string;
    /** 工具执行是否出错 */
    isError?: boolean;
}

export type PiContentBlock = PiTextBlock | PiThinkingBlock | PiToolCallBlock;

/**
 * 替代 AgentMessage: 直接使用 pi 原生 content blocks。
 */
export interface PiMessage {
    id: string;
    agentId: string;
    role: "user" | "assistant" | "tool" | "system";
    /** pi SDK 原生 content blocks */
    contentBlocks: PiContentBlock[];
    timestamp: number;
    isStreaming?: boolean;
    /** Token usage（assistant 消息才有） */
    usage?: UsageSnapshot;
}

/**
 * 多步推理 chunk: 一组 content blocks 构成一个推理步骤。
 * 连续的 assistant PiMessage 合并时，每个 PiMessage 变成一个 PiChunk。
 */
export interface PiChunk {
    contentBlocks: PiContentBlock[];
}

// ============ 保留（兼容旧的） ============

// AgentMessage 保留但标记为 @deprecated，后续 Task 逐步移除引用
// ToolCallRecord 保留但标记为 @deprecated
```

**注意:** 暂时保留 `AgentMessage` / `ToolCallRecord` 类型定义，在后续 task 逐步移除所有引用后再删除。

---

### Task 2: 简化 `message-convert.ts` — 直接 pass-through

**文件:** `src/main/shared/message-convert.ts`

**目标:** `convertPiMessage` 不再做 extract/flatten，直接映射 pi 消息的 content blocks。

**具体改动:**

```ts
import type { PiMessage, PiContentBlock, UsageSnapshot } from "./types.js";

/**
 * Convert a pi AgentMessage into Look's PiMessage.
 * No longer extracts/flattens — content blocks pass through directly.
 * Only adds runtime fields (status) for toolCall blocks.
 */
export function convertPiMessage(piMsg: any, agentId: string, msgId: string): PiMessage {
    const piRole: string = piMsg.role ?? "";

    if (piRole === "user") {
        const text = typeof piMsg.content === "string"
            ? piMsg.content
            : (Array.isArray(piMsg.content)
                ? piMsg.content
                    .filter((b: any) => b.type === "text")
                    .map((b: any) => b.text)
                    .join("\n")
                : "");
        return {
            id: msgId,
            agentId,
            role: "user",
            contentBlocks: [{ type: "text", text }],
            timestamp: piMsg.timestamp ?? Date.now(),
        };
    }

    if (piRole === "assistant") {
        const blocks: PiContentBlock[] = Array.isArray(piMsg.content)
            ? piMsg.content.map((b: any) => {
                if (b.type === "toolCall") {
                    return {
                        type: "toolCall",
                        id: b.id ?? "",
                        name: b.name ?? "unknown",
                        arguments: b.arguments ?? {},
                        status: "success" as const, // restored: 默认 success，无事件流补充
                        result: "",
                        isError: false,
                    } satisfies PiContentBlock;
                }
                // text, thinking — pass through directly
                return { ...b };
            })
            : [];

        return {
            id: msgId,
            agentId,
            role: "assistant",
            contentBlocks: blocks,
            timestamp: piMsg.timestamp ?? Date.now(),
            usage: piMsg.usage ? {
                inputTokens: piMsg.usage.input ?? 0,
                outputTokens: piMsg.usage.output ?? 0,
                cacheReadTokens: piMsg.usage.cacheRead ?? 0,
                cacheWriteTokens: piMsg.usage.cacheWrite ?? 0,
                totalTokens: piMsg.usage.totalTokens ?? 0,
                cost: {
                    input: piMsg.usage.cost?.input ?? 0,
                    output: piMsg.usage.cost?.output ?? 0,
                    cacheRead: piMsg.usage.cost?.cacheRead ?? 0,
                    cacheWrite: piMsg.usage.cost?.cacheWrite ?? 0,
                    total: piMsg.usage.cost?.total ?? 0,
                },
            } : undefined,
        };
    }

    // toolResult, system, etc.
    return {
        id: msgId,
        agentId,
        role: piRole === "toolResult" ? "tool" : "system",
        contentBlocks: typeof piMsg.content === "string"
            ? [{ type: "text", text: piMsg.content }]
            : Array.isArray(piMsg.content)
                ? piMsg.content.map((b: any) => ({ ...b }))
                : [{ type: "text", text: JSON.stringify(piMsg.content ?? piMsg) }],
        timestamp: piMsg.timestamp ?? Date.now(),
    };
}
```

---

### Task 3: 更新 `AgentManager` — 内部消息存储改用 `PiMessage`

**文件:** `src/main/agent-manager.ts`

**目标:**
1. `ManagedAgent.messages` 类型从 `AgentMessage[]` 改为 `PiMessage[]`
2. `loadPersistedAgents` — `uiMessages` 类型改为 `PiMessage[]`
3. `handleLookSideEffect` — message_update 的 delta 直接追加到对应 content block
4. `handleLookSideEffect` — tool_execution_* 直接更新对应 block 的运行时字段
5. `trackUsage` — usage 提取路径不变（pi usage 在 message 顶层，不在 blocks 里）
6. `addMessage` / `getMessages` / `listAgentsWithHistory` — 类型签名更新

**具体改动点:**

```ts
// L96-103: ManagedAgent 类型
interface ManagedAgent {
    info: AgentInfo;
    session: AgentSession;
    messages: PiMessage[];     // ← 改为 PiMessage[]
    unsubscribe: () => void;
    resolveWaits?: (() => void)[];
    permissionMode: PermissionMode;
}

// L236-249: loadPersistedAgents 中的消息恢复
// 不再手动 extract, convertPiMessage 已返回 PiMessage
const uiMessages: PiMessage[] = [];
for (const e of branch) {
    if (e.type !== "message") continue;
    const msg = e.message;
    // 跳过内部消息类型
    if (msg.role === "bashExecution" || msg.role === "custom" || 
        msg.role === "branchSummary" || msg.role === "compactionSummary")
        continue;
    uiMessages.push(convertPiMessage(msg, id, e.id));
}

// L286-306: usage 重计算
// assistant 消息可能有 usage 字段（在 PiMessage.usage，不在 blocks 里）
for (const msg of uiMessages) {
    if (msg.role !== "assistant" || !msg.usage) continue;
    // ... 累加逻辑不变 ...
}

// L1288-1317: handleLookSideEffect — message_update
case "message_update": {
    const evt = event.assistantMessageEvent;
    if (!evt) break;
    const sm = [...m.messages].reverse().find((x) => x.isStreaming);
    if (!sm) break;
    
    if (evt.type === "text_delta") {
        // 找到 active 的 text block（或创建新的）
        let block = sm.contentBlocks
            .filter(b => b.type === "text")
            .reverse()
            .find(b => b.active);
        if (!block || !block.active) {
            // 创建新的 text block
            const newBlock: PiTextBlock = { type: "text", text: "", active: true };
            sm.contentBlocks.push(newBlock);
            block = newBlock;
        }
        block.text += evt.delta;
    } else if (evt.type === "thinking_delta") {
        let block = sm.contentBlocks
            .filter(b => b.type === "thinking")
            .reverse()
            .find(b => b.active);
        if (!block || !block.active) {
            const newBlock: PiThinkingBlock = { type: "thinking", thinking: "", active: true };
            sm.contentBlocks.push(newBlock);
            block = newBlock;
        }
        block.thinking += evt.delta;
    } else if (evt.type === "text_end" || evt.type === "thinking_end") {
        // 标记 block 结束
        const blocks = evt.type === "text_end"
            ? sm.contentBlocks.filter(b => b.type === "text" && b.active)
            : sm.contentBlocks.filter(b => b.type === "thinking" && b.active);
        for (const b of blocks) b.active = false;
    } else if (evt.type === "toolcall_start") {
        // pi contentIndex 告诉我们这是第几个 toolCall
        const ci = (evt as any).contentIndex ?? 0;
        const newBlock: PiToolCallBlock = {
            type: "toolCall",
            id: "", name: "", arguments: {},
            status: "pending",
        };
        sm.contentBlocks.push(newBlock);
    } else if (evt.type === "toolcall_delta") {
        // 累积 toolCall JSON delta
        const tc = sm.contentBlocks
            .filter(b => b.type === "toolCall")
            .reverse()
            .find(b => b.status === "pending");
        if (tc && tc.type === "toolCall") {
            // delta 是 JSON 片段，最终 toolcall_end 会有完整对象
            // 这个中间态可以忽略或简单追踪
        }
    } else if (evt.type === "toolcall_end") {
        const tc = (evt as any).toolCall;
        if (tc) {
            const pending = sm.contentBlocks
                .filter(b => b.type === "toolCall" && b.status === "pending")
                .reverse()[0];
            if (pending && pending.type === "toolCall") {
                pending.id = tc.id ?? "";
                pending.name = tc.name ?? "unknown";
                pending.arguments = tc.arguments ?? {};
                // status 仍然为 pending，等 tool_execution_start
            }
        }
    }
    break;
}

// L1346-1402: handleLookSideEffect — tool_execution_*
case "tool_execution_start": {
    this.updateStatus(agentId, "working");
    // 找到对应的 toolCall block
    const sm = [...m.messages].reverse()
        .find(x => x.isStreaming && x.role === "assistant");
    if (sm) {
        const block = sm.contentBlocks
            .filter(b => b.type === "toolCall")
            .reverse()
            .find(b => b.id === event.toolCallId || (b.status === "pending" && !b.id));
        if (block && block.type === "toolCall") {
            block.id = event.toolCallId;
            block.name = event.toolName;
            block.arguments = event.args ?? {};
            block.status = "running";
        }
    }
    // Permission gate 逻辑保持不变
    break;
}
case "tool_execution_end": {
    // 更新对应 block 的运行时状态
    const sm = [...m.messages].reverse()
        .find(x => x.role === "assistant" && 
            x.contentBlocks.some(b => b.type === "toolCall" && b.id === event.toolCallId));
    if (sm) {
        const block = sm.contentBlocks.find(
            b => b.type === "toolCall" && b.id === event.toolCallId
        );
        if (block && block.type === "toolCall") {
            block.status = event.isError ? "error" : "success";
            block.result = typeof event.result === "string"
                ? event.result
                : JSON.stringify(event.result);
            block.isError = event.isError;
        }
    }
    break;
}

// L917-923: createAgent 中的 addMessage — 系统消息
// system 消息也改成 PiMessage
this.addMessage(id, {
    id: uuidv4(),
    agentId: id,
    role: "system",
    contentBlocks: [{ type: "text", text: `Agent "${options.name}" ...` }],
    timestamp: Date.now(),
});
```

---

### Task 4: 更新 `App.tsx` — 移除 extract 函数，直接存储 content blocks

**文件:** `src/renderer/App.tsx`

**目标:**
1. `messages` 状态类型: `Record<string, PiMessage[]>`
2. `agent:message_start` — 直接存储 pi content blocks，不再 extract
3. `agent:message_update` — delta 追加到对应 block
4. `agent:message_end` — 最终 blocks 替换
5. `agent:tool_execution_*` — 更新对应 toolCall block 状态
6. 删除底部的 `extractText` / `extractThinking` / `extractToolCalls` 函数

**具体改动:**

```tsx
// L35: 状态类型
const [messages, setMessages] = useState<Record<string, PiMessage[]>>({});

// L182-201: agent:message_start
case "agent:message_start": {
    const msg = event.message as any;
    setMessages((prev) => {
        const msgs = [...(prev[event.agentId] ?? [])];
        // 直接使用 pi 的 content blocks，不转换
        const blocks: PiContentBlock[] = Array.isArray(msg.content)
            ? msg.content.map((b: any) => {
                if (b.type === "toolCall") {
                    return {
                        type: "toolCall",
                        id: b.id ?? "",
                        name: b.name ?? "unknown",
                        arguments: b.arguments ?? {},
                        status: "pending" as const,
                        result: "",
                        isError: false,
                    };
                }
                return { ...b, active: true }; // text/thinking block 标记 active
            })
            : [];
        const ui: PiMessage = {
            id: msg.id ?? `m_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
            agentId: event.agentId,
            role: msg.role ?? "assistant",
            contentBlocks: blocks,
            timestamp: msg.timestamp ?? Date.now(),
            isStreaming: true,
        };
        msgs.push(ui);
        return { ...prev, [event.agentId]: msgs };
    });
    break;
}

// L202-241: agent:message_update
case "agent:message_update": {
    const evt = event.assistantMessageEvent;
    setMessages((prev) => {
        const msgs = [...(prev[event.agentId] ?? [])];
        // 找到 streaming message
        const msgId = (event.message as any)?.id;
        let idx = msgId ? msgs.findIndex(m => m.id === msgId) : -1;
        if (idx < 0) {
            for (let i = msgs.length - 1; i >= 0; i--)
                if (msgs[i].isStreaming) { idx = i; break; }
        }
        if (idx < 0) return prev;
        const msg = msgs[idx];
        
        if (evt.type === "text_delta") {
            let block = msg.contentBlocks
                .filter(b => b.type === "text")
                .reverse()
                .find(b => b.active);
            if (!block) {
                const newBlock: PiContentBlock = { type: "text", text: "", active: true };
                msg.contentBlocks.push(newBlock);
                block = newBlock;
            }
            if (block.type === "text") block.text += evt.delta;
        } else if (evt.type === "thinking_delta") {
            let block = msg.contentBlocks
                .filter(b => b.type === "thinking")
                .reverse()
                .find(b => (b as PiThinkingBlock).active);
            if (!block) {
                const newBlock: PiContentBlock = { type: "thinking", thinking: "", active: true };
                msg.contentBlocks.push(newBlock);
                block = newBlock;
            }
            if (block.type === "thinking") block.thinking += evt.delta;
        } else if (evt.type === "text_end") {
            for (const b of msg.contentBlocks)
                if (b.type === "text" && b.active) b.active = false;
        } else if (evt.type === "thinking_end") {
            for (const b of msg.contentBlocks)
                if (b.type === "thinking" && b.active) b.active = false;
        } else if (evt.type === "toolcall_end") {
            const tc = (evt as any).toolCall;
            if (tc) {
                const newBlock: PiContentBlock = {
                    type: "toolCall",
                    id: tc.id ?? "",
                    name: tc.name ?? "unknown",
                    arguments: tc.arguments ?? {},
                    status: "pending",
                    result: "",
                    isError: false,
                };
                msg.contentBlocks.push(newBlock);
            }
        }
        
        msgs[idx] = { ...msg };
        return { ...prev, [event.agentId]: msgs };
    });
    break;
}

// L243-265: agent:message_end
case "agent:message_end": {
    const finalMsg = event.message as any;
    setMessages((prev) => {
        const msgs = [...(prev[event.agentId] ?? [])];
        let idx = msgs.length - 1;
        for (let i = msgs.length - 1; i >= 0; i--)
            if (msgs[i].isStreaming) { idx = i; break; }
        if (idx < 0) return prev;
        
        const blocks: PiContentBlock[] = Array.isArray(finalMsg.content)
            ? finalMsg.content.map((b: any) => {
                if (b.type === "toolCall") {
                    return {
                        type: "toolCall",
                        id: b.id ?? "",
                        name: b.name ?? "unknown",
                        arguments: b.arguments ?? {},
                        status: "success" as const,
                        result: "",
                        isError: false,
                    };
                }
                return { ...b, active: false };
            })
            : [];
        
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

// L267-333: tool_execution_*
// 与主进程逻辑对称：在 contentBlocks 中找到对应 toolCall block 更新状态
// ... (详细代码见 agent-manager Task 3 中的对应逻辑)

// 删除 L689-724: extractText, extractThinking, extractToolCalls 函数
```

---

### Task 5: 更新 `ChatPanel.tsx` — 基于 content blocks 的消息合并

**文件:** `src/renderer/components/ChatPanel.tsx`

**目标:**
1. Props 类型更新: `messages: PiMessage[]`
2. `displayMessages` useMemo 重写: 基于 `contentBlocks` 合并连续 assistant 消息
3. `attachToolResult` 重写: 在 contentBlocks 中找 toolCall block 挂 result

**具体改动:**

```tsx
import type { PiMessage, PiContentBlock, PiChunk, PiToolCallBlock } from "@shared/types";

interface ChatPanelProps {
    // ...
    messages: PiMessage[];
    // ...
}

const displayMessages = useMemo(() => {
    const merged: PiMessage[] = [];
    
    // Attach tool result to the first pending toolCall block
    function attachToolResult(resultText: string) {
        for (let i = merged.length - 1; i >= 0; i--) {
            const a = merged[i];
            if (a.role !== "assistant") continue;
            
            const chunks = a.assistantChunks;
            const blocks = chunks
                ? chunks.flatMap(c => c.contentBlocks)
                : a.contentBlocks;
            
            // Find first toolCall block with no result
            for (const b of blocks) {
                if (b.type === "toolCall" && !b.result) {
                    b.result = resultText;
                    // Don't mutate status — tool_execution_end handles that
                    return true;
                }
            }
        }
        return false;
    }
    
    for (const msg of messages) {
        if (msg.role === "tool") {
            const resultText = msg.contentBlocks
                .filter(b => b.type === "text")
                .map(b => (b as PiTextBlock).text)
                .join("\n");
            if (!resultText) continue;
            attachToolResult(resultText);
            continue;
        }
        
        const last = merged[merged.length - 1];
        
        if (last && last.role === "assistant" && msg.role === "assistant") {
            // 连续 assistant → 合并成 chunks
            const existingChunks: PiChunk[] = last.assistantChunks ?? [
                { contentBlocks: [...last.contentBlocks] },
            ];
            existingChunks.push({ contentBlocks: [...msg.contentBlocks] });
            
            merged[merged.length - 1] = {
                ...last,
                contentBlocks: existingChunks.flatMap(c => c.contentBlocks),
                assistantChunks: existingChunks,
                isStreaming: msg.isStreaming ?? last.isStreaming,
            };
        } else {
            merged.push(msg);
        }
    }
    
    // 隐藏队列消息（逻辑不变）
    const hideCount = queue.steering.length + queue.followUp.length;
    // ...
    return merged;
}, [messages, queue.steering.length, queue.followUp.length]);
```

---

### Task 6: 更新 `MessageBubble.tsx` — 按 content block type 渲染

**文件:** `src/renderer/components/MessageBubble.tsx`

**目标:** 不再读取 `message.content` / `message.thinking` / `message.toolCalls`，改为遍历 `message.contentBlocks` 或 `chunk.contentBlocks`，按 type 渲染。

**具体改动:**

```tsx
import type { PiMessage, PiContentBlock, PiChunk, AgentRole } from "@shared/types";
import type { PiTextBlock, PiThinkingBlock, PiToolCallBlock } from "@shared/types";

interface MessageBubbleProps {
    message: PiMessage;
    agentRole?: AgentRole;
    agentName?: string;
}

// 渲染一个 content block 数组
function renderBlocks(
    blocks: PiContentBlock[],
    isStreaming: boolean,
): React.ReactNode {
    const content: React.ReactNode[] = [];
    
    for (const block of blocks) {
        if (block.type === "thinking") {
            content.push(<ThinkingPanel key={block.thinking?.slice(0, 20)} thinking={block.thinking} />);
        } else if (block.type === "toolCall") {
            content.push(
                <ToolCallCard
                    key={block.id || `tc-${block.name}-${JSON.stringify(block.arguments).slice(0, 40)}`}
                    toolCall={{
                        callId: block.id,
                        toolName: block.name,
                        args: block.arguments,
                        status: block.status,
                        result: block.result ?? "",
                        isError: block.isError ?? false,
                    }}
                />
            );
        } else if (block.type === "text" && block.text) {
            content.push(
                <SkillAwareContent key={block.text.slice(0, 40)} content={block.text} isStreaming={isStreaming} />
            );
        }
    }
    
    return <>{content}</>;
}

// MessageBubble 内部
const MessageBubble = memo(function MessageBubble({ message, agentRole, agentName }: MessageBubbleProps) {
    // ...
    
    // assistantChunks 存在时
    if (message.assistantChunks && message.assistantChunks.length > 0) {
        return (
            // ... avatar, label 保持不变 ...
            <div className="flex flex-col gap-3">
                {message.assistantChunks.map((chunk, ci) => (
                    <div key={ci} className={cn("whisper-bubble ...", ci === last && "border-l-2 border-primary/30")}>
                        <ExecutionProcess
                            thinking={blocksToThinking(chunk.contentBlocks)}
                            toolCalls={blocksToToolCallSummary(chunk.contentBlocks)}
                            hasOutput={chunk.contentBlocks.some(b => b.type === "text" && !!(b as PiTextBlock).text)}
                        >
                            {chunk.contentBlocks
                                .filter(b => b.type === "thinking")
                                .map(b => (
                                    <ThinkingPanel key={(b as PiThinkingBlock).thinking.slice(0, 20)} thinking={(b as PiThinkingBlock).thinking} />
                                ))
                            }
                            {chunk.contentBlocks
                                .filter(b => b.type === "toolCall")
                                .map(b => (
                                    <ToolCallCard key={(b as PiToolCallBlock).id || `tc-${(b as PiToolCallBlock).name}`} toolCall={...} />
                                ))
                            }
                        </ExecutionProcess>
                        {chunk.contentBlocks
                            .filter(b => b.type === "text")
                            .map(b => (
                                <SkillAwareContent key={(b as PiTextBlock).text.slice(0, 40)} content={(b as PiTextBlock).text} isStreaming={isStreaming && ci === last} />
                            ))
                        }
                    </div>
                ))}
            </div>
        );
    }
    
    // 无 chunks — 直接渲染 contentBlocks
    // ... (类似上面的单层渲染)
});
```

---

### Task 7: 更新 `ExecutionProcess.tsx` — props 适配

**文件:** `src/renderer/components/ExecutionProcess.tsx`

**目标:** Props 中的 `toolCalls` 已由 `ToolCallRecord[]` → `PiToolCallBlock[]` 风格的简化数组，接口兼容。

**改动:** 无需改动。`ExecutionProcess` 只用了 `{ callId, toolName, status }` 三个字段，`PiToolCallBlock` 都有。

---

### Task 8: 更新 `PiMessage` 添加 `assistantChunks` 字段

**文件:** `src/main/shared/types.ts`

**目标:** 在 `PiMessage` 上加 `assistantChunks?: PiChunk[]`。

```ts
export interface PiMessage {
    // ... existing fields ...
    /** 多步推理: 连续 assistant 消息合并后的 chunk 列表 */
    assistantChunks?: PiChunk[];
}
```

---

### Task 9: 清理旧类型 — 移除 `AgentMessage` / `ToolCallRecord`

**文件:** `src/main/shared/types.ts`

**步骤:**
1. 搜索项目中所有 `AgentMessage` / `ToolCallRecord` 引用 → 替换为 `PiMessage` / `PiToolCallBlock`
2. 确认无引用后删除这两个 interface 定义
3. 确认编译通过

---

### Task 10: 端到端验证

**验证步骤:**
1. `npm run check` — TypeScript 编译 + lint
2. 启动 app → 创建 chat agent → 发送消息 → 确认消息正确显示
3. 创建 orchestrator → spawn coder agent → 确认跨 agent 消息正确显示
4. 发送带 tool call 的消息 → 确认 thinking/toolCall 正确显示在 ExecutionProcess 中
5. 关闭重启 app → 确认历史消息正确恢复

---

## 影响的文件清单

| 文件 | 改动类型 | 说明 |
|------|---------|------|
| `src/main/shared/types.ts` | 重构 | 新增 `PiContentBlock` 等类型，后续删除 `AgentMessage` |
| `src/main/shared/message-convert.ts` | 重写 | 改为 pass-through |
| `src/main/agent-manager.ts` | 修改 | 消息存储类型 + 事件处理逻辑 |
| `src/renderer/App.tsx` | 重构 | 状态类型 + 事件处理 + 删除 extract 函数 |
| `src/renderer/components/ChatPanel.tsx` | 重写 | `displayMessages` + `attachToolResult` |
| `src/renderer/components/MessageBubble.tsx` | 重写 | 按 content block type 渲染 |
| `src/renderer/components/ExecutionProcess.tsx` | 不变 | 接口兼容 |
| `src/renderer/components/ToolCallCard.tsx` | 不变 | 接口兼容 |
| `src/renderer/components/ThinkingPanel.tsx` | 不变 | 接口兼容 |
| `src/renderer/components/StreamingMarkdown.tsx` | 不变 | 接口兼容 |
| `src/main/index.ts` | 不变 | 接口兼容（仅类型推断变化） |
| `src/main/ipc-handlers.ts` | 不变 | 接口兼容 |

---

## 风险 & 注意事项

1. **ToolCall id 在 streaming 中的时机**: `toolcall_start` 时 pi SDK 可能还没有完整的 `id`。当前实现在 `toolcall_end` 时才拿到完整对象。`tool_execution_start` 事件带 `toolCallId`，需要在 pending 状态的 block 中通过 name+arguments 或其他方式匹配。建议在 `toolcall_end` 后立即补充 id。

2. **Content index 处理**: `AssistantMessageEvent` 中的 `contentIndex` 告诉我们 delta 属于哪个 block。当前计划用 "最后一个 active block" 来匹配，更精确的做法是用 `contentIndex` 直接定位。建议在重构时支持。

3. **向后兼容**: 旧的 session JSONL 文件由 pi SDK 管理，格式不变。`convertPiMessage` 仍然处理恢复场景，只是不再 flatten。

4. **assistantChunks 不变**: ChatPanel 的合并逻辑保持，只是现在合并的是 `contentBlocks` 而不是 `content + thinking + toolCalls` 三个分离字段。

---

## 核心设计原则

- **不做转换**: pi SDK content blocks 直接存储，不做 extract/flatten
- **运行时状态附在 block 上**: toolCall 的 status/result/isError 作为 `PiToolCallBlock` 的扩展字段
- **Streaming delta 追加到最后一个 active block**: text_delta → 最后一个 active text block, thinking_delta → 最后一个 active thinking block
- **UI 渲染按照 block type 分发**: thinking → ThinkingPanel, toolCall → ToolCallCard, text → SkillAwareContent/StreamingMarkdown
- **保留 assistantChunks 合并机制**: pi SDK 连续多个 assistant 消息合并为一个逻辑消息单元的现有行为不变
