# Look 多语言（i18n）实施计划

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** 实现真正的 UI 多语言切换功能。当前 SettingsDialog 中已有语言选择器（en/zh/ja），但切换后 UI 没有任何变化。需要将所有硬编码字符串替换为可翻译的 key，并让语言切换即时生效。

**Architecture:** 使用 `react-i18next`（`i18next` + React 绑定）作为 i18n 方案。翻译文件为 JSON 格式存放在 `src/renderer/locales/` 目录下。通过 React Context（`I18nextProvider`）全局提供翻译函数 `t()`。语言偏好从主进程的 `ui-settings.json` 中读取并联动。

**Tech Stack:** react-i18next, i18next, i18next-browser-languagedetector（可选，用于浏览器环境语言检测）

---

## 为什么选 react-i18next

| 方案 | 优势 | 劣势 | 适用性 |
|------|------|------|--------|
| **react-i18next** ✅ | 轻量、hooks API、命名空间、TypeScript、React 19 兼容 | 需要手动管理 JSON | Electron + React 首选 |
| react-intl (FormatJS) | ICU 消息格式强、国际化完整 | 体积大、学习曲线陡 | 复杂国际化需求 |
| LinguiJS | 消息提取自动化、编译时优化 | 生态小、集成复杂 | 新项目 |
| 自研 Context | 完全控制 | 缺少成熟工具链 | 不推荐 |

react-i18next 被 VS Code（Electron）、Linear、Notion 等一线产品使用，成熟度高。

---

## 实施顺序总览

```
Phase 1: 基础设施搭建         ← 先完成
  Task 1: 安装依赖
  Task 2: 创建翻译 JSON 文件（en/zh/ja）
  Task 3: 创建 i18n.ts 配置
  Task 4: 在 index.tsx 中集成 I18nextProvider
  Task 5: 从 settings 读取语言偏好并初始化

Phase 2: 核心组件翻译（由高到低曝光）← 按顺序逐个组件
  Task 6:  SettingsDialog（高曝光，种类多）
  Task 7:  Sidebar
  Task 8:  ChatPanel
  Task 9:  MessageBubble + ExecutionProcess
  Task 10: AgentCreateDialog
  Task 11: ModelSelector + ThinkingSelector

Phase 3: 辅助组件 + 细节
  Task 12: PermissionDialog
  Task 13: ToolCallCard
  Task 14: PixelAgentAvatar, SkillSlashMenu 等剩余组件
  Task 15: App.tsx 中的 toast 消息

Phase 4: 验证 + 收尾
  Task 16: 语言切换即时生效验证
  Task 17: 运行 lint + typecheck，确保无回归
  Task 18: 自测三种语言覆盖完整性
```

---

## Phase 1: 基础设施搭建

### Task 1: 安装依赖

**Files:**
- Modify: `package.json` (dependencies)

**Step 1: 安装 react-i18next 和 i18next**

```bash
cd /Users/jacky/Desktop/pi
npm install react-i18next i18next
```

**Step 2: 验证安装**

```bash
npm ls react-i18next i18next
```

**Commit:**
```bash
git add package.json package-lock.json
git commit -m "deps: add react-i18next and i18next for i18n"
```

---

### Task 2: 创建翻译 JSON 文件

**Files:**
- Create: `src/renderer/locales/en.json`
- Create: `src/renderer/locales/zh.json`
- Create: `src/renderer/locales/ja.json`

这三个文件是翻译的基础。下面给出**完整的**初始翻译内容，覆盖当前全部硬编码字符串。

#### `src/renderer/locales/en.json`

```json
{
  "common": {
    "ok": "OK",
    "cancel": "Cancel",
    "save": "Save",
    "delete": "Delete",
    "close": "Close",
    "loading": "Loading...",
    "confirm": "Confirm",
    "reset": "Reset"
  },
  "sidebar": {
    "chat": "Chat",
    "orch": "Orch",
    "newAgent": "New Agent",
    "settings": "Settings",
    "noChatAgents": "No chat agents yet.",
    "noOrchAgents": "No orchestration agents yet.",
    "clickNewAgent": "Click + New Agent."
  },
  "settings": {
    "title": "Settings",
    "description": "Customize appearance, manage API keys, and more.",
    "general": "General",
    "apiKeys": "API Keys",
    "chatPrompt": "Chat Prompt",
    "about": "About",
    "appearance": "Appearance",
    "theme": "Theme",
    "darkMode": "Dark mode",
    "lightMode": "Light mode",
    "language": "Language",
    "interfaceLanguage": "Interface language",
    "behavior": "Behavior",
    "defaultThinking": "Default Thinking",
    "thinkingDesc": "Reasoning depth for new agents",
    "autoCollapse": "Auto Collapse",
    "autoCollapseDesc": "Collapse thinking panel when output starts streaming",
    "autoCompress": "Auto Compress",
    "autoCompressDesc": "Automatically compress context when approaching limits",
    "compressThreshold": "Compress Threshold",
    "compressThresholdDesc": "Percentage of context window at which compression triggers",
    "resetDefaults": "Reset to Defaults",
    "resetDone": "Settings reset to defaults",
    "env": "Environment",
    "apiKey": "API Key",
    "setKey": "Set Key",
    "keyUpdated": "{provider} key updated",
    "keyRemoved": "{provider} key removed",
    "testKey": "Test",
    "clearKey": "Clear",
    "selfTestFailed": "Self-test failed",
    "envKeyVerified": "{provider} env key verified",
    "failedSelfTest": "{provider} saved despite failed self-test: {reason}",
    "authSourceEnv": "Detected from {env} in environment",
    "authSourceRuntime": "Provided at runtime",
    "authSourceConfig": "Configured via ~/.pi/agent/models.json",
    "authSourceAuto": "Auto-configured",
    "chatSystemPrompt": "System Prompt",
    "chatSystemPromptDesc": "Custom system prompt for new chat sessions",
    "chatSystemPromptPlaceholder": "Enter a custom system prompt (default: pi SDK coding assistant)"
  },
  "agent": {
    "createTitle": "Create Agent",
    "createDesc": "Configure a new agent with a role and model.",
    "namePlaceholder": "Agent name",
    "role": "Role",
    "model": "Model",
    "thinking": "Thinking",
    "create": "Create",
    "noModels": "No models available. Add API keys in Settings.",
    "switchModel": "Switch model",
    "apiKeys": "API Keys",
    "environment": "Environment",
    "noModelsCategory": "No models in this category.",
    "reasoning": "Reasoning",
    "modelBase": "base",
    "modelThink": "think"
  },
  "chat": {
    "placeholder": "Ask anything...",
    "send": "Send",
    "stop": "Stop",
    "you": "You",
    "agent": "Agent",
    "queued": "Queued",
    "queuedSteering": "Steering",
    "queuedFollowUp": "Follow-up",
    "empty": "No messages yet. Start a conversation.",
    "thinkingLevel": "Thinking",
    "permission": "Permission"
  },
  "execution": {
    "executionProcess": "Execution Process",
    "reasoning": "Reasoning",
    "expanded": "Expanded",
    "collapsed": "Collapsed",
    "steps": "{count} step",
    "steps_plural": "{count} steps"
  },
  "permission": {
    "title": "Permission requested",
    "description": "Agent wants to run a tool that the permission gate flagged.",
    "reason": "Reason",
    "arguments": "Arguments",
    "editPath": "Edit path",
    "otherArgsPreserved": "Other arguments will be preserved.",
    "allow": "Allow",
    "deny": "Deny",
    "allowWithEdits": "Allow with edits",
    "allowEdited": "Allow edited",
    "more": "+{count} more",
    "timedOut": "Timed out — denied: {toolName}"
  },
  "tool": {
    "arguments": "Arguments",
    "result": "Result",
    "error": "Error",
    "noArgs": "no args",
    "readSummary": "Read {path} ({lines} lines, {size})",
    "largeOutputSummary": "{preview} ({lines} lines, {chars} chars)"
  },
  "toast": {
    "modelUnavailable": "Model unavailable: {primary}. Switched to {resolved}.",
    "triedModels": "Tried {count} models in chain. Now using {resolved}.",
    "noHarness": "Harness API not available. Run in Electron.",
    "modelSwitchFailed": "Failed to switch model",
    "permissionMode": "Permission mode: {mode}",
    "error": "[{id}] {message}",
    "configFirstModel": "Configure your first model",
    "configFirstModelDesc": "Add a provider API key in Settings to get started",
    "newChat": "New Chat"
  }
}
```

#### `src/renderer/locales/zh.json`

```json
{
  "common": {
    "ok": "确定",
    "cancel": "取消",
    "save": "保存",
    "delete": "删除",
    "close": "关闭",
    "loading": "加载中...",
    "confirm": "确认",
    "reset": "重置"
  },
  "sidebar": {
    "chat": "对话",
    "orch": "编排",
    "newAgent": "新建 Agent",
    "settings": "设置",
    "noChatAgents": "暂无对话 Agent。",
    "noOrchAgents": "暂无编排 Agent。",
    "clickNewAgent": "点击 + 新建 Agent。"
  },
  "settings": {
    "title": "设置",
    "description": "自定义外观、管理 API 密钥等。",
    "general": "通用",
    "apiKeys": "API 密钥",
    "chatPrompt": "对话提示",
    "about": "关于",
    "appearance": "外观",
    "theme": "主题",
    "darkMode": "深色模式",
    "lightMode": "浅色模式",
    "language": "语言",
    "interfaceLanguage": "界面语言",
    "behavior": "行为",
    "defaultThinking": "默认思考",
    "thinkingDesc": "新建 Agent 时的推理深度",
    "autoCollapse": "自动折叠",
    "autoCollapseDesc": "当输出开始流式传输时自动折叠思考面板",
    "autoCompress": "自动压缩",
    "autoCompressDesc": "接近上下文窗口限制时自动压缩",
    "compressThreshold": "压缩阈值",
    "compressThresholdDesc": "触发压缩的上下文窗口百分比",
    "resetDefaults": "恢复默认",
    "resetDone": "已恢复默认设置",
    "env": "环境变量",
    "apiKey": "API 密钥",
    "setKey": "设置密钥",
    "keyUpdated": "{provider} 密钥已更新",
    "keyRemoved": "{provider} 密钥已清除",
    "testKey": "测试",
    "clearKey": "清除",
    "selfTestFailed": "自检失败",
    "envKeyVerified": "{provider} 环境密钥验证通过",
    "failedSelfTest": "{provider} 自检失败但已保存: {reason}",
    "authSourceEnv": "从环境变量 ${env} 检测到",
    "authSourceRuntime": "运行时提供",
    "authSourceConfig": "通过 ~/.pi/agent/models.json 配置",
    "authSourceAuto": "自动配置",
    "chatSystemPrompt": "系统提示",
    "chatSystemPromptDesc": "新建对话会话的自定义系统提示",
    "chatSystemPromptPlaceholder": "输入自定义系统提示（默认: pi SDK coding assistant）"
  },
  "agent": {
    "createTitle": "创建 Agent",
    "createDesc": "使用角色和模型配置新 Agent。",
    "namePlaceholder": "Agent 名称",
    "role": "角色",
    "model": "模型",
    "thinking": "思考",
    "create": "创建",
    "noModels": "暂无可用模型。请在设置中添加 API 密钥。",
    "switchModel": "切换模型",
    "apiKeys": "API 密钥",
    "environment": "环境变量",
    "noModelsCategory": "该分类下没有模型。",
    "reasoning": "推理",
    "modelBase": "基础",
    "modelThink": "思考"
  },
  "chat": {
    "placeholder": "随便问...",
    "send": "发送",
    "stop": "停止",
    "you": "你",
    "agent": "Agent",
    "queued": "队列",
    "queuedSteering": "引导",
    "queuedFollowUp": "跟进",
    "empty": "暂无消息，开始对话吧。",
    "thinkingLevel": "思考",
    "permission": "权限"
  },
  "execution": {
    "executionProcess": "执行过程",
    "reasoning": "推理",
    "expanded": "展开",
    "collapsed": "已折叠",
    "steps": "{count} 步",
    "steps_plural": "{count} 步"
  },
  "permission": {
    "title": "权限请求",
    "description": "Agent 想要运行一个被权限门控标记的工具。",
    "reason": "原因",
    "arguments": "参数",
    "editPath": "编辑路径",
    "otherArgsPreserved": "其他参数将被保留。",
    "allow": "允许",
    "deny": "拒绝",
    "allowWithEdits": "编辑后允许",
    "allowEdited": "允许（已编辑）",
    "more": "+{count} 更多",
    "timedOut": "超时 — 已拒绝: {toolName}"
  },
  "tool": {
    "arguments": "参数",
    "result": "结果",
    "error": "错误",
    "noArgs": "无参数",
    "readSummary": "读取 {path}（{lines} 行, {size}）",
    "largeOutputSummary": "{preview}（{lines} 行, {chars} 字符）"
  },
  "toast": {
    "modelUnavailable": "模型不可用: {primary}。已切换到 {resolved}。",
    "triedModels": "尝试了 {count} 个模型。当前使用 {resolved}。",
    "noHarness": "Harness API 不可用。请在 Electron 中运行。",
    "modelSwitchFailed": "切换模型失败",
    "permissionMode": "权限模式: {mode}",
    "error": "[{id}] {message}",
    "configFirstModel": "配置第一个模型吧",
    "configFirstModelDesc": "在 API 密钥里添加一个 provider 的 key 即可使用",
    "newChat": "新对话"
  }
}
```

#### `src/renderer/locales/ja.json`

```json
{
  "common": {
    "ok": "OK",
    "cancel": "キャンセル",
    "save": "保存",
    "delete": "削除",
    "close": "閉じる",
    "loading": "読み込み中...",
    "confirm": "確認",
    "reset": "リセット"
  },
  "sidebar": {
    "chat": "チャット",
    "orch": "オーケストレーション",
    "newAgent": "新規 Agent",
    "settings": "設定",
    "noChatAgents": "チャット Agent がまだありません。",
    "noOrchAgents": "オーケストレーション Agent がまだありません。",
    "clickNewAgent": "+ 新規 Agent をクリック。"
  },
  "settings": {
    "title": "設定",
    "description": "外観のカスタマイズ、API キーの管理など。",
    "general": "一般",
    "apiKeys": "API キー",
    "chatPrompt": "チャットプロンプト",
    "about": "About",
    "appearance": "外観",
    "theme": "テーマ",
    "darkMode": "ダークモード",
    "lightMode": "ライトモード",
    "language": "言語",
    "interfaceLanguage": "インターフェース言語",
    "behavior": "動作",
    "defaultThinking": "デフォルト思考",
    "thinkingDesc": "新規 Agent の推論深度",
    "autoCollapse": "自動折りたたみ",
    "autoCollapseDesc": "出力のストリーミング開始時に思考パネルを折りたたむ",
    "autoCompress": "自動圧縮",
    "autoCompressDesc": "コンテキスト制限に近づいたら自動的に圧縮",
    "compressThreshold": "圧縮しきい値",
    "compressThresholdDesc": "圧縮がトリガーされるコンテキストウィンドウの割合",
    "resetDefaults": "デフォルトに戻す",
    "resetDone": "設定をデフォルトに戻しました",
    "env": "環境変数",
    "apiKey": "API キー",
    "setKey": "キーを設定",
    "keyUpdated": "{provider} キーを更新しました",
    "keyRemoved": "{provider} キーを削除しました",
    "testKey": "テスト",
    "clearKey": "クリア",
    "selfTestFailed": "セルフテストに失敗しました",
    "envKeyVerified": "{provider} 環境キーを確認しました",
    "failedSelfTest": "{provider} セルフテスト失敗しましたが保存されました: {reason}",
    "authSourceEnv": "環境変数 ${env} から検出",
    "authSourceRuntime": "ランタイムで提供",
    "authSourceConfig": "~/.pi/agent/models.json で設定",
    "authSourceAuto": "自動設定",
    "chatSystemPrompt": "システムプロンプト",
    "chatSystemPromptDesc": "新規チャットセッションのカスタムシステムプロンプト",
    "chatSystemPromptPlaceholder": "カスタムシステムプロンプトを入力（デフォルト: pi SDK coding assistant）"
  },
  "agent": {
    "createTitle": "Agent を作成",
    "createDesc": "役割とモデルで新しい Agent を設定します。",
    "namePlaceholder": "Agent 名",
    "role": "役割",
    "model": "モデル",
    "thinking": "思考",
    "create": "作成",
    "noModels": "利用可能なモデルがありません。設定で API キーを追加してください。",
    "switchModel": "モデルを切り替え",
    "apiKeys": "API キー",
    "environment": "環境変数",
    "noModelsCategory": "このカテゴリにモデルはありません。",
    "reasoning": "推論",
    "modelBase": "ベース",
    "modelThink": "思考"
  },
  "chat": {
    "placeholder": "何でも聞いてください...",
    "send": "送信",
    "stop": "停止",
    "you": "あなた",
    "agent": "Agent",
    "queued": "キュー",
    "queuedSteering": "ステアリング",
    "queuedFollowUp": "フォローアップ",
    "empty": "まだメッセージがありません。会話を始めましょう。",
    "thinkingLevel": "思考",
    "permission": "権限"
  },
  "execution": {
    "executionProcess": "実行プロセス",
    "reasoning": "推論",
    "expanded": "展開中",
    "collapsed": "折りたたみ済み",
    "steps": "{count} ステップ",
    "steps_plural": "{count} ステップ"
  },
  "permission": {
    "title": "権限リクエスト",
    "description": "Agent が権限ゲートでフラグされたツールを実行しようとしています。",
    "reason": "理由",
    "arguments": "引数",
    "editPath": "パスを編集",
    "otherArgsPreserved": "他の引数は保持されます。",
    "allow": "許可",
    "deny": "拒否",
    "allowWithEdits": "編集して許可",
    "allowEdited": "許可（編集済み）",
    "more": "+{count} 件",
    "timedOut": "タイムアウト — 拒否されました: {toolName}"
  },
  "tool": {
    "arguments": "引数",
    "result": "結果",
    "error": "エラー",
    "noArgs": "引数なし",
    "readSummary": "{path} を読み取り（{lines} 行, {size}）",
    "largeOutputSummary": "{preview}（{lines} 行, {chars} 文字）"
  },
  "toast": {
    "modelUnavailable": "モデルが利用できません: {primary}。{resolved} に切り替えました。",
    "triedModels": "{count} 個のモデルを試行しました。現在 {resolved} を使用中。",
    "noHarness": "Harness API が利用できません。Electron で実行してください。",
    "modelSwitchFailed": "モデルの切り替えに失敗しました",
    "permissionMode": "権限モード: {mode}",
    "error": "[{id}] {message}",
    "configFirstModel": "最初のモデルを設定",
    "configFirstModelDesc": "設定でプロバイダーの API キーを追加してください",
    "newChat": "新規チャット"
  }
}
```

**Step: 创建目录和文件**

```bash
mkdir -p src/renderer/locales
# 然后分别写入以上三个 JSON 文件
```

**Commit:**
```bash
git add src/renderer/locales/
git commit -m "feat(i18n): add translation JSON files for en, zh, ja"
```

---

### Task 3: 创建 i18n.ts 配置

**Files:**
- Create: `src/renderer/i18n.ts`

```typescript
// ============================================================
// i18n Configuration — react-i18next setup
// ============================================================

import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import en from "./locales/en.json";
import zh from "./locales/zh.json";
import ja from "./locales/ja.json";

export type SupportedLocale = "en" | "zh" | "ja";

export const SUPPORTED_LOCALES: SupportedLocale[] = ["en", "zh", "ja"];

/** Locale display names in their own language */
export const LOCALE_LABELS: Record<SupportedLocale, string> = {
  en: "English",
  zh: "中文",
  ja: "日本語",
};

const resources = {
  en: { translation: en },
  zh: { translation: zh },
  ja: { translation: ja },
};

i18n.use(initReactI18next).init({
  resources,
  lng: "en", // Default; overridden after reading persisted settings
  fallbackLng: "en",
  interpolation: {
    escapeValue: false, // React already escapes
  },
  returnObjects: false,
  returnNull: false,
});

export default i18n;
```

**Step: 创建文件**

```bash
# Write the file above to src/renderer/i18n.ts
```

**Commit:**
```bash
git add src/renderer/i18n.ts
git commit -m "feat(i18n): add i18next configuration"
```

---

### Task 4: 在 index.tsx 中集成 I18nextProvider

**Files:**
- Modify: `src/renderer/index.tsx`

**当前代码:**
```tsx
import { Toaster } from "@shared/components/ui/sonner";
import { TooltipProvider } from "@shared/components/ui/tooltip";
import React from "react";
import { createRoot } from "react-dom/client";
import { scan } from "react-scan";
import App from "./App";
import "./App.css";
// ...
```

**修改为:**

在 `<ThemeProvider>` 之前引入 `I18nextProvider`，并导入 i18n 实例和 `App.css`。

```tsx
import { Toaster } from "@shared/components/ui/sonner";
import { TooltipProvider } from "@shared/components/ui/tooltip";
import React from "react";
import { createRoot } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { scan } from "react-scan";
import App from "./App";
import "./App.css";
import i18n from "./i18n";

if (import.meta.env.DEV) {
  scan({
    enabled: true,
    log: true,
    showToolbar: true,
  });
}

const root = createRoot(document.getElementById("root")!);
root.render(
  <React.StrictMode>
    <I18nextProvider i18n={i18n}>
      <TooltipProvider>
        <App />
        <Toaster />
      </TooltipProvider>
    </I18nextProvider>
  </React.StrictMode>,
);
```

**Commit:**
```bash
git add src/renderer/index.tsx
git commit -m "feat(i18n): wrap app with I18nextProvider"
```

---

### Task 5: 从 settings 读取语言偏好并初始化

**Files:**
- Modify: `src/renderer/App.tsx` (lines 414-421, the provider settings fetch effect)
- Add a new `useEffect` early in App.tsx that reads persisted language and calls `i18n.changeLanguage()`

**Step 1: 在 App.tsx 顶部导入 i18n**

```typescript
import i18n from "./i18n";
```

**Step 2: 在 provider settings fetch 之前新增语言初始化 effect**

```tsx
// Initialize i18n language from persisted settings (runs once on mount)
useEffect(() => {
  if (!api) return;
  api.getGeneralSettings()
    .then((r: any) => {
      if (r?.success && r.settings?.language) {
        i18n.changeLanguage(r.settings.language);
      }
    })
    .catch(() => {});
}, []);
```

**Step 3: 在 handleResetDefaults 中也重置语言**

在 App.tsx 的 `handleResetDefaults` 回调中添加 `i18n.changeLanguage("en")`。

**Commit:**
```bash
git add src/renderer/App.tsx
git commit -m "feat(i18n): initialize language from persisted settings on mount"
```

---

## Phase 2: 核心组件翻译

### Task 6: SettingsDialog 翻译

**Files:**
- Modify: `src/renderer/components/SettingsDialog.tsx`

这是字符串最多的组件（~60+ 可翻译字符串）。需要做以下改动：

**Step 1: 导入 useTranslation**

```typescript
import { useTranslation } from "react-i18next";
```

**Step 2: 在组件函数体顶部获取 t 和 i18n**

```typescript
const { t, i18n } = useTranslation();
```

**Step 3: 替换所有硬编码字符串**

关键替换映射表：

| 原字符串 | 替换为 |
|---------|--------|
| `"Settings"` | `t("settings.title")` |
| `"Customize appearance, manage API keys, and more."` | `t("settings.description")` |
| `"General"` | `t("settings.general")` |
| `"API Keys"` | `t("settings.apiKeys")` |
| `"Chat Prompt"` | `t("settings.chatPrompt")` |
| `"About"` | `t("settings.about")` |
| `"Appearance"` | `t("settings.appearance")` |
| `"Theme"` | `t("settings.theme")` |
| `"Dark mode"` / `"Light mode"` | `t("settings.darkMode")` / `t("settings.lightMode")` |
| `"Language"` | `t("settings.language")` |
| `"Interface language"` | `t("settings.interfaceLanguage")` |
| `"Behavior"` | `t("settings.behavior")` |
| `"Default Thinking"` | `t("settings.defaultThinking")` |
| `"Reasoning depth for new agents"` | `t("settings.thinkingDesc")` |
| `"Auto Collapse"` | `t("settings.autoCollapse")` |
| `"Auto Compress"` | `t("settings.autoCompress")` |
| `"Compress Threshold"` | `t("settings.compressThreshold")` |
| `"Reset to Defaults"` | `t("settings.resetDefaults")` |
| `"Settings reset to defaults"` | `t("settings.resetDone")` |
| `"Environment"` | `t("settings.env")` |
| `"API Key"` | `t("settings.apiKey")` |
| `"Set Key"` | `t("settings.setKey")` |
| `"{providerId} key updated"` | `t("settings.keyUpdated", { provider: providerId })` |
| `"{providerId} key removed"` | `t("settings.keyRemoved", { provider: providerId })` |
| `"Test"` | `t("settings.testKey")` |
| `"Clear"` | `t("settings.clearKey")` |
| `"Self-test failed"` | `t("settings.selfTestFailed")` |
| `"{provider} env key verified"` | `t("settings.envKeyVerified", { provider })` |
| `"Failed to save key"` | `t("common.save")` + " failed"（保留具体错误信息直传） |
| `"System Prompt"` | `t("settings.chatSystemPrompt")` |
| `"Custom system prompt for new chat sessions"` | `t("settings.chatSystemPromptDesc")` |
| `"Enter a custom system prompt..."` | `t("settings.chatSystemPromptPlaceholder")` |

authSourceLabel 映射（~line 108-126）:
```typescript
function authSourceLabel(source: string, envLabel?: string): { label: string; title: string } {
  switch (source) {
    case "environment":
      return { label: "env", title: envLabel ? `Detected from $${envLabel} in environment` : "Detected from environment" };
    case "runtime":
      return { label: "runtime", title: "Provided at runtime" };
    case "models_json_key":
    case "models_json_command":
      return { label: "models.json", title: "Configured via ~/.pi/agent/models.json" };
    default:
      return { label: "auto", title: `Auto-configured (${source})` };
  }
}
```
→ 该函数在组件内部定义，需要使用 `useTranslation` 的 `t`。最简单的方式是把该函数移入组件内部或让组件传 `t` 进去。

**Step 4: 语言切换联动**

在 `onValueChange` 中选择了新语言后，除了调用 `persistSettings({ language: v })`，还需要调用 `i18n.changeLanguage(v)` 来即时生效。

当前代码（~line 452-454）:
```tsx
onValueChange={(v) => {
  setLanguage(v);
  persistSettings({ language: v });
}}
```

修改为:
```tsx
onValueChange={(v) => {
  setLanguage(v);
  i18n.changeLanguage(v);
  persistSettings({ language: v });
}}
```

**Commit:**
```bash
git add src/renderer/components/SettingsDialog.tsx
git commit -m "feat(i18n): translate SettingsDialog"
```

---

### Task 7: Sidebar 翻译

**Files:**
- Modify: `src/renderer/components/Sidebar.tsx`

**替换映射表:**

| 原字符串 | 替换为 |
|---------|--------|
| `"Chat"` (Tab label) | `t("sidebar.chat")` |
| `"Orch"` (Tab label) | `t("sidebar.orch")` |
| `"New Agent"` (Button) | `t("sidebar.newAgent")` |
| `"Settings"` (Footer button) | `t("sidebar.settings")` |
| `"No chat agents yet."` | `t("sidebar.noChatAgents")` |
| `"No orchestration agents yet."` | `t("sidebar.noOrchAgents")` |
| `"Click + New Agent."` | `t("sidebar.clickNewAgent")` |

**Commit:**
```bash
git add src/renderer/components/Sidebar.tsx
git commit -m "feat(i18n): translate Sidebar"
```

---

### Task 8: ChatPanel 翻译

**Files:**
- Modify: `src/renderer/components/ChatPanel.tsx`

**替换映射表:**

| 原字符串 | 替换为 |
|---------|--------|
| `"Ask anything..."` (placeholder) | `t("chat.placeholder")` |
| `"Send"` / Send button aria | `t("chat.send")` |
| `"Stop"` / Stop button | `t("chat.stop")` |
| `"No messages yet..."` | `t("chat.empty")` |
| `"Thinking"` | `t("chat.thinkingLevel")` |
| `"Permission"` | `t("chat.permission")` |
| Queued drawer labels: "Queued" / "Steering" / "Follow-up" | `t("chat.queued")` / `t("chat.queuedSteering")` / `t("chat.queuedFollowUp")` |
| `"New Chat"` bottom button | `t("toast.newChat")` |

**Commit:**
```bash
git add src/renderer/components/ChatPanel.tsx
git commit -m "feat(i18n): translate ChatPanel"
```

---

### Task 9: MessageBubble + ExecutionProcess 翻译

**Files:**
- Modify: `src/renderer/components/MessageBubble.tsx`
- Modify: `src/renderer/components/ExecutionProcess.tsx`

**MessageBubble 替换映射表:**

| 原字符串 | 替换为 |
|---------|--------|
| `"You"` | `t("chat.you")` |
| `"Agent"` | `t("chat.agent")` |

**ExecutionProcess 替换映射表（当前有中文硬编码）:**

| 原字符串 | 替换为 |
|---------|--------|
| `"💭 Reasoning"` | emoji + `t("execution.reasoning")` |
| `"执行过程"` | `t("execution.executionProcess")` |
| `"step"` / `"steps"` | `t("execution.steps", { count: stepCount })` |
| `"展开"` | `t("execution.expanded")` |
| `"已折叠"` | `t("execution.collapsed")` |

注意：`ExecutionProcess` 当前使用 `stepCount > 1 ? "s" : ""` 来构成复数，改为使用 i18next 的复数支持：`t("execution.steps", { count: stepCount })`。

**Commit:**
```bash
git add src/renderer/components/MessageBubble.tsx src/renderer/components/ExecutionProcess.tsx
git commit -m "feat(i18n): translate MessageBubble and ExecutionProcess"
```

---

### Task 10: AgentCreateDialog 翻译

**Files:**
- Modify: `src/renderer/components/AgentCreateDialog.tsx`

**替换映射表:**

| 原字符串 | 替换为 |
|---------|--------|
| `"Create Agent"` | `t("agent.createTitle")` |
| `"Configure a new agent with a role and model."` | `t("agent.createDesc")` |
| `"Agent name"` (placeholder) | `t("agent.namePlaceholder")` |
| `"Role"` | `t("agent.role")` |
| `"Model"` | `t("agent.model")` |
| `"Thinking"` | `t("agent.thinking")` |
| `"Create"` | `t("agent.create")` |
| `"No models available. Add API keys in Settings."` | `t("agent.noModels")` |
| ROLE_OPTIONS labels: `"Orchestrator"`, `"Crawler"`, `"Cleaner"`, `"Analyst"`, `"Reporter"`, `"Coder"`, `"Reviewer"`, `"Custom"` | 保留英文角色名（这是系统概念，不翻译） |
| ROLE_OPTIONS descs: `"任务编排"`, `"数据爬取"`, `"数据清洗"`, `"数据分析"`, `"报告生成"`, `"代码编写"`, `"代码审查"`, `"自定义 Agent"` | 保留中文描述（当前就是中文，可独立提供翻译 key 但不做国际化，因为这些是给中国开发者的内部工具描述） |
| THINKING_LEVELS labels: `"Off — 标准模式"` etc. | 保留当前值（UI 概念标签） |

**Commit:**
```bash
git add src/renderer/components/AgentCreateDialog.tsx
git commit -m "feat(i18n): translate AgentCreateDialog"
```

---

### Task 11: ModelSelector + ThinkingSelector 翻译

**Files:**
- Modify: `src/renderer/components/ModelSelector.tsx`
- Modify: `src/renderer/components/ThinkingSelector.tsx`

**ModelSelector 替换映射表:**

| 原字符串 | 替换为 |
|---------|--------|
| `"Switch model"` | `t("agent.switchModel")` |
| `"API Keys"` (tab) | `t("agent.apiKeys")` |
| `"Environment"` (tab) | `t("agent.environment")` |
| `"No models in this category."` | `t("agent.noModelsCategory")` |
| `"base"` / `"think"` | `t("agent.modelBase")` / `t("agent.modelThink")` |
| `"配置第一个模型吧"` | `t("toast.configFirstModel")` |
| `"在 API Keys 里添加一个 provider 的 key 即可使用"` | `t("toast.configFirstModelDesc")` |
| `"Model"` (fallback label) | `t("agent.model")` |
| `"Failed to switch model"` (toast) | `t("toast.modelSwitchFailed")` |

**Commit:**
```bash
git add src/renderer/components/ModelSelector.tsx src/renderer/components/ThinkingSelector.tsx
git commit -m "feat(i18n): translate ModelSelector and ThinkingSelector"
```

---

## Phase 3: 辅助组件 + 细节

### Task 12: PermissionDialog 翻译

**Files:**
- Modify: `src/renderer/components/PermissionDialog.tsx`

**替换映射表:**

| 原字符串 | 替换为 |
|---------|--------|
| `"Permission requested"` | `t("permission.title")` |
| `"Agent wants to run a tool that the permission gate flagged."` | `t("permission.description")` |
| `"Reason"` | `t("permission.reason")` |
| `"Arguments"` | `t("permission.arguments")` |
| `"Edit path"` | `t("permission.editPath")` |
| `"Other arguments will be preserved."` | `t("permission.otherArgsPreserved")` |
| `"Deny"` | `t("permission.deny")` |
| `"Allow with edits"` | `t("permission.allowWithEdits")` |
| `"Allow edited"` | `t("permission.allowEdited")` |
| `"Allow"` | `t("permission.allow")` |
| `"+N more"` | `t("permission.more", { count: queueDepth - 1 })` |
| `"agent {id}"` | `"agent {id}"`（保持不变，这是协议信息） |

**Commit:**
```bash
git add src/renderer/components/PermissionDialog.tsx
git commit -m "feat(i18n): translate PermissionDialog"
```

---

### Task 13: ToolCallCard 翻译

**Files:**
- Modify: `src/renderer/components/ToolCallCard.tsx`

当前有一些中文硬编码（`"读取"`, `"行"`, `"字符"` 等）。替换为：

| 原字符串 | 替换为 |
|---------|--------|
| `"no args"` | `t("tool.noArgs")` |
| `"Arguments"` | `t("tool.arguments")` |
| `"Error"` | `t("tool.error")` |
| `"Result"` | `t("tool.result")` |
| `` `读取 ${path}（${lines} 行, ${kb}）` `` | `t("tool.readSummary", { path, lines, size: kb })` |
| `` `${firstLine}${suffix}（${lines} 行, ${result.length} 字符）` `` | `t("tool.largeOutputSummary", { preview: `${firstLine}${suffix}`, lines, chars: result.length })` |

注意：`formatResultSummary` 是组件内函数，需要获取 `t`。最简单的方式是把结果摘要逻辑内联到 JSX 中，或者让 `formatResultSummary` 接受 `t` 作为参数。

**Commit:**
```bash
git add src/renderer/components/ToolCallCard.tsx
git commit -m "feat(i18n): translate ToolCallCard"
```

---

### Task 14: 剩余小组件翻译

**Files:**
- Modify: `src/renderer/components/PixelAgentAvatar.tsx`（如果包含文本）
- Modify: `src/renderer/components/SkillSlashMenu.tsx`（如果有提示文本）
- Modify: `src/renderer/components/SkillTag.tsx`
- Modify: `src/renderer/components/ContextRing.tsx`
- Modify: `src/renderer/components/PermissionModeSelector.tsx`
- Modify: `src/renderer/components/AddCustomSkillPathDialog.tsx`

这些小组件大部分是纯图标/无文本，只需检查并翻译任何用户可见文本。

**Commit:**
```bash
git add src/renderer/components/
git commit -m "feat(i18n): translate remaining components"
```

---

### Task 15: App.tsx 中的 toast 消息翻译

**Files:**
- Modify: `src/renderer/App.tsx`

**Step 1: 在 App 组件中添加 `useTranslation`**

```typescript
import { useTranslation } from "react-i18next";
// in component:
const { t } = useTranslation();
```

**Step 2: 替换 toast 消息**

| 原字符串 | 替换为 |
|---------|--------|
| `"Harness API not available. Run in Electron."` | `t("toast.noHarness")` |
| `` `Model unavailable: ${event.primary}. Switched to ${event.resolved}.` `` | `t("toast.modelUnavailable", { primary: event.primary, resolved: event.resolved })` |
| `` `Tried ${triedCount} models in chain. Now using ${event.resolved}.` `` | `t("toast.triedModels", { count: triedCount, resolved: event.resolved })` |
| `` `Permission mode: ${event.mode}` `` | `t("toast.permissionMode", { mode: event.mode })` |
| `` `[${event.agentId.slice(0, 6)}] ${event.message}` `` | `t("toast.error", { id: event.agentId.slice(0, 6), message: event.message })` |
| `` `Timed out — denied: ${head.toolName}` `` | `t("permission.timedOut", { toolName: head.toolName })` |

**Step 3: 替换 handleResetDefaults 中的语言重置**

```typescript
i18n.changeLanguage("en");
```

**Commit:**
```bash
git add src/renderer/App.tsx
git commit -m "feat(i18n): translate toast messages in App.tsx"
```

---

## Phase 4: 验证 + 收尾

### Task 16: 语言切换即时生效验证

**操作步骤:**
1. 启动应用: `npm run dev`
2. 打开 Settings → General
3. 切换语言为 中文 → UI 立即变为中文
4. 切换为 日本語 → UI 立即变为日文
5. 关闭 Settings → 再次打开 → 语言选择保持
6. 关闭并重启应用 → 语言选择保持

**Commit:** (无代码变更)

---

### Task 17: 运行 lint + typecheck

```bash
npm run check
```

预期：`biome check` + `tsc --noEmit` x2 + `vitest --run` 全部通过。

如果 `useTranslation` 在顶层函数组件外使用（如 `authSourceLabel` 在 `SettingsDialog.tsx` 中），需要重构为在组件内获取 `t` 后传入该函数。

**Commit:**
```bash
git add -A
git commit -m "chore: fix lint and type issues after i18n changes"
```

---

### Task 18: 自测三种语言覆盖完整性

**操作步骤:**
1. 依次切换到每种语言
2. 浏览每个页面/组件（Settings、Sidebar、ChatPanel、AgentCreateDialog、ModelSelector、PermissionDialog）
3. 确认没有遗漏的英文/中文硬编码字符串
4. 记录任何发现的遗漏，回到对应的 JSON 文件中补充

**Commit:**
```bash
git add src/renderer/locales/
git commit -m "fix(i18n): fill in missing translations found during review"
```

---

## 风险和注意事项

### 1. 函数组件外定义的函数使用 `t`
**问题:** `authSourceLabel` 在 `SettingsDialog.tsx` 中定义在组件外，无法直接使用 `useTranslation`。
**解决方案:** 
- 方案 A: 将该函数移入组件内
- 方案 B: 在接受参数中加入 `t` 函数
推荐方案 B，改动最小：
```typescript
function authSourceLabel(source: string, envLabel: string | undefined, t: TFunction): { label: string; title: string } {
  // ...
}
```

### 2. 中文/日文 fallback
配置 `fallbackLng: "en"` 确保不存在的 key 回退到英文。

### 3. TypeScript 类型安全
当前 JSON 导入没有类型，不会在编译期检查 key 是否存在。未来可以考虑使用 `i18next-resources-for-ts` 生成类型。

### 4. 性能
翻译文件在构建时静态导入（ESM import），不会增加运行时网络请求。i18next 使用内存中的 hash map 查找，性能开销可忽略（<1ms per lookup）。

### 5. 文件体积
3 个 JSON 文件合计约 15-20KB（gzip 后约 3-5KB），可忽略不计。

---

## 总结

| Phase | Task 数 | 预估工作量 |
|-------|---------|-----------|
| Phase 1: 基础设施 | 5 | 15 min |
| Phase 2: 核心组件 | 6 | 30 min |
| Phase 3: 辅助组件 | 4 | 20 min |
| Phase 4: 验证收尾 | 3 | 15 min |
| **总计** | **18** | **~80 min** |
