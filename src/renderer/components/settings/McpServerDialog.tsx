import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

const api = (window as any).look;

interface McpServerDialogProps {
	open: boolean;
	onClose: () => void;
	onSave: (config: unknown) => void;
	editingName?: string;
	initialConfig?: {
		type: string;
		enabled?: boolean;
		command?: string;
		args?: string[];
		url?: string;
	};
}

export function McpServerDialog({ open, onClose, onSave, editingName, initialConfig }: McpServerDialogProps) {
	const [name, setName] = useState("");
	const [type, setType] = useState<"stdio" | "http" | "sse">("stdio");
	const [command, setCommand] = useState("");
	const [args, setArgs] = useState("");
	const [url, setUrl] = useState("");
	const [saving, setSaving] = useState(false);

	const resetForm = useCallback(() => {
		setName("");
		setType("stdio");
		setCommand("");
		setArgs("");
		setUrl("");
	}, []);

	// Pre-fill form when editing an existing server
	useEffect(() => {
		if (!open) return;
		if (editingName && initialConfig) {
			setName(editingName);
			setType(initialConfig.type as "stdio" | "http" | "sse");
			setCommand(initialConfig.command ?? "");
			setArgs((initialConfig.args ?? []).join(" "));
			setUrl(initialConfig.url ?? "");
		} else {
			resetForm();
		}
	}, [open, editingName, initialConfig, resetForm]);
	if (!open) return null;

	const handleSave = async () => {
		if (!name.trim()) {
			toast.error("请输入服务器名称");
			return;
		}
		if (type === "stdio" && !command.trim()) {
			toast.error("请输入命令");
			return;
		}
		if ((type === "http" || type === "sse") && !url.trim()) {
			toast.error("请输入 URL");
			return;
		}

		setSaving(true);
		try {
			const config: Record<string, unknown> = {
				type,
				enabled: editingName ? (initialConfig?.enabled ?? true) : true,
			};
			if (type === "stdio") {
				config.command = command.trim();
				config.args = args.trim().split(/\s+/).filter(Boolean);
			} else {
				config.url = url.trim();
			}

			const result = editingName
				? await api.updateMcpServer(editingName, config)
				: await api.addMcpServer({ name: name.trim(), ...config });
			if (result?.success) {
				toast.success(editingName ? "MCP 服务器已更新" : "MCP 服务器已添加");
				onSave(config);
				resetForm();
			} else {
				toast.error(result?.error ?? (editingName ? "更新失败" : "添加失败"));
			}
		} catch (error) {
			toast.error(error instanceof Error ? error.message : editingName ? "更新失败" : "添加失败");
		} finally {
			setSaving(false);
		}
	};

	return (
		<>
			{/* Backdrop */}
			<button type="button" className="fixed inset-0 z-40 bg-black/20" onClick={onClose} aria-label="关闭" />

			{/* Dialog */}
			<div className="fixed left-1/2 top-1/2 z-50 w-full max-w-md -translate-x-1/2 -translate-y-1/2 rounded-xl border border-hairline bg-popover shadow-2xl">
				{/* Header */}
				<div className="flex items-center justify-between border-b border-hairline px-5 py-4">
					<div>
						<h3 className="text-sm font-semibold">{editingName ? `编辑 ${editingName}` : "添加 MCP 服务器"}</h3>
						<p className="mt-0.5 text-xs text-muted-foreground">
							{editingName ? "修改 MCP 服务器的连接参数" : "配置 MCP 服务器的连接方式和参数"}
						</p>
					</div>
				</div>

				{/* Body */}
				<div className="space-y-4 px-5 py-4">
					{/* Name */}
					<div className="space-y-1.5">
						<label className="text-xs font-medium" htmlFor="mcp-name">
							名称 <span className="text-red-500">*</span>
						</label>
						<input
							id="mcp-name"
							type="text"
							value={name}
							onChange={(e) => setName(e.target.value)}
							placeholder="例如：filesystem, github, postgres"
							readOnly={!!editingName}
							className={`w-full rounded-lg border border-hairline bg-background px-3 py-2 text-sm placeholder:text-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-sky-500 ${editingName ? "cursor-not-allowed opacity-60" : ""}`}
						/>
					</div>

					{/* Transport type */}
					<div className="space-y-1.5">
						<label className="text-xs font-medium" htmlFor="mcp-type">
							传输类型
						</label>
						<select
							id="mcp-type"
							value={type}
							onChange={(e) => setType(e.target.value as typeof type)}
							className="w-full rounded-lg border border-hairline bg-background px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-sky-500"
						>
							<option value="stdio">stdio（子进程）</option>
							<option value="http">HTTP</option>
							<option value="sse">SSE（Server-Sent Events）</option>
						</select>
					</div>

					{/* stdio config */}
					{type === "stdio" && (
						<>
							<div className="space-y-1.5">
								<label className="text-xs font-medium" htmlFor="mcp-command">
									命令 <span className="text-red-500">*</span>
								</label>
								<input
									id="mcp-command"
									type="text"
									value={command}
									onChange={(e) => setCommand(e.target.value)}
									placeholder="npx 或 uvx 或绝对路径"
									className="w-full rounded-lg border border-hairline bg-background px-3 py-2 text-sm placeholder:text-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-sky-500"
								/>
							</div>
							<div className="space-y-1.5">
								<label className="text-xs font-medium" htmlFor="mcp-args">
									参数（空格分隔）
								</label>
								<input
									id="mcp-args"
									type="text"
									value={args}
									onChange={(e) => setArgs(e.target.value)}
									placeholder="-y @modelcontextprotocol/server-xxx"
									className="w-full rounded-lg border border-hairline bg-background px-3 py-2 text-sm placeholder:text-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-sky-500"
								/>
							</div>
						</>
					)}

					{/* HTTP/SSE config */}
					{(type === "http" || type === "sse") && (
						<div className="space-y-1.5">
							<label className="text-xs font-medium" htmlFor="mcp-url">
								URL <span className="text-red-500">*</span>
							</label>
							<input
								id="mcp-url"
								type="text"
								value={url}
								onChange={(e) => setUrl(e.target.value)}
								placeholder="https://mcp.example.com/jsonrpc"
								className="w-full rounded-lg border border-hairline bg-background px-3 py-2 text-sm placeholder:text-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-sky-500"
							/>
						</div>
					)}
				</div>

				{/* Footer */}
				<div className="flex justify-end gap-2 border-t border-hairline px-5 py-3">
					<button
						type="button"
						className="inline-flex items-center rounded-lg border border-hairline bg-background px-3 py-1.5 text-xs font-medium hover:bg-accent transition-colors"
						onClick={() => {
							resetForm();
							onClose();
						}}
					>
						取消
					</button>
					<button
						type="button"
						className="inline-flex items-center rounded-lg bg-sky-500 px-3 py-1.5 text-xs font-medium text-white hover:bg-sky-600 transition-colors disabled:opacity-50"
						onClick={handleSave}
						disabled={saving}
					>
						{saving ? (editingName ? "更新中..." : "添加中...") : editingName ? "保存更改" : "添加服务器"}
					</button>
				</div>
			</div>
		</>
	);
}
