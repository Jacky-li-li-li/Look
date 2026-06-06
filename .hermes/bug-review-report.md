# Look 项目深度 Bug 审查报告

> 审查日期: 2026-06-06
> 审查范围: 全部核心源码 (agent-manager, IPC, App, ChatPanel, MessageBubble, 持久化, 权限, 编排, skills)
> 共发现: 12 个 Bug + 7 个设计缺陷/隐患

---

## 🔴 严重 (2 个)

### Bug #1 — `askAgent` 在目标 Agent 忙碌时返回错误的应答

**文件**: `src/main/agent-manager.ts:1109-1121` + `src/main/tools/orchestration.ts:69-94`

**问题**: `askAgent()` 的实现流程是：

```ts
// agent-manager.ts L1109-1121
async askAgent(agentId, question, timeoutMs) {
    return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(...), timeoutMs);
        (m.resolveWaits ??= []).push(() => {
            clearTimeout(t);
            const last = [...m.messages].reverse().find((x) => x.role === "assistant");
            resolve(last?.content ?? "(no response)");
        });
        this.sendMessage(agentId, question); // ← fire-and-forget
    });
}
```

`sendMessage()` 内部如果目标 agent 正在 streaming，会把消息作为 **steer** 排队：

```ts
// L1053
const streamingBehavior = m.session.isStreaming ? "steer" : undefined;
await m.session.prompt(text, streamingBehavior ? { streamingBehavior } : undefined);
```

**根因**: `resolveWaits` 回调在 `agent_end` 事件触发时执行（L1409）。如果 agent 正忙，当前 turn 的 `agent_end` **比新消息更早**到达。此时回调读到的是**上一轮**的 assistant 回复，不是对 `question` 的应答。Steer 打入的新 turn 稍后才执行，但 Promise 已经用旧应答 resolve 了。

**影响**: `ask_agent` 编排工具返回错误答案，Orchestrator 会基于错误信息做决策。

**修复建议**: 在 steer 场景下，不应立即 resolve，应等待 steer 触发的第二轮 `agent_end`。可通过跟踪 turn 计数器实现。

---

### Bug #2 — PermissionAskService Promise 永久泄漏

**文件**: `src/main/permissions/permission-ask.ts:41-47`

**问题**:

```ts
ask(agentId: string, request: PermissionAskRequest): Promise<PermissionDecision> {
    return new Promise<PermissionDecision>((resolve) => {
        this.resolvers.set(request.requestId, resolve);
        this.pending.push(request.requestId);
        this.emit({ type: "permission:ask", ...request, agentId });
    });
}
```

如果因为任何原因 renderer 不调用 `respondPermission`（IPC 失败、窗口销毁、renderer 崩溃），这个 Promise **永远不会 resolve**，pi SDK 的 `tool_call` hook 被永久挂起，整个 agent session 卡死。

虽然有 renderer 侧 30s 超时默认 deny（`App.tsx:414-425`），但这**完全依赖 IPC 链路的可靠性**。如果 `mainWindow.webContents.send("look:event", ...)` 在 `buildResourceLoader` 中的 `emit()` 调用时失败（比如 window 刚好在工具调用期间被关闭），renderer 永远收不到 `permission:ask` 事件，超时计时器不会启动。

**修复建议**: 在 `PermissionAskService.ask()` 中添加 60s 服务端超时兜底：

```ts
setTimeout(() => {
    if (this.resolvers.has(request.requestId)) {
        this.resolve(request.requestId, { action: "deny", reason: "Server-side timeout (60s)" });
    }
}, 60_000);
```

---

## 🟠 中等 (4 个)

### Bug #3 — `loadPersistedAgents` 一条记录恢复失败导致全部丢弃

**文件**: `src/main/agent-manager.ts:222-393`

**问题**: 整个 `loadPersistedAgents` 函数被一个 `try/catch` 包裹：

```ts
try {
    // ... loop over data.agents ...
    // 每个 agent 调用 createAgentSession() → 可能 throw
} catch (err) {
    console.error("[Look] Failed to load agents:", err);
    return 0;
}
```

如果第 3 个 agent 的 session file 已损坏导致 `SessionManager.open()` 或 `createAgentSession()` 抛异常，前 2 个已经成功恢复的 agent 会被一起丢弃，函数返回 0，然后 `initAgentManager` 会重新创建默认 Orchestrator，覆盖用户的 agent 列表。

**修复建议**: 把 try/catch 移到循环内部，单条失败 skip 继续。

---

### Bug #4 — 从磁盘恢复的 toolCalls 全部显示 "success"

**文件**: `src/main/shared/message-convert.ts:46-54` + `src/main/agent-manager.ts:239`

**问题**: `convertPiMessage()` 将所有 toolCall 硬编码为 `status: "success"`：

```ts
toolCalls: blocks.filter(b => b.type === "toolCall").map(b => ({
    callId: b.id ?? "",
    toolName: b.name ?? "unknown",
    args: b.arguments ?? {},
    result: "",       // ← 结果永远为空
    isError: false,   // ← 永远 false
    status: "success" as const,  // ← 永远 success
}))
```

在实时对话中这不影响——`agent:tool_execution_end` 事件会覆盖正确的状态和结果。但**从磁盘恢复时**，只有 `convertPiMessage()` 这一个数据源，没有事件流补充。导致所有历史 toolCall 在 UI 中显示为绿色的 `✅ success`，即使实际执行失败了。

**修复建议**: 检查 pi SDK 的 JSONL 消息块格式是否包含 toolCall 的执行状态和结果字段，如果有则正确映射。

---

### Bug #5 — Permission Gate 遗漏关键破坏性命令模式

**文件**: `src/main/permissions/permission-gate.ts:32-37`

**问题**: 全局拒绝规则只检测了有限的 pattern：

```ts
const cmd = String(args.command ?? "").toLowerCase();
return (
    cmd.includes("rm -rf /") || cmd.includes("mkfs.") ||
    cmd.includes("dd if=") || cmd.includes("> /dev/sda")
);
```

**遗漏的模式**:
- `rm -rf /*` / `rm -rf ~` / `rm -rf .` — 同等破坏性
- `chmod -R 777 /` — 权限灾难
- `:(){ :|:& };:` — fork bomb
- `git push --force` 不加 `main/master` 限制 → 也适用于其他分支
- 大小写绕过: `RM -RF /` 不会被 `cmd.toLowerCase().includes("rm -rf /")` 匹配

**修复建议**: 增加更多模式，使用正则匹配而非简单 `includes`。

---

### Bug #6 — `useThrottle` 卸载时调用 `setState` 导致 React 警告

**文件**: `src/renderer/hooks/useThrottle.ts:55-65`

**问题**:

```ts
return () => {
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    if (pending.current !== null) {
        setThrottled(pending.current); // ← 组件卸载后 setState
        pending.current = null;
    }
};
```

`useEffect` 的 cleanup 在**每次依赖变化**和**组件卸载**时都执行。当组件卸载或 `isStreaming` 从 `true → false` 时，cleanup 函数仍会调用 `setThrottled`。如果在卸载时调用，React 18+ 会在开发模式下报 warning：`Can't perform a React state update on an unmounted component`。

**修复建议**: 使用 `useRef` 追踪挂载状态，或者在 cleanup 中跳过卸载场景的 flush。

---

## 🟡 低 (6 个)

### Bug #7 — `spawn_agent` 编排工具的 fire-and-forget 竞态

**文件**: `src/main/tools/orchestration.ts:26-43`

**问题**:

```ts
const agentId = await agentManager.createAgent({...});
agentManager.sendMessage(agentId, params.task);  // ← 不 await
return { content: [{ type: "text", text: `Agent spawned: ... Running task` }] };
```

`sendMessage` 是 async 的，但工具函数不 await 它。工具返回的文本说 "Running task" 时，消息**还没有真正发送**。如果 `sendMessage` 内部失败（例如刚创建的 agent 在某些边缘情况下 session 无效），错误通过 `emit("error")` 异步传递，工具已经乐观返回了成功。

**修复建议**: 添加 `await` 或者把 send 的 Promise catch 住并将错误反映在返回值中。

---

### Bug #8 — ContextRing 双重更新机制造成浪费

**文件**: `src/renderer/components/ContextRing.tsx:34-83`

**问题**: ContextRing 有两个独立的 `useEffect` 更新同一个 `usage` 状态：
1. **主动轮询**: 每 3s 通过 `api.getContextUsage()` IPC 拉取
2. **事件驱动**: 监听 `agent:context-usage` 事件推送

两个来源可能在相近时间同时触发 `setUsage`，虽然 React 18 的自动批处理可以合并，但轮询在事件已经保持数据同步的情况下仍在浪费 IPC 往返。

**修复建议**: 事件驱动足够时暂停轮询，或在事件到来时重置轮询计时器。

---

### Bug #9 — App.tsx 将 user `message_start` 也创建为 streaming 消息

**文件**: `src/renderer/App.tsx:182-200`

**问题**: `agent:message_start` handler 不区分 role，对 user 和 assistant 消息一视同仁地创建 `isStreaming: true` 的消息。然后在 `message_end` 替换。虽然 user 消息的 `message_start → message_end` 间隔极短，但严格来说 user 消息不应该有 streaming 状态。

**修复建议**: 检查 `msg.role`，只对 assistant 设置 `isStreaming: true`。

---

### Bug #10 — Permission Gate `write` 规则误拦截 `.env` 文件

**文件**: `src/main/permissions/permission-gate.ts:54-58`

**问题**:

```ts
const p = String(args.path ?? "").toLowerCase();
return p.endsWith(".env") || p.includes(".env.");
```

`p.endsWith(".env")` 会匹配任何以 `.env` 结尾的路径，包括 `openrc.env`、`app.env` 等非 dotenv 文件。同时 `.env.example`、`.env.template` 等**通常不含敏感信息**的文件也被拦截。虽然这偏向安全（宁可多拦不少拦），但在开发体验上可能造成困扰。

**修复建议**: 改为精确匹配 `/\.env$/` 和 `/\.env\.\w+$/`，排除 `.env.example` / `.env.template` / `.env.sample`。

---

### Bug #11 — `checkPermission` 对 `ALL_RULES` 做了两遍完整的线性扫描

**文件**: `src/main/permissions/permission-gate.ts:127-156`

**问题**: `checkPermission` 先完整遍历 `ALL_RULES` 找 deny 规则，再完整遍历一遍找 ask 规则。由于 `ALL_RULES` 已经按优先级排列，一次遍历就可以完成：

```
deny match → return deny
ask match → remember, continue
end of loop → return remembered ask || allow
```

当前实现是 O(2n)，优化为 O(n) 即可。

---

### Bug #12 — `resolveModel` 可能因模型注册表变化产生不一致

**文件**: `src/main/agent-manager.ts:724-735` + `799-837`

**问题**: `createAgent` 中 `firstAvailableModelKey()` 被调用了**两次**：

```ts
const primaryModelId = ... ?? this.firstAvailableModelKey(); // L810
// ... 很多代码 ...
const lastResort = this.firstAvailableModelKey(); // L834
```

两次调用之间模型注册表（`ModelRegistry`）不变（同步代码），所以实际操作上不会出问题。但这是一个**代码异味**——如果未来某次重构在两个调用之间插入了异步操作，两次可能返回不同结果。此外 `firstAvailableModelKey()` 在 `loadPersistedAgents` 中也被单独调用（L267），与 createAgent 路径逻辑重复。

---

## 🔵 设计缺陷 & 隐患 (7 个)

### D1 — `blockedToolCalls` 链式调用过于脆弱

**文件**: `src/main/agent-manager.ts:1371-1373`

**问题**:

```ts
(this.blockedToolCalls.get(agentId) ??
 this.blockedToolCalls.set(agentId, new Set()).get(agentId)!).add(event.toolCallId);
```

`Map.get` → `??` → `Map.set().get()` → `!` → `.add()` 的链式调用极其难读且容易出错（依赖 `set()` 返回 Map 自身的事实），应有更清晰的实现。

---

### D2 — `ask()` 方法中 agentId 被传入两次

**文件**: `src/main/permissions/permission-ask.ts:45`

**问题**:

```ts
this.emit({ type: "permission:ask", ...request, agentId });
```

`request` 对象已包含 `agentId` 字段，spread 后再显式传入一次，冗余。虽然不影响功能，但暗示了类型定义与实际使用的微小不一致。

---

### D3 — `attachToolResult` 中的 mutation 写法脆弱

**文件**: `src/renderer/components/ChatPanel.tsx:202-235`

**问题**: `attachToolResult` 中对 `merged[i]` 和 `chunks[c]` 做了 mutation，虽然有 `.slice()` 保护但极脆弱。应该用 immutable 写法避免任何潜在引用问题。

---

### D4 — `activeAgentIdRef` 绕过闭包但违反 React linting

**文件**: `src/renderer/App.tsx:73-76, 79-341`

**问题**: 使用 `activeAgentIdRef` 绕过闭包问题的设计是有效的，但 `useEffect([], ...)` 空 deps 数组违反了 `react-hooks/exhaustive-deps` linting 规则。未来维护者可能误加 deps 导致订阅重建并引入竞态。

---

### D5 — 系统消息不经过事件流

**文件**: `src/main/agent-manager.ts:917-923`

**问题**: `createAgent` 用 `addMessage` 添加系统消息但不走 `message_end` 事件流——Renderer 永远不会通过事件流收到这个系统消息，只能通过 `agent:history` 拉取。实际影响不大因为 ChatPanel 用 `displayMessages` 处理，但架构上不够一致。

---

### D6 — 设置迁移缺少原子写入保护

**文件**: `src/main/migrate-settings.ts:77-138`

**问题**: 迁移逻辑中先 `delete data[oldKey]` 再写回 `settings.json`。如果 `writeFileSync` 成功但中途断电，`settings.json` 可能处于损坏状态，而 `ui-settings.json` 尚未写入。缺少原子写入保护（如先写 tmp 文件再 rename）。

---

### D7 — `ask_agent` timeout 硬编码

**文件**: `src/main/tools/orchestration.ts:80`

**问题**: `ask_agent` 的 timeout 默认 120 秒硬编码：

```ts
const timeout = (params.timeout_seconds ?? 120) * 1000;
```

对于需要长时间 tool call 的复杂任务，可能不够。应可配置或提供合理的上限。

---

## 📊 总结

| 严重程度 | 数量 | 关键项 |
|---------|------|--------|
| 🔴 严重 | 2 | `askAgent` 竞态返回旧应答, Permission Promise 永久泄漏导致 session 卡死 |
| 🟠 中等 | 4 | 恢复失败全部丢弃, toolCalls 状态错误, 权限遗漏, useThrottle 卸载 setState |
| 🟡 低 | 6 | 编排竞态, 双重更新, user streaming, .env 误拦, 双扫描, 代码异味 |
| 🔵 设计隐患 | 7 | 脆弱代码, 原子性, 可维护性, 硬编码 |

**最需要立即修复的是**:
1. **Bug #1** (`askAgent` race condition) — 影响多 Agent 协作的正确性
2. **Bug #2** (Permission Promise leak) — 影响 Agent session 的稳定性
