// ============================================================
// McpTab — MCP server management
// ============================================================

import { Badge } from "@shared/components/ui/badge";
import { Button } from "@shared/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@shared/components/ui/dialog";
import { Input } from "@shared/components/ui/input";
import { Label } from "@shared/components/ui/label";
import { Textarea } from "@shared/components/ui/textarea";
import { cn } from "@shared/lib/utils";
import { Cpu, Loader2, Plug, Plus, RefreshCw, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

const api = (window as any).look;

interface McpServerInfo {
	name: string;
	config: { command: string; args?: string[]; env?: Record<string, string> };
	status: "disconnected" | "connecting" | "connected" | "error";
	error?: string;
	toolCount: number;
}

interface McpToolInfo {
	name: string;
	description?: string;
	serverName: string;
}

/** Parse a multi-line "KEY=value" string into an env record. */
function parseEnvString(raw: string): Record<string, string> {
	const env: Record<string, string> = {};
	for (const line of raw.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;
		const idx = trimmed.indexOf("=");
		if (idx === -1) continue;
		const key = trimmed.slice(0, idx).trim();
		const value = trimmed.slice(idx + 1).trim();
		if (key) env[key] = value;
	}
	return env;
}

export default function McpTab() {
	const { t } = useTranslation();
	const [servers, setServers] = useState<McpServerInfo[]>([]);
	const [tools, setTools] = useState<McpToolInfo[]>([]);
	const [loading, setLoading] = useState(true);
	const [showDialog, setShowDialog] = useState(false);
	const [formName, setFormName] = useState("");
	const [formCommand, setFormCommand] = useState("");
	const [formArgs, setFormArgs] = useState("");
	const [formEnv, setFormEnv] = useState("");
	const [connecting, setConnecting] = useState(false);

	const invoke = useCallback((type: string, data?: Record<string, unknown>) => api.invoke({ type, ...data }), []);

	const refresh = useCallback(async () => {
		try {
			const [s, t] = await Promise.all([invoke("mcp:list-servers"), invoke("mcp:list-tools")]);
			if (s.success) setServers(s.servers);
			if (t.success) setTools(t.tools);
		} catch {
			// ignore
		} finally {
			setLoading(false);
		}
	}, [invoke]);

	useEffect(() => {
		refresh();
	}, [refresh]);

	const handleAdd = async () => {
		if (!formName.trim() || !formCommand.trim()) return;
		setConnecting(true);
		try {
			const args = formArgs.trim() ? formArgs.split(/\s+/).filter(Boolean) : [];
			const env = parseEnvString(formEnv);
			await invoke("mcp:add-server", {
				name: formName.trim(),
				config: {
					command: formCommand.trim(),
					args: args.length > 0 ? args : undefined,
					env: Object.keys(env).length > 0 ? env : undefined,
				},
			});
			toast.success(t("mcp.serverAdded", { name: formName }));
			setShowDialog(false);
			resetForm();
			await refresh();
		} catch (e: any) {
			toast.error(e?.message || "Failed to add server");
		} finally {
			setConnecting(false);
		}
	};

	const handleRemove = async (name: string) => {
		try {
			await invoke("mcp:remove-server", { name });
			toast.success(t("mcp.serverRemoved", { name }));
			await refresh();
		} catch (e: any) {
			toast.error(e?.message || "Failed to remove server");
		}
	};

	const handleRestart = async (name: string) => {
		try {
			await invoke("mcp:restart-server", { name });
			toast.success(t("mcp.serverRestarted", { name }));
			await refresh();
		} catch (e: any) {
			toast.error(e?.message || "Failed to restart server");
		}
	};

	const handleConnectAll = async () => {
		setLoading(true);
		try {
			await invoke("mcp:connect-all");
			await refresh();
		} catch {
			// ignore
		}
	};

	const resetForm = () => {
		setFormName("");
		setFormCommand("");
		setFormArgs("");
		setFormEnv("");
	};

	const statusBadge = (status: string) => {
		switch (status) {
			case "connected":
				return <Badge className="bg-green-500/10 text-green-600 border-green-500/20">{t("mcp.connected")}</Badge>;
			case "connecting":
				return (
					<Badge variant="outline" className="gap-1">
						<Loader2 className="size-2.5 animate-spin" />
						{t("mcp.connecting")}
					</Badge>
				);
			case "error":
				return <Badge variant="destructive">{t("mcp.error")}</Badge>;
			default:
				return <Badge variant="secondary">{t("mcp.disconnected")}</Badge>;
		}
	};

	if (loading) {
		return (
			<div className="flex items-center justify-center py-12">
				<Loader2 className="size-5 animate-spin text-muted-foreground" />
			</div>
		);
	}

	return (
		<div className="space-y-4">
			{/* Header */}
			<div className="flex items-center justify-between">
				<div>
					<h3 className="text-sm font-medium">{t("mcp.title", "MCP Servers")}</h3>
					<p className="text-xs text-muted-foreground">
						{t("mcp.description", "Connect to MCP servers to expose their tools to agents.")}
					</p>
				</div>
				<div className="flex gap-2">
					<Button variant="outline" size="sm" onClick={handleConnectAll}>
						<Plug className="size-3.5" />
						{t("mcp.connectAll", "Connect All")}
					</Button>
					<Button
						size="sm"
						onClick={() => {
							resetForm();
							setShowDialog(true);
						}}
					>
						<Plus className="size-3.5" />
						{t("mcp.addServer", "Add Server")}
					</Button>
				</div>
			</div>

			{/* Server list */}
			{servers.length === 0 ? (
				<div className="flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed py-10 text-center">
					<Plug className="size-8 text-muted-foreground/40" />
					<p className="text-sm text-muted-foreground">
						{t("mcp.empty", "No MCP servers configured. Add one to get started.")}
					</p>
					<Button
						variant="outline"
						size="sm"
						onClick={() => {
							resetForm();
							setShowDialog(true);
						}}
					>
						<Plus className="size-3.5" />
						{t("mcp.addFirst", "Add first server")}
					</Button>
				</div>
			) : (
				<div className="space-y-2">
					{servers.map((s) => (
						<div key={s.name} className="flex items-center justify-between rounded-lg border p-3">
							<div className="min-w-0 flex-1">
								<div className="flex items-center gap-2">
									<span className="truncate text-sm font-medium">{s.name}</span>
									{statusBadge(s.status)}
									{s.toolCount > 0 && (
										<Badge variant="outline" className="h-4.5 gap-1 px-1.5 text-[10px]">
											<Cpu className="size-2.5" />
											{s.toolCount} {t("mcp.tools", "tools")}
										</Badge>
									)}
								</div>
								<div className="mt-1 truncate font-mono text-[11px] text-muted-foreground">
									{s.config.command}
									{s.config.args ? ` ${s.config.args.join(" ")}` : ""}
								</div>
								{s.error && <p className="mt-1 text-[11px] text-destructive">{s.error}</p>}
							</div>
							<div className="ml-3 flex shrink-0 gap-1">
								<Button
									variant="ghost"
									size="icon"
									className="size-7"
									onClick={() => handleRestart(s.name)}
									disabled={s.status === "connecting"}
								>
									<RefreshCw className={cn("size-3.5", s.status === "connecting" && "animate-spin")} />
								</Button>
								<Button
									variant="ghost"
									size="icon"
									className="size-7 text-destructive hover:text-destructive"
									onClick={() => handleRemove(s.name)}
								>
									<Trash2 className="size-3.5" />
								</Button>
							</div>
						</div>
					))}
				</div>
			)}

			{/* Tools summary */}
			{tools.length > 0 && (
				<div className="space-y-2">
					<h4 className="text-xs font-medium text-muted-foreground">
						{t("mcp.availableTools", "Available Tools")} ({tools.length})
					</h4>
					<div className="max-h-48 overflow-y-auto space-y-1 rounded-lg border p-2">
						{tools.map((tool) => (
							<div
								key={`${tool.serverName}__${tool.name}`}
								className="flex items-center gap-2 px-2 py-1 text-xs"
							>
								<Badge variant="secondary" className="font-mono text-[10px] shrink-0">
									{tool.serverName}
								</Badge>
								<span className="font-medium">{tool.name}</span>
								{tool.description && (
									<span className="truncate text-muted-foreground">— {tool.description}</span>
								)}
							</div>
						))}
					</div>
				</div>
			)}

			{/* Add server dialog */}
			<Dialog open={showDialog} onOpenChange={setShowDialog}>
				<DialogContent className="sm:max-w-md">
					<DialogHeader>
						<DialogTitle>{t("mcp.addServerTitle", "Add MCP Server")}</DialogTitle>
						<DialogDescription>
							{t(
								"mcp.addServerDesc",
								"Configure a local MCP server process. The server will be started as a subprocess.",
							)}
						</DialogDescription>
					</DialogHeader>
					<div className="space-y-3 py-2">
						<div className="space-y-1.5">
							<Label className="text-xs">{t("mcp.serverName", "Server Name")}</Label>
							<Input
								placeholder="e.g. filesystem"
								value={formName}
								onChange={(e) => setFormName(e.target.value)}
							/>
						</div>
						<div className="space-y-1.5">
							<Label className="text-xs">{t("mcp.command", "Command")}</Label>
							<Input
								placeholder="e.g. npx"
								value={formCommand}
								onChange={(e) => setFormCommand(e.target.value)}
							/>
						</div>
						<div className="space-y-1.5">
							<Label className="text-xs">{t("mcp.args", "Arguments (space-separated)")}</Label>
							<Input
								placeholder="e.g. -y @modelcontextprotocol/server-filesystem /tmp"
								value={formArgs}
								onChange={(e) => setFormArgs(e.target.value)}
							/>
						</div>
						<div className="space-y-1.5">
							<Label className="text-xs">{t("mcp.env", "Environment (KEY=value per line)")}</Label>
							<Textarea
								placeholder={`API_KEY=sk-...\nPATH=/usr/local/bin`}
								value={formEnv}
								onChange={(e) => setFormEnv(e.target.value)}
								rows={3}
								className="text-xs"
							/>
						</div>
					</div>
					<DialogFooter>
						<Button variant="outline" onClick={() => setShowDialog(false)}>
							{t("common.cancel", "Cancel")}
						</Button>
						<Button onClick={handleAdd} disabled={!formName.trim() || !formCommand.trim() || connecting}>
							{connecting && <Loader2 className="size-3.5 animate-spin" />}
							{t("common.add", "Add")}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</div>
	);
}
