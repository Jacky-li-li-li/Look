# 剩余 react-doctor 警告处理方案

当前基线（执行完 Provider 设置重构后）：

- **warningCount: 23**
- **score: 65**
- `npm run check` 通过

本方案按**改动风险 / 收益**把剩余警告分成四类，并给出每一类的具体处理动作和预期收益。

---

## 一、速赢项（低改动、高确定性）

### 1.1 ContentEditableInput — 恢复 `role="textbox"`

**当前警告**

- `no-static-element-interactions`（line 463）
- `no-noninteractive-tabindex`（line 465）

**原因**

上一轮为消除 `prefer-tag-over-role` 移除了 `role="textbox"`，结果 contenteditable div 既无 role 又有 `tabIndex/keyboard/paste` 事件，反而引入两条更差的警告。

**方案**

恢复 `role="textbox"`：

```tsx
<div
  ref={editorRef}
  role="textbox"
  tabIndex={0}
  aria-multiline="true"
  aria-label="chat input"
  contentEditable
  ...
>
```

**结果**

- 2 条 warning → 1 条 `prefer-tag-over-role`
- 净减少 **1 条 warning**

---

### 1.2 WorkspaceTreePanel — `rootChildren` 加 `useMemo`

**当前警告**

- `exhaustive-deps` line 130："`rootChildren` is rebuilt every render, so `useMemo` runs every time."

**原因**

```ts
const rootChildren = loaded.get("") ?? [];
const flatRows = useMemo(() => flattenTree(rootChildren, expanded, loaded), [rootChildren, expanded, loaded]);
```

`rootChildren` 是每次 render 重新计算的数组/空数组，导致 `useMemo` 的依赖不稳定。

**方案**

```ts
const rootChildren = useMemo(() => loaded.get("") ?? [], [loaded]);
const flatRows = useMemo(() => flattenTree(rootChildren, expanded, loaded), [rootChildren, expanded, loaded]);
```

`loaded` 是 Jotai atom 值，引用稳定，这样 `rootChildren` 只在 `loaded` 变化时重建。

**结果**

- 消除 **1 条 warning**

---

### 1.3 StreamingMarkdown — 消除 HTML 注入 sink

**当前警告**

- `dangerous-html-sink` line 141

**原因**

Shiki 高亮后的 HTML 通过 `dangerouslySetInnerHTML` 注入。虽然值来自可信的 Shiki，但 react-doctor 无法识别来源。

**方案 A（推荐）：用 DOMPurify 清洗**

安装依赖：

```bash
npm install -D @types/dompurify
npm install dompurify
```

在 renderer 使用：

```ts
import DOMPurify from "dompurify";

const safeHtml = DOMPurify.sanitize(html);
```

```tsx
<div
  className="shiki-code-output"
  // biome-ignore lint/security/noDangerouslySetInnerHtml: sanitized Shiki markup
  dangerouslySetInnerHTML={{ __html: safeHtml }}
/>
```

**方案 B（更彻底）：把 Shiki HAST 转成 React 节点**

Shiki 支持输出 HAST，再用 `hast-util-to-jsx-runtime` 转成 JSX：

```ts
import { codeToHast } from "shiki";
import { toJsxRuntime } from "hast-util-to-jsx-runtime";
import { Fragment, jsx, jsxs } from "react/jsx-runtime";

const hast = await codeToHast(code, { lang, theme });
const element = toJsxRuntime(hast, { Fragment, jsx, jsxs });
```

这样可以完全移除 `dangerouslySetInnerHTML`。

**结果**

- 消除 **1 条 warning**
- 方案 A 改动最小；方案 B 无 HTML sink 但需验证样式兼容性

---

## 二、中等重构项（拆分组件，降低行数）

这些组件的 `no-giant-component` 警告都因为主组件超过 ~300 行。处理思路是**把纯渲染/纯逻辑片段抽成子组件或自定义 hook**。

### 2.1 AddCustomProviderDialog（当前 319 行）

**当前警告**

- `no-giant-component` line 158

**方案**

状态已在前一轮分组完成，现在只需把 `FormBody` 里的 4 个 section 抽到独立文件：

| 新文件 | 负责 |
|---|---|
| `src/renderer/components/settings/ProviderConnectionFields.tsx` | API 协议、name、baseUrl、apiKey、showKey |
| `src/renderer/components/settings/ProviderHeadersSection.tsx` | Headers 折叠列表 |
| `src/renderer/components/settings/ProviderModelsSection.tsx` | Models 增删改 |
| `src/renderer/components/settings/ProviderCompatSection.tsx` | 5 个 compat flag |

`FormBody` 只负责组合：

```tsx
function FormBody({ form, patchForm, patchCompat, errors, ... }) {
  return (
    <form ...>
      <ProviderConnectionFields ... />
      <ProviderHeadersSection ... />
      <ProviderModelsSection ... />
      <ProviderCompatSection ... />
      {testResult && <TestResultsPanel ... />}
    </form>
  );
}
```

**结果**

- 消除 **1 条 warning**
- 主组件预计降到 200 行以内

---

### 2.2 ApiKeysTab（当前 331 行）

**当前警告**

- `no-giant-component` line 340

**方案**

状态已分组完成，现在把剩余 UI 拆成两个子组件：

| 新文件 | 负责 |
|---|---|
| `src/renderer/components/settings/BuiltInProvidersList.tsx` | 遍历 `providers` 渲染 `BuiltInProviderRow`，处理 expand/test/save |
| `src/renderer/components/settings/CustomProvidersSection.tsx` | 自定义 provider 列表 + AddCustomProviderDialog 开关 + remove 确认 |

`ApiKeysTab` 主组件只保留：

- 4 个 state slice
- 4 个 `patchXxx` helper
- 渲染 `<BuiltInProvidersList ... />` 和 `<CustomProvidersSection ... />`
- `loadCustomProviders`

**结果**

- 消除 **1 条 warning**
- 主组件预计降到 180 行以内

---

### 2.3 ContentEditableInput（当前 365 行）

**当前警告**

- `no-giant-component` line 130

**方案**

拆分出：

| 新文件 | 负责 |
|---|---|
| `src/renderer/components/ContentEditableEditor.tsx` | 真正的 `contentEditable` div + 所有事件处理器 |
| `src/renderer/hooks/usePasteAndDrop.ts` | 处理 `onPaste` / `onDrop` / `onDragOver` 的逻辑，返回 `{ handlePaste, handleDrop, handleDragOver }` |
| `src/renderer/components/ContentEditablePlaceholder.tsx` | placeholder 渲染（可选，若主组件仍大） |

主组件 `ContentEditableInput` 只负责：

- 暴露 `ref`（`getText/setText/focus`）
- 维护内部 `html` state
- 组合 `<ContentEditableEditor />` 和 placeholder

**结果**

- 消除 **1 条 warning**
- 主组件预计降到 200 行以内

---

## 三、大型重构项（投入大，需权衡）

这些组件都在 400+ 行，拆分会显著改动 props 流和回调链路，收益是消除 warning 和提升可维护性，风险是引入回归。

### 3.1 App.tsx（当前 557 行）

**当前警告**

- `no-giant-component` line 97

**方案**

抽成 3 个独立单元：

| 新文件 | 负责 |
|---|---|
| `src/renderer/hooks/useAppAuth.ts` | `restoreSession`、Supabase auth 监听、profile 加载 |
| `src/renderer/hooks/useAppActions.ts` | 所有 `handleXxx` 回调（send/select/close/destroy/create/rename/open-folder/settings） |
| `src/renderer/components/AppLayout.tsx` | 渲染 Sidebar / SessionSheetBar / ChatPanel / RightPanel / EmptyState |
| `src/renderer/components/AppDialogs.tsx` | 聚合所有 Dialog：Permission / PlanQuestion / PlanApproval / NewProject / DeleteProject / Settings / UpdateNotification |

`App.tsx` 变成：

```tsx
export default function App() {
  useAppAuth();
  const actions = useAppActions();
  return (
    <ThemeProvider ...>
      <AppLayout actions={actions} />
      <AppDialogs />
    </ThemeProvider>
  );
}
```

**结果**

- 消除 **1 条 warning**
- 但涉及 10+ 个回调和 atom 读写，建议拆完后完整手动回归一次登录/会话切换/设置流程

---

### 3.2 ChatInput.tsx（当前 520 行）

**当前警告**

- `no-giant-component` line 57

**方案**

状态已分组完成，继续拆分 UI：

| 新文件 | 负责 |
|---|---|
| `src/renderer/components/ChatInputToolbar.tsx` | ModelSelector / ThinkingSelector / SubagentToggle / PermissionModeSelector / Send/Abort 按钮 |
| `src/renderer/components/PendingImagePreviews.tsx` | 图片缩略图 + 放大 Dialog |
| `src/renderer/components/ChatInputPickers.tsx` | AgentHashMenu / SkillSlashMenu 组合 + 键盘索引切换 |

`ChatInput` 主组件只保留：

- 4 个 state slice
- `setInput` / `handleSend` / `handleEditorChange` / `handleEditorKeyDown`
- 组合上述子组件

**结果**

- 消除 **1 条 warning**
- 预计主组件降到 250 行以内

---

### 3.3 Sidebar.tsx（当前 413 行）

**当前警告**

- `no-giant-component` line 371

**方案**

已有 `ProjectItem` / `SessionRow` 等子组件，但主组件仍大。进一步拆分：

| 新文件 | 负责 |
|---|---|
| `src/renderer/components/SidebarHeader.tsx` | 顶部项目操作按钮（New Project / Open Project / Settings） |
| `src/renderer/components/SidebarProjectList.tsx` | 项目列表 + 展开/折叠/编辑逻辑 |
| `src/renderer/components/SidebarEmptyState.tsx` | 无项目时的空状态 |

`Sidebar` 主组件只保留：

- edit state、expanded/collapsed sets
- `beginEdit` / `cancelEdit` / `commitEdit`
- 组合子组件

**结果**

- 消除 **1 条 warning**
- 预计主组件降到 250 行以内

---

## 四、建议保留或压制的警告

以下警告改动收益低、风险高，或本身就是业务正确性所需的写法，建议记录原因后保留。

### 4.1 主进程中的 `async-await-in-loop` / `async-defer-await`

涉及文件：

- `src/main/extensions/subagent/agent-runner.ts:100`
- `src/main/session-runtime-manager.ts:1149, 2390`
- `src/main/workspace/workspace-file-service.ts:206, 273`

**保留理由**

- `agent-runner.ts`：Subagent chain 必须**顺序执行**，后一步依赖前一步的 `previousOutput`，不能并行。
- `session-runtime-manager.ts:2390`：`ensurePlanDirectory` 里先建 `contextDir` 再建 `planDir`，且需对每个目录 `lstat` 校验，顺序更稳妥。
- `workspace-file-service.ts:206`：批量 import 文件时，任一步失败都要回滚已导入项，并行会让回滚语义复杂化。
- `workspace-file-service.ts:273`：`chokidar.watch` 需要等待 `ready` 事件后才能判断并发创建问题，guard 必须在 await 之后。

**如果一定要消除**

- 对 `ensurePlanDirectory` 可把 `mkdir+lstat` 包成对单个目录的函数，再用 `Promise.all([ensureDir(contextDir), ensureDir(planDir)])` 并行，但收益很小。
- 其他几个不建议硬改。

---

### 4.2 `ModelSelector.tsx` line 69 — `async-defer-await`

**保留理由**

```ts
const result = await api.switchModel(targetAgentId, modelKey);
if (latestPropsRef.current.onModelChanged !== onChange) return;
```

这里的 post-await guard 是为了防止用户在请求过程中切换了当前 agent。如果改成 pre-await guard，guard 永远为 false（因为 `onChange` 刚从 ref 读出），失去意义。

**如果一定要消除**

可在 await 前加一个形式上的 pre-guard（永远为 false），但属于欺骗 linter，不推荐。

---

### 4.3 `WorkspaceTreePanel.tsx` 剩余警告

剩余：

- `exhaustive-deps` line 120（`watchedPathsRef.current`）
- `async-defer-await` line 164 / 211

**保留理由**

- `watchedPathsRef` 是 mutable ref，cleanup 必须在执行时读取最新 `.current`，不能把它加入 deps 变成稳定闭包。
- `async-defer-await` 两处都是：先 `await listWorkspaceChildren`，再用 `operationGenRef.current !== gen` 丢弃过期请求。gen 在 await 前设置，guard 只能在 await 后生效。

**如果一定要消除 `async-defer-await`**

可在 await 前加一个无意义的 `if (operationGenRef.current !== gen) return;`（此时恒为 false），但同样只是欺骗工具。

---

### 4.4 `AgentHashMenu` / `SkillSlashMenu` / `SessionSheetBar` 的 `prefer-tag-over-role`

| 文件 | 当前 role | 问题 |
|---|---|---|
| `AgentHashMenu.tsx:111` | `listbox` | 用 `<datalist>` 语义不对，且需要自定义键盘导航 |
| `SkillSlashMenu.tsx:197` | `listbox` | 同上 |
| `SessionSheetBar.tsx:83` | `button` | dnd-kit sortable item 用 div + role="button" 是官方推荐模式，改成真实 `<button>` 会与内部按钮嵌套冲突 |

**建议**：保留 role，必要时在代码注释里说明这是 dnd-kit / 自定义 listbox 的标准做法。

---

## 五、整体实施建议

### 推荐顺序

1. **速赢项**：恢复 `ContentEditableInput` role、加 `WorkspaceTreePanel` memo、处理 `StreamingMarkdown` HTML sink
2. **中等重构**：`AddCustomProviderDialog` / `ApiKeysTab` / `ContentEditableInput` 拆分
3. **大型重构**（可选）：`App` / `ChatInput` / `Sidebar`
4. **保留项**：主进程 async、ModelSelector、WorkspaceTreePanel ref、role 警告

### 预期收益估算

| 阶段 | 预计消除 warning | 预计 score |
|---|---|---|
| 速赢项 | 3 | 66 |
| 中等重构 | 3 | 67–68 |
| 大型重构 | 3 | 69–70 |
| 保留项 | — | — |

如果只做速赢 + 中等重构，预计最终 **17 条 warning，score 67–68**。
