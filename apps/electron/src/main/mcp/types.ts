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
	/**
	 * 必需服务器（默认 true）：会话首条消息在预算内等待其连接完成，
	 * 保证 MCP 工具在模型首轮可用；required:false 的服务器后台连接，
	 * 不阻塞任何消息（Proma 式 required/optional 分层）。
	 */
	required?: boolean;
	/** 显式超时 (ms)：优先于分层默认（连接 30s；调用 120s） */
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
	/** 必需服务器：首条消息在预算内等待其连接（required !== false）。 */
	required?: boolean;
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
