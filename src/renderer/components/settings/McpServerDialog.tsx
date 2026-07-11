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
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

const api = window.look;

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
	const { t } = useTranslation();
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
			toast.error(t("mcpDialog.nameRequired"));
			return;
		}
		if (type === "stdio" && !command.trim()) {
			toast.error(t("mcpDialog.commandRequired"));
			return;
		}
		if ((type === "http" || type === "sse") && !url.trim()) {
			toast.error(t("mcpDialog.urlRequired"));
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
				toast.success(t(editingName ? "mcpDialog.updated" : "mcpDialog.added"));
				onSave(config);
				resetForm();
			} else {
				toast.error(result?.error ?? t(editingName ? "mcpDialog.updateFailed" : "mcpDialog.addFailed"));
			}
		} catch (error) {
			toast.error(
				error instanceof Error ? error.message : t(editingName ? "mcpDialog.updateFailed" : "mcpDialog.addFailed"),
			);
		} finally {
			setSaving(false);
		}
	};

	return (
		<Dialog open={open} onOpenChange={(nextOpen) => !nextOpen && !saving && onClose()}>
			<DialogContent
				className="flex max-h-[min(680px,calc(100vh-2rem))] max-w-md flex-col gap-0 overflow-hidden p-0"
				onEscapeKeyDown={(event) => saving && event.preventDefault()}
				onInteractOutside={(event) => saving && event.preventDefault()}
				showCloseButton={!saving}
			>
				<DialogHeader className="border-b border-hairline px-5 py-4 pr-12">
					<DialogTitle>
						{editingName ? t("mcpDialog.editTitle", { name: editingName }) : t("mcpDialog.addTitle")}
					</DialogTitle>
					<DialogDescription>
						{t(editingName ? "mcpDialog.editDescription" : "mcpDialog.addDescription")}
					</DialogDescription>
				</DialogHeader>

				<div className="min-h-0 space-y-4 overflow-y-auto px-5 py-4">
					{/* Name */}
					<div className="space-y-1.5">
						<label className="text-xs font-medium" htmlFor="mcp-name">
							{t("mcpDialog.name")} <span className="text-destructive">*</span>
						</label>
						<Input
							id="mcp-name"
							type="text"
							value={name}
							onChange={(e) => setName(e.target.value)}
							placeholder={t("mcpDialog.namePlaceholder")}
							readOnly={!!editingName}
							className={editingName ? "cursor-not-allowed opacity-60" : undefined}
						/>
					</div>

					{/* Transport type */}
					<div className="space-y-1.5">
						<label className="text-xs font-medium" htmlFor="mcp-type">
							{t("mcpDialog.transport")}
						</label>
						<select
							id="mcp-type"
							value={type}
							onChange={(e) => setType(e.target.value as typeof type)}
							className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
						>
							<option value="stdio">stdio ({t("mcpDialog.subprocess")})</option>
							<option value="http">HTTP</option>
							<option value="sse">SSE (Server-Sent Events)</option>
						</select>
					</div>

					{/* stdio config */}
					{type === "stdio" && (
						<>
							<div className="space-y-1.5">
								<label className="text-xs font-medium" htmlFor="mcp-command">
									{t("mcpDialog.command")} <span className="text-destructive">*</span>
								</label>
								<Input
									id="mcp-command"
									type="text"
									value={command}
									onChange={(e) => setCommand(e.target.value)}
									placeholder={t("mcpDialog.commandPlaceholder")}
								/>
							</div>
							<div className="space-y-1.5">
								<label className="text-xs font-medium" htmlFor="mcp-args">
									{t("mcpDialog.args")}
								</label>
								<Input
									id="mcp-args"
									type="text"
									value={args}
									onChange={(e) => setArgs(e.target.value)}
									placeholder="-y @modelcontextprotocol/server-xxx"
								/>
							</div>
						</>
					)}

					{/* HTTP/SSE config */}
					{(type === "http" || type === "sse") && (
						<div className="space-y-1.5">
							<label className="text-xs font-medium" htmlFor="mcp-url">
								URL <span className="text-destructive">*</span>
							</label>
							<Input
								id="mcp-url"
								type="text"
								value={url}
								onChange={(e) => setUrl(e.target.value)}
								placeholder="https://mcp.example.com/jsonrpc"
							/>
						</div>
					)}
				</div>

				<DialogFooter className="m-0 shrink-0 rounded-none px-5 py-3">
					<Button
						variant="outline"
						size="sm"
						disabled={saving}
						onClick={() => {
							resetForm();
							onClose();
						}}
					>
						{t("common.cancel")}
					</Button>
					<Button
						size="sm"
						onClick={handleSave}
						disabled={saving}
					>
						{saving
							? t(editingName ? "mcpDialog.updating" : "mcpDialog.adding")
							: t(editingName ? "mcpDialog.saveChanges" : "mcpDialog.addServer")}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
