# Look — 看得见的 AI 伙伴

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20.19-brightgreen.svg)](https://nodejs.org/)
[![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-lightgrey.svg)](https://github.com/Jacky-li-li-li/Look/releases)
[![GitHub Release](https://img.shields.io/github/v/release/Jacky-li-li-li/Look)](https://github.com/Jacky-li-li-li/Look/releases)

**Look** 是跑在你电脑上的桌面 AI 工作台——不是又一个网页对话框。

打开本地项目，选一个 Agent，直接说「帮我把这个组件改成严格模式」。它会先读代码、理解结构，再动手，并把改了什么、为什么改讲清楚。

本地优先 · 多模型 · 多会话并发 · Agent / Skill / 定时任务 · 浏览器与桌面自动化

[安装包下载](#安装包下载) · [快速开始](#快速开始) · [架构](#架构一览) · [文档](#文档) · [贡献](#贡献)

---

## 为什么用 Look

| | |
| --- | --- |
| **本地优先** | 会话、配置、密钥都在本机 `~/.look/`，不强制上云 |
| **一个应用接所有模型** | Anthropic / OpenAI / Google / DeepSeek / Groq 等 32+ 提供商，按任务切换 |
| **为长任务设计** | 计划模式、子代理并行、Fork 会话、思考深度——适合复杂编码与调研 |
| **真·可扩展** | Agent、Skill、MCP 三层扩展；能力边界由你定义 |
| **可无人值守** | cron 定时任务 + 浏览器/桌面操作 + 飞书推送 |

---

## 核心能力

**多会话 & 多模型**
每个会话独立运行时可并发，互不阻塞；原生历史支持新建、恢复、Fork 分支与树形导航。

**Agent 与子代理**
内置 Planner / Scout / Worker / Reviewer；可用 Agent Builder 用自然语言创建专属 SubAgent；长任务可拆给多个子代理并行，支持进度查看与取消。

**Skills**
`/skill:name` 原生调用；技能以本地文件组织，可随应用分发或自行编写。

**计划模式**
先产出可执行方案，审批后再落地；Plan 模型可与执行模型分开配置。

**定时任务**
cron 调度（一次 / 每天 / 每周 / 每月），带重试、执行日志与飞书结果推送；后台独立运行，不占当前会话。

**浏览器 & 桌面自动化**
打开网页、读快照、截图、跑脚本；macOS 上可截屏并模拟键鼠操作桌面应用。

**项目工作区**
项目树、共享区、文件查看器、Todo 面板。用户数据统一在 `~/.look/`（开发模式用 `~/.look-dev/`，可用 `LOOK_HOME` 覆盖），不污染项目目录。

**安全**
权限三级 `always / ask / plan`；项目信任模型；主/渲染进程严格隔离；可选 GitHub / Google OAuth。

**桌面体验**
React 19 + Tailwind 4 + shadcn/ui，明暗主题；思考折叠、工具卡片、Markdown / 代码高亮 / Mermaid；应用内自动更新（签名 + 公证）；界面 **中 / EN / 日本語**。

---

## 安装包下载

预构建安装包见 [GitHub Releases](https://github.com/Jacky-li-li-li/Look/releases)：

| 平台 | 格式 |
| --- | --- |
| macOS (Apple Silicon / Intel) | DMG / ZIP |
| Windows (x64) | NSIS |
| Linux (x64) | AppImage / DEB |

> 正式版经 Apple 签名与公证。macOS 若仍被拦截，见 [常见问题](#macos-提示无法验证开发者)。

---

## 快速开始

### 环境要求

| 环境 | 最低版本 |
| --- | --- |
| [Node.js](https://nodejs.org/) | >= 20.19.0（推荐 v22 LTS，可用 `nvm use` 读 `.nvmrc`） |
| npm | >= 10.x |
| macOS | 12 Monterey+（Apple Silicon / Intel） |
| Windows | 10+ x64 |
| Linux | 主流发行版 x64 |

### 开发启动

```bash
git clone https://github.com/Jacky-li-li-li/Look.git
cd Look
npm install          # postinstall 会复制文件图标并应用补丁
npm run dev          # Vite :5174 + Electron 主进程
```

### 可选：Supabase

部分认证/存储能力依赖 Supabase，**不配置不影响核心功能**：

```bash
cp .env.example .env
# 填写 VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY
# 首次可在 Supabase SQL Editor 执行 supabase/migrations/ 下的迁移，或：
npx supabase db push
```

### 构建与打包

```bash
npm run build        # shared + ui + electron
npm start            # 启动已构建的应用
npm run package      # 产出安装包 → release/
```

---

## 架构一览

```
┌────────────────────────────────────────────────────────────┐
│  Renderer                                                  │
│  React 19 · Jotai · Tailwind v4 · shadcn/ui                │
│  会话 / Agent / 设置 / 定时任务 / Agent 广场 …               │
└──────────────────────────┬─────────────────────────────────┘
                           │ contextBridge (preload) → window.look
                           │ IPC: look:event / look:invoke
┌──────────────────────────▼─────────────────────────────────┐
│  Main（Electron）                                          │
│  SessionRuntimeManager · 项目/权限/MCP/技能/子代理/计划     │
│  SchedulerService · LarkBridge · Browser / ComputerUse     │
└──────────────────────────┬─────────────────────────────────┘
                           │ 会话生命周期 / 模型 / 工具 / 事件
┌──────────────────────────▼─────────────────────────────────┐
│  pi SDK（@earendil-works/pi-*）                            │
│  AgentSessionRuntime · SessionManager · ResourceLoader     │
│  ModelRegistry · AuthStorage · ProjectTrust                │
└────────────────────────────────────────────────────────────┘
```

- **进程隔离**：`contextIsolation: true`、`nodeIntegration: false`，跨进程只走 preload 暴露的 `window.look`。
- **pi SDK 第一**：会话、工具、重试、事件流委托给 pi；Look 负责桌面壳、UI 状态、项目编排与扩展。
- **数据流**：Renderer → IPC → SessionRuntimeManager → pi SDK → 事件回传 → Jotai → UI。

### 仓库结构

```
apps/electron/          # Electron 应用边界
  src/main/             # 主进程：session / ipc / scheduler / im / mcp / browser …
  src/renderer/         # React：组件、Jotai store、hooks、locales
  test/                 # Vitest
  default-agents/       # 随包分发：planner / scout / worker / reviewer
  default-skills/       # 随包分发的 Skill
  build/ · scripts/     # 打包资源与辅助脚本
packages/
  shared/               # 共享类型、IPC 契约、存储路径
  ui/                   # 跨进程 shadcn/ui 组件
supabase/               # 可选：认证/存储迁移
docs/                   # 架构与功能文档
```

根 `package.json` 做 workspace 编排；Electron 专属构建与产物在 `apps/electron/`。

---

## 技术栈

| 层 | 技术 |
| --- | --- |
| 框架 | Electron + React 19 |
| 构建 | Vite 6 + tsc |
| 样式 | Tailwind CSS 4 + tw-animate-css |
| 状态 | Jotai + jotai-family |
| 组件 | Radix UI / shadcn/ui |
| AI 运行时 | `@earendil-works/pi-*` |
| i18n | i18next + react-i18next |
| 测试 | Vitest |
| 规范 | Biome |

---

## 命令参考

| 命令 | 说明 |
| --- | --- |
| `npm run dev` | 开发模式（renderer + main） |
| `npm run dev:renderer` / `dev:main` | 只起渲染或主进程 |
| `npm run build` | 构建 shared + ui + electron |
| `npm start` | 启动已构建应用 |
| `npm run package` | 打桌面安装包 |
| `npm test` | 测试 |
| `npm run lint` / `lint:fix` / `format` | 检查 / 修复 / 格式化 |
| `npm run check` | lint + typecheck + test |

**发版**：`git tag vX.Y.Z && git push origin vX.Y.Z` → GitHub Actions 构建、签名、公证并上传 Releases。请保持 tag 与 `apps/electron/package.json` 版本一致，并在 `apps/electron/src/renderer/data/changelog.ts` 顶部追加中/英/日更新说明（关于页时间线读取此处）。

---

## 常见问题

### 安装依赖失败

```bash
npm cache clean --force
rm -rf node_modules package-lock.json
npm install
```

### macOS 提示「无法验证开发者」

[GitHub Releases](https://github.com/Jacky-li-li-li/Look/releases) 上的正式包已经过 Apple 签名与公证。若仍被拦截（例如旁路下载、本地未签名构建），可以：

1. **系统设置 → 隐私与安全性** → 找到 Look →「仍要打开」
2. 或：`xattr -dr com.apple.quarantine /Applications/Look.app`

### 端口 5174 被占用

```bash
lsof -nP -iTCP:5174 -sTCP:LISTEN
kill -9 <PID>
```

### Electron 白屏

```bash
npm run build && npm start
```

### 如何添加模型

应用内 **设置** 添加 API Key。支持 Anthropic、OpenAI、Google、DeepSeek、Groq 等 32+ 提供商，也支持自定义 Provider。

### 定时任务 / IM 通知异常

见 [Scheduled tasks](docs/scheduled-tasks.md) 故障排查。

---

## 文档

| 文档 | 说明 |
| --- | --- |
| [Scheduled tasks](docs/scheduled-tasks.md) | 定时任务架构、创建与排障 |
| [Session Runtime Manager](docs/session-runtime-manager-architecture.md) | 多会话运行时 |
| [Todo 面板设计](docs/todo-panel-design.md) | Todo 面板 |
| [架构审查报告](docs/architecture-review.md) | 架构审查 |
| [贡献指南](CONTRIBUTING.md) | 提 issue / PR、提交规范 |
| [项目记忆 AGENTS.md](AGENTS.md) | 给 Agent 的运行时与扩展约定 |

---

## 贡献

欢迎 issue 与 PR。开发流程、提交信息风格见 [CONTRIBUTING.md](CONTRIBUTING.md)。

```bash
npm install
npm run dev
npm run check        # 提交前建议跑通
```

---

## 联系

使用中有问题或想法，欢迎：

- 开 [GitHub Issue](https://github.com/Jacky-li-li-li/Look/issues)
- [添加作者飞书好友](https://www.feishu.cn/invitation/page/add_contact/?token=b42nc543-2547-467b-8a3b-d73db71acce1&unique_id=NfhtWSY6D_FJhaHffrRANQ==)

---

## 许可证

[MIT](LICENSE) © Jacky-li-li-li
