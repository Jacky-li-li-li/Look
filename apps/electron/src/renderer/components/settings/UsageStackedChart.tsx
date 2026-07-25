// ============================================================
// UsageStackedChart — per-model daily cost stacked bar chart
//
// Each bar = one day. Each colored segment = one model's total cost.
// Tooltip shows cost breakdown (output, input, cache read, cache write).
// ============================================================

import { useMemo } from "react";
import { Bar, BarChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { AggregatedUsage } from "../../store/atoms";

interface UsageStackedChartProps {
	modelUsage: Record<string, Record<string, AggregatedUsage>>;
	selectedYear: number;
}

/** 12-color palette for model assignment. */
export const MODEL_COLORS = [
	"oklch(0.646 0.222 41.116)", // orange
	"oklch(0.6 0.118 184.704)", // cyan
	"oklch(0.398 0.07 227.392)", // indigo
	"oklch(0.828 0.189 84.429)", // yellow
	"oklch(0.769 0.188 70.08)", // amber
	"oklch(0.55 0.18 280)", // purple
	"oklch(0.65 0.2 160)", // teal
	"oklch(0.7 0.22 10)", // coral
	"oklch(0.5 0.08 250)", // blue
	"oklch(0.45 0.15 130)", // green
	"oklch(0.6 0.18 330)", // pink
	"oklch(0.35 0.05 200)", // slate
];

interface ChartDataPoint {
	day: string;
	label: string;
	[key: string]: number | string;
}

function formatCost(value: number): string {
	if (value >= 0.01) return `$${value.toFixed(4)}`;
	if (value >= 0.0001) return `$${value.toFixed(6)}`;
	return `$${value.toExponential(2)}`;
}

function modelTotal(usage: AggregatedUsage): number {
	return usage.cost.output + usage.cost.input + usage.cost.cacheRead + usage.cost.cacheWrite;
}

export function buildModelColorMap(modelNames: string[]): Record<string, string> {
	const map: Record<string, string> = {};
	modelNames.forEach((model, i) => {
		map[model] = MODEL_COLORS[i % MODEL_COLORS.length];
	});
	return map;
}

export function buildChartData(
	modelUsage: Record<string, Record<string, AggregatedUsage>>,
	selectedYear: number,
): { chartData: ChartDataPoint[]; modelNames: string[]; modelKeys: Record<string, string> } {
	const yearPrefix = `${selectedYear}-`;

	const dayCosts: Map<string, Map<string, number>> = new Map();
	const allModels = new Set<string>();

	for (const [dateKey, models] of Object.entries(modelUsage)) {
		if (!dateKey.startsWith(yearPrefix)) continue;
		const mmdd = dateKey.slice(5);
		if (!dayCosts.has(mmdd)) dayCosts.set(mmdd, new Map());
		const costMap = dayCosts.get(mmdd)!;
		for (const [model, usage] of Object.entries(models)) {
			allModels.add(model);
			costMap.set(model, (costMap.get(model) ?? 0) + modelTotal(usage));
		}
	}

	const modelNames = Array.from(allModels).sort((a, b) => {
		let aCost = 0,
			bCost = 0;
		for (const costMap of dayCosts.values()) {
			aCost += costMap.get(a) ?? 0;
			bCost += costMap.get(b) ?? 0;
		}
		return bCost - aCost;
	});

	const modelKeys: Record<string, string> = {};
	modelNames.forEach((model, i) => {
		modelKeys[model] = `m_${i}`;
	});

	const dates = Array.from(dayCosts.keys()).sort();
	const chartData: ChartDataPoint[] = dates.map((mmdd) => {
		const costMap = dayCosts.get(mmdd)!;
		const point: ChartDataPoint = { day: mmdd, label: mmdd };
		for (const model of modelNames) {
			point[modelKeys[model]] = costMap.get(model) ?? 0;
		}
		return point;
	});

	return { chartData, modelNames, modelKeys };
}

interface ChartMeta {
	chartData: ChartDataPoint[];
	modelNames: string[];
	modelColorMap: Record<string, string>;
	modelKeys: Record<string, string>;
	totalCost: number;
}

export default function UsageStackedChart({ modelUsage, selectedYear }: UsageStackedChartProps) {
	const meta = useMemo<ChartMeta>(() => {
		const { chartData, modelNames, modelKeys } = buildChartData(modelUsage, selectedYear);
		const modelColorMap = buildModelColorMap(modelNames);

		let totalCost = 0;
		for (const [dateKey, models] of Object.entries(modelUsage)) {
			if (!dateKey.startsWith(`${selectedYear}-`)) continue;
			for (const usage of Object.values(models)) {
				totalCost += modelTotal(usage);
			}
		}

		return { chartData, modelNames, modelColorMap, modelKeys, totalCost };
	}, [modelUsage, selectedYear]);

	const { chartData, modelNames, modelColorMap, modelKeys, totalCost } = meta;

	if (chartData.length === 0) {
		return <div className="text-muted-foreground py-4 text-[11px]">No usage data for this year.</div>;
	}

	return (
		<div className="flex flex-col gap-3">
			<div className="flex items-center justify-between">
				<h3 className="text-[13px] font-medium">Daily cost by model</h3>
				<span className="font-mono text-[11px] text-muted-foreground">Total: ${totalCost.toFixed(4)}</span>
			</div>
			<div style={{ width: "100%", height: 300 }}>
				<ResponsiveContainer>
					<BarChart data={chartData} margin={{ top: 4, right: 4, bottom: 4, left: 4 }} barCategoryGap="30%">
						<XAxis
							dataKey="label"
							tick={{ fontSize: 10, fill: "oklch(0.55 0.02 260)" }}
							tickLine={false}
							axisLine={false}
							interval={Math.max(0, Math.floor(chartData.length / 8))}
						/>
						<YAxis
							tick={{ fontSize: 10, fill: "oklch(0.55 0.02 260)" }}
							tickLine={false}
							axisLine={false}
							tickFormatter={(v: number) => `$${v.toFixed(4)}`}
							width={52}
						/>
						<Tooltip
							content={({ active, payload, label }) => {
								if (!active || !payload?.length) return null;
								const fullDate = `${selectedYear}-${label}`;
								return (
									<div
										style={{
											background: "oklch(0.21 0.006 285)",
											border: "1px solid oklch(0.28 0.008 286)",
											borderRadius: "8px",
											padding: "8px 10px",
											fontSize: "11px",
											color: "oklch(0.95 0 0)",
											lineHeight: 1.6,
										}}
									>
										<div style={{ fontWeight: 600, marginBottom: 4 }}>{fullDate}</div>
										{[...payload]
											.sort((a, b) => (Number(b.value) || 0) - (Number(a.value) || 0))
											.map((entry) => {
												const modelName = entry.name ?? String(entry.dataKey);
												const usage = fullDate ? modelUsage[fullDate]?.[modelName] : undefined;
												if (!usage || !Number(entry.value)) return null;
												return (
													<div key={modelName} style={{ marginTop: 6 }}>
														<div style={{ fontWeight: 500, color: entry.color }}>{modelName}</div>
														<div style={{ paddingLeft: 8, fontSize: "10px", opacity: 0.85 }}>
															<div>Total: {formatCost(modelTotal(usage))}</div>
														</div>
													</div>
												);
											})}
									</div>
								);
							}}
						/>
						{modelNames.map((model) => (
							<Bar
								key={model}
								dataKey={modelKeys[model]}
								name={model}
								stackId="cost"
								fill={modelColorMap[model]}
								radius={[3, 3, 0, 0]}
							/>
						))}
					</BarChart>
				</ResponsiveContainer>
			</div>
			{/* Legend */}
			<div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[10px] text-muted-foreground">
				{modelNames.map((model) => (
					<div key={model} className="flex items-center gap-1.5">
						<div className="h-2.5 w-2.5 rounded-sm" style={{ backgroundColor: modelColorMap[model] }} />
						<span>{model}</span>
					</div>
				))}
			</div>
		</div>
	);
}
