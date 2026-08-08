// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ProviderIcon } from "../src/renderer/components/ProviderIcon";

describe("ProviderIcon 空 id", () => {
	afterEach(cleanup);

	it("空 id 不渲染占位图标(避免显示 ?)", () => {
		const { container } = render(<ProviderIcon id="" className="size-3" />);
		expect(container.querySelector("span")).toBeNull();
		expect(container.textContent).toBe("");
	});

	it("未收录 provider 显示首字母 monogram 而非 ?", () => {
		render(<ProviderIcon id="brand-new-provider" className="size-3" />);
		expect(screen.getByText("B")).toBeDefined();
		expect(screen.queryByText("?")).toBeNull();
	});

	it("已收录 provider 渲染 SVG 图标", () => {
		const { container } = render(<ProviderIcon id="anthropic" className="size-3" />);
		expect(container.querySelector("svg")).not.toBeNull();
	});
});
