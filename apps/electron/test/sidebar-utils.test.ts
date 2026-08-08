// @vitest-environment node

import type { AgentInfo } from "@shared/types";
import { describe, expect, it } from "vitest";
import {
	compactModelName,
	fmtRelativeTime,
	getSessionActivityAt,
	sortSessionsByActivity,
} from "../src/renderer/components/Sidebar/utils";

function makeSession(id: string, createdAt: number, lastActivityAt?: number): AgentInfo {
	return {
		id,
		name: id,
		model: "openai/gpt-test",
		thinkingLevel: "medium",
		isStreaming: false,
		isRetrying: false,
		isCompacting: false,
		messageCount: 0,
		createdAt,
		lastActivityAt,
	};
}

describe("sidebar session utilities", () => {
	it("orders sessions by content-change time and falls back to creation time", () => {
		const old = makeSession("old", 100);
		const active = makeSession("active", 200, 900);
		const fallback = makeSession("fallback", 800);

		expect(getSessionActivityAt(old)).toBe(100);
		expect(sortSessionsByActivity([old, active, fallback]).map((session) => session.id)).toEqual([
			"active",
			"fallback",
			"old",
		]);
	});

	it("formats compact model names and locale-aware relative times", () => {
		const now = 1_000_000;
		expect(compactModelName("openai/gpt-5.6-terra")).toBe("gpt-5.6-terra");
		expect(compactModelName("  claude-sonnet  ")).toBe("claude-sonnet");
		expect(fmtRelativeTime(now - 120_000, "en", now)).toBe("2m ago");
		expect(fmtRelativeTime(now - 3_600_000, "zh-CN", now)).toContain("小时前");
	});
});
