// ============================================================
// UsageStackedChart — per-model daily cost stacked bar chart
// ============================================================

import { useMemo } from "react";
import { Bar, BarChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

interface ModelCostEntry {
	turns: number;
	cost: number;
}

interface UsageStackedChartProps {
	modelCost: Record<string, Record<string, ModelCostEntry>>;
	selectedYear: number;
}

/** 12-color oklch palette for model assignment. */
const MODEL_COLORS = [
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

/** Known model → color mappings for consistency. */
const KNOWN_MODEL_COLORS: Record<string, string> = {
	"deepseek-v4-flash": MODEL_COLORS[1], // cyan
	"deepseek-v4-pro": MODEL_COLORS[2], // indigo
	"deepseek-v3": MODEL_COLORS[3], // yellow
	"deepseek-reasoner": MODEL_COLORS[4], // amber
	unknown: MODEL_COLORS[11], // slate
};

interface ChartDataPoint {
	day: string;
	label: string;
	[key: string]: number | string;
}

export default function UsageStackedChart({ modelCost, selectedYear }: UsageStackedChartProps) {
	const { chartData, modelNames } = useMemo(() => {
		const yearPrefix = `${selectedYear}-`;
		const dayModelMap: Map<string, Map<string, number>> = new Map();
		const allModels = new Set<string>();

		for (const [dateKey, models] of Object.entries(modelCost)) {
			if (!dateKey.startsWith(yearPrefix)) continue;
			const mmdd = dateKey.slice(5); // "MM-DD"
			if (!dayModelMap.has(mmdd)) dayModelMap.set(mmdd, new Map());
			const dayMap = dayModelMap.get(mmdd)!;
			for (const [model, entry] of Object.entries(models)) {
				allModels.add(model);
				dayMap.set(model, (dayMap.get(model) ?? 0) + entry.cost);
			}
		}

		const modelNames = Array.from(allModels).sort((a, b) => {
			// known models first, then alphabetically
			const aKnown = a in KNOWN_MODEL_COLORS ? 0 : 1;
			const bKnown = b in KNOWN_MODEL_COLORS ? 0 : 1;
			if (aKnown !== bKnown) return aKnown - bKnown;
			if (aKnown === 0) return a.localeCompare(b);
			return a.localeCompare(b);
		});

		const dates = Array.from(dayModelMap.keys()).sort();
		const chartData: ChartDataPoint[] = dates.map((mmdd) => {
			const dayMap = dayModelMap.get(mmdd)!;
			const point: ChartDataPoint = { day: mmdd, label: mmdd };
			for (const model of modelNames) {
				point[model] = dayMap.get(model) ?? 0;
			}
			return point;
		});

		return { chartData, modelNames };
	}, [modelCost, selectedYear]);

	const modelColorMap = useMemo(() => {
		const map: Record<string, string> = {};
		for (const model of modelNames) {
			if (model in KNOWN_MODEL_COLORS) {
				map[model] = KNOWN_MODEL_COLORS[model];
			}
		}
		// Assign remaining models from the palette
		let colorIdx = 0;
		for (const model of modelNames) {
			if (model in map) continue;
			map[model] = MODEL_COLORS[colorIdx % MODEL_COLORS.length];
			colorIdx++;
		}
		return map;
	}, [modelNames]);

	if (chartData.length === 0) {
		return <div className="text-muted-foreground py-4 text-[11px]">No usage data for this year.</div>;
	}

	return (
		<div className="flex flex-col gap-3">
			<h3 className="text-[13px] font-medium">Daily cost by model</h3>
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
							contentStyle={{
								background: "oklch(0.21 0.006 285)",
								border: "1px solid oklch(0.28 0.008 286)",
								borderRadius: "8px",
								fontSize: "12px",
								color: "oklch(0.95 0 0)",
							}}
							formatter={(value, name, item) => {
								const numVal = Number(value);
								if (!numVal) return null;
								const model = String(name);
								const day = (item?.payload as ChartDataPoint | undefined)?.day;
								const turns = day ? modelCost[`${selectedYear}-${day}`]?.[model]?.turns : undefined;
								const label = `$${numVal.toFixed(4)}`;
								return [label, `${model}${turns !== undefined ? ` (${turns} turns)` : ""}`];
							}}
						/>
						{modelNames.map((model) => (
							<Bar
								key={model}
								dataKey={model}
								stackId="cost"
								fill={modelColorMap[model]}
								radius={[3, 3, 0, 0]}
							/>
						))}
					</BarChart>
				</ResponsiveContainer>
			</div>
			{/* Model legend */}
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
