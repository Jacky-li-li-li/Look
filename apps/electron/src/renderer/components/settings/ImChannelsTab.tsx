// ============================================================
// ImChannelsTab — Feishu IM channel management
// ============================================================

import { Badge } from "@shared/components/ui/badge";
import { Button } from "@shared/components/ui/button";
import { Input } from "@shared/components/ui/input";
import { Label } from "@shared/components/ui/label";
import { Check, Eye, EyeOff, KeyRound, Loader2, QrCode, Save, Send, ToggleLeft, ToggleRight, X } from "lucide-react";
import QRCode from "qrcode";
import { createElement, type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import type { ImChannelInfo } from "./types";

const api = window.look;

type RegistrationPhase = "qr" | "polling" | "success" | "error";

interface RegistrationState {
	registrationId: string;
	phase: RegistrationPhase;
	url?: string;
	expireIn?: number;
	error?: string;
	appId?: string;
}

interface IncomingMessage {
	provider: string;
	messageId: string;
	chatId: string;
	senderOpenId: string;
	content: unknown;
	createTime: number;
}

function maskAppId(appId: string): string {
	if (appId.length <= 8) return "****";
	return `${appId.slice(0, 4)}****${appId.slice(-4)}`;
}

function statusBadgeVariant(status: ImChannelInfo["status"]): "default" | "secondary" | "destructive" | "outline" {
	switch (status) {
		case "connected":
			return "default";
		case "connecting":
			return "secondary";
		case "error":
			return "destructive";
		default:
			return "outline";
	}
}

function statusBadgeKey(status: ImChannelInfo["status"]): string {
	switch (status) {
		case "connected":
			return "settings.feishuConnected";
		case "connecting":
			return "settings.feishuConnecting";
		case "error":
			return "settings.imConnectionError";
		default:
			return "settings.imDisconnected";
	}
}

function _parseQrSvg(svg: string): { viewBox?: string; nodes: ReactNode[] } | null {
	try {
		const doc = new DOMParser().parseFromString(svg, "image/svg+xml");
		const svgEl = doc.documentElement;
		if (svgEl.tagName !== "svg") return null;
		const viewBox = svgEl.getAttribute("viewBox") ?? undefined;
		const nodes = Array.from(svgEl.children).map((el, i) => {
			const tag = el.tagName;
			const props: Record<string, string> = { key: String(i) };
			for (const attr of el.attributes) {
				props[attr.name] = attr.value;
			}
			return createElement(tag, props);
		});
		return { viewBox, nodes };
	} catch (err) {
		console.error("[ImChannelsTab] Failed to parse QR SVG:", err);
		return null;
	}
}

/** Format seconds into mm:ss or h:mm:ss */
function formatSeconds(seconds: number): string {
	const h = Math.floor(seconds / 3600);
	const m = Math.floor((seconds % 3600) / 60);
	const s = seconds % 60;
	if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
	return `${m}:${String(s).padStart(2, "0")}`;
}

// ─── QR Registration panel (inline) ─────────────────────────────

function QrRegisterPanel({
	registration,
	qrSvg,
	onCancel,
}: {
	registration: RegistrationState;
	qrSvg: { viewBox?: string; nodes: ReactNode[] } | null;
	onCancel: () => void;
}) {
	const { t } = useTranslation();
	return (
		<div className="rounded-lg border border-hairline bg-background/45 p-4">
			<h4 className="mb-3 text-xs font-medium">{t("settings.scanCreateFeishu")}</h4>
			<div className="flex flex-col items-center gap-3">
				{registration.phase === "qr" && (
					<>
						{qrSvg ? (
							<svg
								className="size-[200px] rounded-md border border-hairline bg-white p-2"
								viewBox={qrSvg.viewBox}
							>
								{qrSvg.nodes}
							</svg>
						) : (
							<div className="flex size-[200px] items-center justify-center rounded-md border border-hairline bg-muted/30">
								<Loader2 className="size-6 animate-spin text-muted-foreground" />
							</div>
						)}
						{registration.expireIn != null && (
							<p className="text-[11px] text-muted-foreground">
								{registration.expireIn > 0
									? `${t("settings.scanQrToConnect")} (${formatSeconds(registration.expireIn)})`
									: t("settings.qrCodeExpired")}
							</p>
						)}
						{!registration.expireIn && (
							<p className="text-[11px] text-muted-foreground">{t("settings.scanQrToConnect")}</p>
						)}
					</>
				)}
				{registration.phase === "polling" && (
					<div className="flex items-center gap-2 py-6 text-[12px] text-muted-foreground">
						<Loader2 className="size-4 animate-spin" />
						{t("settings.waitingForAuth")}
					</div>
				)}
				{registration.phase === "error" && registration.error && (
					<p className="py-2 text-[12px] text-destructive">{registration.error}</p>
				)}
				<Button variant="line" size="sm" className="mt-2 h-7 text-[11px]" onClick={onCancel}>
					{t("common.cancel")}
				</Button>
			</div>
		</div>
	);
}

// ─── Manual connect form (inline) ────────────────────────────────

function ManualConnectForm({
	appName,
	onAppNameChange,
	appId,
	onAppIdChange,
	appSecret,
	onAppSecretChange,
	showSecret,
	onToggleSecret,
	connecting,
	disabled,
	onSubmit,
	onCancel,
	onTest,
	testing,
	testResult,
	testPassed,
}: {
	appName: string;
	onAppNameChange: (v: string) => void;
	appId: string;
	onAppIdChange: (v: string) => void;
	appSecret: string;
	onAppSecretChange: (v: string) => void;
	showSecret: boolean;
	onToggleSecret: () => void;
	connecting: boolean;
	disabled: boolean;
	onSubmit: (e: React.FormEvent) => void;
	onCancel: () => void;
	onTest: () => void;
	testing: boolean;
	testResult: { success: boolean; message: string } | null;
	testPassed: boolean;
}) {
	const { t } = useTranslation();
	return (
		<div className="rounded-lg border border-hairline bg-background/45 p-4">
			<div className="mb-3 flex items-center gap-2">
				<KeyRound className="size-3.5 text-muted-foreground" />
				<h4 className="text-xs font-medium">{t("settings.manualConnectFeishu")}</h4>
			</div>
			<form onSubmit={onSubmit} className="space-y-3">
				<div className="space-y-1">
					<Label className="text-[10px]">{t("settings.appName")}</Label>
					<Input
						size={1}
						value={appName}
						onChange={(e) => onAppNameChange(e.target.value)}
						placeholder="My Feishu App"
						className="h-7 text-[11px]"
					/>
				</div>
				<div className="grid grid-cols-2 gap-3">
					<div className="space-y-1">
						<Label className="text-[10px]">{t("settings.feishuAppId")}</Label>
						<Input
							size={1}
							value={appId}
							onChange={(e) => onAppIdChange(e.target.value.toLowerCase())}
							placeholder="cli_..."
							className="h-7 text-[11px]"
						/>
					</div>
					<div className="space-y-1">
						<Label className="text-[10px]">{t("settings.feishuAppSecret")}</Label>
						<div className="relative">
							<Input
								size={1}
								type={showSecret ? "text" : "password"}
								value={appSecret}
								onChange={(e) => onAppSecretChange(e.target.value)}
								placeholder="********"
								className="h-7 pr-8 text-[11px]"
							/>
							<button
								type="button"
								onClick={onToggleSecret}
								className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:text-foreground"
							>
								{showSecret ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
							</button>
						</div>
					</div>
				</div>
				<div className="flex flex-wrap items-center gap-2">
					<Button
						type="button"
						variant={testPassed ? "default" : "outline"}
						size="sm"
						className="h-7 gap-1.5 text-[11px]"
						onClick={onTest}
						disabled={!appId.trim() || !appSecret.trim() || testing || connecting}
					>
						{testing ? (
							<Loader2 className="size-3 animate-spin" />
						) : testPassed ? (
							<Check className="size-3" />
						) : null}
						{t("settings.testConnection")}
					</Button>
					<Button
						type="submit"
						variant="default"
						size="sm"
						className="h-7 gap-1.5 text-[11px]"
						disabled={!testPassed || connecting}
					>
						{connecting ? <Loader2 className="size-3.5 animate-spin" /> : <KeyRound className="size-3.5" />}
						{t("settings.createApp")}
					</Button>
					<Button variant="line" size="sm" className="h-7 text-[11px]" onClick={onCancel}>
						{t("common.cancel")}
					</Button>
				</div>
				{testResult && (
					<div
						className={`rounded p-2 text-[11px] ${
							testResult.success
								? "bg-green-500/10 text-green-700 dark:text-green-400"
								: "bg-red-500/10 text-red-700 dark:text-red-400"
						}`}
					>
						{testResult.message}
					</div>
				)}
			</form>
		</div>
	);
}

// ─── Channel App Card ───────────────────────────────────────────

function ChannelCard({
	channel,
	onToggle,
	onClick,
}: {
	channel: ImChannelInfo;
	onToggle: () => void;
	onClick: () => void;
}) {
	const { t } = useTranslation();
	return (
		<div
			role="button"
			tabIndex={0}
			className="cursor-pointer rounded-lg border border-hairline bg-background/45 p-4 transition-colors hover:bg-accent/10"
			onClick={onClick}
			onKeyDown={(e) => {
				if (e.key === "Enter" || e.key === " ") {
					e.preventDefault();
					onClick();
				}
			}}
		>
			<div className="flex items-center justify-between gap-3">
				<div className="min-w-0 flex-1">
					<div className="flex items-center gap-2">
						<span className="text-sm font-medium">{channel.name || t("settings.feishu")}</span>
						<Badge variant={statusBadgeVariant(channel.status)} className="h-4 px-1.5 text-[9px]">
							{t(statusBadgeKey(channel.status))}
						</Badge>
					</div>
					<div className="mt-0.5 font-mono text-[10px] text-muted-foreground">{maskAppId(channel.appId)}</div>
					{channel.error && <p className="mt-1 text-[11px] text-destructive">{channel.error}</p>}
				</div>
				<button
					type="button"
					onClick={(e) => {
						e.stopPropagation();
						onToggle();
					}}
					className="flex shrink-0 items-center gap-1 rounded px-2 py-1 text-[11px] transition-colors hover:bg-muted/30"
					title={channel.enabled ? t("settings.disconnect") : t("settings.reconnect")}
				>
					{channel.enabled ? (
						<>
							<ToggleRight className="size-4 text-green-500" />
							<span className="text-green-600">ON</span>
						</>
					) : (
						<>
							<ToggleLeft className="size-4 text-muted-foreground" />
							<span className="text-muted-foreground">OFF</span>
						</>
					)}
				</button>
			</div>
		</div>
	);
}

// ─── Channel Detail Panel (inline) ──────────────────────────────

function ChannelDetailPanel({
	channel,
	onClose,
	onRemove,
	onTest,
	sendingTest,
	testResult,
	editName,
	onNameChange,
	showSecret,
	onToggleSecret,
	onSave,
	saving,
}: {
	channel: ImChannelInfo;
	onClose: () => void;
	onRemove: () => void;
	onTest: () => void;
	sendingTest: boolean;
	testResult: { success: boolean; message: string } | null;
	editName: string;
	onNameChange: (v: string) => void;
	showSecret: boolean;
	onToggleSecret: () => void;
	onSave: () => void;
	saving: boolean;
}) {
	const { t } = useTranslation();
	return (
		<div className="rounded-lg border border-hairline bg-background/45 p-4">
			<div className="mb-3 flex items-center justify-between">
				<h4 className="text-xs font-medium">{channel.name || t("settings.feishu")}</h4>
				<button type="button" onClick={onClose} className="rounded p-1 text-muted-foreground hover:bg-muted/40">
					<X className="size-4" />
				</button>
			</div>
			<div className="space-y-3 text-[12px]">
				<div className="space-y-1">
					<Label className="text-[10px]">{t("settings.appName")}</Label>
					<Input
						size={1}
						value={editName}
						onChange={(e) => onNameChange(e.target.value)}
						className="h-7 text-[11px]"
					/>
				</div>
				<div className="space-y-1">
					<Label className="text-[10px]">{t("settings.feishuAppId")}</Label>
					<div className="font-mono rounded border border-hairline bg-muted/20 px-3 py-1.5 text-[11px]">
						{channel.appId}
					</div>
				</div>
				<div className="space-y-1">
					<Label className="text-[10px]">{t("settings.feishuAppSecret")}</Label>
					<div className="relative">
						<Input
							size={1}
							type={showSecret ? "text" : "password"}
							value="********"
							readOnly
							className="h-7 pr-8 text-[11px]"
						/>
						<button
							type="button"
							onClick={onToggleSecret}
							className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:text-foreground"
						>
							{showSecret ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
						</button>
					</div>
				</div>
				<div className="flex justify-between">
					<span className="text-muted-foreground">{t("settings.status")}</span>
					<Badge variant={statusBadgeVariant(channel.status)} className="h-4 px-1.5 text-[9px]">
						{t(statusBadgeKey(channel.status))}
					</Badge>
				</div>
				{channel.error && (
					<div className="rounded bg-destructive/10 p-2 text-[11px] text-destructive">{channel.error}</div>
				)}
			</div>
			<div className="mt-4 space-y-3 border-t border-hairline pt-3">
				<div className="flex flex-wrap gap-2">
					<Button
						variant="default"
						size="sm"
						className="h-7 gap-1.5 text-[11px]"
						onClick={onSave}
						disabled={saving || !editName.trim()}
					>
						{saving ? <Loader2 className="size-3 animate-spin" /> : <Save className="size-3" />}
						保存
					</Button>
					<Button
						variant="outline"
						size="sm"
						className="h-7 gap-1.5 text-[11px]"
						onClick={onTest}
						disabled={sendingTest}
					>
						{sendingTest ? <Loader2 className="size-3 animate-spin" /> : <Send className="size-3" />}
						{t("settings.testConnection")}
					</Button>
					<Button variant="destructive" size="sm" className="h-7 gap-1.5 text-[11px]" onClick={onRemove}>
						<X className="size-3" />
						{t("settings.remove")}
					</Button>
				</div>
				{testResult && (
					<div
						className={`rounded p-2 text-[11px] ${
							testResult.success
								? "bg-green-500/10 text-green-700 dark:text-green-400"
								: "bg-red-500/10 text-red-700 dark:text-red-400"
						}`}
					>
						{testResult.message}
					</div>
				)}
			</div>
		</div>
	);
}

// ─── Recent Message Card ────────────────────────────────────────

function RecentMessageCard({ message }: { message: IncomingMessage }) {
	const { t } = useTranslation();
	return (
		<div className="rounded-lg border border-hairline bg-background/45 p-4">
			<h4 className="mb-2 text-xs font-medium">{t("settings.recentMessage")}</h4>
			<div className="space-y-1 text-[11px]">
				<div className="flex gap-2">
					<span className="text-muted-foreground">chatId:</span>
					<span className="font-mono">{message.chatId}</span>
				</div>
				<div className="flex gap-2">
					<span className="text-muted-foreground">sender:</span>
					<span className="font-mono">{message.senderOpenId}</span>
				</div>
				<div className="mt-1 rounded bg-muted/45 p-2 font-mono text-[10px]">
					{JSON.stringify(message.content, null, 2)}
				</div>
			</div>
		</div>
	);
}

// ─── Main Component ─────────────────────────────────────────────

export default function ImChannelsTab() {
	const { t } = useTranslation();
	const [channels, setChannels] = useState<ImChannelInfo[]>([]);
	const [loading, setLoading] = useState(false);
	const [manualConnecting, setManualConnecting] = useState(false);
	const [showQrPanel, setShowQrPanel] = useState(false);
	const [showManualPanel, setShowManualPanel] = useState(false);
	const [registration, setRegistration] = useState<RegistrationState | null>(null);
	const [qrSvg, setQrSvg] = useState<{ viewBox?: string; nodes: ReactNode[] } | null>(null);
	const [manualName, setManualName] = useState("");
	const [manualForm, setManualForm] = useState({ appId: "", appSecret: "" });
	const [showManualSecret, setShowManualSecret] = useState(false);
	const [manualTesting, setManualTesting] = useState(false);
	const [manualTestResult, setManualTestResult] = useState<{ success: boolean; message: string } | null>(null);
	const [manualTestPassed, setManualTestPassed] = useState(false);
	const [recentMessage, setRecentMessage] = useState<IncomingMessage | null>(null);
	const [selectedChannelId, setSelectedChannelId] = useState<string | null>(null);
	const [sendingTest, setSendingTest] = useState(false);
	const [testResult, setTestResult] = useState<{ success: boolean; message: string } | null>(null);
	const [detailEditName, setDetailEditName] = useState("");
	const [showDetailSecret, setShowDetailSecret] = useState(false);
	const [saving, setSaving] = useState(false);

	const qrUrlRef = useRef<string | undefined>(undefined);

	const selectedChannel = selectedChannelId
		? (channels.find((ch) => `${ch.provider}-${ch.appId}` === selectedChannelId) ?? null)
		: null;

	const loadChannels = useCallback(async () => {
		if (!api) return;
		try {
			const result = await api.getImChannels();
			if (result?.success && Array.isArray(result.channels)) {
				setChannels(result.channels as ImChannelInfo[]);
			}
		} catch (_err) {
			toast.error(t("settings.imConnectionError"));
		}
	}, [t]);

	useEffect(() => {
		loadChannels();
	}, [loadChannels]);

	// Listen for backend events
	useEffect(() => {
		if (!api) return;
		const unsubscribe = api.onEvent((event: unknown) => {
			if (!event || typeof event !== "object") return;
			const e = event as Record<string, unknown>;
			const type = e.type;

			if (type === "im:registration-update") {
				const update = e as {
					type: string;
					registrationId: string;
					phase: RegistrationPhase;
					url?: string;
					expireIn?: number;
					error?: string;
					appId?: string;
				};
				setRegistration({
					registrationId: update.registrationId,
					phase: update.phase,
					url: update.url,
					expireIn: update.expireIn,
					error: update.error,
					appId: update.appId,
				});
				if (update.phase === "success") {
					toast.success(t("settings.feishuConnected"));
					loadChannels();
					setRegistration(null);
					setQrSvg(null);
					setShowQrPanel(false);
				} else if (update.phase === "error") {
					toast.error(update.error || t("settings.imConnectionError"));
				}
			} else if (type === "im:channel-status") {
				const statusEvent = e as {
					type: string;
					provider: string;
					status: ImChannelInfo["status"];
					appId?: string;
					error?: string;
				};
				setChannels((prev) =>
					prev.map((ch) =>
						ch.provider === statusEvent.provider && ch.appId === statusEvent.appId
							? {
									...ch,
									status: statusEvent.status,
									connected: statusEvent.status === "connected",
									error: statusEvent.error,
								}
							: ch,
					),
				);
			} else if (type === "im:message-received") {
				const msg = e as unknown as IncomingMessage & { type: string };
				setRecentMessage(msg);
			}
		});
		return unsubscribe;
	}, [loadChannels, t]);

	// Generate QR code when registration URL changes
	useEffect(() => {
		if (!registration?.url || registration.url === qrUrlRef.current) return;
		qrUrlRef.current = registration.url;
		let cancelled = false;
		QRCode.toString(registration.url, {
			type: "svg",
			width: 200,
			margin: 2,
			color: { dark: "#000000", light: "#ffffff" },
		})
			.then((svg) => {
				if (!cancelled) setQrSvg(_parseQrSvg(svg));
			})
			.catch((err) => {
				console.error("[ImChannelsTab] Failed to generate QR code:", err);
				if (!cancelled) setQrSvg(null);
			});
		return () => {
			cancelled = true;
		};
	}, [registration?.url]);

	// QR countdown timer
	useEffect(() => {
		if (registration?.expireIn == null || registration.phase !== "qr") return;
		const interval = setInterval(() => {
			setRegistration((prev) => {
				if (!prev || prev.expireIn == null || prev.expireIn <= 0) return prev;
				return { ...prev, expireIn: prev.expireIn - 1 };
			});
		}, 1000);
		return () => clearInterval(interval);
	}, [registration?.expireIn, registration?.phase]);

	// ─── Handlers ───────────────────────────────────────────

	const handleQrConnect = async () => {
		if (!api) return;
		setLoading(true);
		setShowQrPanel(true);
		setShowManualPanel(false);
		setRegistration(null);
		setQrSvg(null);
		try {
			const result = await api.connectFeishuChannel({
				appName: "Look",
				description: t("settings.defaultDesc"),
			});
			if (result?.success && result.registrationId) {
				setRegistration({ registrationId: result.registrationId, phase: "polling" });
			} else {
				toast.error(t("settings.imConnectionError"));
				setShowQrPanel(false);
			}
		} catch (_err) {
			toast.error(t("settings.imConnectionError"));
			setShowQrPanel(false);
		} finally {
			setLoading(false);
		}
	};

	const handleManualTest = async () => {
		if (!api) return;
		setManualTesting(true);
		setManualTestResult(null);
		setManualTestPassed(false);
		try {
			const result = await api.testImConnectionDirect(manualForm.appId.trim(), manualForm.appSecret.trim());
			if (result) {
				setManualTestResult({
					success: result.success,
					message: result.message ?? result.error ?? t("settings.testFailed"),
				});
				if (result.success) setManualTestPassed(true);
			}
		} catch (_err) {
			setManualTestResult({ success: false, message: t("settings.testFailed") });
		} finally {
			setManualTesting(false);
		}
	};

	const handleManualConnect = async (e: React.FormEvent) => {
		e.preventDefault();
		if (!api) return;
		setManualConnecting(true);
		try {
			const name = manualName.trim() || "Feishu";
			const result = await api.connectFeishuManualChannel({
				appId: manualForm.appId.trim(),
				appSecret: manualForm.appSecret.trim(),
				name,
			});
			if (result?.success) {
				toast.success(t("settings.feishuConnected"));
				setManualForm({ appId: "", appSecret: "" });
				setManualName("");
				setManualTestResult(null);
				setManualTestPassed(false);
				setShowManualPanel(false);
				await loadChannels();
			} else {
				toast.error(result?.error || t("settings.imConnectionError"));
			}
		} catch (err) {
			toast.error(err instanceof Error ? err.message : t("settings.imConnectionError"));
		} finally {
			setManualConnecting(false);
		}
	};

	const handleToggleChannel = async (channel: ImChannelInfo) => {
		if (!api) return;
		try {
			if (channel.enabled) {
				await api.disconnectImChannel(channel.provider, channel.appId);
			} else {
				await api.reconnectImChannel(channel.provider, channel.appId);
			}
			await loadChannels();
		} catch (_err) {
			toast.error(t("settings.imConnectionError"));
		}
	};

	const handleRemoveChannel = async () => {
		if (!api || !selectedChannel) return;
		if (!window.confirm(t("settings.confirmRemoveDesc"))) return;
		try {
			await api.removeImChannel(selectedChannel.provider, selectedChannel.appId);
			setSelectedChannelId(null);
			await loadChannels();
		} catch (_err) {
			toast.error(t("settings.imConnectionError"));
		}
	};

	const handleTestChannel = async () => {
		if (!api || !selectedChannel) return;
		setTestResult(null);
		setSendingTest(true);
		try {
			const result = await api.testImConnection(selectedChannel.appId);
			if (result) {
				setTestResult({
					success: result.success,
					message: result.message ?? result.error ?? t("settings.testNoResponse"),
				});
			} else {
				setTestResult({ success: false, message: t("settings.testNoResponse") });
			}
		} catch (_err) {
			setTestResult({ success: false, message: t("settings.connectionTestError") });
		} finally {
			setSendingTest(false);
		}
	};

	const handleSaveChannel = async () => {
		if (!api || !selectedChannel) return;
		const newName = detailEditName.trim();
		if (!newName) {
			toast.error(t("settings.appNameRequired"));
			return;
		}
		setSaving(true);
		try {
			await api.updateImChannel(selectedChannel.appId, { name: newName });
			toast.success(t("settings.saved"));
			await loadChannels();
		} catch (_err) {
			toast.error(t("settings.saveFailed"));
		} finally {
			setSaving(false);
		}
	};

	const handleCancelRegistration = async () => {
		if (!api || !registration?.registrationId) return;
		try {
			await api.cancelFeishuRegistration(registration.registrationId);
		} catch (_err) {
			// ignore
		} finally {
			setRegistration(null);
			setQrSvg(null);
			setShowQrPanel(false);
		}
	};

	const openManualPanel = () => {
		setShowManualPanel((prev) => !prev);
		setShowQrPanel(false);
		setRegistration(null);
		setQrSvg(null);
		setManualTestResult(null);
		setManualTestPassed(false);
	};

	const openDetail = (ch: ImChannelInfo) => {
		const key = `${ch.provider}-${ch.appId}`;
		setSelectedChannelId((prev) => (prev === key ? null : key));
		setDetailEditName(ch.name ?? "");
		setTestResult(null);
	};

	return (
		<div className="flex h-full flex-col gap-4 overflow-y-auto pr-1">
			{/* ── Header with always-visible action buttons ── */}
			<div className="flex items-center justify-between">
				<div>
					<h3 className="text-sm font-medium">{t("settings.imChannels")}</h3>
					<p className="text-[11px] text-muted-foreground">{t("settings.imChannelsDescription")}</p>
				</div>
				<div className="flex items-center gap-2">
					<Button size="sm" className="h-7 gap-1.5 text-[11px]" onClick={handleQrConnect} disabled={loading}>
						{loading ? <Loader2 className="size-3.5 animate-spin" /> : <QrCode className="size-3.5" />}
						{t("settings.scanCreateFeishu")}
					</Button>
					<Button size="sm" className="h-7 gap-1.5 text-[11px]" onClick={openManualPanel} disabled={loading}>
						<KeyRound className="size-3.5" />
						{t("settings.manualConnectFeishu")}
					</Button>
				</div>
			</div>

			{/* ── QR Connect Panel (inline) ── */}
			{showQrPanel && registration && (
				<QrRegisterPanel registration={registration} qrSvg={qrSvg} onCancel={handleCancelRegistration} />
			)}

			{/* ── Manual Connect Panel (inline) ── */}
			{showManualPanel && (
				<ManualConnectForm
					appName={manualName}
					onAppNameChange={setManualName}
					appId={manualForm.appId}
					onAppIdChange={(v) => setManualForm((prev) => ({ ...prev, appId: v }))}
					appSecret={manualForm.appSecret}
					onAppSecretChange={(v) => setManualForm((prev) => ({ ...prev, appSecret: v }))}
					showSecret={showManualSecret}
					onToggleSecret={() => setShowManualSecret((prev) => !prev)}
					connecting={manualConnecting}
					disabled={loading}
					onSubmit={handleManualConnect}
					onCancel={() => setShowManualPanel(false)}
					onTest={handleManualTest}
					testing={manualTesting}
					testResult={manualTestResult}
					testPassed={manualTestPassed}
				/>
			)}

			{/* ── Channel cards list ── */}
			{channels.map((ch) => {
				const cardKey = `${ch.provider}-${ch.appId}`;
				const isDetailOpen = selectedChannelId === cardKey;
				return (
					<div key={cardKey} className="space-y-2">
						<ChannelCard
							channel={ch}
							onToggle={() => handleToggleChannel(ch)}
							onClick={() => {
								openDetail(ch);
							}}
						/>
						{isDetailOpen && selectedChannel && (
							<ChannelDetailPanel
								channel={selectedChannel}
								onClose={() => setSelectedChannelId(null)}
								onRemove={handleRemoveChannel}
								onTest={handleTestChannel}
								sendingTest={sendingTest}
								testResult={testResult}
								editName={detailEditName}
								onNameChange={setDetailEditName}
								showSecret={showDetailSecret}
								onToggleSecret={() => setShowDetailSecret((prev) => !prev)}
								onSave={handleSaveChannel}
								saving={saving}
							/>
						)}
					</div>
				);
			})}

			{/* ── Recent message ── */}
			{recentMessage && <RecentMessageCard message={recentMessage} />}
		</div>
	);
}
