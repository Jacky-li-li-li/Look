# Look 项目深度审计报告（2026-07-11）

## 1. 审计基线

| 维度 | 结果 |
|------|------|
| Lint | `npm run lint` 通过（201 文件，0 error / 0 warning） |
| TypeCheck | `tsconfig.main.json` + `tsconfig.json` 双配置均通过 |
| Test | `npx vitest run`：56 files passed / 2 skipped，319 tests passed / 3 skipped |
| 源码规模 | `src/` 198 个 `.ts/.tsx` 文件，约 36,879 行 |
| pi SDK 版本 | `@earendil-works/pi-*` `^0.80.3` |

> 注：`docs/architecture-review.md` 中记录的「Lint 27 errors / 测试 15 failed」已过期，当前质量门禁已恢复全绿。

---

## 2. 总体评级

| 维度 | 评级 | 说明 |
|------|------|------|
| 功能逻辑正确性 | B+ | 核心路径（会话创建/fork/子代理/权限/Plan/MCP）逻辑正确，少量边界/竞态问题 |
| pi SDK 集成 | A- | 严格遵循 AGENTS.md 约定：单 runtime 实例、bindExtensions、SessionManager、ResourceLoader、Skill `/skill:name` |
| 架构拆分 | B+ | SRT 已拆分为 Catalog/Registry/Factory/EventBus/Notifier/Lifecycle/History/Control/Messaging/Subagent 等服务，但 SRT 仍有 1,312 行，renderer store 仍较庞大 |
| 可维护性 | B+ | lint/type/test 全绿，测试覆盖核心路径，但存在静默吞错、中英混排、console.log 过多 |
| 可扩展性 | B | 单主进程 + 单窗口架构，ExtensionFactory/Skill/Agent 广场预留插件接口，但缺少沙箱与版本管理 |
| 安全性 | B | 进程隔离、路径穿越校验、IM Secret 加密；API Key 仍明文、CSP `img-src` 过宽、第三方 Skill 无隔离 |

---

## 3. pi SDK 集成评估

### 3.1 做得好的地方

- **一会话一 Runtime**：`src/main/session/runtime-registry.ts` 用 `Map<string, ManagedRuntime>` + `initializations` 去重，满足 AGENTS.md「一个 session ID 最多一个 live runtime」。
- **ExtensionFactory 注入合规**：`src/main/session/runtime-factory.ts` 通过 `createAgentSessionFromServices` 注入 `extensionFactories`，没有向 `createAgentSessionServices` 传 `tools` 白名单（`test/pi-runtime-alignment.test.ts` 已回归）。
- **每次 runtime 创建/替换后 bindExtensions**：`SessionRuntimeManager.bindRuntime` 与 `rebindRuntime` 均调用 `session.bindExtensions({ mode: "rpc" })`，并设置 `setRebindSession`。
- **项目信任门控**：`ProjectService.resolveProjectTrust` 使用 `ProjectTrustStore` + `SettingsManager.getDefaultProjectTrust`，`runtime-factory.ts` 通过 `resolveProjectTrust` 回调传给 `ResourceLoader`。
- **Skill 原生调用**：没有二次封装 `skills:invoke`，渲染层直接输入 `/skill:name` 由 pi SDK 处理。
- **历史树/fork 使用 SessionManager**：`session-history-service.ts` 使用 `SessionManager.open(...)` + `createBranchedSession`，不通过 `runtime.fork`。

### 3.2 SDK 集成风险

#### P1 — `bindRuntime` 失败时可能泄漏 runtime

`src/main/session/runtime-manager.ts:647-657`：

```ts
private async createManagedRuntime(...): Promise<ManagedRuntime> {
    const runtime = await this.runtimeFactory.create(...);
    return this.bindRuntime(runtime, projectId, createdAt);
}
```

如果 `bindRuntime` 中 `session.bindExtensions` 或 `permissionService.restoreFromSession` 抛出异常，`runtime` 已被创建但不会被 `dispose()`，也不在 registry 中，造成泄漏。

**建议**：在 `createManagedRuntime` 中 `try/catch` 并在失败时 `await runtime.dispose()`。

#### P1 — `disposeAllRuntimes` 并发遍历 Map 可能跳过条目

`src/main/session/runtime-manager.ts:813-816`：

```ts
async disposeAllRuntimes(): Promise<void> {
    await Promise.all(
        Array.from(this.runtimeRegistry.keys()).map((sessionId) => this.disposeRuntime(sessionId, true)),
    );
}
```

`disposeRuntime` 会 `this.runtimeRegistry.delete(sessionId)`。多个 `disposeRuntime` 并发执行时，`Map.keys()` 迭代器反映的是实时状态，删除尚未访问的 key 可能导致跳过。

**建议**：先 `const keys = [...this.runtimeRegistry.keys()]` 快照再 `Promise.all`。

#### P2 — `event-translator` 对所有 `message_end` 都发射 `assistant_message_end`

`src/main/session/event-translator.ts:126-133`：

```ts
case "message_end": {
    finishActiveBlocks(tracker, events, now);
    const msg = event.message;
    const completed = msg.role !== "assistant" || msg.stopReason !== "aborted";
    events.push({ type: "assistant_message_end", completed, timestamp: now });
    break;
}
```

user / tool_result 消息的 `message_end` 也会生成 `assistant_message_end`。虽然渲染层可能忽略，但语义错误，可能污染 UI 状态机。

**建议**：仅在 `msg.role === "assistant"` 时发射该事件。

#### P2 — `SessionEventProcessor` 静默吞掉 side-effect 错误

`src/main/session/event-processor.ts:87-96`：

```ts
this.host.onAgentEnd(sessionId, event.willRetry).catch(() => {});
...
this.host.onMessageEnd(sessionId, event.message).catch(() => {});
```

`onAgentEnd` 包含刷新目录、持久化权限/Plan 状态；`onMessageEnd` 触发 auto-title 与用量统计。静默吞错会让这些关键副作用失败时无日志。

**建议**：至少记录 `console.error` 或统一 error bus。

---

## 4. 功能逻辑问题

### 4.1 Runtime & Session Core

| 文件 | 行号 | 问题 | 等级 |
|------|------|------|------|
| `session/runtime-manager.ts` | 813-816 | `disposeAllRuntimes` 并发删除 Map key 可能跳过 | P1 |
| `session/runtime-manager.ts` | 647-657 | `bindRuntime` 失败未 dispose runtime | P1 |
| `session/event-translator.ts` | 126-133 | `message_end` 无条件发射 `assistant_message_end` | P2 |
| `session/event-processor.ts` | 87,96 | `.catch(() => {})` 吞掉 side-effect 错误 | P2 |
| `session/session-control-service.ts` | 44-47 | `compress` 只检查 `isStreaming`，未排除 `isRetrying/isCompacting` | P2 |
| `session/session-lifecycle-service.ts` | 90-99 | 当 `preferredModel` 存在时，新会话不会调用 `session.setModel`，依赖 SDK 默认 | P2 |
| `session/session-notifier.ts` | 30-80 | `emitSessionState` 仍会序列化完整 `runtime` 对象与 `entries`（即使 partial） | P2 |

### 4.2 Project & Workspace

| 文件 | 行号 | 问题 | 等级 |
|------|------|------|------|
| `workspace/workspace-file-service.ts` | 182-236 | `importToShared` 对 relative `source` 未强制解析到 home，可能通过 `../../` 引入任意文件 | P1 |
| `projects/project-service.ts` | 1-21 | 文件头注释重复（复制粘贴残留） | P3 |
| `workspace/workspace-file-service.ts` / `workspace-tree-service.ts` | 多处 | `buildNode` / `listChildren` 逻辑重复，未抽象公共 TreeNode builder | P2 |

`importToShared` 相关代码：

```ts
const resolved = path.resolve(source);
if (path.isAbsolute(source) || path.isAbsolute(resolved)) {
    const prefix = homeDir.endsWith(path.sep) ? homeDir : `${homeDir}${path.sep}`;
    if (resolved !== homeDir && !resolved.startsWith(prefix)) {
        throw new Error(`Import source must be within the user home directory: ${source}`);
    }
}
```

当 `source` 为相对路径（如 `../../etc/passwd`）时，`path.isAbsolute(source)` 为 false，但 `path.resolve(source)` 会基于主进程 cwd 解析为绝对路径；由于 `path.isAbsolute(resolved)` 恒为 true，条件进入；但 `resolved.startsWith(prefix)` 可能为 false，会被拒绝。然而如果主进程 cwd 恰好在 home 下，恶意相对路径仍可能落在 home 内并被允许导入。**建议**：一律将 relative source 按 `path.resolve(homeDir, source)` 解析后再校验。

### 4.3 IPC & Cross-Process

| 文件 | 行号 | 问题 | 等级 |
|------|------|------|------|
| `ipc/handlers.ts` | 143-170 | `handleRendererInvoke` 接收一堆参数但实际只依赖闭包 `invokeRouteMap`，参数冗余；窗口重建时旧 handler 引用仍存在直到新 `registerIpcHandlers` 覆盖 | P2 |
| `preload.js` | 33 | 暴露 `process.env.HOME/USERPROFILE`，非敏感但泄露本地路径 | P2 |
| `renderer/store/ipcHandler.ts` | 1078, 1132 | `.catch(() => {})` 吞掉 settings / agent definitions 刷新错误 | P2 |
| `renderer/store/ipcHandler.ts` | 整体 | 1,138 行，仍承担所有事件类型转换，renderer 层「上帝文件」 | P1（架构债） |

### 4.4 Extensions / Permissions / MCP / Models

| 文件 | 行号 | 问题 | 等级 |
|------|------|------|------|
| `permissions/service.ts` | 144-160 | 权限超时后自动 deny，但未 emit `permission:resolved` 事件，UI 可能遗留 pending | P2 |
| `permissions/plan.ts` | 235-272 | `handleApprovalResponse` 在 catch 中 throw 前已 `finishApproval`，可能触发未处理 rejection | P2 |
| `extensions/mcp-extension.ts` | 150-201 | `shellSplitArgs` 自定义 shell split 未处理 `$()`、反引号等，可能产生参数注入 | P2 |
| `mcp/manager.ts` | 87-107 | `persistConfig` 用 `as unknown as Record<string, unknown>` 剥离字段，类型脆弱 | P2 |
| `models/model-provider-service.ts` | 76-93 | `getAvailableModels` 与 `SessionRuntimeManager.getAvailableModelsSync` 重复实现 | P2 |

### 4.5 IM (Feishu/Lark)

| 文件 | 行号 | 问题 | 等级 |
|------|------|------|------|
| `im/lark-bridge-service.ts` | 260, 533, 600 | 发送失败通知时 `.catch(() => {})`，静默失败 | P2 |
| `im/lark-bridge-service.ts` | 603-605 | `handleUserMessage` 的 `finally` 无条件 `replyAccumulators.delete(sessionId)`，即使对话仍在进行也会清掉状态 | P2 |
| `im/lark-channel-manager.ts` | 418 | `disconnect().catch(() => {})` | P2 |
| `im/lark-bridge-service.ts` | 572-589 | 5 分钟超时后未调用 `abortAgent`，session 仍可能在后台运行 | P2 |

### 4.6 Renderer

| 文件 | 行号 | 问题 | 等级 |
|------|------|------|------|
| `renderer/store/atoms.ts` | 51-52 | `initialDataLoadedAtom` 已 deprecated 且无外部引用，可移除 | P3 |
| `renderer/components/chat/SkillSlashMenu.tsx` | 31 | 内部 deprecated 注释，需清理 | P3 |
| `renderer/store/ipcHandler.ts` | 931-933 | `todo:update` 每次 tool_execution_end 触发，对无 TODO.md 的项目也会触发 IPC listSharedFiles 刷新 | P2 |
| `renderer/index.html` | 6-9 | meta CSP 与主进程 header CSP 不一致，`img-src` 仍含 `https:` 通配 | P1（安全） |

---

## 5. 架构评估

### 5.1 主进程拆分（进步明显）

当前 `src/main/session/` 已拆出：

- `runtime-registry.ts`：live runtime 与初始化去重
- `runtime-factory.ts`：pi runtime 构造
- `session-catalog.ts`：JSONL 会话发现
- `session-event-bus.ts`：事件扇出
- `event-translator.ts` + `ui-event-batcher.ts`：SDK → UI 事件翻译与批处理
- `session-lifecycle-service.ts` / `session-history-service.ts` / `session-control-service.ts` / `session-messaging-service.ts` / `session-notifier.ts` / `session-subagent-service.ts` / `session-permission-orchestrator.ts`

相比旧版 2,432 行的 `session-runtime-manager.ts`，职责已大幅下沉。剩余问题：

- `SessionRuntimeManager` 仍是 1,312 行的 facade，连接 20+ 依赖；未来应进一步把 `getAvailableModelsSync`、`getProviderSettings`、`setApiKey` 等模型相关逻辑完全下沉到 `ModelProviderService`。
- `packages/core/src/index.ts` 是空 placeholder，`@look/core` workspace 包无实际导出，说明「把不依赖 Electron 的领域逻辑迁移到 packages/core」的规划尚未落地。

### 5.2 IPC 架构

- 已从巨型 switch 演进为 `src/main/ipc/routers/*.ts` 领域路由 + `handlers.ts` 注册，新增命令无需改中心文件。
- `InvokeContext` 抽象良好，router 只依赖 `ctx`。
- 但 `preload.js` 仍是一份大而全的白名单，新增 IPC 需同步更新；未来可考虑基于 `RendererToMainEvent` 类型生成或校验。

### 5.3 渲染层状态

- `renderer/store/ipcHandler.ts` 1,138 行，承担所有主进程事件 → Jotai atom 的转换。建议按事件域拆分为多个 reducer 文件（session / project / shared / settings / im / plan）。
- `renderer/store/atoms.ts` 352 行，包含 UI / session / project / settings / todo 等多种状态；建议按域拆分。

### 5.4 持久化层

- 无统一 Repository/DAO：`fs.writeFileSync`/JSON.parse 散落在 `settings/*`、`projects/*`、`im/im-storage.ts`、`mcp/manager.ts`、`system/*`。
- 多数写入使用 `tmp + rename` 原子写，这是好的；但缺少统一封装，测试需各自 mock fs。

### 5.5 可扩展性

- ExtensionFactory、Skill 路径、Agent 广场提供了插件化入口。
- 但第三方 Skill/Agent 与主进程共享 Node.js 上下文，无清单、签名、权限声明、沙箱。这是当前最大扩展/安全瓶颈。
- 多窗口/多运行时共享架构未设计：`mainWindow`、`runtimeManager`、`larkChannelManager` 均为全局单例。

---

## 6. 冗余 / 废弃 / 重复代码

| 位置 | 说明 | 建议 |
|------|------|------|
| `packages/core/src/index.ts` | 空 placeholder，workspace 包无导出 | 要么迁移核心逻辑进去，要么移除该 workspace 包 |
| `src/main/session/runtime-manager.ts:92-94` | `EventCallback` 重复 import（一次 type、一次 import） | 删除重复 |
| `src/main/projects/project-service.ts:1-21` | 文件头 JSDoc 重复两次 | 删除重复 |
| `src/main/models/model-provider-service.ts:76-93` 与 `src/main/session/runtime-manager.ts:1121-1139` | `getAvailableModels` / `getAvailableModelsSync` 逻辑重复 | 统一调用 `ModelProviderService` |
| `workspace-file-service.ts` 与 `workspace-tree-service.ts` | `buildNode`、path resolution、ignore 逻辑重复 | 抽象公共 tree-node builder |
| `src/renderer/store/atoms.ts:51-52` | `initialDataLoadedAtom` deprecated 且无引用 | 删除 |
| `src/renderer/components/chat/SkillSlashMenu.tsx:31` | 内部 deprecated 注释 | 清理 |
| 大量 `console.log` / `console.warn` | 生产环境仍输出 | 引入日志级别与生产禁用，或对敏感字段脱敏 |

---

## 7. 安全审计

### 7.1 已落地的好实践

- `contextIsolation: true`、`nodeIntegration: false`、preload 白名单。
- 共享区/工作区路径穿越校验 `resolveInsideRoot` + `realpath`。
- IM `appSecret` 使用 Electron `safeStorage` 加密存储（含降级提示）。
- Plan 模式 bash 白名单、权限 ask/always/plan 三级门控。

### 7.2 仍需整改

#### P0 — API Key 明文存储

`~/.look/auth.json`（pi SDK `AuthStorage`）与 `~/.look/custom-providers.json` 中的 `apiKey` 均以明文保存。这是当前最严重的安全隐患。

**建议**：
1. 将 `im-storage.ts` 的 `safeStorage` 方案推广到 API Key。
2. 提供降级路径：当 `safeStorage.isEncryptionAvailable()` 为 false 时提示用户设置主密码或明确接受风险，不能静默回退明文。
3. 旧版明文文件迁移后删除。

#### P1 — CSP `img-src` 过宽 + meta/header 不一致

主进程 `src/main/index.ts:188-211` 的 header CSP 已收紧 `connect-src`，但 `img-src` 仍包含 `https:` 通配；`src/renderer/index.html` 的 meta CSP 更宽松（`connect-src 'self' https:`）。

**建议**：
- `img-src` 移除 `https:`，改为 `'self' data: blob: file:`；如需网络头像追加具体 CDN 域名。
- 同步 meta CSP 与 header CSP，避免审计误读。

#### P1 — 第三方 Skill / Agent 无沙箱

Skill/Agent 通过文件路径直接加载到 pi SDK `ResourceLoader`，与主进程共享上下文。

**建议**：
- 引入 `skill.json` / agent 清单与权限声明。
- 内置 Skill/Agent 保持当前路径加载。
- 用户导入的第三方 Skill 高风险操作应至少做权限提示，长期考虑 Worker / utilityProcess 隔离。

#### P2 — 日志泄露

`console.error`/`console.warn` 在主进程可能输出完整错误对象、路径、消息内容。`setupProcessBoundary` 将 uncaught exception 通过 IPC 推给渲染层。

**建议**：统一日志接口，敏感字段脱敏；渲染层只接收用户友好消息。

#### P2 — 自动更新签名

`electron-builder.yml` 配置了 macOS `hardenedRuntime` + entitlements，但未配置 Notarization；Windows 无签名配置。

**建议**：补充代码签名与更新包校验和。

---

## 8. 性能与可维护性

### 8.1 性能

- 渲染层 rAF 批处理（`ipcHandler.ts`）与主进程 8ms UI 事件批处理（`UIEventBatcher`）已落地。
- 工作区树懒加载、会话扫描并发控制（`SESSION_SUMMARY_CONCURRENCY = 10`）合理。
- 但 `SessionNotifier.emitSessionState` 每次激活仍传输完整 `runtime` 对象与完整 `entries`（即使 partial 也是先传后 100 条再全量）。长会话应评估增量/分页同步。
- 文件 watcher 按项目/目录独立，缺少全局上限监控。

### 8.2 可维护性

- lint/type/test 全绿，CI 门禁已具备接入条件。
- 测试覆盖核心服务，但缺少 E2E/集成测试验证 IPC 端到端。
- 中英混排注释仍存在（如 `workspace-tree-service.ts`、`lark-bridge-service.ts`），核心模块建议统一英文注释。
- 多处 `.catch(() => {})` 让线上问题难以定位。

---

## 9. 整改建议 Roadmap

### Phase 1：安全与质量门禁（立即 - 2 周）

1. **API Key 加密**：推广 `safeStorage` 到 `auth.json` / `custom-providers.json`，含迁移与降级路径。
2. **收紧 CSP**：`img-src` 移除 `https:`，同步 `renderer/index.html` meta CSP。
3. **修复静默吞错**：所有 `.catch(() => {})` 至少记录 `console.error` 或统一 error bus。
4. **修复 `disposeAllRuntimes` 竞态**：先快照 keys。
5. **修复 `bindRuntime` 失败泄漏**：try/finally dispose。

### Phase 2：功能正确性（2 - 4 周）

1. `event-translator` 仅对 assistant role 发射 `assistant_message_end`。
2. `importToShared` 强制 relative source 解析到 home 后再校验。
3. `SessionControlService.compress` 增加 `isRetrying/isCompacting` 保护。
4. `lark-bridge-service` 超时后调用 `abortAgent`；修正 `finally` 清理逻辑。
5. 权限超时自动 deny 时同步 emit `permission:resolved`。

### Phase 3：架构债务（1 - 3 个月）

1. 继续拆分 SRT：把模型/设置相关查询完全下沉到 `ModelProviderService` / `UserSettingsStore`。
2. 拆分 renderer `store/ipcHandler.ts` 为领域 reducer；拆分 `store/atoms.ts`。
3. 抽象公共 `TreeNodeBuilder` / `Repository`，统一 `tmp + rename` 写入。
4. 落地 `packages/core`：把不依赖 Electron 的领域逻辑迁移进去。
5. 引入统一日志与错误分级。

### Phase 4：扩展与安全（3 - 6 个月）

1. 第三方 Skill/Agent 沙箱化：权限声明 + Worker / utilityProcess 隔离。
2. 多窗口架构预研。
3. 长会话快照增量同步。
4. 自动更新代码签名与校验。

---

## 10. 结论

Look 当前代码库在 pi SDK 集成、主/渲染进程隔离、测试覆盖方面已达到较高水准，lint/type/test 全绿，架构拆分相较旧版有显著进步。主要风险集中在：

1. **安全**：API Key 明文、CSP 过宽、第三方 Skill 无隔离。
2. **功能边界**：`bindRuntime` 失败泄漏、`disposeAllRuntimes` 竞态、`message_end` 事件语义错误、`importToShared` 路径校验漏洞。
3. **架构债**：SRT / renderer store 仍偏大、持久化层未统一、`packages/core` 空置。

建议优先完成 Phase 1 与 Phase 2 中的 P0/P1 项，再逐步推进架构重构。
