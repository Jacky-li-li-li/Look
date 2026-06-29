# Look 后台自动化 Agent 设计方案

> 状态：设计稿（insights-only，待实现）  
> 更新日期：2026-06-29

---

## 1. 概述

为 Look 增加「后台自动化 Agent」能力：用户可创建定时任务，Look 在后台按周期自动触发 Agent 会话执行 prompt，任务完成后通过系统通知 + IM 通知反馈结果。

### 1.1 定位

- **后台自动化 Agent**：不是一次性提醒，而是无人值守地执行 Agent 工作流。
- **本地优先**：所有配置、运行历史、会话文件均保存在本地 `~/.look/`。
- **托盘常驻**：关闭主窗口后仍保持后台运行，Scheduler 继续工作。

### 1.2 Non-Goals

- 不支持应用未运行时由系统级调度器唤醒（超出 MVP 范围）。
- 不支持 IM 通知的富文本卡片（MVP 纯文本，card 二期）。
- 不支持 Schedule 创建新 Schedule（Agent 自管理任务后续再考虑）。

---

## 2. 核心决策

| # | 决策 | 落地 |
|---|---|---|
| 1 | 定位 | 后台自动化 Agent |
| 2 | 后台运行 | 关闭主窗口后隐藏到系统托盘，Scheduler 继续 tick |
| 3 | missed run | 应用关闭期间到期的任务跳过，不补跑 |
| 4 | 权限 | 复用现有 `always` |
| 5 | 模型/thinking | 强制显式选择 |
| 6 | 通知 | 系统通知 + 飞书 IM，MVP 只做飞书 bot |
| 7 | UI | 左侧入口和面板与 Agent 广场同构 |
| 8 | 会话 | 每次运行新建一个独立会话，存 `schedule-sessions/` |
| 9 | Cron | 支持 cron 表达式，同时提供常用周期预设 |
| 10 | 单次失败重试 | 同一会话内立即重试 3 次，3 次都失败后本次运行失败 |
| 11 | Schedule 连续失败 | 连续 3 次运行失败自动 paused |
| 12 | 深链 | 注册 `look://session/{sessionId}`，通知点击直接打开会话 |
| 13 | 开机自启 | 纳入，设置项控制，默认关闭 |
| 14 | IM 配置 | 设置页新增「IM 通知」Tab，集中管理多 provider，Schedule 引用配置 |

---

## 3. 架构

```
┌─────────────────────────────────────────────┐
│  Renderer (React + Jotai)                   │
│  SchedulePanel / SettingsDialog / Sidebar   │
└───────────────────┬─────────────────────────┘
                    │ look:invoke / look:event
┌───────────────────▼─────────────────────────┐
│  Main Process                               │
│  ┌─────────────────────────────────────┐   │
│  │  ScheduleService                    │   │
│  │  - schedules.json CRUD              │   │
│  │  - tick (30s) + nextRunAt           │   │
│  │  - runningSchedules lock            │   │
│  │  - startup recovery                 │   │
│  └──────────────┬──────────────────────┘   │
│                 │                           │
│  ┌──────────────▼──────────────────────┐   │
│  │  ScheduleRunner                     │   │
│  │  - create session per run           │   │
│  │  - set model/thinking/always        │   │
│  │  - retry 3x in same session         │   │
│  │  - wait for agent_end               │   │
│  └──────────────┬──────────────────────┘   │
│                 │                           │
│  ┌──────────────▼──────────────────────┐   │
│  │  SessionRuntimeManager              │   │
│  │  - createAgent / sendMessage        │   │
│  │  - event translation                │   │
│  └──────────────┬──────────────────────┘   │
│                 │                           │
│  ┌──────────────▼──────────────────────┐   │
│  │  ImNotificationService              │   │
│  │  - route by provider                │   │
│  │  - FeishuSender (MVP)               │   │
│  └─────────────────────────────────────┘   │
└─────────────────────────────────────────────┘
        │
        ▼
~/.look/
├── schedules.json
├── im-profiles.json
└── workspaces/<project>/
    └── schedule-sessions/
        └── {sessionId}.jsonl
```

---

## 4. 数据模型

### 4.1 `Schedule`

```ts
type ScheduleType = "interval" | "daily" | "weekly" | "cron";
type ScheduleStatus = "active" | "paused" | "disabled";

interface Schedule {
  id: string;
  name: string;
  prompt: string;
  projectId: string;

  modelKey: string;              // 强制显式选择
  thinkingLevel: ThinkingLevel;  // 强制显式选择
  permissionMode: "always";      // 固定

  scheduleType: ScheduleType;
  intervalMinutes?: number;      // interval
  timeOfDay?: string;            // "HH:mm"
  daysOfWeek?: number[];         // weekly
  cronExpression?: string;       // cron

  timezone: string;              // 默认系统时区

  active: boolean;
  status: ScheduleStatus;
  nextRunAt: number;
  lastRunAt?: number;
  runCount: number;
  maxRuns?: number;

  consecutiveFailures: number;   // 连续失败次数

  notification: {
    system: boolean;
    im: {
      enabledProfiles: string[]; // ImProfile.id 数组
    };
  };

  // 每个 profile 的目标覆盖
  imTargets: Record<string, {
    chatId?: string;
    userId?: string;
  }>;

  runHistory: ScheduleRun[];     // 每个 schedule 保留最近 20 条
  createdAt: number;
  updatedAt: number;
}
```

### 4.2 `ScheduleRun`

```ts
type RunStatus = "running" | "success" | "failed" | "skipped";
type RunTrigger = "scheduled" | "manual";

interface ScheduleRun {
  id: string;
  scheduleId: string;
  sessionId: string;
  status: RunStatus;
  trigger: RunTrigger;

  startedAt: number;
  endedAt?: number;
  durationMs?: number;

  retryAttempt: number;          // 0-2，第几次重试
  outputSummary?: string;
  errorMessage?: string;

  notificationSent: {
    system: boolean;
    im: Record<string, boolean>; // profileId -> 是否成功
  };
  notificationError?: string;
}
```

### 4.3 `ImProfile`

```ts
type ImProviderType = "feishu" | "dingtalk" | "wechat" | "email"; // MVP 只有 feishu

interface ImProfile {
  id: string;
  name: string;                  // 用户自定义，如"飞书工作群"
  provider: ImProviderType;
  enabled: boolean;
  config: FeishuBotConfig;       // 未来扩展为联合类型
}

interface FeishuBotConfig {
  appId: string;
  appSecretEncrypted: string;    // electron.safeStorage 加密
  defaultChatId?: string;        // oc_xxx
  defaultUserId?: string;        // ou_xxx
}
```

### 4.4 持久化文件

```text
~/.look/
├── schedules.json              # { version: 1, schedules: Schedule[] }
├── im-profiles.json            # { version: 1, profiles: ImProfile[] }
└── workspaces/<project>/
    └── schedule-sessions/
        └── {sessionId}.jsonl   # 每次运行一个独立会话
```

---

## 5. 会话与存储

- **每次运行新建一个独立 session**，调用 `SessionRuntimeManager.createAgent({ projectId })`。
- session 文件放在 `~/.look/workspaces/<project>/schedule-sessions/{sessionId}.jsonl`。
- `SessionManager.list` 不扫描 `schedule-sessions/`，避免污染侧边栏。
- `ScheduleRun.sessionId` 记录本次运行创建的 session，用于历史抽屉跳转和深链。

---

## 6. 调度与 Cron

### 6.1 依赖

```bash
npm install cron-parser
```

### 6.2 `computeNextRunAt`

```ts
import { parseExpression } from "cron-parser";

function computeNextRunAt(schedule: Schedule, from = Date.now()): number {
  if (schedule.scheduleType === "cron") {
    const iter = parseExpression(schedule.cronExpression!, {
      currentDate: new Date(from + 1000),
      tz: schedule.timezone,
    });
    return iter.next().getTime();
  }
  // interval / daily / weekly 逻辑...
}
```

### 6.3 常用周期预设

UI 提供下拉预设，选择后自动填充 cron 表达式：

| 预设 | 对应 cron |
|---|---|
| 每小时 | `0 * * * *` |
| 每天 9:00 | `0 9 * * *` |
| 工作日 9:00 | `0 9 * * 1-5` |
| 每周一 9:00 | `0 9 * * 1` |
| 每月 1 日 9:00 | `0 9 1 * *` |
| 自定义 cron | 用户输入 |

### 6.4 Scheduler tick

- tick 周期：30s
- 检查 `nextRunAt <= now`
- 内存锁 `runningSchedules: Set<string>` 防止同 schedule 重叠
- 到点后新建 session → 运行 → 写历史 → 推进 `nextRunAt`

---

## 7. 失败重试与暂停

### 7.1 单次运行内重试

```ts
for (let attempt = 0; attempt < 3; attempt++) {
  try {
    result = await runtimeManager.runScheduleTurn(sessionId, prompt);
    break;
  } catch (err) {
    if (attempt === 2) throw err;
  }
}
```

- 3 次尝试都在**同一个 session** 内重新 `sendMessage`。
- 每次尝试之间**不等待**。
- 3 次都失败后，本次 `ScheduleRun` 标记 `failed`，`consecutiveFailures++`。

### 7.2 Schedule 级暂停

```ts
if (schedule.consecutiveFailures >= 3) {
  schedule.status = "paused";
  schedule.active = false;
  // 发送一次通知：Schedule 已自动暂停
}
```

- 连续 3 次运行失败后自动 paused。
- 用户手动 resume 后 `consecutiveFailures` 清零。

---

## 8. IM 通知中心

### 8.1 设计原则

- 设置页新增「IM 通知」Tab，集中管理所有 IM 渠道。
- 每个 IM 渠道是一个 Profile，当前只支持飞书 bot，未来可扩展钉钉、微信、邮件。
- Schedule 不直接填 appSecret，只引用 `ImProfile.id`，并可覆盖目标 chatId/userId。

### 8.2 飞书 Sender

使用官方 SDK：

```bash
npm install @larksuiteoapi/node-sdk
```

```ts
import * as lark from "@larksuiteoapi/node-sdk";

class FeishuSender implements ImSender {
  private clients = new Map<string, lark.Client>();

  private getClient(config: FeishuBotConfig): lark.Client {
    if (!this.clients.has(config.appId)) {
      this.clients.set(config.appId, new lark.Client({
        appId: config.appId,
        appSecret: decrypt(config.appSecretEncrypted),
        appType: lark.AppType.SelfBuild,
      }));
    }
    return this.clients.get(config.appId)!;
  }

  async send(config, target, text) {
    const client = this.getClient(config);
    const receiveIdType = target.chatId ? "chat_id" : "open_id";
    await client.im.v1.message.create({
      params: { receive_id_type: receiveIdType },
      data: {
        receive_id: target.chatId ?? target.userId!,
        msg_type: "text",
        content: JSON.stringify({ text }),
      },
    });
  }
}
```

### 8.3 统一路由

```ts
class ImNotificationService {
  private senders: Record<ImProviderType, ImSender> = {
    feishu: new FeishuSender(),
  };

  async send(schedule: Schedule, run: ScheduleRun, profiles: ImProfile[]) {
    for (const profile of profiles) {
      if (!profile.enabled) continue;
      const sender = this.senders[profile.provider];
      if (!sender) continue;

      const target = schedule.imTargets[profile.id] ?? {
        chatId: profile.config.defaultChatId,
        userId: profile.config.defaultUserId,
      };

      try {
        await sender.send(profile.config, target, buildMessage(schedule, run));
        run.notificationSent.im[profile.id] = true;
      } catch (err) {
        run.notificationSent.im[profile.id] = false;
        run.notificationError = String(err);
      }
    }
  }
}
```

### 8.4 消息模板（MVP 纯文本）

```
【Look 定时任务】✅ {name} 运行成功
项目：{projectName}
时间：{startedAt}
耗时：{durationMs}ms
模型：{modelKey}
摘要：{outputSummary}

查看会话：look://session/{sessionId}
```

失败/跳过版本替换图标与字段。

---

## 9. UI 设计

### 9.1 左侧入口

`Sidebar.tsx` 底部新增「定时任务」按钮，使用 `Clock` 图标。

### 9.2 定时任务面板

复用 `AgentSquare` 结构：

```
┌────────────────────────────┐
│ ← 返回    定时任务          │
├────────────────────────────┤
│ [全部] [运行中] [已暂停] [失败] │
├────────────────────────────┤
│ 搜索框              [新建]  │
├────────────────────────────┤
│ ┌─────────┐  ┌─────────┐   │
│ │ Schedule│  │ Schedule│   │
│ │  Card   │  │  Card   │   │
│ └─────────┘  └─────────┘   │
└────────────────────────────┘
```

卡片字段：名称 + 状态 Badge、下次运行时间、触发频率、最近运行结果、启用 Switch、Hover 编辑/删除/立即运行。

### 9.3 新建/编辑表单

分步：
1. 基础：名称、项目、prompt
2. 触发：预设选择 或 自定义 cron；interval/daily/weekly 保留
3. 模型：modelKey、thinkingLevel（强制）
4. 通知：系统通知开关、IM 通知多选（来自设置页配置）
5. 高级：maxRuns

### 9.4 设置页「IM 通知」Tab

新增 Tab，结构：

```
┌────────────────────────────────────┐
│ IM 通知                             │
├────────────────────────────────────┤
│ 已配置的 IM 渠道                      │
│ ┌────────────────────────────┐    │
│ │ 🟢 飞书-工作群    编辑 删除 │    │
│ │    appId: cli_xxx          │    │
│ │    默认: oc_xxx            │    │
│ └────────────────────────────┘    │
│                                    │
│ [+ 添加 IM 渠道]                    │
└────────────────────────────────────┘
```

添加/编辑弹窗：选择 provider（当前仅飞书）→ 填名称/appId/appSecret/默认目标 → 测试连接 → 保存。

---

## 10. 托盘与生命周期

```ts
let isQuitting = false;

mainWindow.on("close", (e) => {
  if (!isQuitting) {
    e.preventDefault();
    mainWindow.hide();
  }
});

app.on("before-quit", async () => {
  isQuitting = true;
  scheduler.stop();
  await runtimeManager.dispose();
});
```

Tray 菜单：
- 显示 Look
- 运行状态（disabled label）
- 打开定时任务
- 退出 Look

---

## 11. 深链协议

```ts
app.setAsDefaultProtocolClient("look");

app.on("open-url", (event, url) => {
  event.preventDefault();
  const match = url.match(/^look:\/\/session\/(.+)$/);
  if (match) {
    showMainWindow();
    mainWindow?.webContents.send("look:event", {
      type: "deep-link:session",
      sessionId: match[1],
    });
  }
});
```

---

## 12. 开机自启

```ts
app.setLoginItemSettings({
  openAtLogin: settings.openAtLogin,
  openAsHidden: true,
});
```

- 设置项默认关闭
- UI 放在设置页「通用」分类

---

## 13. 新增/修改文件清单

```
新增：
src/main/
├── schedule/
│   ├── schedule-storage.ts          # schedules.json 读写
│   ├── schedule-service.ts          # CRUD + 启动恢复
│   ├── schedule-scheduler.ts        # tick + 锁
│   └── schedule-runner.ts           # 单次运行 + 3 次重试
├── im/
│   ├── im-profile-storage.ts        # im-profiles.json 读写
│   ├── im-profile-service.ts        # CRUD + 解密
│   ├── im-notification-service.ts   # 统一路由
│   ├── im-sender.ts                 # ImSender 接口
│   └── senders/
│       └── feishu-sender.ts         # 飞书实现
└── protocol-handler.ts              # look:// 处理（可选合并到 index.ts）

src/renderer/
├── components/settings/
│   └── ImNotificationsTab.tsx       # 设置页 IM Tab
├── components/SchedulePanel/
│   ├── SchedulePanel.tsx
│   ├── ScheduleCard.tsx
│   ├── ScheduleEditor.tsx
│   ├── ScheduleHistoryDrawer.tsx
│   └── ImTargetSelector.tsx         # Schedule 表单 IM 选择器
└── store/
    ├── scheduleAtoms.ts
    └── imAtoms.ts

修改：
src/main/index.ts
src/main/session-runtime-manager.ts
src/main/ipc-handlers.ts
src/main/preload.js
src/main/shared/types.ts
src/main/shared/look-storage.ts
src/renderer/App.tsx
src/renderer/components/Sidebar.tsx
src/renderer/components/settings/SettingsDialog.tsx
src/renderer/store/atoms.ts
src/renderer/store/ipcHandler.ts
```

---

## 14. 实现顺序

1. **基础调度器**：`schedule-storage` + `schedule-service` + `schedule-scheduler`
2. **单次运行**：`schedule-runner` + `SessionRuntimeManager` 新增 schedule session 方法
3. **IPC 与 UI 骨架**：IPC 通道、atoms、`SchedulePanel` 空壳
4. **UI 完整实现**：卡片、表单、历史抽屉
5. **Cron 支持**：引入 `cron-parser` + 预设
6. **系统通知**：Electron `Notification`
7. **IM 配置中心**：`im-profile-storage` + `im-profile-service` + 设置页 Tab
8. **飞书通知**：`feishu-sender` + `im-notification-service`
9. **Schedule 通知接入 IM**：`ImTargetSelector`
10. **托盘后台**：改造 `index.ts` 生命周期
11. **深链 + 开机自启**
12. **测试与兜底**：重试、连续失败暂停、missed run

---

## 15. 风险与注意事项

| 风险 | 说明 | 缓解 |
|---|---|---|
| `always` 权限无人值守 | 工具调用不会弹窗 | UI 显著提示；未信任项目禁止启用任务 |
| 模型选择失效 | 用户删除模型或 API key 后任务失败 | 运行前校验 modelKey |
| 飞书 Bot 未进群 | 群消息发送失败 | UI 明确提示 |
| 后台资源占用 | 长期运行保留主进程 | 限制并发运行数 |
| 应用退出中断运行 | 长任务在 `before-quit` 时被终止 | 等待运行完成或超时后退出 |
| 凭证安全 | appSecret 落盘 | 用 `safeStorage` 加密 |
| missed run 业务影响 | 关闭期间任务不补跑 | UI 明确告知用户 |

---

## 16. 附录：Proma 参考

Proma 已实现同构定时任务系统，关键文件：

- `apps/electron/src/main/lib/automation-scheduler.ts`：30s tick + nextRunAt + daily/reuse
- `apps/electron/src/main/lib/automation-manager.ts`：CRUD + `computeNextRunAt` + 历史截断
- `apps/electron/src/main/lib/automation-notification-service.ts`：飞书 card 通知
- `apps/electron/src/main/lib/feishu-bridge.ts`：使用 `@larksuiteoapi/node-sdk`
- `apps/electron/src/main/lib/feishu-config.ts`：`safeStorage` 加密 appSecret

Look 与 Proma 的主要差异：
- Look 每次运行新建会话，Proma 默认 daily 复用。
- Look 单次运行失败重试 3 次，Proma 不重试。
- Look 支持 cron 表达式，Proma 不支持。
- Look 的 IM 配置独立在设置页，Schedule 引用 profile。
