# Look — Multi-Agent Orchestration System

基于 [pi SDK](https://github.com/earendil-works/pi-mono) 的 Electron 多 Agent 编排桌面应用。

## 架构

```
┌─ Electron Renderer (React + shadcn/ui) ─────────────────────┐
│  Sidebar (Tab: 💬Chat | 🎯Orch)  │  ChatPanel (Markdown)    │
│  AgentCreateDialog · SettingsDialog · ModelSelector         │
├─────────────────────────────────────────────────────────────┤
│  IPC Bridge (contextBridge → preload.js)                    │
├─────────────────────────────────────────────────────────────┤
│  Electron Main Process                                      │
│  ┌─────────────────────────────────────────────────────┐    │
│  │              AgentManager (Singleton)                │    │
│  │  ┌──────────┐  ┌──────────┐  ┌──────────┐          │    │
│  │  │Chat Sess │  │Orch Sess │  │Coder Sess│  ...     │    │
│  │  │(Sonnet)  │  │(Sonnet)  │  │(Sonnet)  │          │    │
│  │  └──────────┘  └──────────┘  └──────────┘          │    │
│  └─────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────┘
```

## 项目结构

```
look/
├── src/
│   ├── main/                         # Electron 主进程
│   │   ├── index.ts                  #   入口 + 默认 agent 创建
│   │   ├── agent-manager.ts          #   多 Agent 编排核心
│   │   ├── ipc-handlers.ts           #   主进程 ↔ 渲染进程 IPC
│   │   ├── preload.js                #   contextBridge (CJS)
│   │   ├── agents/roles.ts           #   8 种 Agent 角色定义
│   │   ├── tools/orchestration.ts    #   编排工具 (spawn/send/ask/wait/list)
│   │   ├── permissions/permission-gate.ts  # 三层权限控制
│   │   └── shared/
│   │       ├── types.ts              #   共享类型
│   │       ├── components/ui/        #   shadcn/ui 组件 (18个)
│   │       └── lib/utils.ts          #   cn() 工具函数
│   └── renderer/                     # React 前端
│       ├── App.tsx                   #   主应用 (事件订阅+状态管理)
│       ├── App.css                   #   Tailwind + shadcn 主题
│       ├── hooks/useThrottle.ts      #   流式内容节流 Hook
│       └── components/
│           ├── Sidebar.tsx           #   左侧 Tab 面板 (Chat/Orch)
│           ├── ChatPanel.tsx         #   聊天区 (滚动+输入)
│           ├── MessageBubble.tsx     #   消息气泡 (思考→工具→输出)
│           ├── StreamingMarkdown.tsx #   Markdown 流式渲染
│           ├── ExecutionProcess.tsx  #   执行过程折叠面板
│           ├── ThinkingPanel.tsx     #   思考过程面板
│           ├── ToolCallCard.tsx      #   工具调用卡片
│           ├── AgentCreateDialog.tsx #   创建 Agent 弹窗
│           ├── SettingsDialog.tsx    #   API Key 管理弹窗
│           ├── ModelSelector.tsx     #   模型切换下拉
│           ├── ThinkingSelector.tsx  #   思考级别下拉
│           └── PixelAgentAvatar.tsx  #   像素风 Agent 头像
├── .pi/settings.json                 # pi SDK 设置
├── components.json                   # shadcn/ui 配置
└── package.json
```

## 快速开始

```bash
export ANTHROPIC_API_KEY=sk-ant-...
npm install
npm run dev:renderer   # 终端1: Vite dev server
npm run dev:main       # 终端2: Electron
```

## Agent 角色

| 角色 | 图标 | 工具 | 默认模型 | Thinking |
|------|------|------|----------|----------|
| Chat | 💬 | read,bash,write,edit,grep,find,ls | Sonnet 4 | medium |
| Orchestrator | 🎯 | +spawn_agent,send_to_agent,ask_agent | Sonnet 4 | medium |
| Coder | 💻 | read,bash,write,edit,grep,find,ls | Sonnet 4 | medium |
| Reviewer | 🔍 | read,grep,find,ls (只读) | Haiku 4 | off |
| Crawler | 🕷️ | read,bash,write,edit,grep,find | Sonnet 4 | low |
| Cleaner | 🧹 | read,bash,write,edit,grep,find | Haiku 4 | off |
| Analyst | 📊 | read,bash,write,edit,grep,find | Sonnet 4 | high |
| Reporter | 📝 | read,bash,write,edit,grep,find | Sonnet 4 | medium |

## 多 Agent 通信

| 工具 | 模式 | 说明 |
|------|------|------|
| `spawn_agent` | 异步 | 创建子 Agent 后台执行 |
| `send_to_agent` | 异步 | 发送消息 (fire-and-forget) |
| `ask_agent` | 同步 | 发问并等待回复 |
| `wait_for_agent` | 阻塞 | 等待指定 Agent 完成 |
| `list_agents` | 查询 | 列出所有 Agent 状态 |

## 权限控制

三层规则（优先级从高到低）：

1. **全局拒绝** — `rm -rf /`、`mkfs`、force push main → 直接拦截
2. **角色限制** — Reviewer 不能 write/edit
3. **路径保护** — 修改 `package.json`/`.env`/源码 → 弹窗确认

## 消息气泡结构

```
┌─────────────────────────────────────────┐
│ ▶ 📋 执行过程    3 steps · 已折叠       │  ← 自动折叠
│   ├ 💭 Reasoning                        │
│   ├ 🛠 read file.ts    ✓ success        │
│   └ 🛠 bash npm test   ✕ error          │
├─────────────────────────────────────────┤
│ Markdown 输出 (流式渲染 + 代码高亮)       │
└─────────────────────────────────────────┘
```

## pi SDK 集成

- `createAgentSession()` — 独立 Agent 会话
- `AuthStorage` + `ModelRegistry` — 多 Provider 模型管理
- `SettingsManager.inMemory()` — retry 配置
- `session.subscribe()` — 事件流处理
- `DefaultResourceLoader` — system prompt 注入
- `defineTool()` — 自定义工具注册

## Chat Mode 通用约定（project 内部约定）

`chat` role 是"通用工作台"——**没有 role preset**，所有"用户的选择"都是真正的配置：

| 字段 | 值 | 含义 |
|---|---|---|
| `defaultModel` | `null` | 不预设——`createAgent` 走 `firstAvailableModelKey()` |
| `fallbackModels` | `[]` | 不用 role 静态 fallback——由 `createAgent` 动态构建（role static + 用户已配 models + firstAvailableKey 末位兜底） |
| `tools` | `null` | "全开内置工具"（null 是 sentinel，`createAgent` 内部展开为默认 7 个） |
| `systemPrompt` | `""` | 不注入 role preset——用户在 UI 里自己决定风格 |

`getRoleTools` / `getRoleDefaults` 返回类型是 `string[] \| null` / `string \| null`——**null 是"无 role 默认"信号**，不是"传错了"。

测试用 mock auth storage：`(m as any).authStorage = mock;` 绕过构造器注入（ts 类型擦除允许改 private 字段，运行时 OK）。`resolveModel` 内部用 `isUserConfigured(provider)` 跳过 unconfigured entries——`setModel` 同样要预检。

## Tab 路由（Chat vs Orch）

`Sidebar.isChatAgent` 用显式枚举 `CHAT_TAB_ROLES = new Set(["chat"])`，**不要用负定义**（`!isChatAgent`）。coder / custom / orchestrator 全部走 Orch tab——chat 是唯一"通用工作台"。

新加 role 时先想清楚它属于哪个 tab——属于 Chat 的加进 `CHAT_TAB_ROLES`；属于 Orch 的不动。Custom 也是 Orch（用户自定，不混进 chat）。

## pi SDK 重要 API 行为

- `m.session.prompt(text, options?)` —— **streaming 时必须传 `options.streamingBehavior`**（`"steer"` 插队 / `"followUp"` 排队），否则 SDK 抛 "streaming and no streamingBehavior specified"。`sendMessage` 用 `steer` 行为：用户在 streaming 时发新消息会插到当前 turn 之后。
- `m.session.isStreaming` —— `boolean` getter，用来判定走哪条 prompt path。
- `m.session.abort()` —— fire-and-forget。**不要主动改 status**——让 SDK 的 tool_execution_end / message_end 事件流自然把 status 拉回 idle，UI 状态机才一致。
- `m.session.steer(text)` / `followUp(text)` —— 独立 API 存在，但**优先用 `prompt(text, { streamingBehavior })`**（更声明式，少一个分支）。
