// UsageStackedChart 纯数据转换的回归测试。
// 重点覆盖：模型名含 "." 时不能被 recharts 的 lodash 路径解析吞掉（柱条消失 bug）。

import { describe, expect, it } from "vitest";
import { buildChartData, buildModelColorMap } from "../src/renderer/components/settings/UsageStackedChart";

describe("buildChartData", () => {
	it("keeps models with dots in their names addressable via safe dataKeys", () => {
		const { chartData, modelNames, modelKeys } = buildChartData(
			{
				"2026-07-01": {
					"gemini-2.5-pro": { turns: 2, cost: 0.0123 },
					"deepseek-v3": { turns: 1, cost: 0.0045 },
				},
			},
			2026,
		);

		expect(modelNames).toEqual(["deepseek-v3", "gemini-2.5-pro"]);
		// dataKeys must never contain characters recharts treats as path syntax
		for (const key of Object.values(modelKeys)) {
			expect(key).toMatch(/^[a-zA-Z0-9_]+$/);
		}
		expect(chartData).toHaveLength(1);
		const point = chartData[0];
		expect(point.day).toBe("07-01");
		expect(point[modelKeys["gemini-2.5-pro"]]).toBe(0.0123);
		expect(point[modelKeys["deepseek-v3"]]).toBe(0.0045);
	});

	it("filters by selected year and fills missing models with 0", () => {
		const { chartData, modelKeys } = buildChartData(
			{
				"2025-12-31": { "gpt-4.1": { turns: 1, cost: 1 } },
				"2026-01-01": { "gpt-4.1": { turns: 1, cost: 0.5 } },
				"2026-01-02": { other: { turns: 1, cost: 0.25 } },
			},
			2026,
		);

		expect(chartData.map((p) => p.day)).toEqual(["01-01", "01-02"]);
		// every model key present on every point, zero-filled
		expect(chartData[0][modelKeys.other]).toBe(0);
		expect(chartData[1][modelKeys["gpt-4.1"]]).toBe(0);
		expect(chartData[1][modelKeys.other]).toBe(0.25);
	});

	it("returns empty chart data when the year has no usage", () => {
		const { chartData, modelNames } = buildChartData({ "2025-01-01": { a: { turns: 1, cost: 1 } } }, 2026);
		expect(chartData).toEqual([]);
		expect(modelNames).toEqual([]);
	});
});

describe("buildModelColorMap", () => {
	it("does not reuse known-model colors for unknown models", () => {
		const models = ["deepseek-v3", "unknown", "m-a", "m-b", "m-c", "m-d", "m-e", "m-f", "m-g"];
		const map = buildModelColorMap(models);
		const colors = models.map((m) => map[m]);
		expect(new Set(colors).size).toBe(models.length);
	});

	it("keeps fixed colors for known models", () => {
		const map = buildModelColorMap(["deepseek-v4-flash", "deepseek-v4-pro"]);
		expect(map["deepseek-v4-flash"]).not.toBe(map["deepseek-v4-pro"]);
	});

	it("wraps the palette without crashing when models outnumber colors", () => {
		const models = Array.from({ length: 15 }, (_, i) => `model-${i}`);
		const map = buildModelColorMap(models);
		for (const model of models) {
			expect(typeof map[model]).toBe("string");
			expect(map[model].length).toBeGreaterThan(0);
		}
	});
});
