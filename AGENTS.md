---
description: Project memory for Look (multi-agent Electron+React desktop app wrapping pi SDK). Read before changing agent-manager.ts, IPC, or session persistence.
---

# Look — project memory

## Session tree / branching (v0.4)
Type: rule
Look 是个 Electron 桌面 app, 直接用 `@earendil-works/pi-coding-agent` 的 SessionManager, **不写自己的 session wrapper**。但**不是裸用** — 看下面几点。

### 1. leafId 必须持久化到 agents.json
pi SessionManager 内部维护 `leafId` 指针, 但 Look 自己的 `agents.json` 索引里也必须存一份。**理由**: 重启时 SessionManager.open(file) 会把 leafId 默认恢复成 "文件最后一条 entry", 这等于 "切分支从来没发生"。修法:

- `ManagedAgent.leafId: string | null` 镜像
- `saveIndex()` 写 `leafId` 字段
- `loadPersistedAgents()` 读 `leafId`, 如果和 `sm.getLeafId()` 不一致 → `sm.branch(persistedLeafId)` 恢复
- leafId 改变靠 SDK 事件回流 (message_start / navigateTree 完成) **不要轮询**

### 2. branchSummary 不能在加载时丢
Look v0.4 之前, `loadPersistedAgents` 在反序列化 .jsonl 时**静默跳过** `role === "branchSummary"` 的消息, 导致切分支重启后, **新分支的 LLM 拿不到旧分支进展的总结**。修法: 只跳过 `bashExecution` / `custom` / `compactionSummary`, **`branchSummary` 保留**, 会被 `convertPiMessage` 转为 user message 进入上下文。

### 3. 用 AgentSession.navigateTree, 不是裸 SessionManager.branch
详见 agent memory `llm-sdk-patterns.md` 里 "pi SDK session tree" 那条 — 简而言之: `navigateTree` 是 pi TUI 用的同一套, 自动处理 editorText 填回 + summary prompt, 别重复造轮子。

### 4. 分支 = 新 agent
Look 的"分支" = **新 agent** (新 id + 新 sessionFile + 出现在 sidebar), 不是同 agent 换 file。原因: 同 agent 换 file 在用户认知里反直觉 ("我点了 fork 怎么还回到老 agent 的空 message 列表?")。`createForkedSession` 内部走 `createBranchedSession` + `createAgentSession` 重建, **新建的 agent 必须 broadcast `agent:created` + `agent:history` + `agent:list`** 让渲染层 sidebar / chat 同步。

## 渲染层浮按钮位置
Type: design-decision
**v0.4 决策**: assistant 消息的 hover 浮按钮 (复制 / 分叉 / 抽会话) 放**消息行外部下方** (`<div data-message-id>` 的兄弟节点), 不放 bubble 内部。

- 理由: bubble 本身是纯内容, 加边框 / 装饰会破坏 InK Wash 单色克制
- `group/message` 在 ChatPanel 层级包整行, hover bubble **或** 浮按钮都保持显示
- `ml-9` (= avatar 1.75rem + gap 0.5rem) 让 action strip 左对齐 bubble 左边
- user 消息不放浮按钮 (语义上 "重新发同一句话" 不是分叉)

## tsc baseline 隐式 any 的坑
Type: trap
**改 baseline tsc-passing 代码时, 新加 import 可能让 TS 重新 narrow 事件类型, 暴露出旧代码的隐式 any 变严格类型。** Look 项目里加 `import { ... }` 之前, `event.steering` 可能是 `any` 而通过, 之后变成 `readonly string[]`, 旧赋值 `[event.steering]` 报 "readonly cannot be assigned"。修法: spread `[...event.steering]` 或拷到 mutable 数组。

来源: 加 agent:tree-changed case 派发时撞了这个, 修了 `agent:queue_update` 的旧代码。

## MCP (Model Context Protocol)
Type: rule
Look 把 MCP 实现为 pi extension（`src/main/mcp/mcp-extension.ts`），而不是自己包一层 runtime。设计约定：

- **工具命名**：pi 侧注册为 `mcp:{serverName}:{toolName}`（ASCII 冒号），不再使用旧的全角 `：`。
- **Schema 转换**：MCP server 返回的 JSON Schema 会尽量转成 TypeBox schema 传给 `pi.registerTool`，让 LLM 拿到结构化参数提示；无法转换的字段回退到 `Type.Any()`。
- **激活方式**：`createAgentSession` 传了 `tools` 时会过滤掉 extension tools，因此 `AgentManager.syncMcpToolsIntoSession()` 在会话创建后把 `mcp:*` 工具名重新加入 active tools。
- **权限门控**：MCP 工具在 "ask" 模式下默认需要用户确认；"plan" 模式下会被阻断（不是 read-only）；"allow" 模式直接放行。
- **输入框触发**：输入框输入 `#mcp` 呼出 MCP 工具选择面板，Tab/Enter 选中后插入 `mcp:{server}:{tool} `。
- **生命周期**：`session_start` 自动 `connectAll()`；`before-quit` 调用 `disconnectAll()` 清理子进程。
- **依赖**：`@modelcontextprotocol/sdk` 必须是 `package.json` 的直接依赖，不能靠 transitive dependency。
