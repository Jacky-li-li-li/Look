# TODO.md 实时可视化 — 设计方案

## 概述

利用 pi 的 `TODO.md` 约定（AI 用 `write`/`edit` 工具维护任务列表），Look 自动解析并在 ChatPanel 输入框上方以紧凑进度条实时展示进度。

**AI 写 TODO.md → Look 解析 → 用户看到进度。**

---

## 设计原则

1. **不违背 pi 哲学** — 只是可视化，不改 AI 行为
2. **零侵入** — 不修改 pi SDK，不添加新工具
3. **实时更新** — 每次 `tool_execution_end` 刷新，不等 `agent_end`
4. **项目级** — 每个项目的 TODO.md 独立解析
5. **会话无关** — 同一项目的多个会话共享同一份 TODO.md

---

## 触发机制

```
AI 调用 write("TODO.md", ...)  ──→  tool_execution_end  ──→  SRT 解析  ──→  IPC 推送
AI 调用 edit("TODO.md", ...)   ──→  tool_execution_end  ──→  ↑ 同上
```

**为什么用 `tool_execution_end` 而不是 `agent_end`？**

| 触发点 | 延迟 | 体验 |
|--------|------|------|
| `agent_end` | 整个 turn 结束 | 批量更新，中间看不到进度 |
| `tool_execution_end` | 每次工具执行完 | **实时**，每完成一项立即勾掉 |

## 数据流

```
 ┌──────────┐     write/edit      ┌──────────┐
 │   AI     │ ─────────────────→  │ TODO.md  │
 └──────────┘                     └────┬─────┘
                                       │
 ┌──────────────────┐    tool_exec     │
 │  EventProcessor  │ ← ─ ─ ─ ─ ─ ─ ─ ┘
 └────────┬─────────┘
          │ handle()
 ┌────────▼─────────┐
 │  RuntimeManager  │
 │  emitTodoUpdate  │ → parseTodoFile(cwd) → TodoItem[]
 └────────┬─────────┘
          │ emit({ type: "todo:update", ... })
 ┌────────▼─────────┐
 │  IPC → ipcHandler│ → todoItemsAtomFamily.set(items)
 └────────┬─────────┘
          │
 ┌────────▼─────────┐
 │  ChatPanel.tsx    │
 │  (输入框上方)      │ → 进度条（始终可见）+ 可展开任务列表
 └──────────────────┘
```

## 改动清单

### 新增文件（2 个）

| 文件 | 行数 | 职责 |
|------|------|------|
| `src/main/session/todo-parser.ts` | ~25 | 纯函数：解析 TODO.md → TodoItem[] |
| `src/renderer/components/TodoPanel.tsx` | ~60 | 紧凑进度条 + 可展开任务列表 |

### 修改文件（3 个）

| 文件 | 改动量 | 内容 |
|------|--------|------|
| `packages/shared/src/types.ts` | +5 行 | 新增 `TodoItem` interface + `todo:update` 事件 |
| `src/main/session/event-processor.ts` | +3 行 | `tool_execution_end` case 调用 `host.emitTodoUpdate` |
| `src/main/session/runtime-manager.ts` | +8 行 | 实现 `emitTodoUpdate` 方法 |
| `src/renderer/components/ChatPanel.tsx` | -20 +6 行 | 删除 SubAgent 进度卡片，替换为 `<TodoPanel />` |

### 渲染层（不改文件结构）

| 位置 | 内容 |
|------|------|
| `src/renderer/store/atoms.ts` | +3 行：`todoItemsAtomFamily` |
| `src/renderer/store/ipcHandler.ts` | +4 行：`todo:update` case |

---

## 详细设计

### 1. `packages/shared/src/types.ts`

在 `MainToRendererEvent` 联合类型中添加：

```typescript
// 在文件末尾合适位置添加：

export interface TodoItem {
  text: string;   // 任务文本（去掉 "- [ ]" 前缀）
  done: boolean;  // 是否完成
  line: number;   // TODO.md 原始行号
}

// MainToRendererEvent 联合中新增：
| {
    type: "todo:update";
    sessionId: string;
    items: TodoItem[];
  }
```

### 2. `src/main/session/todo-parser.ts`

```typescript
// 纯函数，零依赖（仅 fs），可独立测试

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface TodoItem {
  text: string;
  done: boolean;
  line: number;
}

/**
 * 解析项目根目录的 TODO.md。
 * @returns TodoItem[] 或 null（文件不存在/无 checkbox）
 */
export function parseTodoFile(cwd: string): TodoItem[] | null {
  const todoPath = join(cwd, "TODO.md");
  if (!existsSync(todoPath)) return null;

  let content: string;
  try {
    content = readFileSync(todoPath, "utf-8");
  } catch {
    return null;
  }

  const items: TodoItem[] = [];
  let lineNum = 0;

  for (const line of content.split("\n")) {
    lineNum++;
    const doneMatch = line.match(/^\s*-\s*\[(x|X)\]\s+(.+)/);
    const todoMatch = line.match(/^\s*-\s*\[\s\]\s+(.+)/);

    if (doneMatch) {
      items.push({ text: doneMatch[2].trim(), done: true, line: lineNum });
    } else if (todoMatch) {
      items.push({ text: todoMatch[1].trim(), done: false, line: lineNum });
    }
  }

  return items.length > 0 ? items : null;
}
```

**解析规则：**
- `- [x] 任务` / `- [X] 任务` → done: true
- `- [ ] 任务` → done: false
- 支持缩进（`  - [ ] 子任务`）
- 非 checkbox 行忽略
- 无 checkbox 的文件返回 null（不展示面板）

### 3. `src/main/session/event-processor.ts`

在 `tool_execution_end` case 增加 TODO 检查：

```typescript
// ISessionEventHost 接口新增方法：
export interface ISessionEventHost {
  // ... 现有方法 ...

  /** 每次 tool_execution_end 时检查 TODO.md 是否需要更新 */
  emitTodoUpdate(sessionId: string): void;
}

// handle() 方法中：
case "tool_execution_end":
  this.host.emitSessionUpdated(sessionId);
  this.host.emitTodoUpdate(sessionId);  // 新增
  break;
```

### 4. `src/main/session/runtime-manager.ts`

实现 `emitTodoUpdate`：

```typescript
// 在 ISessionEventHost 实现区域添加：
emitTodoUpdate(sessionId: string): void {
  const managed = this.runtimes.get(sessionId);
  if (!managed) return;
  const items = parseTodoFile(managed.runtime.cwd);
  if (items) {
    this.emit({ type: "todo:update", sessionId, items });
  }
}
```

### 5. `src/renderer/components/TodoPanel.tsx`

位置：ChatPanel 中，消息列表与输入框之间。替换原有的 SubAgent 进度卡片。

交互模式：始终可见（有任务时），可折叠展开。与当前 SubAgent 进度卡片风格一致。

```tsx
import { useAtomValue } from "jotai";
import { CheckCircle2, Circle, ListTodo, ChevronDown, ChevronRight } from "lucide-react";
import { memo, useState } from "react";
import { activeAgentIdAtom, todoItemsAtomFamily } from "../store/atoms";

export const TodoPanel = memo(function TodoPanel() {
  const agentId = useAtomValue(activeAgentIdAtom);
  const items = useAtomValue(todoItemsAtomFamily(agentId ?? ""));
  const [expanded, setExpanded] = useState(false);

  // 无任务时不渲染
  if (!agentId || items.length === 0) return null;

  const doneCount = items.filter((i) => i.done).length;
  const total = items.length;
  const allDone = doneCount === total;
  const firstUndone = items.findIndex((i) => !i.done);

  // 全部完成时自动折叠
  if (allDone && expanded) setExpanded(false);

  return (
    <div className="shrink-0 mx-5 pb-1">
      {/* 折叠态：进度条按钮 */}
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center gap-2 rounded-lg border border-hairline bg-card/30 px-3 py-1.5 text-left text-[11px] transition-colors hover:bg-card/50"
      >
        <ListTodo className={`size-3.5 shrink-0 ${allDone ? "text-green-500" : "text-sky-500"}`} />
        <span className="font-medium">
          {allDone
            ? `全部完成 · ${total} 项`
            : `${doneCount}/${total} 已完成`}
        </span>
        {/* 迷你进度条 */}
        <div className="ml-auto flex items-center gap-1.5">
          <div className="h-1 w-16 overflow-hidden rounded-full bg-muted">
            <div
              className={`h-full rounded-full transition-all duration-500 ${
                allDone ? "bg-green-500" : "bg-blue-500"
              }`}
              style={{ width: `${total > 0 ? (doneCount / total) * 100 : 0}%` }}
            />
          </div>
          {expanded
            ? <ChevronDown className="size-3 text-muted-foreground/50" />
            : <ChevronRight className="size-3 text-muted-foreground/50" />
          }
        </div>
      </button>

      {/* 展开态：任务列表 */}
      {expanded && (
        <div className="mt-1 space-y-0.5 rounded-lg border border-hairline bg-card/30 px-3 py-1.5">
          {items.map((item) => (
            <div
              key={item.line}
              className={`flex items-start gap-2 py-0.5 text-[12px] leading-relaxed ${
                item.done
                  ? "text-muted-foreground/60 line-through"
                  : "text-foreground"
              }`}
            >
              {item.done ? (
                <CheckCircle2 className="mt-0.5 size-3 shrink-0 text-green-500" />
              ) : (
                <Circle
                  className={`mt-0.5 size-3 shrink-0 ${
                    items.indexOf(item) === firstUndone
                      ? "text-sky-500 animate-pulse"
                      : "text-muted-foreground"
                  }`}
                />
              )}
              <span className="break-words">{item.text}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
});
```

**设计要点：**
- 无任务时 `return null`，完全不可见，不占空间
- 折叠态：一行按钮，左侧图标 + 计数文字 + 迷你进度条 + 展开箭头
- 展开态：按钮下方弹出任务列表，带淡入效果
- 第一个未完成项（推测为"进行中"）的圆圈图标使用脉冲动画 `animate-pulse` + `text-sky-500`
- 全部完成时：按钮变绿、自动折叠、图标切换为绿色
- 使用 `memo` 包裹，与项目现有组件风格一致
- `key={item.line}` 使用行号作为稳定标识

### 6. `src/renderer/components/ChatPanel.tsx`

删除原有 SubAgent 进度卡片（L116-146 的 `SubagentProgressCard` 区域），替换为 `<TodoPanel />`：

```tsx
// 删除：SubagentProgressCard 相关的 import、atom 订阅、useEffect、JSX
// 新增 import：
import { TodoPanel } from "./TodoPanel";

// 在 ChatMessageList 和 ChatQueueDrawer 之间插入：
<div className="shrink-0">
  <TodoPanel />
</div>
```

完整位置示意：

```tsx
<div className="flex min-h-0 flex-1 flex-col">
  <ChatMessageList ... />
  {/* ↓ TODO 进度条 — 替代原 SubAgent 进度卡片 */}
  <TodoPanel />
  <ChatQueueDrawer ... />
  <ChatInput ... />
</div>
```

### 7. 渲染层状态

```typescript
// atoms.ts 新增
export const todoItemsAtomFamily = atomFamily((_sessionId: string) =>
  atom<TodoItem[]>([])
);

// ipcHandler.ts 新增（在 window.look.onEvent 回调中）：
case "todo:update":
  appStore.set(todoItemsAtomFamily(event.sessionId), event.items);
  break;
```

---

## 用户视角

### 正常流程

```
1. 用户打开 pi 项目，TODO.md 为空 → 面板不显示任何内容

2. 用户: "帮我给这个项目加单元测试"

3. AI 开始工作:
   write("TODO.md", "- [ ] 分析现有测试\n- [ ] 添加工具函数测试\n- [ ] 添加组件测试")
   → 输入框上方出现紧凑进度条：

   ┌──────────────────────────────────┐
   │ 📋  0/3 已完成   ░░░░░░░░  ▸    │  ← 折叠态按钮
   └──────────────────────────────────┘

     用户点击展开：
   ┌──────────────────────────────────┐
   │ 📋  0/3 已完成   ░░░░░░░░  ▾    │
   ├──────────────────────────────────┤
   │ ◌ 分析现有测试        ← 脉冲高亮 │
   │ ○ 添加工具函数测试               │
   │ ○ 添加组件测试                   │
   └──────────────────────────────────┘

4. AI 执行完 "分析现有测试":
   edit("TODO.md", ...)
   → 进度条实时更新：

   ┌──────────────────────────────────┐
   │ 📋  1/3 已完成   ████░░░░  ▸    │
   ├──────────────────────────────────┤
   │ ✅ 分析现有测试                   │
   │ ◌ 添加工具函数测试    ← 脉冲高亮  │
   │ ○ 添加组件测试                   │
   └──────────────────────────────────┘

5. 三个任务全部完成后，自动折叠：

   ┌──────────────────────────────────┐
   │ ✅  全部完成 · 3 项  ████████  ▸ │  ← 绿色，已折叠
   └──────────────────────────────────┘

   用户可手动展开回看已完成列表。
```

**位置示意（在 ChatPanel 中）：**

```
┌──────────────────────────────┐
│  MessageBubble ...           │  ← 消息列表
│  MessageBubble ...           │
├──────────────────────────────┤
│ 📋 2/5 已完成  ████░░  ▾    │  ← TodoPanel（输入框上方）
│  ├ ✅ 分析现有测试            │
│  ├ ◌ 添加工具函数测试 (脉冲)  │
│  ├ ○ 添加组件测试             │
│  ├ ○ 写文档                  │
│  └ ○ 发布                   │
├──────────────────────────────┤
│  ChatQueueDrawer             │
├──────────────────────────────┤
│  ChatInput ...               │
└──────────────────────────────┘
```

### 边界情况

| 场景 | 行为 |
|------|------|
| 项目中无 TODO.md | 面板不渲染，聊天界面无变化 |
| TODO.md 无 checkbox | 同上（`parseTodoFile` 返回空，面板不显示） |
| 全部任务完成 | 自动折叠为绿色按钮 `✅ 全部完成 · N 项`；可手动展开回看 |
| AI 未使用 TODO.md | 面板不渲染（`return null`），聊天界面无任何变化 |
| TODO.md 文件被外部编辑 | 下次 tool_execution_end 自动刷新 |
| 任务文本含特殊字符 | 原始文本展示，不做 HTML 渲染 |
| 任务数量很多（20+） | 展开列表 `max-h-48 overflow-auto`，避免撑满输入区 |

---

## 技术要点

### 为什么用 `tool_execution_end` 而非 `agent_end`

```
agent_end:       AI 全部做完才刷新 → 用户要等很久
tool_execution_end: 每次工具调用完就刷新 → 实时看到进度
```

`TODO.md` 是小文件（通常 < 2KB），每次 `tool_execution_end` 重新读取和解析的性能开销可忽略。

### 为什么用项目级而非会话级

TODO.md 存在项目根目录，同一项目的多个会话共享同一份文件。与会话无关——无论用户在哪个会话中，都能看到当前项目的任务进度。

### 为什么只用 checkbox 格式

pi 的 AI 模型被训练使用 Markdown checkbox。只解析 `- [ ]` 和 `- [x]` 两种格式，简单可靠。不需要支持数字列表、表格等复杂格式。

### 为什么不做双向绑定

面板只读。用户不能勾选/取消任务——只有 AI 能通过 `write`/`edit` 工具修改 TODO.md。保持 pi 的单一真相源原则。

---

## 代码量总结

| 类别 | 文件 | 行数 |
|------|------|------|
| 新增 | `todo-parser.ts` | 25 |
| 新增 | `TodoPanel.tsx` | 60 |
| 修改 | `shared/types.ts` | +5 |
| 修改 | `event-processor.ts` | +3 |
| 修改 | `runtime-manager.ts` | +8 |
| 修改 | `ChatPanel.tsx` | -20 +6 |
| 修改 | `atoms.ts` | +3 |
| 修改 | `ipcHandler.ts` | +4 |
| **合计** | | **~94 行（净增）** |
