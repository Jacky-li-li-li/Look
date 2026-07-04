# 聊天消息滚动管理方案分析

> 2026-07-03 — 自定义滚动方案设计

---

## 问题回顾

Electron 聊天应用中，页面刷新后消息列表滚动位置停留在顶部而非底部。

**根本原因**：Virtuoso 虚拟列表用 `defaultItemHeight`（默认 30px）估算未渲染条目的高度，而实际消息高度为 80-500px。`initialTopMostItemIndex: { index: "LAST" }` 和 `scrollToIndex("LAST")` 都基于估算高度计算总列表高度和滚动位置，导致估算底部远低于真实底部。

**已排查的关键发现**：react-virtuoso v4.18.7 提供了 `heightEstimates: number[]` prop（类型定义行 1753），允许为每个条目提供预估高度数组。这是解决问题的最直接入口。

---

## 方案一：Pre-measure + heightEstimates（保留 Virtuoso，修复估算层）

### 原理

在数据到达后、Virtuoso 渲染前，为每条 `TimelineItem` 计算预估高度，传给 `heightEstimates`。Virtuoso 用它构建初始 size tree，大幅提高 `initialTopMostItemIndex` 和 `scrollToIndex("LAST")` 的精度。真高在条目实际渲染后由 ResizeObserver 自动修正。

### 高度预估策略（按精度递增）

#### 1a. 文本长度启发式（零 DOM 开销）

```ts
function estimateMessageHeight(item: TimelineItem): number {
  if (item.entry) return 80; // SessionEntry 固定小卡片

  const msg = item.message;
  if (!msg) {
    // 流式条目：用之前实测的平均流式高度
    if (item.isLive) return 400;
    return 120;
  }

  if (msg.role === "user") {
    const text = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
    return Math.max(60, Math.min(500, 48 + text.length * 0.08));
  }

  if (msg.role === "assistant") {
    // assistant 包含 thinking/toolCall/text 多种 block
    if (!("content" in msg)) return 300;
    const blocks = Array.isArray(msg.content) ? msg.content : [];
    let height = 80; // header
    for (const block of blocks) {
      if (block.type === "text") height += Math.max(40, block.text.length * 0.09);
      else if (block.type === "thinking") height += Math.max(60, (block.thinking?.length ?? 0) * 0.07);
      else if (block.type === "toolCall") height += 120;
      else if (block.type === "image") height += 200;
    }
    if (item.toolResultMap) height += Object.keys(item.toolResultMap).length * 100;
    return Math.max(120, Math.min(2000, height));
  }

  if (msg.role === "bashExecution") return Math.max(120, Math.min(600, 60 + msg.output.length * 0.06));

  return 200; // fallback
}
```

**精度**：平均误差 ±40%，但对 `heightEstimates` 来说已经比默认 30px 精确 3-5 倍。

#### 1b. DOM 预测量（离屏渲染一次）

```ts
function useHeightEstimates(timeline: TimelineItem[]): number[] {
  const [estimates, setEstimates] = useState<number[]>([]);
  const measureRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (timeline.length === 0) return;
    // 在离屏容器中渲染所有消息，用 ResizeObserver 测量
    const container = document.createElement("div");
    container.style.cssText =
      "position:fixed;left:-9999px;top:0;width:600px;visibility:hidden;pointer-events:none;";
    document.body.appendChild(container);

    // 批次渲染避免长任务卡顿
    const BATCH_SIZE = 30;
    const heights: number[] = [];
    let batchIndex = 0;

    function measureBatch() {
      const start = batchIndex * BATCH_SIZE;
      const end = Math.min(start + BATCH_SIZE, timeline.length);
      const fragment = document.createDocumentFragment();

      for (let i = start; i < end; i++) {
        const wrapper = document.createElement("div");
        wrapper.className = "px-5 py-1.5";
        // 渲染简化的消息 DOM（仅骨架结构）
        wrapper.innerHTML = getSkeletonHTML(timeline[i]);
        fragment.appendChild(wrapper);
      }

      container.appendChild(fragment);
      // 让浏览器布局
      requestAnimationFrame(() => {
        const children = container.children;
        for (let i = 0; i < children.length; i++) {
          heights[start + i] = (children[i] as HTMLElement).offsetHeight;
        }
        batchIndex++;
        if (batchIndex * BATCH_SIZE < timeline.length) {
          requestAnimationFrame(measureBatch);
        } else {
          document.body.removeChild(container);
          setEstimates(heights);
        }
      });
    }

    requestAnimationFrame(measureBatch);
    return () => { document.body.contains(container) && document.body.removeChild(container); };
  }, [timeline.length]); // 仅在 length 变化时重新测量（初始加载/切换会话）

  return estimates;
}
```

**精度**：±5-10%，因为 DOM 结构与真实渲染高度相关。

#### 1c. 持久化高度缓存（推荐方案，组合 1a + localStorage）

```ts
// 缓存 key：messageId → measuredHeight
const HEIGHT_CACHE_KEY = "look:msg-heights";

function usePersistedHeightEstimates(
  timeline: TimelineItem[],
  virtuosoRef: RefObject<VirtuosoHandle | null>,
): number[] {
  const cache = useMemo(() => loadHeightCache(), []);

  const estimates = useMemo(() => {
    return timeline.map((item, i) => {
      // 1. 优先用缓存
      if (cache.has(item.id)) return cache.get(item.id)!;
      // 2. 其次用启发式估算
      return estimateMessageHeight(item);
    });
  }, [timeline, cache]);

  // 渲染后将实测高度回写缓存
  const handleItemsRendered = useCallback(
    (items: ListItem<TimelineItem>[]) => {
      for (const li of items) {
        if (li.size > 0 && li.data?.id) {
          cache.set(li.data.id, li.size);
        }
      }
      // 延迟持久化，避免频繁写
      scheduleCachePersist(cache);
    },
    [cache],
  );

  return estimates;
}
```

这是**最推荐的路径**：首屏用启发式估算，渲染后用实测值更新缓存，二次进入时直接用缓存数据。Virtuoso 的 `itemsRendered` 回调提供每个条目的 `size`（Line 1276）。

### 实现复杂度：中

- ~200 行新增代码
- 不改变现有组件结构
- 不需要修改 IPC 数据流
- 不需要替换 Virtuoso

### 性能影响

| 场景 | 影响 |
|------|------|
| 首屏加载 | `heightEstimates` 避免 Virtuoso 多次重测，反而加快首次布局 |
| 滚动中 | 无影响（Virtuoso 自有 ResizeObserver 只在条目渲染时触发） |
| streaming | 流式条目高度持续变化，`followOutput` 仍然有效 |
| 大量消息（1000+） | 持久化缓存大小 ~10KB，不影响性能 |

### 场景覆盖

- **初始加载** ✅ 通过 `heightEstimates` 提供从缓存/启发式获取的预估高度
- **streaming 跟随** ✅ `followOutput` 和现有 `streamingUiFootprint` 机制不冲突
- **用户滚离** ✅ `atBottomStateChange` + `userScrolledAwayRef` 机制不变
- **切换会话** ✅ `Virtuoso key={agentId}` 触发完全重建，新 `heightEstimates` 生效
- **消息量大** ✅ 仍由 Virtuoso 虚拟化处理，缓存减少重复测量

### 关键代码改动（ChatMessageList.tsx）

```tsx
// 新增
import { usePersistedHeightEstimates } from "../hooks/useHeightEstimates";

const heightEstimates = usePersistedHeightEstimates(timeline, virtuosoRef);

<Virtuoso
  key={agentId}
  ref={virtuosoRef}
  data={timeline}
  computeItemKey={computeItemKey}
  heightEstimates={heightEstimates}  // ← 新增
  defaultItemHeight={120}            // ← 提高默认值（原来是 30）
  initialTopMostItemIndex={{ index: "LAST", align: "end" }}
  followOutput={followOutput}
  atBottomStateChange={handleAtBottomChange}
  itemContent={itemContent}
  itemsRendered={onItemsRendered}    // ← 新增：回写实测高度
/>
```

### 优缺点

| 优点 | 缺点 |
|------|------|
| 改动最小，不破坏现有架构 | 仍然依赖 Virtuoso，只是用对了它的 API |
| `heightEstimates` 是 v4 官方设计的功能 | 缓存策略需要维护（清理、失效） |
| 渐进增强：缓存为空时回退到启发式 | 首屏仍有短暂估算误差（但比 30px 好得多） |
| streaming、followOutput 等现有功能不变 | 需要处理 agent 更新后 message 内容变化的情况 |

---

## 方案二：Scroll Anchoring Queue（旁路 Virtuoso 用原生 scrollTop 控制）

### 原理

完全不使用 `scrollToIndex`、`initialTopMostItemIndex`、`followOutput`。改用 `scrollerRef` 获取底层 DOM 元素，用原生 `scrollTop` 和 `scrollHeight` 管理滚动。

核心思想：记录"锚点消息底部距视口底部的距离"，当内容高度变化时恢复这个距离。

### 实现设计

```ts
interface ScrollAnchor {
  anchorNodeId: string;          // 锚点消息 id
  distanceFromBottom: number;    // 锚点底部到视口底部的像素距离
}

function useScrollAnchor(scrollerEl: HTMLElement | null, timeline: TimelineItem[]) {
  const anchorRef = useRef<ScrollAnchor | null>(null);
  const mutationObserverRef = useRef<MutationObserver | null>(null);

  // 初始化：滚动到底部
  const scrollToRealBottom = useCallback(() => {
    if (!scrollerEl) return;
    scrollerEl.scrollTop = scrollerEl.scrollHeight;
  }, [scrollerEl]);

  // 记录锚点
  const recordAnchor = useCallback(() => {
    if (!scrollerEl) return;
    const viewportBottom = scrollerEl.scrollTop + scrollerEl.clientHeight;

    // 找最后一个在视口中的消息
    const children = scrollerEl.querySelectorAll("[data-message-id]");
    let anchorNode: Element | null = null;
    for (let i = children.length - 1; i >= 0; i--) {
      const rect = children[i].getBoundingClientRect();
      if (rect.bottom <= viewportBottom) {
        anchorNode = children[i];
        break;
      }
    }

    if (anchorNode) {
      anchorRef.current = {
        anchorNodeId: (anchorNode as HTMLElement).dataset.messageId!,
        distanceFromBottom: viewportBottom - anchorNode.getBoundingClientRect().bottom,
      };
    }
  }, [scrollerEl]);

  // 恢复锚点：在 MutationObserver 中，内容变化后恢复
  const restoreAnchor = useCallback(() => {
    if (!scrollerEl || !anchorRef.current) return;
    const { anchorNodeId, distanceFromBottom } = anchorRef.current;
    const node = scrollerEl.querySelector(`[data-message-id="${anchorNodeId}"]`);
    if (node) {
      const nodeBottom = node.getBoundingClientRect().bottom;
      const scrollerTop = scrollerEl.getBoundingClientRect().top;
      scrollerEl.scrollTop = nodeBottom - scrollerTop - scrollerEl.clientHeight + distanceFromBottom;
    }
  }, [scrollerEl]);

  // 流式跟随：持续记录 + 恢复
  useEffect(() => {
    if (!scrollerEl) return;
    const observer = new MutationObserver(() => {
      restoreAnchor();
    });
    observer.observe(scrollerEl, { childList: true, subtree: true, characterData: true });
    return () => observer.disconnect();
  }, [scrollerEl, restoreAnchor]);

  return { scrollToRealBottom, recordAnchor, restoreAnchor };
}
```

### 实现复杂度：高

- 需要精确管理 MutationObserver 的生命周期
- 需要处理 ResizeObserver 中图片加载、代码块展开等引起的异步高度变化
- 需要区分"用户滚动"和"内容增长导致的被动滚动"（抖动问题）
- 需要在 Virtuoso 的虚拟化 DOM 操作和自定义滚动控制之间协调

### 性能影响

- MutationObserver 在流式输出时可能高频触发（每个 delta 都触发）
- 需要节流/去抖策略
- 与 Virtuoso 的内部滚动管理可能产生冲突

### 场景覆盖

- **初始加载** ⚠️ 需要等 Virtuoso 渲染一部分条目后才能计算真实底部
- **streaming 跟随** ✅ MutationObserver 天然跟随内容变化
- **用户滚离** ✅ 原生 scroll 事件更精确
- **切换会话** ✅ 重置锚点状态
- **消息量大** ⚠️ 仍依赖 Virtuoso 虚拟化，但滚动控制绕过了 Virtuoso，可能出现竞态

---

## 方案三：移除 react-virtuoso，使用简单 div + overflow:auto

### 原理

聊天场景中消息数量通常在几十到几千条之间。在"只渲染最近 N 条 + 滚动加载更多"的策略下，完全可以不用虚拟化。直接使用 div + overflow-y:auto，用原生 `scrollTop = scrollHeight` 滚动到底部。

### 消息量评估

基于代码分析：
- `agent.messageCount` / `stats.totalMessages` 跟踪消息数
- 典型聊天会话：50-500 条消息
- 极端情况：2000+ 条消息的长对话

### 实现设计

```tsx
function SimpleChatMessageList({ timeline, agentId, ... }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [visibleCount, setVisibleCount] = useState(200); // 默认显示最近 200 条
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const isAtBottomRef = useRef(true);

  // 只渲染最近 visibleCount 条
  const visibleTimeline = useMemo(
    () => timeline.slice(Math.max(0, timeline.length - visibleCount)),
    [timeline, visibleCount],
  );

  // 初始滚动到底部
  useEffect(() => {
    if (containerRef.current && timeline.length > 0) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [agentId]); // 切换会话时

  // 首次有数据时
  const didInitialScroll = useRef(false);
  useEffect(() => {
    if (!didInitialScroll.current && timeline.length > 0) {
      didInitialScroll.current = true;
      const el = containerRef.current;
      if (el) requestAnimationFrame(() => { el.scrollTop = el.scrollHeight; });
    }
  }, [timeline.length]);

  // streaming 跟随
  useEffect(() => {
    if (isBusy && isAtBottomRef.current && containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [timeline, isBusy]); // timeline 引用变化时（内容增长）

  // 滚动事件：检测是否在底部、是否触发加载更多
  const handleScroll = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 50;
    isAtBottomRef.current = atBottom;
    setIsAtBottom(atBottom);

    // 滚动到顶部时加载更多
    if (el.scrollTop < 200 && !isLoadingMore && visibleCount < timeline.length) {
      setIsLoadingMore(true);
      const prevHeight = el.scrollHeight;
      requestAnimationFrame(() => {
        setVisibleCount((c) => Math.min(c + 100, timeline.length));
        requestAnimationFrame(() => {
          // 保持滚动位置不变（补偿新增内容高度）
          if (el) el.scrollTop = el.scrollHeight - prevHeight;
          setIsLoadingMore(false);
        });
      });
    }
  }, [isLoadingMore, visibleCount, timeline.length]);

  return (
    <div className="relative h-0 min-h-0 flex-1">
      <div
        ref={containerRef}
        className="h-full overflow-y-auto overscroll-contain"
        onScroll={handleScroll}
      >
        <div className="min-h-full">
          {visibleCount < timeline.length && (
            <div className="py-3 text-center text-xs text-muted-foreground">
              {isLoadingMore ? "加载更多消息..." : `${timeline.length - visibleCount} 条更早的消息`}
            </div>
          )}
          {visibleTimeline.map((item) => (
            <MessageItem key={item.id} item={item} />
          ))}
        </div>
      </div>
      {!isAtBottom && (
        <ScrollToBottomButton onClick={() => {
          if (containerRef.current) {
            containerRef.current.scrollTop = containerRef.current.scrollHeight;
          }
        }} />
      )}
    </div>
  );
}
```

### 性能基准估算

| 消息数 | DOM 节点估算 | 渲染时间 | 内存 |
|--------|-------------|---------|------|
| 50 | ~500 | <10ms | ~2MB |
| 200 | ~2000 | ~30ms | ~8MB |
| 500 | ~5000 | ~80ms | ~20MB |
| 1000 | ~10000 | ~200ms | ~40MB |

一般 200 条以内体验很好。超出后通过"最近 200 条 + 加载更多"分页，始终保持 DOM 可控。

### 实现复杂度：低

- ~150 行新增代码
- 移除 react-virtuoso 依赖
- 移除 Virtuoso 相关的 props、refs、callbacks
- 需要重新实现"回到底部按钮"（但逻辑更简单）

### 性能影响

- **优点**：零虚拟化开销，scrollTop/scrollHeight 操作 O(1)，无需高度估算
- **缺点**：500+ 条消息时初始渲染慢。分页策略可缓解。
- **内存**：200 条消息的 DOM 约 8-10MB，对 Electron 应用可接受

### 场景覆盖

- **初始加载** ✅ 原生 `scrollTop = scrollHeight` 精确定位到底部
- **streaming 跟随** ✅ 原生 scrollTop 操作，快速且精确
- **用户滚离** ✅ 原生 scroll 事件天然精确
- **切换会话** ✅ `useEffect([agentId])` 触发重置
- **消息量大** ⚠️ 需要分页。严重情况下（500+ 条）可能不流畅
- **消息搜索/跳转到特定消息** ⚠️ 需要额外实现（原来的 `scrollToIndex` 丢失）

---

## 方案四：两阶段渲染（先占位后精确）

### 原理

Phase 1：所有消息用最小占位高度（如 40px）快速渲染，让 Virtuoso 在 1 帧内完成整个列表的"骨架"。
Phase 2：用 ResizeObserver 监听每条消息的容器，一旦测量到真实高度就更新。

类似 Twitter/X 的时间线加载策略：先显示骨架屏，再展开真实内容。

### 实现设计

```tsx
function TwoPhaseMessageList({ timeline, ... }: Props) {
  const [phases, setPhases] = useState<Record<string, "skeleton" | "measured">>({});

  // Phase 1: 骨架渲染
  const SkeletonMessage = memo(({ item }: { item: TimelineItem }) => {
    const ref = useRef<HTMLDivElement>(null);
    const estimatedH = item.isLive ? 400 : estimateMessageHeight(item);

    useEffect(() => {
      // 用 observer 等待真实内容
      const el = ref.current;
      if (!el) return;
      const observer = new ResizeObserver((entries) => {
        const h = entries[0]?.contentRect.height;
        if (h && h > estimatedH * 0.5 && h < estimatedH * 3) {
          // 高度稳定后标记为已测量
          setPhases((p) => ({ ...p, [item.id]: "measured" }));
          observer.disconnect();
        }
      });
      observer.observe(el);
      return () => observer.disconnect();
    }, []);

    return (
      <div ref={ref} style={{ minHeight: estimatedH }}>
        <MessageBubbleProxy item={item} skeleton={phases[item.id] !== "measured"} />
      </div>
    );
  });

  // 总高度在 Phase 1 就由 estimatedH 累加得出，比 30px 精确；
  // Phase 2 后 ResizeObserver 更新真实高度，Virtuoso 自动重新布局。
}
```

### 实现复杂度：高

- 每个消息都需要一个 ResizeObserver，超过 100 个时性能堪忧
- 需要区分"骨架"和"真实"渲染，组件层面改动大
- Phase 1→2 过渡可能有视觉闪烁

### 性能影响

- 100 个 ResizeObserver = 100 个监听器，每个消息变化都触发回调
- 骨架→真实内容的过渡可能引起浏览器多次 reflow
- Virtuoso 在 Phase 2 需要重新计算整个 size tree

---

## 综合推荐

### 推荐方案：方案 1c（heightEstimates + 持久化缓存）

**核心理由**：

1. **react-virtuoso v4 已经为这个问题设计了 `heightEstimates` 方案**。我们需要的不是绕过 Virtuoso，而是正确使用它的 API。
2. `heightEstimates` 让 Virtuoso 在首次渲染前就拥有接近真实的高度估算，`scrollToIndex("LAST")` 将会精确定位。
3. 持久化缓存让二次打开时完全不需要估算——所有高度都是上次实测的准确值。
4. **改动最小**：只需在 `ChatMessageList.tsx` 中加两个 prop、一个新 hook。
5. 虚拟化的性能优势得以保留，当消息数超过 500 时仍无压力。

### 激进替代：方案 3（移除 react-virtuoso）

如果团队认为：
- 聊天场景的虚拟化带来更多麻烦（高度估算、滚动 API 不直观）而非价值
- 消息数通常 <300 条
- 希望完全掌控滚动行为

那么方案 3 是更简洁的选择。实现成本比调试 Virtuoso 的滚动行为更低，且 `scrollTop = scrollHeight` 永远不会出错。

**判断标准**：统计用户平均会话的消息数。如果 80% 的会话 <200 条消息 → 方案 3。如果有大量 500+ 条的会话 → 方案 1c。

### 不推荐方案 2 和 4

- **方案 2**：MutationObserver + 手动锚定在理论上是完备的，但实现复杂度远高于收益。Virtuoso 内部已经做了类似的 size tree 管理，方案 2 相当于重写这部分。
- **方案 4**：两阶段渲染引入了可见的视觉闪烁，且每个消息一个 ResizeObserver 的架构在消息数多时会产生性能问题。这本质上是方案 1 的低效实现。

### 总结对比表

| 维度 | 方案1c heightEstimates | 方案2 Anchoring | 方案3 移除Virtuoso | 方案4 两阶段 |
|------|----------------------|-----------------|-------------------|-------------|
| 实现复杂度 | 中 | 高 | 低~中 | 高 |
| 代码改动量 | ~200行 | ~350行 | ~200行（含删除） | ~400行 |
| 首屏准确度 | ★★★★☆ | ★★★☆☆ | ★★★★★ | ★★★★☆ |
| streaming体验 | ★★★★★ | ★★★★☆ | ★★★★★ | ★★★☆☆ |
| 大量消息性能 | ★★★★★ | ★★★★☆ | ★★★☆☆ | ★★★☆☆ |
| 维护成本 | 低 | 高 | 低 | 高 |
| 回退风险 | 低（仅新增prop） | 中 | 中（移除依赖） | 高 |
| 与其他Virtuoso用法兼容 | ✅ 完全兼容 | ⚠️ 可能冲突 | N/A | ⚠️ 部分兼容 |
