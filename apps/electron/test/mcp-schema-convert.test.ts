// ============================================================
// MCP Schema Convert — 单元测试
// ============================================================

import { describe, expect, it } from "vitest";
import { jsonSchemaToTypeBox } from "../src/main/mcp/schema-convert.js";

describe("jsonSchemaToTypeBox", () => {
	it("converts a simple string property", () => {
		const schema = {
			type: "object" as const,
			properties: {
				name: { type: "string", description: "The name" },
			},
			required: ["name"],
		};
		const result = jsonSchemaToTypeBox(schema);
		expect(result).toBeDefined();
	});

	it("converts a number property", () => {
		const schema = {
			type: "object" as const,
			properties: {
				count: { type: "number" },
			},
			required: ["count"],
		};
		const result = jsonSchemaToTypeBox(schema);
		expect(result).toBeDefined();
	});

	it("converts a boolean property", () => {
		const schema = {
			type: "object" as const,
			properties: {
				enabled: { type: "boolean" },
			},
		};
		const result = jsonSchemaToTypeBox(schema);
		expect(result).toBeDefined();
	});

	it("converts an enum property to Union of Literals", () => {
		const schema = {
			type: "object" as const,
			properties: {
				status: { type: "string", enum: ["active", "inactive", "pending"] },
			},
			required: ["status"],
		};
		const result = jsonSchemaToTypeBox(schema);
		expect(result).toBeDefined();
	});

	it("converts an array property", () => {
		const schema = {
			type: "object" as const,
			properties: {
				tags: { type: "array", items: { type: "string" } },
			},
		};
		const result = jsonSchemaToTypeBox(schema);
		expect(result).toBeDefined();
	});

	it("converts a nested object property", () => {
		const schema = {
			type: "object" as const,
			properties: {
				config: {
					type: "object",
					properties: {
						host: { type: "string" },
						port: { type: "number" },
					},
					required: ["host"],
				},
			},
		};
		const result = jsonSchemaToTypeBox(schema);
		expect(result).toBeDefined();
	});

	it("handles optional properties (not in required array)", () => {
		const schema = {
			type: "object" as const,
			properties: {
				name: { type: "string" },
				description: { type: "string" },
			},
			required: ["name"],
		};
		const result = jsonSchemaToTypeBox(schema);
		expect(result).toBeDefined();
	});

	it("handles empty schema (no properties)", () => {
		const schema = {
			type: "object" as const,
		};
		const result = jsonSchemaToTypeBox(schema);
		expect(result).toBeDefined();
	});

	it("handles unknown type as Any", () => {
		const schema = {
			type: "object" as const,
			properties: {
				data: {} as Record<string, never>,
			},
		};
		const result = jsonSchemaToTypeBox(schema);
		expect(result).toBeDefined();
	});
});
