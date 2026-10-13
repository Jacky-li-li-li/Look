# Look Runtime Adapter

状态：**Phase 1 + Phase 2 + Phase 3b 已在 main**（Phase 3b = Session* / shared 去 pi，经 PR #11；零用户可见行为变化；版本/changelog 口径仍属 **2.7.x**）· 默认引擎仍为 **pi**  
叙事目标：**2.8** = 可选执行基座可宣称之时（DshAdapter 真能开、用户可切引擎）——**尚未到**  
关联：deepseek-harness（dsh）、后续 Claude Code SDK 等  
权威设计草案来源：仓库外设计稿；本文为落地文档。  
**§10** = 换底座 **design / prep only**（缺口清单 · 组合根选型约定 · 映射表含 TBD · 刻意不做）——**无** Dsh 实现、**无** 可切换引擎宣称。

## 1. 问题

今天 Look 的「执行」不是可插拔的：

- 会话生命周期、工具、Skill、事件流都直接依赖 `@earendil-works/pi-*`
- UI / IPC / 权限层默认「底下就是 pi」
- 换模型 ≠ 换执行基座；dsh / Claude Code 是换引擎

目标：用户能选择执行基座（pi / dsh / …），架构上清晰、默认行为不变、后续加基座不 fork 一套 session。

## 2. 设计原则

1. **宿主稳定，引擎可换**：Electron 壳、IPC、Renderer、权限 UI 只认识 Look 自己的契约。
2. **最小面，强制覆盖**：每个基座必须实现同一组能力；做不到的能力显式声明「不支持」，禁止静默降级。
3. **默认仍是 pi**：功能开关关闭时，行为与现网一致（`PiAdapter` 走现有路径）。
4. **会话分仓并存**：不把 pi JSONL 与 dsh SessionEvent 硬融；Look 只维护「LookSession 元数据 → 引擎侧 session 句柄」映射。
5. **事件进 Look，不改 IPC 形状**：引擎事件映射到现有 `main-to-renderer` session 事件；禁止为某个基座新增平行 IPC 通道。
6. **权限仍由 Look 守门**：tool-approval / ask-plan-always 在 Look 侧统一；引擎侧沙箱是补充，不是替代。

## 3. 分层

```
Renderer (Jotai / Chat UI)
        │  look:invoke + 现有 session events
        ▼
IPC routers / Session*Service（用例层，不 import pi/dsh —— 逐步迁）
        │
        ▼
RuntimePort（接口） ←── RuntimePortRegistry（按 Look sessionId 持有/解析 Port）
        │
   ┌────┴────┐
   ▼         ▼
PiAdapter  DshAdapter  （+ 未来 ClaudeCodeAdapter）
   │         │
 pi SDK    dsh --profile sdk（或嵌入 SDK）
```

**代码锚点：**

| 模块 | 路径 |
|------|------|
| Port 类型 | `apps/electron/src/main/runtime-port/types.ts` |
| PiAdapter | `apps/electron/src/main/runtime-port/pi-adapter.ts` |
| Port 注册表 | `apps/electron/src/main/runtime-port/registry.ts` |
| 组合根装配 | `apps/electron/src/main/session/composition/builder-phases/extensions.ts` |
| abort 缝 | `SessionLifecycleService.abortAgent` → `runtimePort.abort` |
| Lark 队列 abort | `apps/electron/src/main/im/lark-chat-queue.ts` |
| Look 侧类型 / ops | `look-types.ts` · `pi-session-ops.ts` · `thinking.ts`（Phase 3b） |
| 既有 pi 工厂 | `apps/electron/src/main/session/runtime/runtime-factory.ts` |
| 既有活实例表 | `apps/electron/src/main/session/runtime/runtime-registry.ts` |

## 4. RuntimePort 最小面

```ts
type EngineId = "pi" | "dsh" | "claude-code";

interface RuntimePort {
  readonly engineId: EngineId;
  readonly capabilities: EngineCapabilities;

  create(input: CreateSessionInput): Promise<EngineSessionRef>;
  resume(ref: EngineSessionRef): Promise<void>;
  dispose(ref: EngineSessionRef): Promise<void>;

  send(ref: EngineSessionRef, message: UserMessage): Promise<void>;
  abort(ref: EngineSessionRef): Promise<void>;

  subscribe(ref: EngineSessionRef, sink: (e: LookSessionEvent) => void): Unsubscribe;
  resolveToolApproval(ref: EngineSessionRef, decision: ApprovalDecision): Promise<void>;
}
```

**不进最小面（后续阶段）：** fork/tree、Skill 热加载、MCP 桥、Computer Use 作为 Port 方法。dsh 第一期可在 `capabilities` 关掉这些。

## 5. Phase 状态（已合 main）

### Phase 1 — 已落地（已在 main）

- `RuntimePort` + `EngineCapabilities` + 相关类型
- `PiAdapter`：薄封装，委托现有 `SessionRuntimeFactory` / 活 `AgentSessionRuntime`
- `RuntimePortRegistry`：默认 Port + 按 session 绑定（为多引擎预留）
- 组合根构造默认 `PiAdapter`，经 `RuntimeManagerComposition.runtimePort` / `SessionRuntimeManager.runtimePort` 可取
- 单元测试：engineId、capabilities、create/dispose/send/abort/resolveToolApproval 委托

### Phase 2 — 已落地（已在 main）

- **Abort 缝**：`SessionLifecycleService.abortAgent` 在组合根注入 `runtimePort` 时走 `runtimePort.abort({ engineId, sessionId })`（PiAdapter → `session.abort()`）；子会话 / permission / plan 取消仍由 lifecycle 负责
- **Registry 与活会话对齐**：`onSessionBound` / `associateRuntimePort`（rebind 换 id）`bind`；`onSessionDisposed` `unbind`
- **Lark chat queue in-flight abort**：`LarkChatTaskQueue` 每 key 持有 `AbortController`；`enqueue(task: (signal) => …)`；`abort` / `clear` / `clearForApp` 会 abort in-flight 并跳过 pending；桥接 stop / unbind / dispose 路径 **先** abort 队列信号再 `abortAgent`

### Phase 3b — Session* 解耦（PR #11，已在 main；口径仍 2.7.x）

- **`apps/electron/src/main/session/services/` 不再直接 import `@earendil-works/pi-*`**（`rg` 该目录应为空）
- 新增 Look 侧边界：`look-types.ts`（opaque handle / ModelLookup / PersistedSessionRow 等）、`pi-session-ops.ts`（SessionManager create/open/list/fork 唯一入口）、`thinking.ts`（clamp / supported levels）
- **`SessionMessagingService` 发送走 `RuntimePort.send`**（组合根注入；PiAdapter → `session.prompt`，含 `streamingBehavior` / `onPreflight`）
- 组合根 `builder-phases/core.ts` / `ui.ts` 在交给 lifecycle coordinator 前用 `asPiSessionManager` 收窄 opaque handle
- **Session*Service 不再拿到 `AgentSessionRuntime`**：`ManagedRuntime.runtime` 仅供 lifecycle coordinator / composition / events 使用；services 只见 `ManagedSession`（`session: EngineSessionView`，`runtime-port/look-types.ts`），pi 实现为 `runtime-port/pi-session-view.ts`（每次调用委托 `runtime.session`，跟随 pi 原地换 session）。`setModel` / thinking 等的 `LookModelRef → pi Model` 收窄只在 adapter（`toPiModel`）；services 中 `setModel(model as never)` 与 `thinking.ts` 的 `as never` 已移除
- **`@look/shared/types` 不再 re-export pi 的 `SessionEntry` / `ImageContent` / `AgentMessage`**：改为 Look 自有 DTO（`types/dto/engine.ts`：`LookAgentMessage`、`LookImageContent`（兼容别名 `ImageContent`）、`LookContextUsage`、`LookSessionStats`、`LookModelInfo`、`NavigateTreeResult` 等，字段与现网 wire 格式 1:1，IPC 形状不变）；pi `SessionEntry → LookSessionEntry` 投影移到 `runtime-port/session-entry-projection.ts`；`ToolCallHandler`（pi 扩展类型）移到 main `permissions/tool-call-handler.ts`
- **守卫测试** `apps/electron/test/runtime-port-boundary.test.ts`：`session/services/**` 与 `packages/shared/src/**` 出现 `@earendil-works/pi-*` import/re-export、或 services 触达 `.runtime.session` / `AgentSessionRuntime` 即失败
- 组合根 `startEvent` 不再 `as SessionStartEvent`：`EngineSessionStartEvent` 与 pi `SessionStartEvent` 结构一致
- **仍在 adapter / factory / translator / composition / extensions 等处保留 pi**——有意为之；IPC 形状不变；**不是**可切换引擎

### 已落地 vs 尚未落地

| 已落地（Phase 1+2+3b 已在 main） | 尚未（勿对外宣称） |
|-----------|-------------------|
| RuntimePort + PiAdapter 骨架 | DshAdapter / ClaudeCodeAdapter |
| abort 生产路径经 RuntimePort | 设置项 `executionEngine` + capabilities 灰显 UI |
| Registry bind/unbind 与活会话对齐 | 生产事件路径改走 `Port.subscribe` |
| Lark 队列可 abort in-flight / pending | 用户可切引擎 / 「可选执行基座」产品口径 |
| Session*Service / `@look/shared` 无直接 `@earendil-works/pi-*` import，services 不见 `AgentSessionRuntime`（Phase 3b，已在 main，PR #11） | factory / translator / composition / extensions 去 pi（后续） |
| 默认仍是 pi；零行为变化（除有意 abortability） |  |

## 6. 版本与 2.8 叙事（发版口径）

- **2.7.x**：Phase 1+2+3b 落地期间的 hotfix / 常规发版线。Port 缝、PiAdapter、Session* 去直接 pi import **不**单独构成版本叙事；changelog 不写「已进入可选执行基座」。
- **2.8（预留）**：仅在 **DshAdapter 真能开**（用户可切引擎、capabilities 诚实灰显）时，再宣称「可选执行基座 / RuntimePort-first，默认 PiAdapter」。在此之前文档与发版话术都不要抢先。
- 本文件的更新是文档对齐；**不 bump** `package.json` / 不打 tag / 不发 Release。

## 7. 行为保证

- **零用户可见行为变化**（除有意的 abortability）：默认路径仍是 pi；活会话生命周期仍由 `RuntimeLifecycleCoordinator` 拥有。
- Lark：**stop / 解绑 / dispose 现在会取消同 chat 的 pending 队列任务**，并 abort in-flight 信号；与既有 `abortAgent` 一起使用。
- Port 是组合边界上的缝。Phase 3b 后 Session*Service 经 RuntimePort / pi-session-ops / look-types 访问引擎；**adapter、runtime-factory、event-translator、composition、extensions** 仍直接依赖 pi——有意为之，不是 2.8 已完成的标志。

## 8. 后续顺序

1. ~~抽 Port + PiAdapter 包装现网~~ ← Phase 1（已在 main）
2. ~~abort 缝 + Lark queue abort + registry 对齐~~ ← Phase 2（已在 main）
3. ~~Session*Service 去直接 `@earendil-works/pi-*` import；messaging 经 RuntimePort.send~~ ← Phase 3b（已在 main，PR #11；仍 2.7.x）
4. ~~换底座 design / prep（缺口清单 · 选型约定 · 契约测试文档）~~ ← §10（本设计；仍 2.7.x，**不可**对外宣称可切换）
5. 设置项 `executionEngine` + capabilities 灰显（另 PR）
6. **DshAdapter MVP**：create / send / stream / abort / 基础 tool-approval → **此时才进入 2.8 产品叙事**
7. 更深解耦（factory / translator / composition 只经 Port）；AGENTS.md 已先立 RuntimePort-first 长期规则（pi 不变量在默认 PiAdapter 下仍适用）
8. Claude Code 另 PR

## 9. 评审检查清单

- [x] Port 覆盖 create/resume/send/abort/subscribe/tool-approval（Phase 1 表面）
- [x] abort 生产路径经 RuntimePort（Phase 2）
- [x] Lark 队列可 abort in-flight / pending（Phase 2）
- [x] 默认 pi；Phase 1+2+3b 不宣称已进 2.8
- [x] Session*Service 无直接 `@earendil-works/pi-*` import（Phase 3b）
- [x] messaging / abort 生产路径经 RuntimePort；IPC 形状不变
- [x] §10 换底座 design / prep：完整缺口清单 + 刻意不做 + 默认 pi/回退 + 映射表 TBD + 契约测试（skip）文档化
- [ ] 事件映射进现有 session UI 事件经 `Port.subscribe`（生产路径未改；后续引擎必须遵守）
- [ ] dsh/Claude 可插拔而非 fork 一套 session（尚未实现）
- [ ] changelog / 发版表述「可选执行基座」（**仅当 Dsh 可开 → 2.8**）

---

## 10. 换底座设计（design / prep only · 2.7.x）

> **本文档定位**：长期可维护的引擎基座替换（换底座 / 未来 `DshAdapter`）的**设计与缺口清单**。  
> **不是**：可切换引擎产品能力、Dsh 实现、版本 bump、或 changelog「可选执行基座」宣称。  
> **默认引擎仍为 pi**；enablement 另 PR，且仅在第二适配器真能开时才进入 **2.8** 产品叙事。

### 10.1 刻意不做（本设计 PR / 当前阶段边界）

| 刻意不做 | 说明 |
|----------|------|
| 不实现 `DshAdapter` / ClaudeCodeAdapter | 无 SDK 依赖、无子进程、无 feature flag 接线 |
| 不改 IPC 形状 | `look:invoke`、`MainToRendererEvent`、renderer 契约保持原样；不为第二引擎开平行通道 |
| 不 bump 版本 / 不改 changelog 产品口径 | 仍属 **2.7.x** 文档与契约 prep；禁止写「已支持切换引擎 / 2.8」 |
| 不热切换 live turn 中的引擎 | 即便日后 enable，也只作用于新会话或显式迁移 |
| 不统一 pi JSONL 与 dsh SessionEvent 物理格式 | 会话分仓；Look 只持有元数据 → 引擎句柄映射 |
| 不把 factory / event-translator / composition / extensions 一次去 pi | 仍属后续解耦；本设计只列缺口 |
| 不宣称 `Port.subscribe` 已是生产事件路径 | 生产 UI 事件仍经 `SessionEventProcessor` |
| 不引入设置项 `executionEngine` UI | 组合根选型设计可写，产品开关另 PR |

### 10.2 现状缺口清单（相对第二适配器必须实现的面）

以下方法名均来自仓库实码（`runtime-port/`、`session/`、`ipc/`），第二适配器（如 Dsh）要对齐或显式声明不支持。

#### A. `RuntimePort`（`types.ts` → `PiAdapter`）

| 成员 | 现状（pi） | 第二适配器要求 | 缺口 / 备注 |
|------|------------|----------------|-------------|
| `engineId` | `"pi"` | 返回真实 id（如 `"dsh"`） | 类型已含 `"dsh" \| "claude-code"`，无实现 |
| `capabilities` | `PI_ENGINE_CAPABILITIES` 全 `true` | 诚实声明；不支持则 `false` + UI 灰显 | dsh 首期多半 fork/skillsSlash/mcp/computerUse/sessionTree = false |
| `create(input)` | 需 `engine: PiEngineCreateOptions`（`sessionManager` + 可选 start/factory） | 自有 create；`CreateSessionInput.engine` 不透明 | **缺口**：Port 层 create 仍强耦合 pi SessionManager 载荷 |
| `resume(ref)` | `resumeSession` → `lifecycle.ensureRuntime` 或已 live 则 no-op | 同语义 resume / ensure | **缺口**：dsh 会话句柄与 Look sessionId 映射未设计落地 |
| `dispose(ref)` | `disposeSession` → lifecycle / `runtime.dispose` | 释放引擎资源 | OK 作为契约；实现 TBD |
| `send(ref, message)` | → `session.prompt`（`streamingBehavior` / `onPreflight` / images） | 用户 turn 入引擎 | **TBD**：dsh 是否有 steer/followUp 等价；images 形状 |
| `abort(ref)` | → `session.abort()` | 取消 in-flight turn | 生产路径已经 Port（Phase 2） |
| `subscribe(ref, sink)` | 仅挂 pi `session.subscribe`；**不向 sink 投递 LookSessionEvent** | 必须映射为 `LookSessionEvent`（=`MainToRendererEvent`） | **大缺口**：生产事件仍在 `SessionEventProcessor` / event-translator |
| `resolveToolApproval(ref, decision)` | → Look `permissionService.handleResponse` | Look 守门后回灌；引擎侧沙箱非替代 | **TBD**：dsh tool waterfall 如何挂 Look gate |

#### B. `EngineSessionView`（`look-types.ts` → `PiSessionView`）

Session*Service 经 `ManagedSession.session` 调用，**不经** `RuntimePort`。第二引擎若复用现有 Session* 路径，必须提供同等 view（或把这些能力逐步收进 Port）。

| 类别 | 实码成员 |
|------|----------|
| 只读状态 | `sessionId`, `sessionFile`, `model`, `thinkingLevel`, `isStreaming`, `isRetrying`, `isCompacting`, `sessionManager`, `settings` |
| 模型 / thinking | `setModel`, `setThinkingLevel`, `supportsThinking`, `getAvailableThinkingLevels` |
| 统计 | `getSessionStats`, `getContextUsage` |
| Turn / 控制 | `prompt`, `abort`, `compact`, `abortCompaction`, `reload`, `navigateTree` |
| 元数据 / 工具 | `setSessionName`, `setAutoCompactionEnabled`, `getAllTools`, `getActiveToolNames`, `setActiveToolsByName` |
| Skills / hooks | `getLoadedSkills`, `runBeforeForkHooks` |

**缺口：** 多数 view 方法仍是 pi 语义（JSONL tree、`/skill:name`、extension hooks）。dsh 需逐项：实现 / `capabilities` 关闭 / 或从 Session* 调用点拆除。

#### C. 会话持久化 ops（`pi-session-ops.ts`）

`createEngineSession` · `openEngineSession` · `openEngineSessionForFork` · `listEngineSessions` · `engineSessionId` / `Cwd` / `Dir` · `createBranchedEngineSession` · `asPiSessionManager`

**缺口：** 名称已是 Engine*，实现 100% `SessionManager`。第二引擎需要平行 ops 或 Port 级 persistence；**禁止**跨引擎 resume 同一物理日志。

#### D. 队列（`pi-queue-ops.ts` + IPC）

- `replayQueue(managed, excludeText?)` · `insertQueuedAsSteer(managed, text)`  
- IPC：`agent-router` 经上述 helpers；Lark：`LarkChatTaskQueue`（`AbortController` per key）

**缺口：** queue ops 仍吃 `PiRuntimeHolder.runtime.session`（`clearQueue` / `steer` / `followUp` / `prompt`）。dsh 无对等 API 则需 Port 级 queue 面或 capabilities 关闭队列编辑。

#### E. 事件 / 翻译

- 生产：`SessionEventProcessor` + `event-translator` → `session:ui-event` 等 `MainToRendererEvent`
- Port：`LookSessionEvent = MainToRendererEvent`，但 `PiAdapter.subscribe` **故意不映射**

**缺口：** 第二适配器必须自备 translator → 现有 UI 事件；缺映射则丢弃/debug，**不得**新开 IPC。

#### F. 模型 / thinking / host 句柄

- `thinking.ts`：`getSupportedThinkingLevels` · `clampThinkingLevel`（经 `toPiModel`）
- `model-host-types.ts`：`EngineModelRuntime` / `EngineModelRegistry` / `EngineCredentialStore`（仍是 pi 类型别名）
- IPC invoke-context 暴露上述句柄

**缺口：** 模型目录与凭据是否 per-engine、dsh 模型 id 如何映射 `LookModelRef` —— **TBD**。

#### G. 组合根 / Registry（已有缝，未选型）

- 装配：`builder-phases/extensions.ts` 固定 `new PiAdapter(...)` + `portRegistry.setDefault(piAdapter)`
- `RuntimePortRegistry`：`setDefault` / `getDefault` / `bind` / `unbind` / `get`（fallback default）
- lifecycle：`onSessionBound` → `bind`；`onSessionDisposed` → `unbind`；`associateRuntimePort`（rebind）

**缺口：** 无 `engineId` 配置读取、无失败回退逻辑、无 per-session 非 pi bind 的生产路径。

### 10.3 组合根引擎选型（选型缝已接线 · 生产只注册 pi）

```
composition root (extensions.ts 一带)
        │
        ├─ 读配置 / flag（尚未存在）→ 目标 engineId
        ├─ 尝试构造对应 Adapter
        │     └─ 失败 → 记录原因 → 回退 PiAdapter
        ├─ portRegistry.setDefault(selectedPort)   // 默认必须能落到 pi
        └─ b.runtimePort = selectedPort
```

| 规则 | 约定 |
|------|------|
| 默认 | **pi**（`PiAdapter`）；无配置 = 现网行为 |
| 失败回退 | 任一非 pi 适配器构造/探活失败 → **回退 pi**，不阻断启动 |
| IPC | **形状不变**；renderer 不因引擎更换改 invoke/event 协议 |
| 绑定 | 新会话 `bind(sessionId, port)`；未 bind 时 `registry.get` fallback default |
| 本阶段 | `runtime-port/engine-selection.ts` 的 `selectRuntimeEngine` 已接入 `extensions.ts`；生产 `factories` **只有 `pi`**，请求其它 id（`LOOK_RUNTIME_ENGINE`，仅开发/测试）一律 warn 后回退 pi；无设置 UI |

### 10.4 映射表（lifecycle / events / abort / permissions / model / thinking）

| Look 概念 | pi（现网） | dsh（目标示意） | 状态 |
|-----------|------------|-----------------|------|
| 创建会话 | `createEngineSession` + factory.create / `RuntimePort.create` | dsh session / SDK create | **TBD** 句柄与 Look sessionId |
| resume | `openEngineSession` + `ensureRuntime` / `Port.resume` | dsh resume by ref | **TBD**；禁止跨引擎打开 pi JSONL |
| dispose | lifecycle.disposeRuntime / `Port.dispose` | 释放 dsh 资源 | 契约有；实现 **TBD** |
| 用户消息 | `Port.send` → `session.prompt` | agent turn / prompt API | **TBD** steer/followUp/images |
| abort turn | `Port.abort` → `session.abort`；Lark 队列先 abort signal | dsh cancel | 契约清晰；dsh API **TBD** |
| 流式 / UI 事件 | `SessionEventProcessor` → `session:ui-event`（assistant_* / tool_* / run_status / …） | 映射进同一 `MainToRendererEvent` | **TBD** 事件字典；`Port.subscribe` 生产化未做 |
| 队列编辑 | `replayQueue` / `insertQueuedAsSteer` | ？ | **TBD** 或 capabilities 关闭 |
| tool-approval | Look `permissionService` + `Port.resolveToolApproval` | tools waterfall → Look gate | **TBD** 挂接点 |
| plan / ask 模式 | Look permission orchestrator + `session.abort` / `setModel` | ？ | **TBD**（可能首期不支持） |
| 模型切换 | `EngineSessionView.setModel(LookModelRef)` | dsh model id？ | **TBD** |
| thinking | `setThinkingLevel` / `clampThinkingLevel` / `getSupportedThinkingLevels` | ？ | **TBD**；无则 `supportsThinking() === false` |
| compaction | `compact` / `abortCompaction` | ？ | capabilities.compaction |
| session tree / fork | `navigateTree` / `createBranchedEngineSession` / before-fork hooks | 通常无 | capabilities.sessionTree / fork = false |
| skills | `getLoadedSkills` + `/skill:name` | ？ | capabilities.skillsSlash |
| MCP / CU | pi extensions | ？ | capabilities.mcp / computerUse |

规则：Adapter 只输出已有 Look DTO / `MainToRendererEvent`；**不清空缺口装成已完成**。

### 10.5 验收标准（本设计 + 后续实现 PR）

**文档 / 设计 PR（本 PR）应满足：**

1. 缺口清单覆盖 Port + View + queue + events + ops，且方法名为实码名  
2. 明确「刻意不做」与「默认 pi + 失败回退 + IPC 不变」  
3. 映射表含 **TBD**，不假装完整  
4. 不 bump 版本；不在 changelog / 用户向文档宣称可切换引擎或 2.8 已交付  

**守卫（已有，必须保持绿）：**

- `apps/electron/test/runtime-port-boundary.test.ts`  
  - `session/services/**`、`ipc/**`、`packages/shared/src/**` 无 `@earendil-works/pi-*` import/re-export  
  - services / ipc 不触达 `.runtime.session` / `AgentSessionRuntime` / `AgentSession`

**规划中的 Port 契约测试（文档化契约，非红灯）：**

- `apps/electron/test/runtime-port-contract.test.ts`（`describe.skip`）列出 `RuntimePort` 必选成员与 `EngineCapabilities` 键，作为第二适配器 checklist  
- 实现 Dsh 的 PR 再去掉 skip，并对假适配器做编译期 / 运行期断言  

**第二适配器落地 PR 另需（非本 PR）：**

- 组合根选型 + 失败回退 pi  
- 事件映射进现有 UI 事件（或证明走共享 translator）  
- capabilities 诚实；IPC diff 为空  

### 10.6 实施状态（`feat/runtime-engine-selection`）

| 项 | 状态 |
|----|------|
| 测试专用假适配器 `test/helpers/fake-runtime-adapter.ts`（`RuntimePort` + `EngineSessionView`，capabilities 全 `false`，不支持即抛错） | ✅ 已完成；**不是** DshAdapter，不进 `src/`、不进生产注册 |
| `runtime-port-contract.test.ts` 去 skip，对 `PiAdapter`（mock runtime）与假适配器跑同一套契约 | ✅ 已完成 |
| 组合根选型缝 `selectRuntimeEngine`：默认 pi；未知 / 未注册 / 初始化失败 / engineId 不符 → warn + 回退 pi | ✅ 已完成（生产只注册 pi，行为不变） |
| IPC 形状与所选引擎无关（invoke 通道集合一致；`InvokeContext` 不含 port；`ipc/**` 不 import 选型/适配器） | ✅ 测试守护 |
| `PiAdapter.subscribe` 投递 `LookSessionEvent`（生产事件路径改走 Port） | ⏳ TBD（契约测试中 `it.todo`） |
| 真实 Dsh：事件字典映射、sessionId↔句柄、steer/followUp/images、tool waterfall → Look gate | ⏳ TBD（无 Dsh 协议，未实现） |
| `CreateSessionInput.engine` 去 pi 载荷耦合、persistence/queue ops 平行实现、模型/thinking per-engine | ⏳ TBD |
| 设置项 / 产品开关、版本与 changelog 口径 | ❌ 刻意不做（仍 2.7.x） |
