# Look

基于 Electron 的 pi SDK 桌面客户端。

## 特性

- **单会话运行时** — 任意时刻只保留一个活动的 pi `AgentSessionRuntime`
- **原生会话历史** — 新建、恢复、Fork 和树导航均使用 pi `SessionManager`
- **技能系统** — 使用 pi ResourceLoader 和 `/skill:name` 原生调用
- **32+ AI 提供商** — 内置 Anthropic、OpenAI、Google、DeepSeek、Groq 等主流模型提供商图标与配置
- **项目信任** — 使用 pi Project Trust 决定是否加载项目资源
- **国际化** — 支持中文、英文、日文
- **现代 UI** — 基于 React 19、Tailwind CSS 4、shadcn/ui，支持暗色/亮色主题

## 技术栈

| 层 | 技术 |
|---|---|
| 框架 | Electron + React 19 |
| 构建 | Vite 6 + tsc |
| 样式 | Tailwind CSS 4 + tw-animate-css |
| 状态管理 | Jotai + jotai-family |
| 组件 | Radix UI / shadcn/ui |
| 国际化 | i18next + react-i18next |
| 测试 | Vitest |
| 代码规范 | Biome |

## 快速开始

```bash
# 安装依赖
npm install

# 开发模式（启动 renderer 和 main 进程）
npm run dev

# 构建
npm run build

# 启动应用
npm start

# 打包为桌面安装包
npm run package
```

## 项目结构

```
src/
├── main/                 # Electron 主进程
│   ├── index.ts          # 入口
│   ├── ipc-handlers.ts   # IPC 通信处理
│   ├── session-runtime-manager.ts  # 单一 pi 会话运行时
│   ├── preload.js        # 预加载脚本
│   ├── shared/           # 共享类型/工具/UI 组件
│   ├── mcp/              # pi MCP Extension
│   └── assets/           # 静态资源
└── renderer/             # React 渲染进程
    ├── App.tsx           # 主应用
    ├── components/       # UI 组件
    ├── providers/        # AI 提供商图标
    ├── hooks/            # 自定义 hooks
    ├── store/            # Jotai 状态
    ├── locales/          # 国际化文案
    └── lib/              # 工具库
```

## 命令

| 命令 | 说明 |
|------|------|
| `npm run dev` | 启动开发模式 |
| `npm run build` | 构建项目 |
| `npm run start` | 启动 Electron |
| `npm run package` | 打包安装包 |
| `npm test` | 运行测试 |
| `npm run lint` | 代码检查 |
| `npm run lint:fix` | 自动修复代码问题 |
| `npm run format` | 格式化代码 |
| `npm run check` | 完整检查（lint + typecheck + test） |
