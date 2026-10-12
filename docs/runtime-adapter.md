# Look Runtime Adapter

状态：**Phase 1 skeleton**（本分支 / 合并后叙事对齐 2.8）· 默认引擎仍为 **pi**  
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

**代码锚点（Phase 1）：**

| 模块 | 路径 |
|------|------|
| Port 类型 | `apps/electron/src/main/runtime-port/types.ts` |
| PiAdapter | `apps/electron/src/main/runtime-port/pi-adapter.ts` |
| Port 注册表 | `apps/electron/src/main/runtime-port/registry.ts` |
| 组合根装配 | `apps/electron/src/main/session/composition/builder-phases/extensions.ts` |
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

## 5. Phase 1 已落地 / 未落地

### 已落地

- `RuntimePort` + `EngineCapabilities` + 相关类型
- `PiAdapter`：薄封装，委托现有 `SessionRuntimeFactory` / 活 `AgentSessionRuntime`
- `RuntimePortRegistry`：默认 Port + 按 session 绑定（为多引擎预留）
- 组合根构造默认 `PiAdapter`，经 `RuntimeManagerComposition.runtimePort` / `SessionRuntimeManager.runtimePort` 可取
- 单元测试：engineId、capabilities、create/dispose/send/abort/resolveToolApproval 委托

### 明确未落地（本 PR 不做）

- **DshAdapter / ClaudeCodeAdapter**
- 设置项 `executionEngine` + capabilities 灰显 UI
- 从 `Session*Service` 批量删除 `@earendil-works/pi-*` import（后续 PR）
- 生产事件路径改走 `Port.subscribe`（仍由 `SessionEventProcessor` 映射）
- browser-service / ApiKeysTab 拆分
- Lark queue abort
- 版本 bump / GitHub Release

## 6. 行为保证

- **零用户可见行为变化**：默认路径仍是 pi；活会话生命周期仍由 `RuntimeLifecycleCoordinator` 拥有。
- Port 是组合边界上的缝，不是本 PR 对所有 call site 的重定向。

## 7. 后续顺序

1. ~~抽 Port + PiAdapter 包装现网~~ ← Phase 1（本分支）
2. 设置项 `executionEngine` + capabilities 灰显
3. **DshAdapter MVP**：create / send / stream / abort / 基础 tool-approval
4. Session*Service 逐步只依赖 RuntimePort；文档 / AGENTS.md「pi first」→「RuntimePort first，默认 PiAdapter」（pi 不变量在仅有 PiAdapter 时仍适用）
5. Claude Code 另 PR

## 8. 评审检查清单

- [x] Port 覆盖 create/resume/send/abort/subscribe/tool-approval（Phase 1 表面）
- [ ] 事件映射进现有 session UI 事件、IPC 形状不变（生产路径未改；后续引擎必须遵守）
- [ ] dsh/Claude 可插拔而非 fork 一套 session（尚未实现）
- [x] 默认 pi
- [ ] changelog 表述为「可选执行基座」（待有第二个引擎再发）
