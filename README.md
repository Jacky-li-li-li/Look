# Look — 你的桌面 AI 工作台

**Look** 是一个基于 Electron 与 pi SDK 构建的桌面 AI 助手。它把多个 AI 模型、多个会话、Agent 与技能、定时任务、浏览器/桌面自动化汇聚在一个本地优先的桌面应用里，让你用一套工具完成思考、编码、执行与自动化。

---

## 它能干什么

### 多会话、多模型并行

- 每个会话拥有独立的 AI 运行时，已打开的会话可以**并发运行**，互不阻塞
- 支持 **32+ AI 提供商**：Anthropic、OpenAI、Google、DeepSeek、Groq 等主流模型，一套界面自由切换
- 原生会话历史：**新建、恢复、Fork（分支）与树形导航**，随时回到任意对话分支

### Agent 与子代理

- 内置 **Agent 广场**：开箱即用的规划（Planner）、侦察（Scout）、实现（Worker）、审查（Reviewer）等 Agent 模板
- **自定义 Agent**：用自然语言让 Agent Builder 帮你创建专属 SubAgent，配置工具白名单、模型与图标
- **子代理委派**：把长任务拆给多个子代理并行执行；支持**总指挥模式**，长任务按汇报点持续等待，随时查看进度或取消

### Skills 技能系统

- 使用 `/skill:name` 原生调用技能，无需离开对话
- 技能以本地文件组织，可随应用分发、也可自己编写

### 计划模式（Plan Mode）

- 先在规划模式下产出可执行方案，审批通过后再落地执行
- 可独立配置 Plan 模式专属模型，规划与执行使用不同模型

### 定时任务（Scheduled Tasks）

- 以 **cron 调度**运行 Agent：一次性、每天、每周、每月
- 支持**重试策略**、**执行日志**、失败告警，结果可通过**飞书**推送
- 任务在后台独立运行，不占用你当前正在查看的会话

### 浏览器与桌面自动化

- **浏览器工具集**：Agent 可打开网页、读取页面快照、截图并执行脚本
- **macOS 桌面操作**：屏幕截图与模拟键鼠操作，让 Agent 操作桌面应用

### 项目工作区

- 项目树、共享区、文件查看器（含图片预览）、Todo 面板
- 所有用户数据统一存储在 `~/.look/`，**不污染你的项目目录**

### 安全与权限

- **权限三级控制**：`always / ask / plan`，敏感操作（写文件、执行命令）可控
- **项目信任模型**：按项目决定是否加载项目资源
- **严格进程隔离**：渲染进程与主进程通过 preload 桥接，渲染层无法直接访问系统能力
- **账号登录**：支持 GitHub / Google OAuth（可选 Supabase），飞书 IM 集成

### 现代桌面体验

- React 19 + Tailwind CSS 4 + shadcn/ui，暗色/亮色主题
- 思考过程折叠、工具调用卡片、Markdown / 代码高亮 / Mermaid 渲染
- 应用内**自动更新**，发现新版本一键下载、重启安装（签名 + 公证）
- 国际化：**中文 / English / 日本語**

---

## 为什么值得用（价值主张）

1. **本地优先、数据自主**：所有会话、配置、密钥都留在你本机的 `~/.look/`，不强制上云。
2. **一个应用接所有模型**：无需在多个网页/客户端之间切换，按任务挑模型（强推理、长上下文、中文、代码各有擅长）。
3. **可扩展**：Agent、Skill、MCP 三层扩展机制，能力边界由你定义。
4. **真·自动化**：定时任务 + 浏览器/桌面操作 + IM 推送，把"需要人在场"的重复工作交给无人值守的 Agent。
5. **为长任务设计**：计划模式、子代理委派、Fork 会话、思考深度选择，适合复杂的编码与调研任务。

---

## 架构一览

```
┌────────────────────────────────────────────────────────────┐
│  Renderer（渲染进程）                                        │
│  React 19 + Jotai + Tailwind v4 + shadcn/ui                │
│  · 会话/Agent/设置/定时任务/Agent 广场等全部 UI                │
└──────────────────────────┬─────────────────────────────────┘
                           │ contextBridge (preload) — window.look API
                           │ IPC: look:event / look:invoke
┌──────────────────────────▼─────────────────────────────────┐
│  Main（Electron 主进程）                                     │
│  · SessionRuntimeManager —— 多会话运行时注册表（去重、并发）   │
│  · 项目 / 工作区 / 权限 / MCP / 技能 / 子代理 / 计划服务        │
│  · SchedulerService —— cron 定时任务                         │
│  · LarkBridgeService —— 飞书 IM 桥接                        │
│  · BrowserService / ComputerUse —— 浏览器与桌面自动化        │
└──────────────────────────┬─────────────────────────────────┘
                           │ 委托会话生命周期 / 模型 / 工具 / 事件
┌──────────────────────────▼─────────────────────────────────┐
│  pi SDK（@earendil-works/pi-*）                              │
│  AgentSessionRuntime / SessionManager / ResourceLoader      │
│  ModelRegistry / AuthStorage / ProjectTrust                 │
└────────────────────────────────────────────────────────────┘
```

- **主/渲染进程严格隔离**：`contextIsolation: true`、`nodeIntegration: false`，所有跨进程通信经 `preload` 暴露的 `window.look` API。
- **pi SDK 第一**：会话生命周期、工具执行、重试、事件流等 AI 核心能力全部委托给 pi SDK，Look 专注桌面壳、UI 状态、项目编排与扩展。
- **数据流**：Renderer → IPC → SessionRuntimeManager → pi SDK → 事件回传 → Jotai 状态 → UI。

### 项目结构

```
apps/
└── electron/             # Electron 应用边界
    ├── src/
    │   ├── main/         # 主进程：application、session、ipc、scheduler、im、mcp、
    │   │                 #   browser、computer-use、extensions、permissions 等
    │   └── renderer/     # React 渲染进程：组件、store(Jotai)、hooks、locales
    ├── test/             # Vitest 应用测试
    ├── default-agents/   # 随安装包分发的 Agent 模板（planner/scout/worker/reviewer）
    ├── default-skills/   # 随安装包分发的 Skill 模板
    ├── build/            # 图标和平台打包资源
    └── scripts/          # 构建、staging、签名辅助脚本
packages/
├── shared/               # 共享类型、IPC 契约、存储路径、UI 原语
└── ui/                   # 跨进程共享的 shadcn/ui 组件
supabase/                 # 可选：Supabase 数据库迁移（认证/存储）
docs/                     # 架构与功能文档
```

根 `package.json` 负责 workspace 编排并保留所有常用命令；Electron 专属构建配置与产物位于 `apps/electron/`。

---

## 快速开始

### 1. 克隆仓库

```bash
git clone https://github.com/Jacky-li-li-li/Look.git
cd Look
```

### 2. 安装依赖

```bash
npm install
```

> `postinstall` 脚本会自动复制文件图标并应用补丁。

### 3. 配置 Supabase（可选）

Look 使用 Supabase 进行部分可选功能的认证和存储。如需启用：

```bash
cp .env.example .env
```

编辑 `.env` 文件，填入你的 Supabase 项目信息：

```
VITE_SUPABASE_URL=https://your-project-id.supabase.co
VITE_SUPABASE_ANON_KEY=your-anon-key
```

首次创建 Supabase 项目后，应用数据库迁移 `supabase/migrations/20260609000000_create_user_profiles.sql`。可在 Supabase SQL Editor 中执行该文件，或在配置并关联 Supabase CLI 项目后运行：

```bash
npx supabase db push
```

> 不配置 Supabase 不影响核心功能的使用。

### 4. 启动开发模式

```bash
npm run dev
```

这将同时启动：

- Vite 开发服务器（端口 5174，渲染进程）
- Electron 主进程

### 5. 生产构建

```bash
npm run build
npm start
```

### 6. 打包为安装包

```bash
npm run package
```

打包产物将输出到 `release/` 目录。

---

## 安装包下载

可通过 [GitHub Releases](https://github.com/Jacky-li-li-li/Look/releases) 下载预构建安装包：

| 平台 | 格式 |
| --- | --- |
| macOS (Apple Silicon) | DMG / ZIP |
| macOS (Intel) | DMG / ZIP |
| Windows | NSIS 安装程序 |
| Linux | AppImage / DEB |

---

## 环境要求

| 环境 | 最低版本 | 说明 |
| --- | --- | --- |
| [Node.js](https://nodejs.org/) | &gt;= 20.19.0 | 推荐使用 v22 LTS |
| [npm](https://www.npmjs.com/) | &gt;= 10.x | 随 Node.js 一同安装 |
| **操作系统** |  |  |
| macOS | 12 (Monterey) 或更高 | 支持 Apple Silicon (M1/M2/M3/M4) 和 Intel |
| Windows | Windows 10 或更高 | x64 架构 |
| Linux | 主流发行版 | x64 架构 |

> 使用 `.nvmrc` 管理 Node.js 版本：`nvm use`（需安装 [nvm](https://github.com/nvm-sh/nvm)）

---

## 技术栈

| 层 | 技术 |
| --- | --- |
| 框架 | Electron + React 19 |
| 构建 | Vite 6 + tsc |
| 样式 | Tailwind CSS 4 + tw-animate-css |
| 状态管理 | Jotai + jotai-family |
| 组件 | Radix UI / shadcn/ui |
| AI 运行时 | @earendil-works/pi-\*（AgentSessionRuntime / SessionManager / ResourceLoader） |
| 国际化 | i18next + react-i18next |
| 测试 | Vitest |
| 代码规范 | Biome |

---

## 命令参考

| 命令 | 说明 |
| --- | --- |
| `npm run dev` | 启动开发模式（renderer + main） |
| `npm run dev:renderer` | 仅启动 Vite 开发服务器 |
| `npm run dev:main` | 仅编译主进程并启动 Electron |
| `npm run build` | 构建项目（shared + ui + electron） |
| `npm run start` | 启动 Electron 应用（需先 build） |
| `npm run package` | 打包为桌面安装包 |
| `npm test` | 运行测试 |
| `npm run lint` | 代码检查 |
| `npm run lint:fix` | 自动修复代码问题 |
| `npm run format` | 格式化代码 |
| `npm run check` | 完整检查（lint + typecheck + test） |

> 发版：`git tag vX.Y.Z && git push origin vX.Y.Z` 触发 GitHub Actions 构建 → 签名 → 公证 → 上传 GitHub Releases。每次发版同时在 `apps/electron/src/renderer/data/changelog.ts` 头部追加一条版本记录（设置 → 关于页展示）。

---

## 常见问题

### 安装依赖失败

```bash
# 清除 npm 缓存
npm cache clean --force
# 删除 node_modules 重新安装
rm -rf node_modules package-lock.json
npm install
```

### macOS 提示"无法验证开发者"

由于应用未通过 Apple 公证，首次打开时需要：

1. 打开 **系统设置 → 隐私与安全性**
2. 找到 Look 并点击"仍要打开"
3. 或运行：`xattr -dr com.apple.quarantine /Applications/Look.app`

### 端口 5174 被占用

```bash
lsof -nP -iTCP:5174 -sTCP:LISTEN
# 找到占用进程 PID 后：
kill -9 <PID>
```

### Electron 显示白屏

确保构建已完成：

```bash
npm run build
npm start
```

### 如何添加 AI 模型提供商

在应用启动后，通过设置界面添加 API Key。支持的提供商包括 Anthropic、OpenAI、Google、DeepSeek、Groq 等 32+ 种，也支持自定义 Provider。

### 定时任务不触发 / IM 通知无法启用

参见 Scheduled tasks 故障排查。

---

## 文档

- Scheduled tasks（定时任务）
- Session Runtime Manager 架构
- Todo 面板设计
- 架构审查报告

---

## 联系我们

在使用 Look 过程中有任何问题、建议或想交流想法，欢迎添加作者飞书好友：

[点击添加飞书好友](https://www.feishu.cn/invitation/page/add_contact/?token=b42nc543-2547-467b-8a3b-d73db71acce1&unique_id=NfhtWSY6D_FJhaHffrRANQ==)

---

## 许可证

[MIT](LICENSE) © Jacky-li-li-li