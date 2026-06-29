// ============================================================
// ImChannelsTab — Feishu IM channel management
// ============================================================

import { Badge } from "@shared/components/ui/badge";
import { Button } from "@shared/components/ui/button";
import { Input } from "@shared/components/ui/input";
import { Label } from "@shared/components/ui/label";
import { Loader2, MessageCircle, Send, Unlink } from "lucide-react";
import QRCode from "qrcode";
import { createElement, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import type { ImChannelInfo } from "./types";

const api = (window as any).look;

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

function parseQrSvg(svg: string): { viewBox?: string; nodes: ReactNode[] } | null {
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

export default function ImChannelsTab() {
	const { t } = useTranslation();
	const [channels, setChannels] = useState<ImChannelInfo[]>([]);
	const [loading, setLoading] = useState(false);
	const [registration, setRegistration] = useState<RegistrationState | null>(null);
	const [qrSvg, setQrSvg] = useState<{ viewBox?: string; nodes: ReactNode[] } | null>(null);
	const [recentMessage, setRecentMessage] = useState<IncomingMessage | null>(null);
	const [testForm, setTestForm] = useState({ receiveIdType: "open_id", receiveId: "", text: "" });
	const [sendingTest, setSendingTest] = useState(false);
	const qrUrlRef = useRef<string | undefined>(undefined);

	const loadChannels = useCallback(async () => {
		if (!api) return;
		try {
			const result = await api.getImChannels();
			if (result?.success && Array.isArray(result.channels)) {
				setChannels(result.channels);
			}
		} catch (_err) {
			toast.error(t("settings.imConnectionError"));
		}
	}, [t]);

	useEffect(() => {
		loadChannels();
	}, [loadChannels]);

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
				if (statusEvent.status === "connected") {
					setRegistration(null);
					setQrSvg(null);
				}
			} else if (type === "im:message-received") {
				const msg = e as unknown as IncomingMessage & { type: string };
				setRecentMessage(msg);
			}
		});
		return unsubscribe;
	}, [loadChannels, t]);

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
				if (!cancelled) setQrSvg(svg);
			})
			.catch((err) => {
				console.error("[ImChannelsTab] Failed to generate QR code:", err);
				if (!cancelled) setQrSvg(null);
			});
		return () => {
			cancelled = true;
		};
	}, [registration?.url]);

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

	const handleConnect = async () => {
		if (!api) return;
		setLoading(true);
		try {
			const result = await api.connectFeishuChannel({
				appName: "Look",
				description: t("settings.imChannels.defaultDesc"),
			});
			if (result?.success && result.registrationId) {
				setRegistration({ registrationId: result.registrationId, phase: "polling" });
			} else {
				toast.error(t("settings.imConnectionError"));
			}
		} catch (_err) {
			toast.error(t("settings.imConnectionError"));
		} finally {
			setLoading(false);
		}
	};

	const handleDisconnect = async () => {
		if (!api) return;
		try {
			await api.disconnectImChannel("feishu");
			await loadChannels();
			setRegistration(null);
			setQrSvg(null);
		} catch (_err) {
			toast.error(t("settings.imConnectionError"));
		}
	};

	const handleCancelRegistration = async () => {
		if (!api || !registration?.registrationId) return;
		try {
			await api.cancelFeishuRegistration(registration.registrationId);
			setRegistration(null);
			setQrSvg(null);
		} catch (_err) {
			toast.error(t("settings.imConnectionError"));
		}
	};

	const handleSendTest = async (e: React.FormEvent) => {
		e.preventDefault();
		if (!api) return;
		setSendingTest(true);
		try {
			const result = await api.sendImTestMessage({
				receiveIdType: testForm.receiveIdType,
				receiveId: testForm.receiveId,
				text: testForm.text,
			});
			if (result?.success) {
				toast.success(t("settings.testMessageSent"));
				setTestForm((prev) => ({ ...prev, text: "" }));
			} else {
				toast.error(result?.error || t("settings.imConnectionError"));
			}
		} catch (_err) {
			toast.error(t("settings.imConnectionError"));
		} finally {
			setSendingTest(false);
		}
	};

	const feishuChannel = channels.find((ch) => ch.provider === "feishu");
	const isConnected = feishuChannel?.connected ?? false;
	const isRegistering = registration != null && !isConnected;

	return (
		<div className="flex h-full flex-col gap-4 overflow-y-auto pr-1">
			<div className="flex items-center justify-between">
				<div>
					<h3 className="text-sm font-medium">{t("settings.imChannels")}</h3>
					<p className="text-[11px] text-muted-foreground">{t("settings.imChannelsDescription")}</p>
				</div>
				{!isConnected && !isRegistering && (
					<Button size="sm" className="h-7 gap-1.5 text-[11px]" onClick={handleConnect} disabled={loading}>
						{loading ? <Loader2 className="size-3.5 animate-spin" /> : <MessageCircle className="size-3.5" />}
						{t("settings.connectFeishu")}
					</Button>
				)}
			</div>

			{isRegistering && (
				<div className="rounded-lg border border-hairline bg-background/45 p-4">
					<h4 className="mb-2 text-xs font-medium">{t("settings.feishu")}</h4>
					{registration.phase === "qr" && (
						<div className="flex flex-col items-center gap-3">
							{qrSvg ? (
								<div
									className="size-[200px] rounded-md border border-hairline bg-white p-2"
									dangerouslySetInnerHTML={{ __html: qrSvg }}
								/>
							) : (
								<div className="flex size-[200px] items-center justify-center rounded-md border border-hairline bg-muted/30">
									<Loader2 className="size-6 animate-spin text-muted-foreground" />
								</div>
							)}
							{registration.url && (
								<a
									href={registration.url}
									target="_blank"
									rel="noreferrer"
									className="max-w-full truncate text-[11px] text-primary hover:underline"
								>
									{registration.url}
								</a>
							)}
							{registration.expireIn != null && (
								<p className="text-[11px] text-muted-foreground">
									{registration.expireIn > 0
										? `${t("settings.scanQrToConnect")} (${registration.expireIn}s)`
										: t("settings.qrCodeExpired")}
								</p>
							)}
							{!registration.expireIn && (
								<p className="text-[11px] text-muted-foreground">{t("settings.scanQrToConnect")}</p>
							)}
						</div>
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
					<Button variant="line" size="sm" className="mt-3 h-7 text-[11px]" onClick={handleCancelRegistration}>
						{t("common.cancel")}
					</Button>
				</div>
			)}

			{feishuChannel && (
				<div className="rounded-lg border border-hairline bg-background/45 p-4">
					<div className="flex items-start justify-between gap-3">
						<div className="min-w-0 flex-1">
							<div className="flex items-center gap-2">
								<span className="text-sm font-medium">{feishuChannel.name || t("settings.feishu")}</span>
								<Badge variant={statusBadgeVariant(feishuChannel.status)} className="h-4 px-1.5 text-[9px]">
									{t(
										`settings.${feishuChannel.status === "connected" ? "feishuConnected" : "imConnectionError"}`,
									)}
								</Badge>
							</div>
							<div className="mt-0.5 font-mono text-[10px] text-muted-foreground">
								{maskAppId(feishuChannel.appId)}
							</div>
							{feishuChannel.error && <p className="mt-1 text-[11px] text-destructive">{feishuChannel.error}</p>}
						</div>
						<Button
							variant="line"
							size="sm"
							className="h-7 gap-1 text-[11px]"
							onClick={handleDisconnect}
							disabled={loading}
						>
							<Unlink className="size-3" />
							{t("settings.disconnect")}
						</Button>
					</div>

					{isConnected && (
						<form onSubmit={handleSendTest} className="mt-4 space-y-3 border-t border-hairline pt-3">
							<h5 className="text-xs font-medium">{t("settings.sendTestMessage")}</h5>
							<div className="grid grid-cols-2 gap-3">
								<div className="space-y-1">
									<Label className="text-[10px]">{t("settings.receiveIdType")}</Label>
									<Input
										size={1}
										value={testForm.receiveIdType}
										onChange={(e) => setTestForm((prev) => ({ ...prev, receiveIdType: e.target.value }))}
										placeholder="open_id"
										className="h-7 text-[11px]"
									/>
								</div>
								<div className="space-y-1">
									<Label className="text-[10px]">{t("settings.receiveId")}</Label>
									<Input
										size={1}
										value={testForm.receiveId}
										onChange={(e) => setTestForm((prev) => ({ ...prev, receiveId: e.target.value }))}
										placeholder="ou_..."
										className="h-7 text-[11px]"
									/>
								</div>
							</div>
							<div className="space-y-1">
								<Label className="text-[10px]">{t("settings.messageText")}</Label>
								<Input
									size={1}
									value={testForm.text}
									onChange={(e) => setTestForm((prev) => ({ ...prev, text: e.target.value }))}
									placeholder={t("chat.placeholder")}
									className="h-7 text-[11px]"
								/>
							</div>
							<Button
								type="submit"
								size="sm"
								className="h-7 gap-1 text-[11px]"
								disabled={!testForm.receiveId || !testForm.text || sendingTest}
							>
								{sendingTest ? <Loader2 className="size-3 animate-spin" /> : <Send className="size-3" />}
								{t("settings.sendTestMessage")}
							</Button>
						</form>
					)}
				</div>
			)}

			{recentMessage && (
				<div className="rounded-lg border border-hairline bg-background/45 p-4">
					<h4 className="mb-2 text-xs font-medium">{t("settings.recentMessage")}</h4>
					<div className="space-y-1 text-[11px]">
						<div className="flex gap-2">
							<span className="text-muted-foreground">chatId:</span>
							<span className="font-mono">{recentMessage.chatId}</span>
						</div>
						<div className="flex gap-2">
							<span className="text-muted-foreground">sender:</span>
							<span className="font-mono">{recentMessage.senderOpenId}</span>
						</div>
						<div className="mt-1 rounded bg-muted/45 p-2 font-mono text-[10px]">
							{JSON.stringify(recentMessage.content, null, 2)}
						</div>
					</div>
				</div>
			)}
		</div>
	);
}
