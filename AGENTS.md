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
