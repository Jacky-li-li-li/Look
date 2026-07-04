import { Button } from "@shared/components/ui/button";
import { Switch } from "@shared/components/ui/switch";
import { useAtomValue } from "jotai";
import { ChevronDown, Package, Pencil, Plus, RefreshCw, Trash, Wrench } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { mcpStatusVersionAtom } from "../../store/atoms";
import { McpServerDialog } from "./McpServerDialog";

interface McpServerStatus {
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

interface McpToolInfo {
	name: string;
	description?: string;
}

export default function McpServersTab() {
	const [servers, setServers] = useState<McpServerStatus[]>([]);
	const [loading, setLoading] = useState(true);
	const [showDialog, setShowDialog] = useState(false);
	const [editingName, setEditingName] = useState<string | null>(null);
	const [expandedServers, setExpandedServers] = useState<Set<string>>(new Set());
	const [serverTools, setServerTools] = useState<Map<string, McpToolInfo[]>>(new Map());
	const [pendingToggles, setPendingToggles] = useState<Record<string, boolean>>({});
	const pendingTogglesRef = useRef<Record<string, boolean>>({});
	const statusVersion = useAtomValue(mcpStatusVersionAtom);

	const refresh = useCallback(async () => {
		try {
			const result = await (window as any).look.listMcpServers();
			if (result?.success) {
				const pending = pendingTogglesRef.current;
				const nextServers = ((result.servers ?? []) as McpServerStatus[]).map((server) => {
					if (!(server.name in pending)) return server;
					const enabled = pending[server.name] ?? server.enabled;
					return {
						...server,
						enabled,
						connected: enabled ? server.connected : false,
						connecting: enabled || server.connecting,
						toolCount: enabled ? server.toolCount : 0,
						lastError: enabled ? undefined : server.lastError,
					};
				});
				setServers(nextServers);
				setServerTools((prev) => {
					const validNames = new Set(nextServers.map((server) => server.name));
					const next = new Map(prev);
					for (const name of next.keys()) {
						const server = nextServers.find((item) => item.name === name);
						if (!server?.connected || !validNames.has(name)) next.delete(name);
					}
					return next;
				});
			}
		} catch {
			// ignore
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		void statusVersion;
		refresh();
	}, [refresh, statusVersion]);

	const toggleExpand = async (name: string) => {
		const next = new Set(expandedServers);
		if (next.has(name)) {
			next.delete(name);
			setExpandedServers(next);
		} else {
			next.add(name);
			setExpandedServers(next);
			if (!serverTools.has(name)) {
				try {
					const result = await (window as any).look.listMcpTools(name);
					if (result?.success) {
						const tools = (result.tools ?? []) as McpToolInfo[];
						setServerTools((prev) => {
							const nextMap = new Map(prev);
							nextMap.set(name, tools);
							return nextMap;
						});
					}
				} catch {
					// ignore
				}
			}
		}
	};

	const handleToggle = async (name: string, enabled: boolean) => {
		// 乐观更新：立即反映 UI 状态
		pendingTogglesRef.current = { ...pendingTogglesRef.current, [name]: enabled };
		setPendingToggles(pendingTogglesRef.current);
		setServers((prev) =>
			prev.map((s) =>
				s.name === name
					? {
							...s,
							enabled,
							connected: enabled ? s.connected : false,
							connecting: enabled,
							toolCount: enabled ? s.toolCount : 0,
							lastError: undefined,
						}
					: s,
			),
		);
		try {
			const result = await (window as any).look.toggleMcpServer(name, enabled);
			if (result?.success) {
				await refresh();
			} else {
				toast.error(result?.error ?? "操作失败");
				const { [name]: _removed, ...rest } = pendingTogglesRef.current;
				pendingTogglesRef.current = rest;
				setPendingToggles(rest);
				await refresh(); // 失败时刷新回真实状态
			}
		} catch {
			toast.error("操作失败");
			const { [name]: _removed, ...rest } = pendingTogglesRef.current;
			pendingTogglesRef.current = rest;
			setPendingToggles(rest);
			await refresh();
		} finally {
			const { [name]: _removed, ...rest } = pendingTogglesRef.current;
			pendingTogglesRef.current = rest;
			setPendingToggles(rest);
		}
	};

	const handleTest = async (name: string) => {
		const result = await (window as any).look.testMcpServer(name);
		if (result?.success) {
			toast.success(`连接成功，${result.tools?.length ?? 0} 个工具可用`);
			refresh();
		} else {
			toast.error(result?.error ?? "连接失败");
		}
	};

	const handleDelete = async (name: string) => {
		const result = await (window as any).look.removeMcpServer(name);
		if (result?.success) {
			refresh();
		} else {
			toast.error(result?.error ?? "删除失败");
		}
	};

	const handleEdit = (name: string) => {
		setEditingName(name);
		setShowDialog(true);
	};

	const handleAdd = () => {
		setEditingName(null);
		setShowDialog(true);
	};

	const handleSave = async (_config: unknown) => {
		setShowDialog(false);
		setEditingName(null);
		refresh();
	};

	if (loading) {
		return (
			<div className="flex h-full min-h-0 items-center justify-center p-4 text-xs text-muted-foreground">
				加载 MCP 服务器...
			</div>
		);
	}

	return (
		<div className="flex h-full min-h-0 flex-col overflow-y-auto p-4">
			<div className="flex items-center justify-between">
				<div>
					<h3 className="text-sm font-semibold">MCP 服务器</h3>
					<p className="mt-0.5 text-xs text-muted-foreground">连接外部 MCP 服务器，为 AI Agent 扩展工具能力</p>
				</div>
				<Button type="button" variant="line-filled" size="sm" className="h-7 gap-1.5 text-xs" onClick={handleAdd}>
					<Plus className="size-3.5" />
					添加
				</Button>
			</div>

			<div className="mt-3 flex gap-3 text-xs text-muted-foreground">
				<span>{servers.length} 个已配置</span>
				<span>·</span>
				<span className="text-green-600">{servers.filter((s) => s.connected).length} 个已连接</span>
				<span>·</span>
				<span>{servers.reduce((sum, s) => sum + s.toolCount, 0)} 个工具可用</span>
			</div>

			{servers.length === 0 ? (
				<div className="mt-4 flex flex-col items-center justify-center rounded-lg border-2 border-dashed border-hairline p-8 text-center">
					<Package className="size-8 text-muted-foreground/40" />
					<p className="mt-3 text-sm font-medium">暂无 MCP 服务器</p>
					<p className="mt-1 text-xs text-muted-foreground">添加 MCP 服务器后，AI Agent 即可使用其提供的工具</p>
				</div>
			) : (
				<div className="mt-3 space-y-2">
					{servers.map((server) => {
						const expanded = expandedServers.has(server.name);
						const tools = serverTools.get(server.name);

						return (
							<div key={server.name} className="rounded-lg border border-hairline transition-all">
								<div className="flex w-full items-center gap-3 p-3 text-left hover:bg-accent/30 transition-colors">
									<button
										type="button"
										className="flex min-w-0 flex-1 items-center gap-3 text-left"
										onClick={() => toggleExpand(server.name)}
										aria-expanded={expanded}
										aria-label={`${expanded ? "折叠" : "展开"} ${server.name}`}
									>
										<div
											className={`size-2.5 shrink-0 rounded-full ${
												server.connected
													? "bg-green-500"
													: server.connecting
														? "bg-sky-500"
														: server.enabled
															? "bg-amber-400"
															: "bg-muted-foreground/30"
											}`}
										/>
										<div className="min-w-0 flex-1">
											<div className="flex items-center gap-2">
												<p className="truncate text-sm font-medium">{server.name}</p>
												{server.discoveredFrom && (
													<span className="shrink-0 rounded bg-sky-100 px-1.5 py-0.5 text-[10px] font-medium text-sky-600">
														从 {server.discoveredFrom} 发现
													</span>
												)}
											</div>
											<p className="mt-0.5 text-xs text-muted-foreground">
												{server.type.toUpperCase()} · {server.toolCount} 个工具
												{server.connected && <span className="text-green-600"> · 已连接</span>}
												{server.connecting && !server.connected && (
													<span className="text-sky-600"> · 连接中</span>
												)}
												{server.enabled && !server.connected && !server.connecting && (
													<span className="text-amber-600"> · 未连接</span>
												)}
												{server.lastError && <span className="text-red-600"> · {server.lastError}</span>}
											</p>
										</div>
										<ChevronDown
											className={`size-4 shrink-0 text-muted-foreground transition-transform ${
												expanded ? "rotate-180" : ""
											}`}
										/>
									</button>
									<div className="flex shrink-0 items-center gap-1">
										<Switch
											size="default"
											checked={server.enabled}
											disabled={server.name in pendingToggles}
											onCheckedChange={(checked) => handleToggle(server.name, checked)}
											aria-label={server.enabled ? "禁用" : "启用"}
										/>
										<button
											type="button"
											className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
											onClick={(e) => {
												e.stopPropagation();
												handleTest(server.name);
											}}
											aria-label="测试连接"
										>
											<RefreshCw className="size-3.5" />
										</button>
										<button
											type="button"
											className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
											onClick={(e) => {
												e.stopPropagation();
												handleEdit(server.name);
											}}
											aria-label="编辑"
										>
											<Pencil className="size-3.5" />
										</button>
										<button
											type="button"
											className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-red-50 hover:text-red-600 transition-colors"
											onClick={(e) => {
												e.stopPropagation();
												handleDelete(server.name);
											}}
											aria-label="删除"
										>
											<Trash className="size-3.5" />
										</button>
									</div>
								</div>

								{expanded && (
									<div className="border-t border-hairline bg-accent/20 px-4 py-3">
										{tools === undefined ? (
											<p className="text-xs text-muted-foreground">加载中...</p>
										) : tools.length === 0 ? (
											<p className="text-xs text-muted-foreground">此服务器未提供任何工具</p>
										) : (
											<div className="space-y-1.5">
												{tools.map((tool) => (
													<div key={tool.name} className="flex items-start gap-2">
														<Wrench className="mt-0.5 size-3 shrink-0 text-muted-foreground" />
														<div className="min-w-0">
															<p className="text-xs font-medium font-mono">{tool.name}</p>
															{tool.description && (
																<p className="mt-0.5 text-[10px] leading-snug text-muted-foreground line-clamp-2">
																	{tool.description}
																</p>
															)}
														</div>
													</div>
												))}
											</div>
										)}
									</div>
								)}
							</div>
						);
					})}
				</div>
			)}

			<McpServerDialog
				open={showDialog}
				onClose={() => {
					setShowDialog(false);
					setEditingName(null);
				}}
				onSave={handleSave}
				editingName={editingName ?? undefined}
				initialConfig={
					editingName
						? (() => {
								const srv = servers.find((s) => s.name === editingName);
								return srv
									? {
											type: srv.type,
											enabled: srv.enabled,
											command: srv.command,
											args: srv.args,
											url: srv.url,
										}
									: undefined;
							})()
						: undefined
				}
			/>
		</div>
	);
}
