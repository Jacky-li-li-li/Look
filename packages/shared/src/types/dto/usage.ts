// 用量统计 DTO —— 与 pi SDK 的 Usage 结构对齐（session JSONL assistant 消息）。
// 主进程 usage-service 聚合后经 IPC 返回；渲染端 UsageHeatmap/UsageStackedChart 消费。

export interface SdkUsageCost {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	total: number;
}

export interface SdkUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	reasoning?: number;
	totalTokens: number;
	cost: SdkUsageCost;
}

/** Aggregated daily usage: sums of raw SdkUsage objects per model. */
export interface AggregatedUsage extends SdkUsage {
	turns: number;
}

export interface ModelCostEntry {
	turns: number;
	cost: number;
}

/** usage:get 的成功载荷（每日聚合用量，按年份/模型两级索引）。 */
export interface UsageData {
	usage: Record<string, number>;
	modelCost: Record<string, Record<string, ModelCostEntry>>;
	/** Per-day per-model aggregated SDK Usage objects */
	modelUsage: Record<string, Record<string, AggregatedUsage>>;
	years: number[];
}
