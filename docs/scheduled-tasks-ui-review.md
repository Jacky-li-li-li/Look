# 定时任务模块 UI 样式审查报告

> 审查日期：2026-07-13  
> 审查范围：`src/renderer/components/scheduler/ScheduledTasksPage.tsx`（830行单文件，涵盖列表、详情、编辑/创建、执行历史四大视图）  
> 设计系统参考：`packages/shared/src/components/ui/*`、`App.css`（Look 设计系统）、`tailwind.config`（shadcn/ui 主题变量）

---

## 一、总体评估

该模块将所有 UI 逻辑集中在单个 830 行的文件中，未作组件拆分。整体功能完整（列表→详情→创建/编辑→执行轨迹），但存在以下系统性问题：

1. **与项目组件库标准偏离明显**：自建了 `SectionCard`、`Field` 等组件替代 `Card`、`Label` 标准组件
2. **Typography 尺度混乱**：页面内出现 `text-[9px]`、`text-[10px]`、`text-[11px]`、`text-[12px]`、`text-xs`、`text-sm`、`text-base`、`text-lg` 共 8 种字号，且最小的 9px 低于可读性下限
3. **间距系统不统一**：同一个文件中 `space-y-1.5`、`space-y-2`、`space-y-4`、`space-y-6`、`gap-1`、`gap-2`、`gap-3`、`gap-4`、`gap-6` 并存，缺乏层级规范
4. **暗色模式未充分验证**：当前代码大量使用硬编码色值（如 `bg-emerald-500`），在 `.tone-dark` 下可能对比度不足

---

## 二、问题清单

### 2.1 视觉一致性

#### 问题 V-01：Badge 组件样式被覆盖，偏离组件标准
- **位置**：任务列表项 `TaskListItem`（第187行）、详情视图 `TaskDetail`（第223行）
- **描述**：项目 `Badge` 组件标准为 `h-5 text-xs`，但该模块将 Badge 覆盖为 `h-4 px-1.5 text-[9px]`，尺寸缩小约 20%
- **违规**：违反组件库一致性原则——组件尺寸不应在消费侧覆盖，应使用组件自身的 `size` 或 `variant` 变体
- **建议**：移除 `className="h-4 px-1.5 text-[9px]"` 覆盖，考虑在 `Badge` 组件中新增 `size="xs"` 变体供全局使用

#### 问题 V-02：SectionCard 自建组件替代项目标准 Card
- **位置**：`SectionCard` 组件（第351-370行），用于编辑器的"执行计划"卡片和"IM通知"卡片
- **描述**：自建了带有 `bg-muted/15`、`border-hairline`、`border-l-4` accent 样式的卡片容器，而项目已有完整的 `Card`/`CardHeader`/`CardContent` 组件体系
- **违规**：违反"复用已有组件"的工程原则，引入了新的视觉模式（如左侧 accent border）
- **建议**：使用 `Card` + `CardHeader` + `CardContent` 替代 `SectionCard`；如确需左侧 accent 样式，考虑在 `Card` 上通过 className 扩展而非自建组件

#### 问题 V-03：Field 组件与 Label 标准不一致
- **位置**：`Field` 组件（第339-349行）
- **描述**：项目 `Label` 组件标准字号为 `text-sm`，而 `Field` 内部将 label 字体设为 `text-[11px]`，比标准缩小了约 2px，视觉层级降低过多
- **违规**：表单标签字号应在全项目内保持一致
- **建议**：使用项目 `Label` 组件，或至少将字号统一为 `text-xs`（而非 `text-[11px]` 这种不对应 Token 的任意值）

#### 问题 V-04：状态色使用硬编码值，非语义化 Token
- **位置**：`statusTone()`（第115-119行）、`statusBorder()`（第122-127行）、任务列表项状态圆点（第180行）
- **描述**：
  - 成功态直接使用 `bg-emerald-500`，而非项目的语义 Token（项目无 `--success` 变量，但建议统一为 Tailwind 类 `bg-emerald-500` 或定义语义 Token）
  - 失败态正确使用 `bg-destructive`
  - 运行态使用 `bg-amber-500`（硬编码）
  - 暂停态使用 `bg-muted-foreground/40`（半透明灰色，在暗色模式下可能不可见）
- **违规**：颜色应通过 Token 引用，便于主题切换时自动适配
- **建议**：
  - 定义 `--status-success`、`--status-warning`、`--status-idle` CSS 变量
  - 在 `.tone-dark` 下提供对应的暗色值
  - 使用 `bg-(--status-success)` 等方式引用

#### 问题 V-05：列表项选中态用自定义颜色拼写，非标准高亮方案
- **位置**：`TaskListItem`（第177行）
- **描述**：选中态使用 `border-foreground/25 bg-accent/30`，hover 态使用 `bg-accent/15`
- **分析**：与项目内侧边栏 `liquid-row` 的 `data-active` 规范不一致；同时 `bg-accent/30` 和 `bg-accent/15` 的透明度值（30% vs 15%）差异不明显，可能不易区分
- **建议**：统一为 `liquid-row` 的 data-active 样式模式；或将透明度差异加大到 10% → 25%

#### 问题 V-06：标题字号不一致
- **位置**：详情视图头部第220行（`text-lg`）、编辑器头部第474行（`text-lg`）
- **分析**：项目内 `CardTitle` 标准为 `text-base`，`DialogTitle` 为 `text-base`。`text-lg` 在模块内显得过大
- **建议**：统一为 `text-base font-semibold tracking-tight` 与项目标题规范对齐

#### 问题 V-07：图标尺寸混用
- **位置**：多处
- **描述**：
  - 详情视图操作按钮图标用 `size-3.5`（对应 Button `size="sm"` 的 svg 规范）—**正确**
  - 删除按钮图标用 `size-4`（而非 `size-3.5`）—**不一致**（第261行）
  - 空状态图标用 `size-4`（第130行）和 `size-5`（第147行）—**两个空状态图标大小不同**
  - 详情卡内的 BellRing 图标用 `size-3.5`（第318行）
- **违规**：同一视图层级下的功能图标应使用统一的尺寸
- **建议**：功能图标统一为 `size-3.5`，装饰性空状态图标统一为 `size-5` 或 `size-6`

---

### 2.2 布局合理性

#### 问题 L-01：左侧列表面板宽度硬编码
- **位置**：主布局 aside 元素（第834行）
- **描述**：`className="flex w-72 shrink-0 …"` 使用 Tailwind 的 `w-72`（288px），而项目定义了 `--sidebar-width: 280px` CSS 变量
- **违规**：宽度应引用项目布局变量，避免 magic number
- **建议**：使用 `w-[var(--sidebar-width)]` 或定义一个 `--scheduler-list-width` 变量

#### 问题 L-02：执行历史面板固定高度无响应式
- **位置**：执行历史区域（第902行）
- **描述**：`className="h-60 shrink-0 …"` 固定 240px 高度
- **分析**：在小屏笔记本（如 768px 高）上，240px + 顶部 header 约 52px，主内容区仅剩约 476px；在 1080p 屏幕上也有比例不协调的问题（历史面板占主区约 30%）
- **建议**：
  - 桌面端使用 `h-[max(200px,25vh)]` 或百分比
  - 移动端/窄屏下考虑将历史面板改为可折叠面板或抽屉

#### 问题 L-03：任务列表项内部间距过于紧凑
- **位置**：`TaskListItem`（第174行）
- **描述**：`px-3 py-2.5` 在列表项内部产生了约 10px 的上下内边距，配合 `gap-3` 的布局间距，密集任务时视觉压迫感强
- **推荐**：至少 `py-3`（12px），以匹配项目侧边栏 `liquid-row` 的节奏

#### 问题 L-04：编辑器表单无分组视觉分隔
- **位置**：`TaskEditor` 表单区域（第482-574行）
- **描述**：表单分为"基本信息"、"执行计划"、"模型与通知"、"提示词与参数"、"重试设置"等逻辑区域，但除了执行计划使用 `SectionCard` 外，其他区域通过 `grid` 原生排列，缺少视觉边界
- **建议**：
  - 使用 `Card` 或 `<fieldset>` 对每个逻辑区域进行包裹
  - 或至少在区域间添加 `Separator` 分隔线

#### 问题 L-05：详情页信息卡网格在窄屏下排版异常
- **位置**：`TaskDetail` 信息卡（第266-295行）
- **描述**：`grid-cols-2 md:grid-cols-4`——在 640px 以下为 2 列，但提示词和参数卡是 `grid-cols-1 lg:grid-cols-2`，在 640-1024px 之间为单列，其他卡为双列，造成视觉跳跃
- **建议**：在 640-1024px 断点统使用 2 列布局；或将所有信息卡放入同一 grid 统一管理列数

#### 问题 L-06：无移动端适配考虑
- **位置**：全文
- **描述**：整个页面假设至少 768px 宽度（列表 288px + 内容 340px + 右侧面板）。在平板竖屏（768px）或更窄设备上，布局会出现横向溢出或被截断
- **分析**：Electron 应用中通常窗口最小宽度为 900px+，但应考虑用户可能的窄窗口使用场景
- **建议**：
  - 在 `<1024px` 时将列表面板折叠为可切换的抽屉
  - 详情/编辑器布局在 `<640px` 时使用单列

---

### 2.3 交互细节

#### 问题 I-01：任务列表项禁用态缺失
- **位置**：`TaskListItem`（第163行）
- **描述**：任务列表项仅有 `cursor-pointer` 和 hover/选中样式，无 `disabled` 视觉状态
- **影响**：当任务正在操作中（如 busy 状态），用户点击任务列表项仍会有 hover 反馈，造成"可以交互"的错觉
- **建议**：当 `busy === true` 时，给列表项添加 `opacity-50 pointer-events-none` 样式

#### 问题 I-02：缺少加载骨架屏
- **位置**：整个页面（首次加载时）
- **描述**：任务列表、详情区在数据加载过程中无任何加载指示器或骨架屏，用户仅看到空态或短暂闪烁
- **建议**：
  - 添加 `Skeleton` 组件（项目中 shadcn/ui 提供）
  - 至少在列表区显示 2-3 个骨架占位项

#### 问题 I-03：busy 状态反馈不完整
- **位置**：`ScheduledTasksPage` 主组件（第817行）
- **描述**：`busy` 状态仅传递给详情视图的按钮 `disabled` 属性和 editor 的按钮 `disabled` 属性，但：
  - 头部的"+ 新建任务"按钮在 busy 时不禁用
  - 左侧列表项在 busy 时不禁用点击
  - 无全局 loading overlay 或进度指示
- **建议**：
  - 头部"新建任务"按钮在 busy 时添加 `disabled` 属性
  - 考虑在操作区域添加 `LoaderCircle` 旋转指示器

#### 问题 I-04：Toast 提示缺少操作一致性
- **位置**：`save()`（第610行）、`act()`（第624行）
- **描述**：成功 Toast 使用 `toast.success()`，失败使用 `toast.error()`；但部分操作（如 pause/start）成功后无 Toast 提示，用户缺少操作确认
- **建议**：
  - 所有操作（start/pause/run/delete）完成后给出 `toast.success` 确认
  - 统一 Toast 文案格式

#### 问题 I-05：测试结果的视觉反馈区域可发现性不足
- **位置**：`TaskEditor` 测试结果展示（第575-600行）
- **描述**：测试结果卡片出现在表单底部、保存按钮上方，用户可能因滚动距离长而忽略测试结果
- **建议**：
  - 测试完成后自动滚动到结果区域（使用 `scrollIntoView`）
  - 或在顶部显示一个 sticky 的测试状态条

#### 问题 I-06：删除操作使用原生 confirm 弹窗
- **位置**：`act()` 函数（第624行）
- **描述**：`window.confirm(t("scheduledTasks.deleteConfirm", ...))` 使用浏览器原生确认对话框
- **违规**：与应用整体使用 shadcn/ui `Dialog` 组件的模式不一致（参见 AgentEditor 使用 Dialog）
- **建议**：使用项目 `Dialog` 组件实现删除确认弹窗

---

### 2.4 合规性（可访问性 / WCAG）

#### 问题 A-01：字体过小违反 WCAG 2.1 SC 1.4.4（文本缩放）
- **位置**：全文多处使用 `text-[9px]` 和 `text-[10px]`
- **描述**：WCAG 要求文本可放大至 200% 而不丢失内容。虽然浏览器缩放可处理，但 9px 的基础字号在 1x 缩放下肉眼极难阅读，尤其在 Retina 以外的屏幕上
- **影响元素**：
  - 任务列表 badge：`text-[9px]`
  - 详情信息卡标签：`text-[10px]`
  - 列表项元信息：`text-[10px]`
  - 测试结果信息：`text-[9px]`
- **建议**：最小正文字号不低于 `text-[10px]`（约 10px），标签类不低于 `text-[11px]`（约 11px）

#### 问题 A-02：muted-foreground 在小字号下对比度不足
- **位置**：`text-[10px] text-muted-foreground` 的列表项描述文本（第189行）
- **分析**：
  - light 模式：`--muted-foreground: oklch(0.52 0.002 85)` 在 `--background: oklch(0.985 0.002 85)` 上的对比度约为 4.2:1
  - dark 模式：`--muted-foreground: oklch(0.72 0.002 85)` 在 `--background: oklch(0.09 0.002 85)` 上的对比度约为 5.5:1
  - **light 模式下的 10px 字号 + 4.2:1 对比度 → 违反 WCAG 2.1 SC 1.4.3**（普通文本需要 ≥4.5:1，小文本更高）
- **建议**：light 模式下将 `--muted-foreground` 调整为 `oklch(0.48 0.002 85)` 以提高对比度至 ~5:1

#### 问题 A-03：状态圆点缺少文字标签
- **位置**：任务列表项状态圆点（第180行）
- **描述**：`<span className="size-2 rounded-full …"/>` 为纯装饰性色块，无 `aria-label` 或 `role="img"`，屏幕阅读器无法识别任务状态
- **建议**：添加 `aria-label={task.status === 'scheduled' ? '运行中' : '已暂停'}` 和 `role="img"`

#### 问题 A-04：自定义列表项缺少 ARIA 角色信息
- **位置**：`TaskListItem`（第163行）
- **描述**：`role="button"` 的列表项没有 `aria-pressed` 或 `aria-selected` 来指示选中状态
- **建议**：添加 `aria-selected={isSelected}` 和 `aria-label={task.name}`

#### 问题 A-05：emoji 图标（✅/❌）在通知中使用的问题
- **位置**：后端 `main/index.ts` 第296行（非 UI 文件，但影响用户可见通知）
- **描述**：通知文案中使用 emoji `✅` 和 `❌` 作为状态指示，在不同操作系统/字体下渲染效果不一致
- **建议**：使用文字标签 `[成功]` / `[失败]` 替代 emoji，或仅在富文本通知中使用

#### 问题 A-06：焦点可见性不一致
- **位置**：整个模块
- **描述**：
  - 列表项有 `focus-visible:ring-2 focus-visible:ring-ring/50` — **良好**
  - 详情视图的按钮依赖 Button 组件的 focus-visible 处理 — **正确**
  - 但测试结果区域、IM 通知信息条等不可交互内容无焦点
  - `SectionCard` 无 focus 样式
- **分析**：整体焦点管理良好，主要问题集中在自定义交互元素上
- **建议**：对 `EmptyTaskList` 和 `EmptyWorkspace` 中的装饰性图标添加 `aria-hidden="true"`

---

### 2.5 代码质量 / 组件架构

#### 问题 C-01：单文件过大，应拆分为多个组件文件
- **位置**：`ScheduledTasksPage.tsx`（830行）
- **描述**：该文件包含了 `EmptyTaskList`、`EmptyWorkspace`、`TaskListItem`、`TaskDetail`、`Field`、`SectionCard`、`TaskEditor`、`ExecutionHistory`、`ScheduledTasksPage` 共 9 个组件和多个工具函数
- **建议**：拆分为：
  - `scheduler/TaskListPanel.tsx`（含 `TaskListItem`、`EmptyTaskList`）
  - `scheduler/TaskDetail.tsx`
  - `scheduler/TaskEditor.tsx`（含 `Field`、`SectionCard`）
  - `scheduler/ExecutionHistory.tsx`
  - `scheduler/ScheduledTasksPage.tsx`（主容器，仅组合布局）
  - `scheduler/helpers.ts`（工具函数：`scheduleForTask`、`formatDate`、`statusTone` 等）

#### 问题 C-02：className 使用模板字符串而非 cn() 工具
- **位置**：`TaskListItem` 第177-178行
- **描述**：使用 `` `… ${isSelected ? "…" : "…"} …` `` 拼接 className，而非项目统一的 `cn()` 工具
- **违规**：`cn()` 是项目全局统一的类名合并方式（含 `twMerge` 冲突解决），应全网一致使用
- **建议**：改为 `cn("base-classes", isSelected && "selected-classes")`

---

## 三、对照参考页面

| 维度 | 通用设置页 (`GeneralTab`) | 定时任务页 (`ScheduledTasksPage`) | 差距 |
|------|--------------------------|----------------------------------|----|
| 卡片容器 | 使用 `Card`/`CardHeader`/`CardContent` | 自建 `SectionCard` | ❌ 应统一 |
| 标签字号 | `text-[13px]` | `text-[11px]` | ⚠️ 偏小 |
| 描述字号 | `text-[11px]` | `text-[10px]` | ⚠️ 偏小 |
| 内边距 | `p-4` 统一 | `p-5`、`px-4 py-2`、`p-2` 混用 | ⚠️ 不统一 |
| 分隔线 | `divide-y divide-hairline` | `border-b border-hairline` + 自建分隔 | ✅ 方式不同但合理 |
| 按钮尺寸 | `size="sm"` | `size="sm"` + `size="icon-sm"` | ✅ 一致 |
| Select 尺寸 | `size="sm"` | 默认 `size="default"` | ⚠️ 应用 sm |

---

## 四、优化建议（按优先级排序）

### 高优先级（影响一致性与可访问性）

1. **P0-1**: 统一组件使用——将 `SectionCard` 替换为项目 `Card`，将 `Field` 替换为项目 `Label`
2. **P0-2**: 提升最小字号至 `text-[10px]`（标签）、`text-[11px]`（正文），移除所有 `text-[9px]`
3. **P0-3**: Badge 不再覆盖组件标准样式，如需更小尺寸考虑在 Badge 组件库中新增 `size="xs"`
4. **P0-4**: 删除确认使用项目 `Dialog` 替代 `window.confirm`
5. **P0-5**: 添加 ARIA 属性（`aria-selected`、`aria-label` 等）至自定义交互元素

### 中优先级（提升用户体验）

6. **P1-1**: 拆分为多个组件文件，降低单文件复杂度
7. **P1-2**: 添加加载骨架屏 / 首次加载指示器
8. **P1-3**: busy 状态下全局禁用操作入口（头部按钮、列表项点击）
9. **P1-4**: 添加暗色模式下的状态色适配（定义语义 Token）
10. **P1-5**: 执行历史面板高度改为响应式（vh 或百分比）
11. **P1-6**: 左侧列表宽度引用项目 CSS 变量

### 低优先级（细节打磨）

12. **P2-1**: 统一图标的尺寸：功能图标 `size-3.5`，装饰图标 `size-5`
13. **P2-2**: 使用 `cn()` 替代模板字符串拼接 className
14. **P2-3**: 测试完成后自动滚动到结果区域
15. **P2-4**: 所有操作添加成功 Toast 确认
16. **P2-5**: 移动端/窄屏响应式布局优化

---

## 五、总结

定时任务模块在功能层面完成度较高，但在 UI 样式的一致性上与项目设计系统存在较明显的偏离。核心问题集中在：

1. **组件复用不足**：自建了约 3 个与项目组件库功能重复的容器/表单组件
2. **Typography 尺度失控**：8 种字号混用，且最小的 9px 无法满足无障碍标准
3. **间距缺乏层级**：同一视图内 gap/space 值跳跃过大
4. **硬编码色值与 Token 混用**：部分状态色直接写 Tailwind 色值而非引用设计 Token

建议优先修复 P0 级别的 5 个问题（组件统一、字号提升、Badge 规范、删除确认弹窗、ARIA 无障碍），这些修复可在不改变功能的前提下显著提升视觉一致性和可访问性。

P1 级别的问题（组件拆分、骨架屏、响应式）涉及较大的重构工作，建议纳入下一个迭代计划。

---

*报告生成于 2026-07-13，基于代码版本 `ScheduledTasksPage.tsx` (830 lines) 和设计系统规范。*
