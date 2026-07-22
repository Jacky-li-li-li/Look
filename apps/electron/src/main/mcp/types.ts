// ============================================================
// MCP (Model Context Protocol) — 类型定义
// ============================================================

/** MCP 服务器配置 */
export interface McpServerConfig {
	name: string;
	type: "stdio" | "http" | "sse";
	command?: string;
	args?: string[];
	env?: Record<string, string>;
	url?: string;
	headers?: Record<string, string>;
	enabled: boolean;
	/** 工具调用超时 (ms)，默认 120_000 */
	timeout?: number;
	_source?: "user" | "project" | "discovered";
	_discoveredFrom?: string;
}

/** MCP 工具定义（适配 MCP 协议 tools/list 返回值） */
export interface McpTool {
	name: string;
	description?: string;
	inputSchema: {
		type: "object";
		properties?: Record<string, McpJsonSchemaProperty>;
		required?: string[];
	};
}

/** MCP JSON Schema 属性类型 */
export interface McpJsonSchemaProperty {
	type?: string;
	description?: string;
	enum?: string[];
	items?: McpJsonSchemaProperty;
	properties?: Record<string, McpJsonSchemaProperty>;
	required?: string[];
	additionalProperties?: boolean;
}

/** MCP 工具调用结果 */
export interface McpCallResult {
	content: McpContentItem[];
	isError?: boolean;
}

/** MCP 内容项 */
export type McpContentItem =
	| { type: "text"; text: string }
	| { type: "image"; data: string; mimeType: string }
	| { type: "resource"; resource: unknown };

/** MCP 服务器状态（供 UI 查询） */
export interface McpServerStatus {
	name: string;
	type: string;
	enabled: boolean;
	connected: boolean;
	connecting?: boolean;
	toolCount: number;
	lastError?: string;
	source?: string;
	discoveredFrom?: string;
	command?: string;
	args?: string[];
	url?: string;
}

/** MCP 连接测试结果 */
export interface McpTestResult {
	success: boolean;
	tools?: McpTool[];
	error?: string;
}
