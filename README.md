# Look

基于 Electron 的 pi SDK 桌面客户端 —— 一个支持多会话、多模型、可扩展的 AI 助手桌面应用。

> 定时任务文档请参见 [Scheduled tasks](docs/scheduled-tasks.md)。

## 特性

- **多会话运行时** — 每个会话拥有独立的 pi `AgentSessionRuntime`，已初始化会话可并发运行
- **原生会话历史** — 新建、恢复、Fork 和树导航均使用 pi `SessionManager`
- **技能系统** — 使用 pi ResourceLoader 和 `/skill:name` 原生调用
- **32+ AI 提供商** — 内置 Anthropic、OpenAI、Google、DeepSeek、Groq 等主流模型提供商图标与配置
- **项目信任** — 使用 pi Project Trust 决定是否加载项目资源
- **国际化** — 支持中文 (zh)、英文 (en)、日文 (ja)
- **现代 UI** — 基于 React 19、Tailwind CSS 4、shadcn/ui，支持暗色/亮色主题

## 环境要求

| 环境 | 最低版本 | 说明 |
|------|---------|------|
| [Node.js](https://nodejs.org/) | >= 20.19.0 | 推荐使用 v22 LTS |
| [npm](https://www.npmjs.com/) | >= 10.x | 随 Node.js 一同安装 |
| **操作系统** | | |
| macOS | 12 (Monterey) 或更高 | 支持 Apple Silicon (M1/M2/M3/M4) 和 Intel |
| Windows | Windows 10 或更高 | x64 架构 |
| Linux | 主流发行版 | x64 架构 |

> 使用 `.nvmrc` 管理 Node.js 版本：`nvm use`（需安装 [nvm](https://github.com/nvm-sh/nvm)）

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

## 安装包下载

可通过 [GitHub Releases](https://github.com/Jacky-li-li-li/Look/releases) 下载预构建安装包：

| 平台 | 格式 |
|------|------|
| macOS (Apple Silicon) | DMG / ZIP |
| macOS (Intel) | DMG / ZIP |
| Windows | NSIS 安装程序 |
| Linux | AppImage / DEB |

## 项目结构

```
apps/
└── electron/             # Electron 应用边界
    ├── src/
    │   ├── main/         # 主进程、preload 与 pi runtime 集成
    │   └── renderer/     # React 渲染进程
    ├── test/             # Vitest 应用测试
    ├── default-agents/   # 随安装包分发的 Agent 模板
    ├── default-skills/   # 随安装包分发的 Skill 模板
    ├── build/            # 图标和平台打包资源
    └── scripts/          # 构建、staging、签名辅助脚本
packages/
└── shared/               # 共享类型、工具与 UI 组件
```

根 `package.json` 负责 workspace 编排并保留所有常用命令；Electron 专属构建配置与产物位于 `apps/electron/`。所有用户数据统一存储在 `~/.look/` 下，不写入项目目录的 `.pi/` 文件夹。

## 命令参考

| 命令 | 说明 |
|------|------|
| `npm run dev` | 启动开发模式（renderer + main） |
| `npm run build` | 构建项目 |
| `npm run start` | 启动 Electron 应用 |
| `npm run package` | 打包为桌面安装包 |
| `npm test` | 运行测试 |
| `npm run lint` | 代码检查 |
| `npm run lint:fix` | 自动修复代码问题 |
| `npm run format` | 格式化代码 |
| `npm run check` | 完整检查（lint + typecheck + test） |

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

在应用启动后，通过设置界面添加 API Key。支持的提供商包括 Anthropic、OpenAI、Google、DeepSeek、Groq 等 32+ 种。

## 许可证

[MIT](LICENSE) © Jacky-li-li-li
