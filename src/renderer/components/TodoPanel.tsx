// ============================================================
// TodoPanel — ChatPanel 输入框上方的紧凑 TODO 进度条
//
// 展示 AI 在 TODO.md 中记录的任务进度，替代原 SubAgent 进度卡片。
// 折叠态：一行按钮含进度条；展开态：详细任务列表。
// ============================================================

import { useAtomValue } from "jotai";
import { CheckCircle2, Circle, ChevronDown, ChevronRight, ListTodo } from "lucide-react";
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
        <div className="mt-1 space-y-0.5 rounded-lg border border-hairline bg-card/30 px-3 py-1.5 max-h-48 overflow-auto">
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
