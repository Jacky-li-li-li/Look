# Provider 设置状态重构方案

目标：消除 `AddCustomProviderDialog` 与 `ApiKeysTab` 的 `prefer-useReducer`、`no-many-boolean-props`、`no-giant-component` 三条 react-doctor 警告，同时保持现有行为和类型安全。

---

## 1. AddCustomProviderDialog.tsx

### 1.1 当前问题

- 主组件存在 12+ 个 `useState`：name / baseUrl / apiProtocol / apiKeyVal / showKey / headers / headersOpen / models + 5 个 compat flag + saving + testResult。
- `FormBody` 接收 5 个 compat boolean + 3 个 error boolean，触发 `no-many-boolean-props`。
- `FormBody` 本身超过 300 行，触发 `no-giant-component`。

### 1.2 状态重构

#### 新增类型（建议放在 `src/renderer/components/settings/provider-form-state.ts`）

```ts
import type { CustomProviderInput, CustomProviderModelInput } from "./types";

export type ApiProtocol = CustomProviderInput["api"];

export interface ProviderCompatState {
  supportsDeveloperRole: boolean;
  supportsReasoningEffort: boolean;
  forceAdaptiveThinking: boolean;
  supportsEagerToolInputStreaming: boolean;
  allowEmptySignature: boolean;
}

export interface ProviderFormState {
  api: ApiProtocol;
  name: string;
  baseUrl: string;
  apiKey: string;
  showKey: boolean;
  headers: Array<{ id: number; key: string; value: string }>;
  headersOpen: boolean;
  models: Array<CustomProviderModelInput & { _key: number }>;
  compat: ProviderCompatState;
}

export interface ProviderFormErrors {
  name?: boolean;
  baseUrl?: boolean;
  apiKey?: boolean;
}

export function buildInitialForm(initial?: CustomProviderInput): ProviderFormState {
  return {
    api: normalizeApiProtocol(initial?.api),
    name: initial?.name ?? "",
    baseUrl: initial?.baseUrl ?? "",
    apiKey: initial?.apiKey ?? "",
    showKey: false,
    headers: initial?.headers
      ? Object.entries(initial.headers).map(([k, v], i) => ({ id: i + 1, key: k, value: v }))
      : [],
    headersOpen: false,
    models: initial?.models.map((m, i) => ({ ...m, _key: i + 1 })) ?? [],
    compat: {
      supportsDeveloperRole: initial?.compat?.supportsDeveloperRole !== false,
      supportsReasoningEffort: initial?.compat?.supportsReasoningEffort !== false,
      forceAdaptiveThinking: !!initial?.compat?.forceAdaptiveThinking,
      supportsEagerToolInputStreaming: initial?.compat?.supportsEagerToolInputStreaming !== false,
      allowEmptySignature: !!initial?.compat?.allowEmptySignature,
    },
  };
}
```

#### 主组件保留的 useState

```ts
const [form, setForm] = useState<ProviderFormState>(() => buildInitialForm(initial));
const [saving, setSaving] = useState(false);
const [testResult, setTestResult] = useState<TestCustomProviderResult | null>(null);
```

#### 通用 patch helper

```ts
const patchForm = useCallback(
  <K extends keyof ProviderFormState>(key: K, value: ProviderFormState[K]) => {
    setForm((prev) => ({ ...prev, [key]: value }));
  },
  [],
);

const patchCompat = useCallback(
  <K extends keyof ProviderCompatState>(key: K, value: boolean) => {
    setForm((prev) => ({ ...prev, compat: { ...prev.compat, [key]: value } }));
  },
  [],
);
```

这样 `useState` 数量从 12 降到 3，满足 react-doctor 阈值。

### 1.3 子组件拆分

把 `FormBody` 拆成 4 个独立组件，全部放到 `src/renderer/components/settings/`：

| 文件 | 职责 | 关键 props |
|---|---|---|
| `ProviderConnectionFields.tsx` | API 协议、name、baseUrl、apiKey、showKey | `form`, `patchForm`, `errors`, `isEdit`, `t` |
| `ProviderHeadersSection.tsx` | Headers 折叠/增删改 | `headers`, `headersOpen`, `onAdd/update/remove`, `onToggleOpen`, `t` |
| `ProviderModelsSection.tsx` | Models 列表/增删改 | `models`, `onAdd/update/remove`, `newItemKey`, `t` |
| `ProviderCompatSection.tsx` | 5 个 compat flag | `compat`, `api`, `onChange`, `t` |

新的 `FormBody` 只剩骨架：

```tsx
function FormBody({
  form,
  patchForm,
  patchCompat,
  errors,
  saving,
  testResult,
  isEdit,
  newItemKey,
  addModel,
  updateModel,
  removeModel,
  addHeader,
  updateHeader,
  removeHeader,
  t,
}: FormBodyProps) {
  return (
    <form className="space-y-5" onSubmit={(e) => e.preventDefault()}>
      <ProviderConnectionFields form={form} patchForm={patchForm} errors={errors} isEdit={isEdit} t={t} />
      <ProviderHeadersSection
        headers={form.headers}
        headersOpen={form.headersOpen}
        onToggleOpen={() => patchForm("headersOpen", !form.headersOpen)}
        onAdd={addHeader}
        onUpdate={updateHeader}
        onRemove={removeHeader}
        t={t}
      />
      <ProviderModelsSection
        models={form.models}
        onAdd={addModel}
        onUpdate={updateModel}
        onRemove={removeModel}
        newItemKey={newItemKey}
        t={t}
      />
      <ProviderCompatSection compat={form.compat} api={form.api} onChange={patchCompat} t={t} />
      {testResult && <TestResultsPanel result={testResult} t={t} />}
    </form>
  );
}
```

### 1.4 错误提示对象化

把 `hasNameError` / `hasBaseUrlError` / `hasApiKeyError` 合并为 `errors: ProviderFormErrors`：

```ts
const errors: ProviderFormErrors = useMemo(() => ({
  name: validationErrors.some((e) => e.includes("name")),
  baseUrl: validationErrors.some((e) => e.includes("baseUrl")),
  apiKey: validationErrors.some((e) => e.includes("apiKey")),
}), [validationErrors]);
```

这样 `FormBody` 不再接收大量 boolean prop。

---

## 2. ApiKeysTab.tsx

### 2.1 当前问题

- 主组件 12 个 `useState`。
- 主组件 718 行，触发 `no-giant-component`。

### 2.2 状态分组

#### 新增类型（建议放在同一文件顶部或 `src/renderer/components/settings/api-keys-state.ts`）

```ts
interface KeyEditState {
  editing: string | null;
  input: string;
  showKey: boolean;
}

interface UiState {
  saving: boolean;
  loadingKey: boolean;
  testStatus: Record<string, TestVerdict>;
  forceSave: ForceSaveState;
}

interface AccordionState {
  providers: Record<string, boolean>;
  customProviders: Record<string, boolean>;
}

interface CustomPanelState {
  view: { type: "list" } | { type: "form"; editing?: CustomProviderInput };
  list: CustomProviderInput[];
  confirmRemove: string | null;
  confirmClear: ProviderInfo | null;
}
```

#### 主组件只保留 4 个 useState

```ts
const [keyEdit, setKeyEdit] = useState<KeyEditState>({
  editing: null,
  input: "",
  showKey: false,
});

const [ui, setUi] = useState<UiState>({
  saving: false,
  loadingKey: false,
  testStatus: {},
  forceSave: null,
});

const [accordion, setAccordion] = useState<AccordionState>({
  providers: {},
  customProviders: {},
});

const [custom, setCustom] = useState<CustomPanelState>({
  view: { type: "list" },
  list: [],
  confirmRemove: null,
  confirmClear: null,
});
```

#### patch helper

```ts
const patchKeyEdit = useCallback(
  <K extends keyof KeyEditState>(key: K, value: KeyEditState[K]) =>
    setKeyEdit((prev) => ({ ...prev, [key]: value })),
  [],
);

const patchUi = useCallback(
  <K extends keyof UiState>(key: K, value: UiState[K]) =>
    setUi((prev) => ({ ...prev, [key]: value })),
  [],
);

const patchAccordion = useCallback(
  <K extends keyof AccordionState>(key: K, value: AccordionState[K]) =>
    setAccordion((prev) => ({ ...prev, [key]: value })),
  [],
);

const patchCustom = useCallback(
  <K extends keyof CustomPanelState>(key: K, value: CustomPanelState[K]) =>
    setCustom((prev) => ({ ...prev, [key]: value })),
  [],
);
```

### 2.3 子组件拆分

新增 `src/renderer/components/settings/CustomProvidersSection.tsx`：

```ts
interface CustomProvidersSectionProps {
  customProviders: CustomProviderInput[];
  expanded: Record<string, boolean>;
  view: CustomPanelState["view"];
  confirmRemove: string | null;
  onToggleExpand: (name: string) => void;
  onEdit: (cp: CustomProviderInput) => void;
  onRemove: (name: string) => void;
  onViewChange: (view: CustomPanelState["view"]) => void;
  onListChange: (list: CustomProviderInput[]) => void;
  onProvidersChange: ApiKeysTabProps["onProvidersChange"];
}
```

它内部负责：
- 渲染 `CustomProviderRow` 列表
- 打开/关闭 `AddCustomProviderDialog`
- 调用 IPC 增删改后通过 `onProvidersChange` 同步到父组件

`ApiKeysTab` 主组件只负责：
- 渲染内置 provider 列表（`BuiltInProviderRow`）
- 渲染 `CustomProvidersSection`
- 保存/测试 key 的 IPC 调用

### 2.4 BuiltInProviderRow prop 简化

把与 key 编辑相关的外部状态打包：

```ts
interface BuiltInProviderRowProps {
  provider: ProviderInfo;
  isExpanded: boolean;
  testStatus: TestVerdict;
  editor: KeyEditState & Pick<UiState, "saving" | "loadingKey" | "forceSave">;
  onToggleExpand: () => void;
  onOpenEditor: () => void;
  onSave: () => void;
  onForceSave: () => void;
  onClear: () => void;
}
```

---

## 3. 实施顺序

建议分阶段推进，降低回归风险：

### Phase 1：状态分组（先消除 prefer-useReducer）

1. `AddCustomProviderDialog`：
   - 新增 `provider-form-state.ts` 类型与 `buildInitialForm`。
   - 把主组件的 12 个 `useState` 合并为 `form / saving / testResult`。
   - 提供 `patchForm` / `patchCompat` helper。
   - 把所有 `setXxx` 调用改为 `patchForm` / `patchCompat`。
   - 跑 `npm run check`。

2. `ApiKeysTab`：
   - 新增 4 个 state slice 类型。
   - 把 12 个 `useState` 合并为 4 个对象状态。
   - 提供 `patchKeyEdit` / `patchUi` / `patchAccordion` / `patchCustom`。
   - 跑 `npm run check`。

### Phase 2：子组件拆分（再消除 no-giant-component / no-many-boolean-props）

1. `AddCustomProviderDialog`：
   - 拆分 `ProviderConnectionFields`、`ProviderHeadersSection`、`ProviderModelsSection`、`ProviderCompatSection`。
   - 把 `FormBody` 的 boolean error prop 改为 `errors` 对象。
   - 跑 `npm run check`。

2. `ApiKeysTab`：
   - 拆分 `CustomProvidersSection`。
   - 简化 `BuiltInProviderRow` 的 prop 接口。
   - 跑 `npm run check`。

---

## 4. 预期收益

| 文件 | 当前 warning | 预期剩余 warning |
|---|---|---|
| `AddCustomProviderDialog.tsx` | `prefer-useReducer` (1) + `no-many-boolean-props` (1) + `no-giant-component` (2) | 0 |
| `ApiKeysTab.tsx` | `prefer-useReducer` (1) + `no-giant-component` (1) | 0 |

预计总 warning 从 27 降到约 **21–22**，react-doctor 分数可能从 64 提升到 **66–68**。

---

## 5. 风险与回滚

- 这两个组件没有独立测试，主要依赖 `tsc` / `biome` / 现有集成测试，Phase 1 和 Phase 2 之间务必跑 `npm run check`。
- 所有改动都是 props/状态搬运，不改动 IPC 调用语义。
- 建议 Phase 1 完成后先提交/保存一次，便于回滚。
