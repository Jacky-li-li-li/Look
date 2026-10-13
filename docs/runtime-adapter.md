# Look Runtime Adapter

状态：**Phase 1 + Phase 2 + Phase 3b 已在 main**（Phase 3b = Session* / shared 去 pi，经 PR #11；零用户可见行为变化；版本/changelog 口径仍属 **2.7.x**）· 默认引擎仍为 **pi**  
叙事目标：**2.8** = 可选执行基座可宣称之时（DshAdapter 真能开、用户可切引擎）——**尚未到**  
关联：deepseek-harness（dsh）、后续 Claude Code SDK 等  
权威设计草案来源：仓库外设计稿；本文为落地文档。

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
4. 设置项 `executionEngine` + capabilities 灰显
5. **DshAdapter MVP**：create / send / stream / abort / 基础 tool-approval → **此时才进入 2.8 产品叙事**
6. 更深解耦（factory / translator / composition 只经 Port）；AGENTS.md 已先立 RuntimePort-first 长期规则（pi 不变量在默认 PiAdapter 下仍适用）
7. Claude Code 另 PR

## 9. 评审检查清单

- [x] Port 覆盖 create/resume/send/abort/subscribe/tool-approval（Phase 1 表面）
- [x] abort 生产路径经 RuntimePort（Phase 2）
- [x] Lark 队列可 abort in-flight / pending（Phase 2）
- [x] 默认 pi；Phase 1+2+3b 不宣称已进 2.8
- [x] Session*Service 无直接 `@earendil-works/pi-*` import（Phase 3b）
- [x] messaging / abort 生产路径经 RuntimePort；IPC 形状不变
- [ ] 事件映射进现有 session UI 事件经 `Port.subscribe`（生产路径未改；后续引擎必须遵守）
- [ ] dsh/Claude 可插拔而非 fork 一套 session（尚未实现）
- [ ] changelog / 发版表述「可选执行基座」（**仅当 Dsh 可开 → 2.8**）
