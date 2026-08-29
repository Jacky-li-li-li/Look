// MCP 服务器/工具 DTO —— LookAPI 与 InvokeResponseMap 共用。
// 与主进程 mcp/types.ts 的 McpServerStatus / McpTool 结构一致，
// 路由器返回时经结构化类型对齐，无需显式转换。

/** MCP JSON Schema 属性类型（递归）。 */
export interface McpJsonSchemaPropertyDto {
	type?: string;
	description?: string;
	enum?: string[];
	items?: McpJsonSchemaPropertyDto;
	properties?: Record<string, McpJsonSchemaPropertyDto>;
	required?: string[];
	additionalProperties?: boolean;
}

/** MCP 工具定义（适配 MCP 协议 tools/list 返回值）。 */
export interface McpToolDto {
	name: string;
	description?: string;
	inputSchema: {
		type: "object";
		properties?: Record<string, McpJsonSchemaPropertyDto>;
		required?: string[];
	};
}

/** 带所属服务器名的 MCP 工具条目（listAllMcpTools 载荷元素）。 */
export interface McpToolWithServer {
	server: string;
	tool: McpToolDto;
}

/** MCP 服务器状态条目（供 UI 查询）。 */
export interface McpServerStatusEntry {
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
