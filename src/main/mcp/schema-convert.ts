// ============================================================
// MCP JSON Schema → TypeBox Schema 转换器
//
// 将 MCP 工具的 inputSchema（JSON Schema 格式）转换为 pi SDK
// 可用的 TypeBox schema，用于 api.registerTool() 的 parameters 字段。
// ============================================================

import { type TSchema, Type } from "typebox";
import type { McpJsonSchemaProperty } from "./types.js";

/**
 * 将 MCP 工具的 JSON Schema (inputSchema) 转换为 TypeBox schema。
 * MCP 工具的 inputSchema 顶层必须是 object 类型。
 */
export function jsonSchemaToTypeBox(inputSchema: {
	type: "object";
	properties?: Record<string, McpJsonSchemaProperty>;
	required?: string[];
}): TSchema {
	if (!inputSchema.properties) {
		return Type.Object({}, { additionalProperties: false });
	}

	const properties: Record<string, TSchema> = {};

	for (const [key, propSchema] of Object.entries(inputSchema.properties)) {
		const isRequired = inputSchema.required?.includes(key) ?? false;
		properties[key] = isRequired ? convertProperty(propSchema) : Type.Optional(convertProperty(propSchema));
	}

	return Type.Object(properties, { additionalProperties: false });
}

function convertProperty(schema: McpJsonSchemaProperty): TSchema {
	let result: TSchema;

	switch (schema.type) {
		case "string": {
			if (schema.enum && schema.enum.length > 0) {
				result = Type.Union(schema.enum.map((v) => Type.Literal(v)));
			} else {
				result = Type.String();
			}
			break;
		}

		case "number":
		case "integer": {
			result = Type.Number();
			break;
		}

		case "boolean": {
			result = Type.Boolean();
			break;
		}

		case "array": {
			if (schema.items) {
				result = Type.Array(convertProperty(schema.items));
			} else {
				result = Type.Array(Type.Any());
			}
			break;
		}

		case "object": {
			if (schema.properties) {
				const nestedProps: Record<string, TSchema> = {};
				for (const [k, v] of Object.entries(schema.properties)) {
					const req = schema.required?.includes(k) ?? false;
					nestedProps[k] = req ? convertProperty(v) : Type.Optional(convertProperty(v));
				}
				result = Type.Object(nestedProps, {
					additionalProperties: schema.additionalProperties ?? false,
				});
			} else {
				result = Type.Object({}, { additionalProperties: false });
			}
			break;
		}

		default: {
			// 未知类型 → 接受任意值
			result = Type.Any();
		}
	}

	if (schema.description) {
		(result as any).description = schema.description;
	}

	return result;
}
