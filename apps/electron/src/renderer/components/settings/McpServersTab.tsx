import { Button } from "@look/ui/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@look/ui/components/ui/dialog";
import { Switch } from "@look/ui/components/ui/switch";
import { useAtomValue } from "jotai";
import { ChevronDown, Package, Pencil, Plus, RefreshCw, Trash, Wrench } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
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
	const { t } = useTranslation();
	const [servers, setServers] = useState<McpServerStatus[]>([]);
	const [loading, setLoading] = useState(true);
	const [showDialog, setShowDialog] = useState(false);
	const [editingName, setEditingName] = useState<string | null>(null);
	const [expandedServers, setExpandedServers] = useState<Set<string>>(new Set());
	const [serverTools, setServerTools] = useState<Map<string, McpToolInfo[]>>(new Map());
	const [pendingToggles, setPendingToggles] = useState<Record<string, boolean>>({});
	const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
	const [deleting, setDeleting] = useState(false);
	const pendingTogglesRef = useRef<Record<string, boolean>>({});
	const statusVersion = useAtomValue(mcpStatusVersionAtom);

	const refresh = useCallback(async () => {
		try {
			const result = await window.look.listMcpServers();
			if (!result?.success) {
				toast.error(result?.error ?? t("mcpServers.loadFailed"));
			} else {
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
		} catch (error) {
			toast.error(error instanceof Error ? error.message : t("mcpServers.loadFailed"));
		} finally {
			setLoading(false);
		}
	}, [t]);

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
					const result = await window.look.listMcpTools(name);
					if (result?.success) {
						const tools = (result.tools ?? []) as McpToolInfo[];
						setServerTools((prev) => {
							const nextMap = new Map(prev);
							nextMap.set(name, tools);
							return nextMap;
						});
					} else {
						toast.error(result?.error ?? t("mcpServers.toolsLoadFailed"));
					}
				} catch (error) {
					toast.error(error instanceof Error ? error.message : t("mcpServers.toolsLoadFailed"));
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
			const result = await window.look.toggleMcpServer(name, enabled);
			if (result?.success) {
				await refresh();
			} else {
				toast.error(result?.error ?? t("mcpServers.actionFailed"));
				const { [name]: _removed, ...rest } = pendingTogglesRef.current;
				pendingTogglesRef.current = rest;
				setPendingToggles(rest);
				await refresh(); // 失败时刷新回真实状态
			}
		} catch {
			toast.error(t("mcpServers.actionFailed"));
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
		try {
			const result = await window.look.testMcpServer(name);
			if (result?.success) {
				toast.success(t("mcpServers.testSucceeded", { count: result.tools?.length ?? 0 }));
				void refresh();
			} else {
				toast.error(result?.error ?? t("mcpServers.testFailed"));
			}
		} catch (error) {
			toast.error(error instanceof Error ? error.message : t("mcpServers.testFailed"));
		}
	};

	const handleDelete = async () => {
		if (!deleteTarget || deleting) return;
		setDeleting(true);
		try {
			const result = await window.look.removeMcpServer(deleteTarget);
			if (!result?.success) throw new Error(result?.error ?? t("mcpServers.deleteFailed"));
			setDeleteTarget(null);
			await refresh();
			toast.success(t("mcpServers.deleted"));
		} catch (error) {
			toast.error(error instanceof Error ? error.message : t("mcpServers.deleteFailed"));
		} finally {
			setDeleting(false);
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
		void refresh();
	};

	if (loading) {
		return (
			<div className="flex h-full min-h-0 items-center justify-center p-4 text-xs text-muted-foreground">
				{t("mcpServers.loading")}
			</div>
		);
	}

	return (
		<div className="flex h-full min-h-0 flex-col overflow-y-auto p-4">
			<div className="flex items-center justify-between">
				<div>
					<h3 className="text-[13px] font-medium">{t("mcpServers.title")}</h3>
					<p className="text-[11px] text-muted-foreground">{t("mcpServers.description")}</p>
				</div>
				<Button type="button" variant="line-filled" size="sm" className="h-7 gap-1.5 text-xs" onClick={handleAdd}>
					<Plus className="size-3.5" />
					{t("mcpServers.add")}
				</Button>
			</div>

			<div className="mt-3 flex gap-3 text-xs text-muted-foreground">
				<span>{t("mcpServers.configured", { count: servers.length })}</span>
				<span>·</span>
				<span className="text-green-600">
					{t("mcpServers.connectedCount", { count: servers.filter((s) => s.connected).length })}
				</span>
				<span>·</span>
				<span>{t("mcpServers.toolCount", { count: servers.reduce((sum, s) => sum + s.toolCount, 0) })}</span>
			</div>

			{servers.length === 0 ? (
				<div className="mt-4 flex flex-col items-center justify-center rounded-lg border-2 border-dashed border-hairline p-8 text-center">
					<Package className="size-8 text-muted-foreground/40" />
					<p className="mt-3 text-sm font-medium">{t("mcpServers.empty")}</p>
					<p className="mt-1 text-xs text-muted-foreground">{t("mcpServers.emptyHint")}</p>
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
										aria-label={t(expanded ? "mcpServers.collapse" : "mcpServers.expand", {
											name: server.name,
										})}
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
														{t("mcpServers.discoveredFrom", { source: server.discoveredFrom })}
													</span>
												)}
											</div>
											<p className="mt-0.5 text-xs text-muted-foreground">
												{server.type.toUpperCase()} · {t("mcpServers.tools", { count: server.toolCount })}
												{server.connected && (
													<span className="text-green-600"> · {t("mcpServers.connected")}</span>
												)}
												{server.connecting && !server.connected && (
													<span className="text-sky-600"> · {t("mcpServers.connecting")}</span>
												)}
												{server.enabled && !server.connected && !server.connecting && (
													<span className="text-amber-600"> · {t("mcpServers.disconnected")}</span>
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
											aria-label={t(server.enabled ? "mcpServers.disable" : "mcpServers.enable")}
										/>
										<button
											type="button"
											className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
											onClick={(e) => {
												e.stopPropagation();
												handleTest(server.name);
											}}
											aria-label={t("mcpServers.testConnection")}
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
											aria-label={t("mcpServers.edit")}
										>
											<Pencil className="size-3.5" />
										</button>
										<button
											type="button"
											className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-red-50 hover:text-red-600 transition-colors"
											onClick={(e) => {
												e.stopPropagation();
												setDeleteTarget(server.name);
											}}
											aria-label={t("mcpServers.delete")}
										>
											<Trash className="size-3.5" />
										</button>
									</div>
								</div>

								{expanded && (
									<div className="border-t border-hairline bg-accent/20 px-4 py-3">
										{tools === undefined ? (
											<p className="text-xs text-muted-foreground">{t("mcpServers.toolsLoading")}</p>
										) : tools.length === 0 ? (
											<p className="text-xs text-muted-foreground">{t("mcpServers.noTools")}</p>
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

			<Dialog open={deleteTarget !== null} onOpenChange={(open) => !open && !deleting && setDeleteTarget(null)}>
				<DialogContent
					className="max-w-sm"
					onEscapeKeyDown={(event) => deleting && event.preventDefault()}
					onInteractOutside={(event) => deleting && event.preventDefault()}
				>
					<DialogHeader>
						<DialogTitle>{t("mcpServers.deleteTitle")}</DialogTitle>
						<DialogDescription>{t("mcpServers.deleteDescription", { name: deleteTarget })}</DialogDescription>
					</DialogHeader>
					<DialogFooter>
						<Button variant="outline" size="sm" disabled={deleting} onClick={() => setDeleteTarget(null)}>
							{t("common.cancel")}
						</Button>
						<Button variant="destructive" size="sm" disabled={deleting} onClick={() => void handleDelete()}>
							{deleting ? t("mcpServers.deleting") : t("common.delete")}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</div>
	);
}
