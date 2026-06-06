# 消息管道重构：消除 AgentMessage 中间层，直接使用 pi SDK Content Blocks

> 规划日期: 2026-06-06
> 项目: Look (基于 pi SDK 的多 Agent 桌面应用)

---

## 目标

消除 `AgentMessage` UI 格式转换层（`extractText` / `extractThinking` / `extractToolCalls`），
渲染器和主进程直接使用 pi SDK 原生的 content blocks `[{type:"text",text}, {type:"thinking",thinking}, {type:"toolCall",id,name,arguments}]`
作为消息规范格式。toolCall 和 thinking 保持当前 UI 设计样式不变。

## 架构对比

```
【现在】pi content blocks → extract/flatten → AgentMessage {content, thinking, toolCalls[]} → UI
【目标】pi content blocks → 直接存储为 PiMessage.contentBlocks → UI（按 type 分发渲染）
```

## 不改动的文件

| 文件 | 原因 |
|------|------|
| `ExecutionProcess.tsx` | 只用 `{callId, toolName, status}`，`PiToolCallBlock` 都有 |
| `ToolCallCard.tsx` | 接口不变，只是数据来源变了 |
| `ThinkingPanel.tsx` | 只读 `thinking: string`，不变 |
| `StreamingMarkdown.tsx` | 只读 `content: string`，不变 |
| `SkillAwareContent.tsx` | 只读 `content: string`，不变 |
| `ContextRing.tsx` | 不涉及消息结构 |
| `PermissionDialog.tsx` | 不涉及消息结构 |
| `Sidebar.tsx` | 只读 `AgentInfo`，不变 |
| `index.ts` (main) | 接口兼容 |
| `ipc-handlers.ts` | 接口兼容 |
| `roles.ts`, `permission-gate.ts`, `orchestration.ts` | 不涉及消息结构 |

---

## Task 1: types.ts — 新增 PiContentBlock 体系类型

**文件**: `src/main/shared/types.ts`

**操作**: 在 `AssistantChunk` 定义之前（约 L95）插入新类型体系。

### 1.1 新增 PiContentBlock 类型体系

在 L95 之前插入：

```ts
// ============================================================
// Pi Content Block Types — directly map pi SDK content blocks
//
// pi SDK (pi-ai/dist/types.d.ts):
//   TextContent     = { type:"text",     text: string }
//   ThinkingContent = { type:"thinking", thinking: string, redacted?: bool }
//   ToolCall        = { type:"toolCall", id:string, name:string, arguments:Record<string,any> }
//   ToolResultMessage = { role:"toolResult", toolCallId, toolName, content, isError, ... }
//
// Our Pi* types add runtime state fields (status, result, isError)
// for toolCall blocks, and an `active` flag for streaming blocks.
// ============================================================

/** pi SDK text block + streaming flag */
export interface PiTextBlock {
    type: "text";
    text: string;
    /** true while text_delta is still arriving for this block */
    active?: boolean;
}

/** pi SDK thinking block + streaming flag */
export interface PiThinkingBlock {
    type: "thinking";
    thinking: string;
    redacted?: boolean;
    /** true while thinking_delta is still arriving for this block */
    active?: boolean;
}

/** pi SDK toolCall block + runtime state injected by tool_execution events */
export interface PiToolCallBlock {
    type: "toolCall";
    id: string;
    name: string;
    arguments: Record<string, any>;
    /** Runtime: pending → running → success|error */
    status: "pending" | "running" | "success" | "error";
    /** Tool execution output (filled by tool_execution_end or toolResult restore) */
    result?: string;
    /** Whether the tool execution errored */
    isError?: boolean;
}

/** Union of all pi content block types with runtime extensions */
export type PiContentBlock = PiTextBlock | PiThinkingBlock | PiToolCallBlock;

/**
 * Replaces AgentMessage. Stores pi SDK content blocks directly,
 * without extract/flatten. Tool execution state is on the blocks.
 */
export interface PiMessage {
    id: string;
    agentId: string;
    role: "user" | "assistant" | "tool" | "system";
    /** pi SDK native content blocks (not flattened) */
    contentBlocks: PiContentBlock[];
    timestamp: number;
    isStreaming?: boolean;
    /** Token usage (assistant messages only) */
    usage?: UsageSnapshot;
    /**
     * ChatPanel display-time merge: consecutive assistant PiMessages
     * become PiChunks under a single merged PiMessage.
     */
    assistantChunks?: PiChunk[];
}

/** One reasoning step within a merged multi-turn assistant reply */
export interface PiChunk {
    contentBlocks: PiContentBlock[];
}
```

### 1.2 标记旧类型为 @deprecated

在 `AgentMessage` (约 L103) 和 `ToolCallRecord` (约 L119) 上方各加一行：

```ts
/** @deprecated Use PiMessage instead. Will be removed in Task 7. */
export interface AgentMessage {
```

```ts
/** @deprecated Use PiToolCallBlock instead. Will be removed in Task 7. */
export interface ToolCallRecord {
```

### 1.3 更新 PiMessage 需要新增 `piMessage` 到 MainToRendererEvent

`agent:message_start`、`agent:message_update`、`agent:message_end` 的 payload 中 `message` 字段最终会变成 `PiMessage`（中间阶段可以是 `any`）。

---

## Task 2: message-convert.ts — 重写为 pass-through

**文件**: `src/main/shared/message-convert.ts` (L1-105)

**操作**: 全部替换。

```ts
import type { PiContentBlock, PiMessage, UsageSnapshot } from "./types.js";

/**
 * Convert a pi SDK message into PiMessage.
 * No extraction/flattening — content blocks pass through directly.
 *
 * pi SDK message shapes (from pi-ai/dist/types.d.ts):
 *   UserMessage:      { role:"user", content: string | (TextContent|ImageContent)[] }
 *   AssistantMessage: { role:"assistant", content: (TextContent|ThinkingContent|ToolCall)[], usage }
 *   ToolResultMessage:{ role:"toolResult", toolCallId, toolName, content, isError }
 */
export function convertPiMessage(piMsg: any, agentId: string, msgId: string): PiMessage {
    const piRole: string = piMsg.role ?? "";

    // ── User message ──
    if (piRole === "user") {
        const text = typeof piMsg.content === "string"
            ? piMsg.content
            : Array.isArray(piMsg.content)
                ? piMsg.content
                    .filter((b: any) => b.type === "text")
                    .map((b: any) => b.text)
                    .join("\n")
                : "";
        return {
            id: msgId,
            agentId,
            role: "user",
            contentBlocks: [{ type: "text", text }],
            timestamp: piMsg.timestamp ?? Date.now(),
        };
    }

    // ── Assistant message ──
    if (piRole === "assistant") {
        const blocks: PiContentBlock[] = Array.isArray(piMsg.content)
            ? piMsg.content.map((b: any): PiContentBlock => {
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
                // text, thinking — pass through as-is, mark non-streaming
                return { ...b, active: false };
            })
            : [];

        return {
            id: msgId,
            agentId,
            role: "assistant",
            contentBlocks: blocks,
            timestamp: piMsg.timestamp ?? Date.now(),
            usage: piMsg.usage ? usageFromPi(piMsg.usage) : undefined,
        };
    }

    // ── Tool result ──
    if (piRole === "toolResult") {
        const text = Array.isArray(piMsg.content)
            ? piMsg.content
                .filter((b: any) => b.type === "text")
                .map((b: any) => b.text)
                .join("\n")
            : (typeof piMsg.content === "string" ? piMsg.content : "");
        return {
            id: msgId,
            agentId,
            role: "tool",
            contentBlocks: [{ type: "text", text }],
            timestamp: piMsg.timestamp ?? Date.now(),
            // Attach toolResult metadata so the restore path can patch the toolCall block
            ...({ _toolCallId: piMsg.toolCallId, _toolName: piMsg.toolName, _isError: piMsg.isError } as any),
        };
    }

    // ── Fallback (system, custom, etc.) ──
    return {
        id: msgId,
        agentId,
        role: "system",
        contentBlocks: typeof piMsg.content === "string"
            ? [{ type: "text", text: piMsg.content }]
            : Array.isArray(piMsg.content)
                ? piMsg.content.map((b: any) => ({ ...b }))
                : [{ type: "text", text: JSON.stringify(piMsg.content ?? piMsg) }],
        timestamp: piMsg.timestamp ?? Date.now(),
    };
}

/** Convert pi SDK Usage to Look's UsageSnapshot */
function usageFromPi(u: any): UsageSnapshot {
    return {
        inputTokens: u.input ?? 0,
        outputTokens: u.output ?? 0,
        cacheReadTokens: u.cacheRead ?? 0,
        cacheWriteTokens: u.cacheWrite ?? 0,
        totalTokens: u.totalTokens ?? 0,
        cost: {
            input: u.cost?.input ?? 0,
            output: u.cost?.output ?? 0,
            cacheRead: u.cost?.cacheRead ?? 0,
            cacheWrite: u.cost?.cacheWrite ?? 0,
            total: u.cost?.total ?? 0,
        },
    };
}
```

---

## Task 3: agent-manager.ts — 消息存储和事件处理改用 content blocks

**文件**: `src/main/agent-manager.ts` (1664 行)

### 3.1 类型声明更新

**L95-103**: `ManagedAgent` 中 `messages` 类型改为 `PiMessage[]`:

```ts
interface ManagedAgent {
    info: AgentInfo;
    session: AgentSession;
    messages: PiMessage[];  // ← changed from AgentMessage[]
    unsubscribe: () => void;
    resolveWaits?: (() => void)[];
    permissionMode: PermissionMode;
}
```

### 3.2 import 更新

**L36-48**: `convertPiMessage` 返回类型已变；import `PiMessage`/`PiContentBlock` 等:

```ts
import { convertPiMessage } from "./shared/message-convert.js";
import type {
    AgentInfo,
    AgentMessage,      // ← keep for AgentInfo (unchanged outer struct)
    AgentRole,
    AgentStatus,
    ContextUsageInfo,
    MainToRendererEvent,
    PermissionMode,
    PiMessage,         // ← new
    PiContentBlock,    // ← new
    PiTextBlock,       // ← new
    PiThinkingBlock,   // ← new
    PiToolCallBlock,   // ← new
    TaskNode,
    ThinkingLevel,
    UsageSnapshot,
} from "./shared/types.js";
```

### 3.3 loadPersistedAgents — 恢复路径

**L236-249**: `uiMessages` 类型和 convertPiMessage 调用:

```ts
const uiMessages: PiMessage[] = [];  // ← changed from AgentMessage[]
for (const e of branch) {
    if (e.type !== "message") continue;
    const msg = e.message;
    if (
        msg.role === "bashExecution" ||
        msg.role === "custom" ||
        msg.role === "branchSummary" ||
        msg.role === "compactionSummary"
    )
        continue;
    uiMessages.push(convertPiMessage(msg, id, e.id));
}
```

**新增**: 遍历完后，对 `toolResult` 消息补充 toolCall block 的运行时状态:

```ts
// After the for loop, patch toolCall blocks with results from toolResult messages.
// pi SDK records isError in ToolResultMessage — we backfill it into the
// toolCall block so the restored UI shows correct status immediately.
for (const msg of uiMessages) {
    if (msg.role !== "tool") continue;
    const tcId = (msg as any)._toolCallId as string | undefined;
    const isError = (msg as any)._isError as boolean | undefined;
    if (!tcId) continue;

    // Walk backwards through assistant messages to find the matching toolCall block
    for (let i = uiMessages.length - 1; i >= 0; i--) {
        const am = uiMessages[i];
        if (am.role !== "assistant") continue;
        const block = am.contentBlocks.find(
            (b): b is PiToolCallBlock => b.type === "toolCall" && b.id === tcId
        );
        if (!block) continue;
        block.result = msg.contentBlocks
            .filter(b => b.type === "text")
            .map(b => (b as PiTextBlock).text)
            .join("\n");
        block.isError = isError ?? false;
        block.status = isError ? "error" : "success";
        break;
    }
}
```

**L286-306**: usage 重计算（`PiMessage.usage` 在顶层，不在 blocks 里）:

```ts
const cumUsage: UsageSnapshot = { ...EMPTY_USAGE };
let hasMessageUsage = false;
for (const msg of uiMessages) {
    if (msg.role !== "assistant" || !msg.usage) continue;
    hasMessageUsage = true;
    const u = msg.usage;
    cumUsage.inputTokens += u.inputTokens;
    // ... 其余不变 ...
    cumUsage.cost.total += u.cost.total;
}
```

### 3.4 handleLookSideEffect — message_start

**L1278-1286**: 不变（只 break）。

### 3.5 handleLookSideEffect — message_update (delta 处理)

**L1288-1300**: 重写为直接追加到对应的 content block:

```ts
case "message_update": {
    const evt = event.assistantMessageEvent;
    if (!evt) break;
    const sm = [...m.messages].reverse().find((x) => x.isStreaming);
    if (!sm) break;

    if (evt.type === "text_delta") {
        // Find last active text block, or create one
        let block = [...sm.contentBlocks].reverse().find(
            (b): b is PiTextBlock => b.type === "text" && b.active
        ) as PiTextBlock | undefined;
        if (!block) {
            block = { type: "text", text: "", active: true };
            sm.contentBlocks.push(block);
        }
        block.text += evt.delta;
    } else if (evt.type === "thinking_delta") {
        let block = [...sm.contentBlocks].reverse().find(
            (b): b is PiThinkingBlock => b.type === "thinking" && b.active
        ) as PiThinkingBlock | undefined;
        if (!block) {
            block = { type: "thinking", thinking: "", active: true };
            sm.contentBlocks.push(block);
        }
        block.thinking += evt.delta;
    } else if (evt.type === "text_end") {
        for (const b of sm.contentBlocks) {
            if (b.type === "text" && b.active) (b as PiTextBlock).active = false;
        }
    } else if (evt.type === "thinking_end") {
        for (const b of sm.contentBlocks) {
            if (b.type === "thinking" && b.active) (b as PiThinkingBlock).active = false;
        }
    } else if (evt.type === "toolcall_end") {
        const tc = (evt as any).toolCall;
        if (tc) {
            // Find a pending toolCall block without an id, or create one
            let block = sm.contentBlocks.find(
                (b): b is PiToolCallBlock => 
                    b.type === "toolCall" && b.status === "pending" && !b.id
            ) as PiToolCallBlock | undefined;
            if (!block) {
                block = {
                    type: "toolCall",
                    id: tc.id ?? "",
                    name: tc.name ?? "unknown",
                    arguments: tc.arguments ?? {},
                    status: "pending",
                    result: "",
                    isError: false,
                };
                sm.contentBlocks.push(block);
            } else {
                block.id = tc.id ?? block.id;
                block.name = tc.name ?? block.name;
                block.arguments = tc.arguments ?? block.arguments;
            }
        }
    }
    break;
}
```

### 3.6 handleLookSideEffect — message_end

**L1301-1344**: 更新 message_end 的 m.messages 写入:

```ts
case "message_end": {
    const msg = event.message;
    if (msg && (msg.role === "user" || msg.role === "assistant" || msg.role === "toolResult")) {
        const realId = (msg as any).id ?? `m_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
        if (!m.messages.some((x) => x.id === realId)) {
            this.addMessage(agentId, convertPiMessage(msg, agentId, realId));
        }
    }
    if (msg?.role === "assistant" && msg.usage) this.trackUsage(agentId, msg.usage);

    m.info.messageCount = m.messages.length;

    // sessionFile commit + context ring — unchanged
    const sessionFile = m.session.sessionFile;
    if (sessionFile && fs.existsSync(sessionFile)) {
        this.saveIndex();
    }
    const ctx = this.getContextUsage(agentId);
    if (ctx) this.emit({ type: "agent:context-usage", agentId, usage: ctx });
    break;
}
```

### 3.7 handleLookSideEffect — tool_execution_start

**L1346-1387**: 更新为直接操作 content block:

```ts
case "tool_execution_start": {
    this.updateStatus(agentId, "working");
    const sm = [...m.messages].reverse().find(
        (x) => x.isStreaming && x.role === "assistant"
    ) ?? [...m.messages].reverse().find((x) => x.role === "assistant");
    if (sm) {
        // Find matching toolCall block: by id, or by pending state
        let block = sm.contentBlocks.find(
            (b): b is PiToolCallBlock =>
                b.type === "toolCall" && (b.id === event.toolCallId || (b.status === "pending" && !b.id))
        ) as PiToolCallBlock | undefined;
        if (!block) {
            block = {
                type: "toolCall",
                id: event.toolCallId,
                name: event.toolName,
                arguments: event.args ?? {},
                status: "running",
                result: "",
                isError: false,
            };
            sm.contentBlocks.push(block);
        } else {
            block.status = "running";
            block.name = event.toolName || block.name;
            if (event.args) block.arguments = event.args;
        }
    }

    // Permission gate — unchanged
    const perm = checkPermission(event.toolName, event.args ?? {}, m.info.role);
    if (perm.action === "deny") {
        (this.blockedToolCalls.get(agentId) ?? 
         this.blockedToolCalls.set(agentId, new Set()).get(agentId)!).add(event.toolCallId);
        this.emit({
            type: "agent:tool_execution_end",
            agentId,
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            result: { content: [{ type: "text", text: `BLOCKED: ${perm.reason}` }] },
            isError: true,
        });
    }
    break;
}
```

### 3.8 handleLookSideEffect — tool_execution_end

**L1388-1402**: 更新:

```ts
case "tool_execution_end": {
    const sm = [...m.messages].reverse().find(
        (x) => x.role === "assistant" &&
            x.contentBlocks.some(
                (b): b is PiToolCallBlock => b.type === "toolCall" && b.id === event.toolCallId
            )
    );
    if (sm) {
        const block = sm.contentBlocks.find(
            (b): b is PiToolCallBlock => b.type === "toolCall" && b.id === event.toolCallId
        );
        if (block) {
            block.status = event.isError ? "error" : "success";
            block.result = typeof event.result === "string"
                ? event.result
                : JSON.stringify(event.result);
            block.isError = event.isError;
        }
    }
    break;
}
```

### 3.9 createAgent — 系统消息

**L917-923**: `addMessage` 调用:

```ts
this.addMessage(id, {
    id: uuidv4(),
    agentId: id,
    role: "system",
    contentBlocks: [{ type: "text", text: `Agent "${options.name}" [${options.role}] started. Model: ${resolvedId}, Thinking: ${thinkingLevel}${fallbackNote}${modelWarn}` }],
    timestamp: Date.now(),
});
```

### 3.10 addMessage — 类型签名

**L1510-1515**: 参数类型:

```ts
private addMessage(agentId: string, msg: PiMessage): void {
    // ... body unchanged ...
}
```

### 3.11 getMessages / listAgentsWithHistory — 返回类型

**L1001-1011**: 返回类型自动推导，代码不变。

---

## Task 4: App.tsx — 状态管理和事件处理改用 content blocks

**文件**: `src/renderer/App.tsx` (724 行)

### 4.1 import 更新

**L5**: 添加 Pi 类型 import:

```ts
import type { AgentInfo, AgentMessage, MainToRendererEvent, PiContentBlock, PiMessage, PiTextBlock, PiThinkingBlock, PiToolCallBlock, ThinkingLevel, ToolCallRecord } from "@shared/types";
```

### 4.2 状态类型

**L35**: `messages` 状态:

```ts
const [messages, setMessages] = useState<Record<string, PiMessage[]>>({});
```

### 4.3 agent:message_start handler

**L182-200**: 重写为直接用 pi content blocks:

```ts
case "agent:message_start": {
    const msg = event.message as any;
    setMessages((prev) => {
        const msgs = [...(prev[event.agentId] ?? [])];
        const blocks: PiContentBlock[] = Array.isArray(msg.content)
            ? msg.content.map((b: any): PiContentBlock => {
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
                return { ...b, active: true };
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
```

### 4.4 agent:message_update handler

**L202-241**: 重写为直接操作 block:

```ts
case "agent:message_update": {
    const evt = event.assistantMessageEvent;
    setMessages((prev) => {
        const msgs = [...(prev[event.agentId] ?? [])];
        const msgId = (event.message as any)?.id;
        let idx = msgId ? msgs.findIndex(m => m.id === msgId) : -1;
        if (idx < 0) {
            for (let i = msgs.length - 1; i >= 0; i--)
                if (msgs[i].isStreaming) { idx = i; break; }
        }
        if (idx < 0) return prev;
        const msg = { ...msgs[idx], contentBlocks: [...msgs[idx].contentBlocks] };

        if (evt.type === "text_delta") {
            let block = [...msg.contentBlocks].reverse().find(
                (b): b is PiTextBlock => b.type === "text" && b.active
            ) as PiTextBlock | undefined;
            if (!block) {
                block = { type: "text", text: "", active: true };
                msg.contentBlocks.push(block);
            }
            block.text += evt.delta;
        } else if (evt.type === "thinking_delta") {
            let block = [...msg.contentBlocks].reverse().find(
                (b): b is PiThinkingBlock => b.type === "thinking" && b.active
            ) as PiThinkingBlock | undefined;
            if (!block) {
                block = { type: "thinking", thinking: "", active: true };
                msg.contentBlocks.push(block);
            }
            block.thinking += evt.delta;
        } else if (evt.type === "text_end") {
            for (const b of msg.contentBlocks)
                if (b.type === "text" && b.active) (b as PiTextBlock).active = false;
        } else if (evt.type === "thinking_end") {
            for (const b of msg.contentBlocks)
                if (b.type === "thinking" && b.active) (b as PiThinkingBlock).active = false;
        } else if (evt.type === "toolcall_end") {
            const tc = (evt as any).toolCall;
            if (tc) {
                const block: PiToolCallBlock = {
                    type: "toolCall",
                    id: tc.id ?? "",
                    name: tc.name ?? "unknown",
                    arguments: tc.arguments ?? {},
                    status: "pending",
                    result: "",
                    isError: false,
                };
                msg.contentBlocks.push(block);
            }
        }

        msgs[idx] = msg;
        return { ...prev, [event.agentId]: msgs };
    });
    break;
}
```

### 4.5 agent:message_end handler

**L243-265**: 重写:

```ts
case "agent:message_end": {
    const finalMsg = event.message as any;
    setMessages((prev) => {
        const msgs = [...(prev[event.agentId] ?? [])];
        let idx = msgs.length - 1;
        for (let i = msgs.length - 1; i >= 0; i--)
            if (msgs[i].isStreaming) { idx = i; break; }
        if (idx < 0) return prev;

        const blocks: PiContentBlock[] = Array.isArray(finalMsg.content)
            ? finalMsg.content.map((b: any): PiContentBlock => {
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
```

### 4.6 agent:tool_execution_* handlers

**L267-333**: 重写为操作 content blocks:

```ts
case "agent:tool_execution_start":
case "agent:tool_execution_update":
case "agent:tool_execution_end": {
    setMessages((prev) => {
        const msgs = [...(prev[event.agentId] ?? [])];
        let idx = msgs.length - 1;
        for (let i = msgs.length - 1; i >= 0; i--)
            if (msgs[i].isStreaming) { idx = i; break; }
        if (idx < 0) return prev;
        const msg = { ...msgs[idx], contentBlocks: [...msgs[idx].contentBlocks] };
        const callId = event.toolCallId;

        if (event.type === "agent:tool_execution_start") {
            let block = msg.contentBlocks.find(
                (b): b is PiToolCallBlock =>
                    b.type === "toolCall" && (b.id === callId || (b.status === "pending" && !b.id))
            ) as PiToolCallBlock | undefined;
            if (!block) {
                block = {
                    type: "toolCall",
                    id: callId,
                    name: event.toolName,
                    arguments: event.args ?? {},
                    status: "running",
                    result: "",
                    isError: false,
                };
                msg.contentBlocks.push(block);
            } else {
                block.status = "running";
                block.name = event.toolName || block.name;
                block.arguments = event.args ?? block.arguments;
            }
        } else if (event.type === "agent:tool_execution_update") {
            const partial = (event.partialResult as any)?.content?.[0]?.text ?? "";
            const block = msg.contentBlocks.find(
                (b): b is PiToolCallBlock => b.type === "toolCall" && b.id === callId
            );
            if (block) block.result = (block.result ?? "") + partial;
        } else {
            // tool_execution_end
            const resultStr = typeof event.result === "string"
                ? event.result
                : ((event.result as any)?.content?.[0]?.text ?? JSON.stringify(event.result));
            const block = msg.contentBlocks.find(
                (b): b is PiToolCallBlock => b.type === "toolCall" && b.id === callId
            );
            if (block) {
                block.status = event.isError ? "error" : "success";
                block.result = resultStr;
                block.isError = event.isError;
            }
        }

        msgs[idx] = msg;
        return { ...prev, [event.agentId]: msgs };
    });
    break;
}
```

### 4.7 删除 extract 函数

**L689-724**: 删除 `extractText`, `extractThinking`, `extractToolCalls`。

---

## Task 5: ChatPanel.tsx — displayMessages 基于 content blocks 重写

**文件**: `src/renderer/components/ChatPanel.tsx` (506 行)

### 5.1 import 更新

**L8**: 类型 import:

```ts
import type { AgentMessage, AgentRole, AgentStatus, PermissionMode, PiContentBlock, PiMessage, PiToolCallBlock } from "@shared/types";
```

### 5.2 Props 类型更新

**L24**: `messages` prop:

```ts
messages: PiMessage[];
```

### 5.3 displayMessages useMemo — attachToolResult 重写

**L200-233**: 替换 `attachToolResult`:

```ts
/** Attach a tool result to the first toolCall block with no result.
 *  Searches backwards through merged[], then forward through content blocks
 *  so the earliest pending toolCall gets its result first. */
function attachToolResult(resultText: string) {
    for (let i = merged.length - 1; i >= 0; i--) {
        const a = merged[i];
        if (a.role !== "assistant") continue;

        // Search through chunks (if multi-chunk merged) or flat contentBlocks
        const allBlocks = a.assistantChunks
            ? a.assistantChunks.flatMap(c => c.contentBlocks)
            : a.contentBlocks;

        for (const b of allBlocks) {
            if (b.type === "toolCall" && !b.result) {
                b.result = resultText;
                return true;
            }
        }
    }
    return false;
}
```

### 5.4 displayMessages useMemo — 主循环重写

**L235-290**: 替换消息合并逻辑:

```ts
for (const msg of messages) {
    if (msg.role === "tool") {
        const resultText = msg.contentBlocks
            .filter(b => b.type === "text")
            .map(b => (b as any).text ?? "")
            .join("\n");
        if (!resultText) continue;
        attachToolResult(resultText);
        continue;
    }

    const last = merged[merged.length - 1];

    if (last && last.role === "assistant" && msg.role === "assistant") {
        // ── Consecutive assistant → push as new chunk ──
        const existingChunks = last.assistantChunks ?? [
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
```

### 5.5 displayMessages 返回

**L293-306**: `hideCount` 逻辑不变。

---

## Task 6: MessageBubble.tsx — 按 content block type 渲染

**文件**: `src/renderer/components/MessageBubble.tsx` (137 行)

### 6.1 import 更新

**L6**: 类型 import:

```ts
import type { AgentRole, PiContentBlock, PiMessage, PiTextBlock, PiThinkingBlock, PiToolCallBlock } from "@shared/types";
```

### 6.2 Props 类型

**L16**: `message` prop:

```ts
message: PiMessage;
```

### 6.3 辅助函数: block → ToolCallCard props

在组件定义之前新增:

```ts
/** Convert PiToolCallBlock to the shape ToolCallCard expects */
function toToolCallRecord(b: PiToolCallBlock) {
    return {
        callId: b.id,
        toolName: b.name,
        args: b.arguments,
        status: b.status,
        result: b.result ?? "",
        isError: b.isError ?? false,
    };
}
```

### 6.4 system 消息渲染

**L25-33**: 改为读 `contentBlocks`:

```ts
if (isSystem) {
    const text = message.contentBlocks
        .filter(b => b.type === "text")
        .map(b => (b as PiTextBlock).text)
        .join(" ");
    return (
        <div className="flex justify-center py-1">
            <span className="...">
                <Settings2 className="size-3" />
                <span className="truncate">{text}</span>
            </span>
        </div>
    );
}
```

### 6.5 user 消息渲染

**L36+**: user 消息只有 text block，读第一个:

```tsx
// user 消息: 取第一个 text block 的 text
const userText = message.contentBlocks
    .filter(b => b.type === "text")
    .map(b => (b as PiTextBlock).text)
    .join("");
```

User 消息路径中 `message.content` 替换为 `userText`。

### 6.6 assistantChunks 路径

**L60-99**: 重写为按 block type 渲染:

```tsx
{message.assistantChunks && message.assistantChunks.length > 0 ? (
    <div className="flex flex-col gap-3">
        {message.assistantChunks.map((chunk, ci) => {
            const isLastChunk = ci === message.assistantChunks!.length - 1;
            const thinkingBlocks = chunk.contentBlocks.filter(b => b.type === "thinking") as PiThinkingBlock[];
            const toolCallBlocks = chunk.contentBlocks.filter(b => b.type === "toolCall") as PiToolCallBlock[];
            const textBlocks = chunk.contentBlocks.filter(b => b.type === "text") as PiTextBlock[];
            const hasOutput = textBlocks.some(b => !!b.text);

            return (
                <div key={ci} className={cn(
                    "whisper-bubble whisper-bubble--assistant flex flex-col gap-2 rounded-lg px-3.5 py-2.5 text-[13px] leading-relaxed w-full",
                    isLastChunk && message.assistantChunks!.length > 1 && "border-l-2 border-primary/30",
                )}>
                    <ExecutionProcess
                        thinking={thinkingBlocks.map(b => b.thinking).join("\n") || undefined}
                        toolCalls={toolCallBlocks.map(b => ({ callId: b.id, toolName: b.name, status: b.status }))}
                        hasOutput={hasOutput}
                    >
                        {thinkingBlocks.map((b, ti) => (
                            <ThinkingPanel key={`t-${ti}-${b.thinking.slice(0, 20)}`} thinking={b.thinking} />
                        ))}
                        {toolCallBlocks.map((b) => (
                            <ToolCallCard key={b.id || `tc-${b.name}`} toolCall={toToolCallRecord(b)} />
                        ))}
                    </ExecutionProcess>

                    {textBlocks.map((b, ti) => (
                        b.text ? (
                            <div key={`txt-${ti}`} className="message-prose">
                                <SkillAwareContent
                                    content={b.text}
                                    isStreaming={message.isStreaming && isLastChunk && ti === textBlocks.length - 1}
                                />
                            </div>
                        ) : null
                    ))}
                </div>
            );
        })}
    </div>
) : (
    /* ── Single-chunk (legacy / user message) ── */
    // ...相同逻辑，只是直接遍历 message.contentBlocks ...
)}
```

---

## Task 7: 清理旧类型

**文件**: `src/main/shared/types.ts`

**操作**:

1. 确认项目中无任何 `AgentMessage` / `ToolCallRecord` / `AssistantChunk` 引用
2. 删除这三个 interface 定义及其 `@deprecated` 注释
3. 确认编译通过: `npx tsc -p tsconfig.json --noEmit && npx tsc -p tsconfig.main.json --noEmit`

---

## Task 8: 端到端验证

### 8.1 编译验证

```bash
cd /Users/jacky/Desktop/pi
npm run check
```

### 8.2 实时消息测试

1. 启动 app（或至少编译通过）
2. 创建 chat agent
3. 发送需要工具调用的消息（如 "读取 package.json 并分析"）
4. 确认: thinking 正确显示在 ExecutionProcess 中
5. 确认: toolCall 正确显示 status（running → success/error）
6. 确认: 多次 tool call 的连续 assistant 消息合并为 chunks

### 8.3 恢复测试

1. 发送几条消息后关闭 app
2. 重新启动 app
3. 确认: 历史消息正确恢复
4. 确认: 工具的 execution status 正确显示（不再是全部 ✅ success）

### 8.4 跨 agent 测试

1. 创建 orchestrator + coder
2. orchestrator 通过 `spawn_agent` 派发任务
3. 确认两个 agent 的聊天面板都正确渲染

---

## 总结

| 文件 | 改动行数（估算） | 操作 |
|------|-----------------|------|
| `types.ts` | +70 行 | 新增 Pi 类型体系 |
| `message-convert.ts` | 105→120 行 | 全部重写 |
| `agent-manager.ts` | ~80 行改动 | 类型 + 事件处理重写 |
| `App.tsx` | ~150 行改动 + 删除 35 行 | 状态 + 事件处理重写 |
| `ChatPanel.tsx` | ~60 行改动 | displayMessages + attachToolResult |
| `MessageBubble.tsx` | ~80 行改动 | 按 block type 渲染 |
| 其他 | 0 行 | 接口兼容不变 |

**核心设计原则**:
1. **不做转换**: pi content blocks 直接存储，不做 extract/flatten
2. **运行时状态附在 block 上**: toolCall 的 status/result/isError 作为 `PiToolCallBlock` 的扩展字段
3. **Streaming delta 追加到最后一个 active block**: text_delta → 最后一个 active text block, thinking_delta → 最后一个 active thinking block
4. **UI 渲染按照 block type 分发**: thinking → ThinkingPanel, toolCall → ToolCallCard, text → SkillAwareContent/StreamingMarkdown
5. **保留 assistantChunks 合并机制**: pi SDK 连续多个 assistant 消息合并为一个逻辑消息的现有行为不变
6. **修复 Bug #4**: 从磁盘恢复时，`toolResult` 消息的 `isError` 被注入到对应 toolCall block，恢复后的 UI 正确显示工具执行状态
