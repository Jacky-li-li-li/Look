// ============================================================
// ImChannelsTab — Feishu IM channel management
// ============================================================

import { Badge } from "@look/ui/components/ui/badge";
import { Button } from "@look/ui/components/ui/button";
import { Input } from "@look/ui/components/ui/input";
import { Label } from "@look/ui/components/ui/label";
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

// ─── grouped state types ────────────────────────────────────────

interface ListState {
	channels: ImChannelInfo[];
	loading: boolean;
	selectedChannelId: string | null;
	sendingTest: boolean;
	testResult: { success: boolean; message: string } | null;
	recentMessage: IncomingMessage | null;
}

interface QrState {
	showPanel: boolean;
	registration: RegistrationState | null;
	qrSvg: { viewBox?: string; nodes: ReactNode[] } | null;
}

interface ManualState {
	connecting: boolean;
	showPanel: boolean;
	name: string;
	form: { appId: string; appSecret: string };
	showSecret: boolean;
	testing: boolean;
	testResult: { success: boolean; message: string } | null;
	testPassed: boolean;
}

interface DetailState {
	editName: string;
	showSecret: boolean;
	saving: boolean;
}

export default function ImChannelsTab() {
	const { t } = useTranslation();

	// ── grouped state (20 → 4 useState) ──
	const [list, setList] = useState<ListState>({
		channels: [],
		loading: false,
		selectedChannelId: null,
		sendingTest: false,
		testResult: null,
		recentMessage: null,
	});
	const [qr, setQr] = useState<QrState>({
		showPanel: false,
		registration: null,
		qrSvg: null,
	});
	const [manual, setManual] = useState<ManualState>({
		connecting: false,
		showPanel: false,
		name: "",
		form: { appId: "", appSecret: "" },
		showSecret: false,
		testing: false,
		testResult: null,
		testPassed: false,
	});
	const [detail, setDetail] = useState<DetailState>({
		editName: "",
		showSecret: false,
		saving: false,
	});

	// ── patch helpers ──
	// 支持函数式更新：patch(key, prev => ...) 时把 value 当函数调用，语义与 setX((prev) => ...) 一致
	const patchList = useCallback(
		<K extends keyof ListState>(key: K, value: ListState[K] | ((prev: ListState[K]) => ListState[K])) =>
			setList((prev) => ({
				...prev,
				[key]: typeof value === "function" ? value(prev[key]) : value,
			})),
		[],
	);
	const patchQr = useCallback(
		<K extends keyof QrState>(key: K, value: QrState[K] | ((prev: QrState[K]) => QrState[K])) =>
			setQr((prev) => ({
				...prev,
				[key]: typeof value === "function" ? value(prev[key]) : value,
			})),
		[],
	);
	const patchManual = useCallback(
		<K extends keyof ManualState>(key: K, value: ManualState[K] | ((prev: ManualState[K]) => ManualState[K])) =>
			setManual((prev) => ({
				...prev,
				[key]: typeof value === "function" ? value(prev[key]) : value,
			})),
		[],
	);
	const patchDetail = useCallback(
		<K extends keyof DetailState>(key: K, value: DetailState[K] | ((prev: DetailState[K]) => DetailState[K])) =>
			setDetail((prev) => ({
				...prev,
				[key]: typeof value === "function" ? value(prev[key]) : value,
			})),
		[],
	);

	const qrUrlRef = useRef<string | undefined>(undefined);

	const selectedChannel = list.selectedChannelId
		? (list.channels.find((ch) => `${ch.provider}-${ch.appId}` === list.selectedChannelId) ?? null)
		: null;

	const loadChannels = useCallback(async () => {
		if (!api) return;
		try {
			const result = await api.getImChannels();
			if (result?.success && Array.isArray(result.channels)) {
				patchList("channels", result.channels as ImChannelInfo[]);
			}
		} catch (_err) {
			toast.error(t("settings.imConnectionError"));
		}
	}, [patchList, t]);

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
				patchQr("registration", {
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
					patchQr("registration", null);
					patchQr("qrSvg", null);
					patchQr("showPanel", false);
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
				patchList("channels", (prev) =>
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
				patchList("recentMessage", msg);
			}
		});
		return unsubscribe;
	}, [loadChannels, patchList, patchQr, t]);

	// Generate QR code when registration URL changes
	useEffect(() => {
		if (!qr.registration?.url || qr.registration.url === qrUrlRef.current) return;
		qrUrlRef.current = qr.registration.url;
		let cancelled = false;
		QRCode.toString(qr.registration.url, {
			type: "svg",
			width: 200,
			margin: 2,
			color: { dark: "#000000", light: "#ffffff" },
		})
			.then((svg) => {
				if (!cancelled) patchQr("qrSvg", _parseQrSvg(svg));
			})
			.catch((err) => {
				console.error("[ImChannelsTab] Failed to generate QR code:", err);
				if (!cancelled) patchQr("qrSvg", null);
			});
		return () => {
			cancelled = true;
		};
	}, [patchQr, qr.registration?.url]);

	// QR countdown timer
	useEffect(() => {
		if (qr.registration?.expireIn == null || qr.registration.phase !== "qr") return;
		const interval = setInterval(() => {
			patchQr("registration", (prev) => {
				if (!prev || prev.expireIn == null || prev.expireIn <= 0) return prev;
				return { ...prev, expireIn: prev.expireIn - 1 };
			});
		}, 1000);
		return () => clearInterval(interval);
	}, [patchQr, qr.registration?.expireIn, qr.registration?.phase]);

	// ─── Handlers ───────────────────────────────────────────

	const handleQrConnect = async () => {
		if (!api) return;
		patchList("loading", true);
		patchQr("showPanel", true);
		patchManual("showPanel", false);
		patchQr("registration", null);
		patchQr("qrSvg", null);
		try {
			const result = await api.connectFeishuChannel({
				appName: "Look",
				description: t("settings.defaultDesc"),
			});
			if (result?.success && result.registrationId) {
				patchQr("registration", { registrationId: result.registrationId, phase: "polling" });
			} else {
				toast.error(t("settings.imConnectionError"));
				patchQr("showPanel", false);
			}
		} catch (_err) {
			toast.error(t("settings.imConnectionError"));
			patchQr("showPanel", false);
		} finally {
			patchList("loading", false);
		}
	};

	const handleManualTest = async () => {
		if (!api) return;
		patchManual("testing", true);
		patchManual("testResult", null);
		patchManual("testPassed", false);
		try {
			const result = await api.testImConnectionDirect(manual.form.appId.trim(), manual.form.appSecret.trim());
			if (result) {
				patchManual("testResult", {
					success: result.success,
					message: result.success
						? (result.message ?? t("settings.testFailed"))
						: (result.error ?? t("settings.testFailed")),
				});
				if (result.success) patchManual("testPassed", true);
			}
		} catch (_err) {
			patchManual("testResult", { success: false, message: t("settings.testFailed") });
		} finally {
			patchManual("testing", false);
		}
	};

	const handleManualConnect = async (e: React.FormEvent) => {
		e.preventDefault();
		if (!api) return;
		patchManual("connecting", true);
		try {
			const name = manual.name.trim() || "Feishu";
			const result = await api.connectFeishuManualChannel({
				appId: manual.form.appId.trim(),
				appSecret: manual.form.appSecret.trim(),
				name,
			});
			if (result?.success) {
				toast.success(t("settings.feishuConnected"));
				patchManual("form", { appId: "", appSecret: "" });
				patchManual("name", "");
				patchManual("testResult", null);
				patchManual("testPassed", false);
				patchManual("showPanel", false);
				await loadChannels();
			} else {
				toast.error(result?.error || t("settings.imConnectionError"));
			}
		} catch (err) {
			toast.error(err instanceof Error ? err.message : t("settings.imConnectionError"));
		} finally {
			patchManual("connecting", false);
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
			patchList("selectedChannelId", null);
			await loadChannels();
		} catch (_err) {
			toast.error(t("settings.imConnectionError"));
		}
	};

	const handleTestChannel = async () => {
		if (!api || !selectedChannel) return;
		patchList("testResult", null);
		patchList("sendingTest", true);
		try {
			const result = await api.testImConnection(selectedChannel.appId);
			if (result) {
				patchList("testResult", {
					success: result.success,
					message: result.success
						? (result.message ?? t("settings.testNoResponse"))
						: (result.error ?? t("settings.testNoResponse")),
				});
			} else {
				patchList("testResult", { success: false, message: t("settings.testNoResponse") });
			}
		} catch (_err) {
			patchList("testResult", { success: false, message: t("settings.connectionTestError") });
		} finally {
			patchList("sendingTest", false);
		}
	};

	const handleSaveChannel = async () => {
		if (!api || !selectedChannel) return;
		const newName = detail.editName.trim();
		if (!newName) {
			toast.error(t("settings.appNameRequired"));
			return;
		}
		patchDetail("saving", true);
		try {
			await api.updateImChannel(selectedChannel.appId, { name: newName });
			toast.success(t("settings.saved"));
			await loadChannels();
		} catch (_err) {
			toast.error(t("settings.saveFailed"));
		} finally {
			patchDetail("saving", false);
		}
	};

	const handleCancelRegistration = async () => {
		if (!api || !qr.registration?.registrationId) return;
		try {
			await api.cancelFeishuRegistration(qr.registration.registrationId);
		} catch (_err) {
			// ignore
		} finally {
			patchQr("registration", null);
			patchQr("qrSvg", null);
			patchQr("showPanel", false);
		}
	};

	const openManualPanel = () => {
		patchManual("showPanel", (prev) => !prev);
		patchQr("showPanel", false);
		patchQr("registration", null);
		patchQr("qrSvg", null);
		patchManual("testResult", null);
		patchManual("testPassed", false);
	};

	const openDetail = (ch: ImChannelInfo) => {
		const key = `${ch.provider}-${ch.appId}`;
		patchList("selectedChannelId", (prev) => (prev === key ? null : key));
		patchDetail("editName", ch.name ?? "");
		patchList("testResult", null);
	};

	return (
		<div className="flex h-full min-h-0 flex-col gap-4 overflow-y-auto p-4">
			{/* ── Header with always-visible action buttons ── */}
			<div className="flex items-center justify-between">
				<div>
					<h3 className="text-[13px] font-medium">{t("settings.imChannels")}</h3>
					<p className="text-[11px] text-muted-foreground">{t("settings.imChannelsDescription")}</p>
				</div>
				<div className="flex items-center gap-2">
					<Button size="sm" className="h-7 gap-1.5 text-[11px]" onClick={handleQrConnect} disabled={list.loading}>
						{list.loading ? <Loader2 className="size-3.5 animate-spin" /> : <QrCode className="size-3.5" />}
						{t("settings.scanCreateFeishu")}
					</Button>
					<Button size="sm" className="h-7 gap-1.5 text-[11px]" onClick={openManualPanel} disabled={list.loading}>
						<KeyRound className="size-3.5" />
						{t("settings.manualConnectFeishu")}
					</Button>
				</div>
			</div>

			{/* ── QR Connect Panel (inline) ── */}
			{qr.showPanel && qr.registration && (
				<QrRegisterPanel registration={qr.registration} qrSvg={qr.qrSvg} onCancel={handleCancelRegistration} />
			)}

			{/* ── Manual Connect Panel (inline) ── */}
			{manual.showPanel && (
				<ManualConnectForm
					appName={manual.name}
					onAppNameChange={(v) => patchManual("name", v)}
					appId={manual.form.appId}
					onAppIdChange={(v) => patchManual("form", (prev) => ({ ...prev, appId: v }))}
					appSecret={manual.form.appSecret}
					onAppSecretChange={(v) => patchManual("form", (prev) => ({ ...prev, appSecret: v }))}
					showSecret={manual.showSecret}
					onToggleSecret={() => patchManual("showSecret", (prev) => !prev)}
					connecting={manual.connecting}
					disabled={list.loading}
					onSubmit={handleManualConnect}
					onCancel={() => patchManual("showPanel", false)}
					onTest={handleManualTest}
					testing={manual.testing}
					testResult={manual.testResult}
					testPassed={manual.testPassed}
				/>
			)}

			{/* ── Channel cards list ── */}
			{list.channels.map((ch) => {
				const cardKey = `${ch.provider}-${ch.appId}`;
				const isDetailOpen = list.selectedChannelId === cardKey;
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
								onClose={() => patchList("selectedChannelId", null)}
								onRemove={handleRemoveChannel}
								onTest={handleTestChannel}
								sendingTest={list.sendingTest}
								testResult={list.testResult}
								editName={detail.editName}
								onNameChange={(v) => patchDetail("editName", v)}
								showSecret={detail.showSecret}
								onToggleSecret={() => patchDetail("showSecret", (prev) => !prev)}
								onSave={handleSaveChannel}
								saving={detail.saving}
							/>
						)}
					</div>
				);
			})}

			{/* ── Recent message ── */}
			{list.recentMessage && <RecentMessageCard message={list.recentMessage} />}
		</div>
	);
}
