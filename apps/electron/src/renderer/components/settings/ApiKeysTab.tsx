// ============================================================
// ApiKeysTab — Provider API key management
// ============================================================

import { cn } from "@look/ui";
import { Badge } from "@look/ui/components/ui/badge";
import { Button } from "@look/ui/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@look/ui/components/ui/dialog";
import { Input } from "@look/ui/components/ui/input";
import type { TFunction } from "i18next";
import { AlertCircle, ChevronRight, Copy, Cpu, Eye, EyeOff, Key, Loader2, ShieldCheck, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { ProviderIcon } from "../ProviderIcon";
import AddCustomProviderDialog from "./AddCustomProviderDialog";
import CustomProvidersSection from "./CustomProvidersSection";
import type { CustomProviderInput, CustomProviderStats, ProviderInfo, ProviderModelInfo, TestVerdict } from "./types";

const api = window.look;

// 保存触发编辑按钮的引用，用于关闭编辑后恢复焦点
const editTriggerRef = { current: null as HTMLElement | null };

type ForceSaveState = { provider: string; key: string; reason: string; status: number } | null;

// ═══════════════════════════════════════════
// grouped state types
// ═══════════════════════════════════════════

interface KeyEditState {
	editing: string | null;
	input: string;
	showKey: boolean;
	/** 当前 input 是否为掩码值（主进程脱敏返回）；若用户未改动则不覆盖原 key。 */
	masked: boolean;
	/** 打开编辑器时回填的原始内容（用于判断用户是否改动）。 */
	originalInput: string;
	/** reveal 成功后拿到的明文；隐藏且未改动时用它判断是否可安全恢复掩码。 */
	revealedKey: string | null;
}

interface UiState {
	saving: boolean;
	loadingKey: boolean;
	revealing: boolean;
	testStatus: Record<string, TestVerdict>;
	forceSave: ForceSaveState;
}

interface AccordionState {
	providers: Record<string, boolean>;
	customProviders: Record<string, boolean>;
}

interface CustomPanelState {
	view: { type: "list" } | { type: "form"; editing?: CustomProviderInput };
	list: CustomProviderInput[];
	confirmRemove: string | null;
	confirmClear: ProviderInfo | null;
}

// ═══════════════════════════════════════════
// helpers
// ═══════════════════════════════════════════

function formatContextWindow(tokens: number): string {
	if (tokens >= 1_000_000) {
		return `${(tokens / 1_000_000).toFixed(tokens % 1_000_000 === 0 ? 0 : 1)}M`;
	}
	return `${Math.round(tokens / 1000)}K`;
}

function ProviderModelCount({ provider }: { provider: ProviderInfo }) {
	return (
		<Badge variant="outline" className="h-5 gap-1 px-1.5 font-mono text-[10px]">
			<Cpu className="size-2.5" />
			{provider.modelsAvailable}
		</Badge>
	);
}

/** 凭据来源徽标文案 key（authSource 枚举 → i18n key），未知来源返回 null 不显示。
 *  stored（存储在 Look）是默认情况，不显示徽标；只标注非默认来源（环境变量/本次会话/配置文件）。 */
function authSourceLabelKey(source: string | undefined): string | null {
	switch (source) {
		case "environment":
			return "settings.authSourceEnvironment";
		case "runtime":
			return "settings.authSourceRuntime";
		case "models_json_key":
		case "models_json_command":
			return "settings.authSourceConfig";
		case "auto":
			return "settings.authSourceAuto";
		default:
			return null;
	}
}

function ModelList({ models, t }: { models: ProviderModelInfo[]; t: (key: string) => string }) {
	return (
		<div className="border-t border-hairline bg-background/45 px-3 py-1.5">
			<div className="grid grid-cols-[minmax(0,1.2fr)_minmax(0,1.4fr)_auto_auto] gap-3 px-2 pb-1 text-[9px] font-medium text-muted-foreground">
				<span>{t("settings.modelTable.name")}</span>
				<span>{t("settings.modelTable.id")}</span>
				<span>{t("settings.modelTable.type")}</span>
				<span>{t("settings.modelTable.context")}</span>
			</div>
			{models.map((model) => (
				<div
					key={model.id}
					className="grid grid-cols-[minmax(0,1.2fr)_minmax(0,1.4fr)_auto_auto] items-center gap-3 rounded-md px-2 py-1.5 text-left hover:bg-muted/45"
				>
					<div className="min-w-0 truncate text-[12px] font-medium">{model.name}</div>
					<div className="min-w-0 truncate font-mono text-[10px] text-muted-foreground">{model.id}</div>
					<span className="shrink-0 whitespace-nowrap rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
						{model.reasoning ? t("agent.modelThink") : t("agent.modelBase")}
					</span>
					<span className="shrink-0 whitespace-nowrap font-mono text-[10px] text-muted-foreground">
						{formatContextWindow(model.contextWindow)}
					</span>
				</div>
			))}
		</div>
	);
}

interface ApiKeysTabProps {
	providers: ProviderInfo[];
	customProviders: CustomProviderInput[];
	customStats: CustomProviderStats;
	onProvidersChange: (data: {
		providers: ProviderInfo[];
		customProviders: CustomProviderInput[];
		customStats: CustomProviderStats;
	}) => void;
}

function canClearProviderKey(provider: ProviderInfo): boolean {
	return provider.hasKey && (!provider.authSource || provider.authSource === "stored");
}

function providerTrack(provider: ProviderInfo, status: TestVerdict): string {
	if (status?.verdict === "ok") {
		return "bg-emerald-500";
	}
	if (status?.verdict === "error") {
		return "bg-rose-500";
	}
	if (status?.verdict === "skipped") {
		return "bg-amber-500";
	}
	if (!provider.hasKey) {
		return "bg-muted-foreground/35";
	}
	return "bg-emerald-500";
}

// ═══════════════════════════════════════════
// sub-components
// ═══════════════════════════════════════════

function BuiltInProviderRow({
	provider,
	isEditing,
	isExpanded,
	testStatus,
	editor,
	saving,
	loadingKey,
	forceSave,
	onToggleExpand,
	onOpenEditor,
	onCloseEditor,
	onSave,
	onForceSave,
	onClearClick,
	onLoginClick,
	onLogoutClick,
}: {
	provider: ProviderInfo;
	isEditing: boolean;
	isExpanded: boolean;
	testStatus: Record<string, TestVerdict>;
	editor: {
		editing: string | null;
		input: string;
		showKey: boolean;
		masked: boolean;
		originalInput: string;
		revealing: boolean;
		setInput: (v: string) => void;
		onToggleReveal: () => void;
		onCopyKey: () => void;
	};
	saving: boolean;
	loadingKey: boolean;
	forceSave: ForceSaveState;
	onToggleExpand: () => void;
	onOpenEditor: () => void;
	onCloseEditor: () => void;
	onSave: () => void;
	onForceSave: () => void;
	onClearClick: () => void;
	onLoginClick: () => void;
	onLogoutClick: () => void;
}) {
	const { t } = useTranslation();
	const track = providerTrack(provider, testStatus[provider.id]);
	const hasModels = !!provider.models?.length;
	const clearable = canClearProviderKey(provider);
	const rowForceSave = forceSave?.provider === provider.id ? forceSave : null;

	return (
		<div
			className={cn(
				"relative overflow-hidden rounded-md border border-hairline bg-muted/30 transition-colors",
				isEditing && "bg-muted/45 ring-1 ring-primary/45",
			)}
		>
			<div className={cn("absolute left-0 top-0 h-full w-0.5", track)} aria-hidden="true" />
			<span className="sr-only">
				{testStatus[provider.id]?.verdict === "ok"
					? t("settings.statusVerified")
					: testStatus[provider.id]?.verdict === "error"
						? t("settings.statusFailed")
						: testStatus[provider.id]?.verdict === "skipped"
							? t("settings.statusUntested")
							: provider.hasKey
								? t("settings.statusConfigured")
								: t("settings.statusNeedsKey")}
			</span>
			<div
				role="button"
				tabIndex={hasModels ? 0 : -1}
				className="group grid cursor-pointer grid-cols-[minmax(0,1fr)_auto] items-center gap-3 px-3 py-2 pl-4 w-full text-left bg-transparent border-0"
				aria-expanded={isExpanded}
				aria-disabled={!hasModels}
				onClick={() => hasModels && onToggleExpand()}
				onKeyDown={(e) => {
					if (hasModels && (e.key === "Enter" || e.key === " ")) {
						e.preventDefault();
						onToggleExpand();
					}
				}}
			>
				<div className="min-w-0">
					<div className="flex min-w-0 flex-wrap items-center gap-1.5">
						<ChevronRight
							aria-hidden="true"
							className={cn(
								"size-3 shrink-0 text-muted-foreground transition-transform",
								isExpanded && "rotate-90",
								!hasModels && "opacity-30",
							)}
						/>
						<ProviderIcon id={provider.id} className="size-4 shrink-0" />
						<span className="min-w-0 truncate text-[12px] font-medium">{provider.name}</span>
						{provider.hasKey && authSourceLabelKey(provider.authSource) && (
							<Badge
								variant="outline"
								className="h-4 shrink-0 px-1 text-[9px] font-normal text-muted-foreground"
								title={provider.envLabel ? `${provider.envLabel}` : undefined}
							>
								{t(authSourceLabelKey(provider.authSource)!)}
							</Badge>
						)}
						<ProviderModelCount provider={provider} />
					</div>
				</div>
				<div
					className={cn(
						"flex shrink-0 items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100",
						isEditing && "opacity-100",
					)}
					onClick={(e) => e.stopPropagation()}
				>
					{provider.hasLogin && canClearProviderKey(provider) && (
						<Button
							variant="line"
							size="xs"
							className="h-7 text-[10px]"
							onClick={onLogoutClick}
							aria-label={t("settings.logout")}
						>
							{t("settings.logout")}
						</Button>
					)}
					{provider.hasLogin && !provider.hasKey && (
						<Button
							variant="line-filled"
							size="xs"
							className="h-7 text-[10px]"
							onClick={onLoginClick}
							aria-label={t("settings.login")}
						>
							{t("settings.login")}
						</Button>
					)}
					{provider.supportsApiKey && provider.authSource !== "environment" && (
						<Button
							variant={isEditing ? "line-filled" : "line"}
							size="xs"
							className="h-7 text-[10px]"
							onClick={() => (isEditing ? onCloseEditor() : onOpenEditor())}
							aria-label={
								isEditing ? t("common.cancel") : provider.hasKey ? t("settings.editKey") : t("settings.addKey")
							}
						>
							<Key data-icon="inline-start" className="size-3" aria-hidden="true" />
							{isEditing ? t("common.cancel") : provider.hasKey ? t("settings.editKey") : t("settings.addKey")}
						</Button>
					)}
					{clearable && provider.supportsApiKey && (
						<Button
							variant="line-ghost"
							size="icon-xs"
							className={cn(
								"h-7 w-7 text-muted-foreground hover:text-destructive",
								isEditing && "invisible pointer-events-none",
							)}
							onClick={onClearClick}
							aria-label={t("settings.clearKey")}
							aria-hidden={isEditing}
							disabled={isEditing}
						>
							<Trash2 className="size-3" aria-hidden="true" />
						</Button>
					)}
				</div>
			</div>

			{isEditing && (
				<div className="border-t border-hairline bg-background/35 px-3 py-3 pl-4">
					<div className="flex items-start gap-2">
						<div className="relative min-w-0 flex-1">
							<Input
								type={editor.showKey ? "text" : "password"}
								value={editor.input}
								onChange={(e) => {
									editor.setInput(e.target.value);
								}}
								onKeyDown={(e) => {
									if (e.key === "Enter") onSave();
									if (e.key === "Escape") onCloseEditor();
								}}
								placeholder={loadingKey ? t("common.loading") : "sk-..."}
								autoFocus
								autoComplete="new-password"
								disabled={loadingKey || editor.revealing}
								className="h-8 pr-16 font-mono text-[12px]"
							/>
							{/* 显示明文后出现复制按钮，方便一键复制完整 key */}
							{editor.showKey && !editor.masked && editor.input && (
								<Button
									variant="ghost"
									size="icon"
									className="absolute right-8 top-0 size-8"
									onClick={editor.onCopyKey}
									aria-label={t("settings.copyKey")}
									title={t("settings.copyKey")}
								>
									<Copy data-icon="inline-start" aria-hidden="true" className="size-3.5" />
								</Button>
							)}
							<Button
								variant="ghost"
								size="icon"
								className="absolute right-0 top-0 size-8"
								onClick={editor.onToggleReveal}
								disabled={editor.revealing}
								aria-label={editor.showKey ? t("settings.hideKey") : t("settings.showKey")}
								aria-pressed={editor.showKey}
							>
								{editor.revealing ? (
									<Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
								) : editor.showKey ? (
									<EyeOff data-icon="inline-start" aria-hidden="true" />
								) : (
									<Eye data-icon="inline-start" aria-hidden="true" />
								)}
							</Button>
						</div>
						<Button
							variant="line-filled"
							size="sm"
							className="h-8 text-[11px]"
							onClick={onSave}
							disabled={saving || loadingKey || !editor.input.trim()}
						>
							{saving ? (
								<>
									<Loader2 data-icon="inline-start" className="size-3 animate-spin" />
									{t("settings.testingKey")}
								</>
							) : (
								<>
									<ShieldCheck data-icon="inline-start" className="size-3" />
									{t("settings.testAndSaveKey")}
								</>
							)}
						</Button>
					</div>
					{provider.envVar && (
						<p className="mt-1.5 text-[10px] text-muted-foreground">
							{t("settings.envKeyHint")}{" "}
							<code className="rounded bg-muted px-1 font-mono text-[10px]">export {provider.envVar}=...</code>
						</p>
					)}
					{rowForceSave && (
						<div className="mt-2 rounded-md border border-rose-500/25 bg-rose-500/[0.04] p-2.5">
							<div className="flex items-center gap-1.5 text-[11px] font-medium text-rose-700 dark:text-rose-300">
								<AlertCircle className="size-3.5" />
								{t("settings.selfTestFailed")}
								{rowForceSave.status ? ` · HTTP ${rowForceSave.status}` : ""}
							</div>
							<p className="mt-1 font-mono text-[10px] text-rose-700/80 dark:text-rose-300/80">
								{rowForceSave.reason}
							</p>
							<div className="mt-2 flex items-center gap-2">
								<Button variant="line" size="xs" className="h-6 text-[10px]" onClick={onSave} disabled={saving}>
									{t("settings.retryTest")}
								</Button>
								<Button
									variant="line-filled"
									size="xs"
									className="h-6 text-[10px]"
									onClick={onForceSave}
									disabled={saving}
								>
									{t("settings.saveAnyway")}
								</Button>
							</div>
						</div>
					)}
				</div>
			)}

			{isExpanded && provider.models && provider.models.length > 0 && <ModelList models={provider.models} t={t} />}
		</div>
	);
}

// ═══════════════════════════════════════════
// main component
// ═══════════════════════════════════════════

export default function ApiKeysTab({ providers, customProviders, customStats, onProvidersChange }: ApiKeysTabProps) {
	const { t } = useTranslation();

	// ── grouped state (13 → 4 useState) ──
	const [keyEdit, setKeyEdit] = useState<KeyEditState>({
		editing: null,
		input: "",
		showKey: false,
		masked: false,
		originalInput: "",
		revealedKey: null,
	});
	const [ui, setUi] = useState<UiState>({
		saving: false,
		loadingKey: false,
		revealing: false,
		testStatus: {},
		forceSave: null,
	});
	const [accordion, setAccordion] = useState<AccordionState>({ providers: {}, customProviders: {} });
	// customProviders prop seeds the list from the startup-loaded settings, so the
	// section renders its rows on first paint instead of flashing the empty state
	// while listCustomProviders() is in flight. The effect below still re-fetches
	// to pick up any changes made after startup.
	const [custom, setCustom] = useState<CustomPanelState>({
		view: { type: "list" },
		list: customProviders,
		confirmRemove: null,
		confirmClear: null,
	});

	// ── patch helpers ──
	const patchKeyEdit = useCallback(
		<K extends keyof KeyEditState>(key: K, value: KeyEditState[K]) =>
			setKeyEdit((prev) => ({ ...prev, [key]: value })),
		[],
	);
	const patchUi = useCallback(
		<K extends keyof UiState>(key: K, value: UiState[K]) => setUi((prev) => ({ ...prev, [key]: value })),
		[],
	);
	const patchCustom = useCallback(
		<K extends keyof CustomPanelState>(key: K, value: CustomPanelState[K]) =>
			setCustom((prev) => ({ ...prev, [key]: value })),
		[],
	);

	// ── load custom providers ──
	const loadCustomProviders = useCallback(async () => {
		if (!api) return;
		try {
			const r = await api.listCustomProviders();
			if (r?.success) patchCustom("list", r.providers ?? []);
		} catch {
			/* ignore */
		}
	}, [patchCustom]);

	useEffect(() => {
		loadCustomProviders();
	}, [loadCustomProviders]);

	// ── accordion toggles ──
	const toggleProviderExpand = (id: string) => {
		setAccordion((prev) => ({ ...prev, providers: { ...prev.providers, [id]: !prev.providers[id] } }));
	};

	const toggleCustomProviderExpand = (name: string) => {
		setAccordion((prev) => ({
			...prev,
			customProviders: { ...prev.customProviders, [name]: !prev.customProviders[name] },
		}));
	};

	// ── key management ──
	const persistKey = async (providerId: string, key: string) => {
		if (!api) return false;
		try {
			const result = await api.setApiKey(providerId, key);
			if (result?.success) {
				onProvidersChange({
					providers: result.providers,
					customProviders: result.customProviders,
					customStats: result.customStats,
				});
				toast.success(
					key
						? t("settings.keyUpdated", { provider: providerId })
						: t("settings.keyRemoved", { provider: providerId }),
				);
				return true;
			}
			toast.error(result?.error ?? t("settings.selfTestFailed"));
		} catch (e) {
			toast.error(e instanceof Error ? e.message : t("settings.selfTestFailed"));
		}
		return false;
	};

	const closeEditor = () => {
		patchUi("saving", false);
		patchKeyEdit("editing", null);
		patchKeyEdit("input", "");
		patchKeyEdit("showKey", false);
		patchKeyEdit("masked", false);
		patchKeyEdit("originalInput", "");
		patchKeyEdit("revealedKey", null);
		patchUi("loadingKey", false);
		patchUi("revealing", false);
		patchUi("forceSave", null);
		// 恢复焦点到触发编辑的按钮
		editTriggerRef.current?.focus();
		editTriggerRef.current = null;
	};

	const openEditor = async (provider: ProviderInfo) => {
		editTriggerRef.current = document.activeElement as HTMLElement | null;
		patchKeyEdit("editing", provider.id);
		patchKeyEdit("showKey", false);
		patchKeyEdit("masked", false);
		patchKeyEdit("originalInput", "");
		patchKeyEdit("revealedKey", null);
		patchUi("forceSave", null);
		if (provider.hasKey && canClearProviderKey(provider) && api) {
			patchUi("loadingKey", true);
			patchKeyEdit("input", "");
			try {
				const r = await api.getApiKey(provider.id);
				if (r?.success && r.key) {
					// 防御竞态：只有当前仍在编辑同一 provider 时才写入
					const key = r.key;
					const masked = r.masked === true;
					setKeyEdit((prev) => {
						if (prev.editing !== provider.id) return prev;
						return { ...prev, input: key, masked, originalInput: key };
					});
				}
			} catch {
				/* 获取失败时输入框保持空白，用户可手动输入 */
			}
			patchUi("loadingKey", false);
		} else {
			// env-var / 非可清除 provider：同步清空，无竞态窗口
			patchKeyEdit("input", "");
			patchKeyEdit("masked", false);
			patchKeyEdit("originalInput", "");
		}
	};

	const handleToggleReveal = async () => {
		const providerId = keyEdit.editing;
		if (!providerId || !api) return;
		if (keyEdit.showKey) {
			// 隐藏：若当前是 reveal 出来的明文且用户未改动，恢复掩码显示，避免明文残留在屏幕上
			if (keyEdit.revealedKey && keyEdit.input.trim() === keyEdit.revealedKey.trim()) {
				setKeyEdit((prev) => ({
					...prev,
					showKey: false,
					input: prev.originalInput,
					masked: true,
					revealedKey: null,
				}));
			} else {
				patchKeyEdit("showKey", false);
			}
			return;
		}
		if (keyEdit.masked) {
			// 掩码 → 按需向主进程请求明文（仅用户显式点击显示时才会发生）
			patchUi("revealing", true);
			try {
				const r = await api.getApiKey(providerId, { reveal: true });
				const revealedKey = r?.success ? r.key : null;
				if (revealedKey) {
					setKeyEdit((prev) => {
						if (prev.editing !== providerId) return prev;
						return { ...prev, input: revealedKey, masked: false, showKey: true, revealedKey };
					});
				}
			} catch {
				/* 获取明文失败保持掩码，用户可重试 */
			}
			patchUi("revealing", false);
		} else {
			patchKeyEdit("showKey", true);
		}
	};

	const handleCopyKey = async () => {
		if (!keyEdit.input) return;
		try {
			await navigator.clipboard.writeText(keyEdit.input);
			toast.success(t("settings.keyCopied"));
		} catch {
			toast.error(t("settings.keyCopyFailed"));
		}
	};

	const handleSave = async () => {
		if (!keyEdit.editing || !api || !keyEdit.input.trim()) return;
		const providerId = keyEdit.editing;
		const key = keyEdit.input.trim();
		// 掩码回填且用户未改动：保持原 key，不做任何写入，直接关闭。
		// （掩码不是真实 key，走测试/保存流程必然失败。）
		if (keyEdit.masked && keyEdit.originalInput && key === keyEdit.originalInput.trim()) {
			closeEditor();
			return;
		}
		patchUi("saving", true);
		patchUi("forceSave", null);
		let testResult: { ok?: boolean; skipped?: boolean; status?: number; error?: string; reason?: string } | null =
			null;
		try {
			const r = await api.testApiKey(providerId, key);
			if (r?.success) testResult = r.result;
		} catch {
			/* swallow */
		}
		if (!testResult || (testResult.ok === undefined && !testResult.skipped)) {
			testResult = { skipped: true, reason: "Self-test unavailable" };
		}
		if (testResult.ok === true) {
			if (await persistKey(providerId, key)) {
				setUi((prev) => ({
					...prev,
					testStatus: { ...prev.testStatus, [providerId]: { verdict: "ok" } },
				}));
				closeEditor();
			}
			return;
		}
		if (testResult.skipped) {
			if (await persistKey(providerId, key)) {
				setUi((prev) => ({
					...prev,
					testStatus: { ...prev.testStatus, [providerId]: { verdict: "skipped", reason: testResult.reason } },
				}));
				closeEditor();
			}
			return;
		}
		patchUi("saving", false);
		patchUi("forceSave", {
			provider: providerId,
			key,
			reason: testResult.error ?? "Unknown error",
			status: testResult.status ?? 0,
		});
	};

	const handleForceSave = async () => {
		if (!ui.forceSave) return;
		const { provider, key, reason } = ui.forceSave;
		patchUi("saving", true);
		if (await persistKey(provider, key)) {
			setUi((prev) => ({ ...prev, testStatus: { ...prev.testStatus, [provider]: { verdict: "error", reason } } }));
			toast.warning(t("settings.failedSelfTest", { provider, reason }));
			closeEditor();
		}
	};

	const handleClearKey = async () => {
		if (!custom.confirmClear) return;
		const providerId = custom.confirmClear.id;
		if (await persistKey(providerId, "")) {
			setUi((prev) => ({ ...prev, testStatus: { ...prev.testStatus, [providerId]: null } }));
			if (keyEdit.editing === providerId) closeEditor();
		}
		patchCustom("confirmClear", null);
	};

	const handleRemoveCustom = async () => {
		if (!custom.confirmRemove || !api) return;
		try {
			const r = await api.removeCustomProvider(custom.confirmRemove);
			if (r?.success && r.removed) {
				toast.success(t("settings.customProviders.toast.removed"));
				loadCustomProviders();
				try {
					const providersRes = await api.getSettings();
					if (providersRes?.success)
						onProvidersChange({
							providers: providersRes.providers,
							customProviders: providersRes.customProviders,
							customStats: providersRes.customStats,
						});
				} catch {}
			}
		} catch (e) {
			toast.error(e instanceof Error ? e.message : t("settings.customProviders.toast.removeFailed"));
		}
		patchCustom("confirmRemove", null);
	};

	// ── OAuth login / logout ──
	const handleLogin = async (provider: ProviderInfo) => {
		if (!api) return;
		try {
			const result = await api.providerLogin(provider.id);
			if (result?.success) {
				toast.success(t("settings.loginSuccess", { provider: provider.name }));
				onProvidersChange({
					providers: result.providers,
					customProviders: result.customProviders,
					customStats: result.customStats,
				});
			} else {
				toast.error(result?.error ?? t("settings.loginFailed"));
			}
		} catch (e) {
			toast.error(e instanceof Error ? e.message : String(e));
		}
	};

	const handleLogout = async (provider: ProviderInfo) => {
		if (!api) return;
		try {
			const result = await api.providerLogout(provider.id);
			if (result?.success) {
				toast.success(t("settings.logoutSuccess", { provider: provider.name }));
				onProvidersChange({
					providers: result.providers,
					customProviders: result.customProviders,
					customStats: result.customStats,
				});
			} else {
				toast.error(result?.error ?? t("settings.logoutFailed"));
			}
		} catch (e) {
			toast.error(e instanceof Error ? e.message : String(e));
		}
	};

	// ── render ──
	const allProviders = [...providers].sort((a, b) => (b.hasKey ? 1 : 0) - (a.hasKey ? 1 : 0));

	if (custom.view.type === "form") {
		return (
			<AddCustomProviderDialog
				key={custom.view.editing ? `edit-${custom.view.editing.name}` : "add"}
				open={true}
				onClose={() => patchCustom("view", { type: "list" })}
				initial={custom.view.editing}
				onSaved={() => {
					loadCustomProviders();
					patchCustom("view", { type: "list" });
					api?.getSettings?.()
						.then((r) => {
							if (r?.success)
								onProvidersChange({
									providers: r.providers,
									customProviders: r.customProviders,
									customStats: r.customStats,
								});
						})
						.catch((err) => console.warn("[ApiKeysTab] refresh settings failed:", err));
				}}
				mode="inline"
				onBack={() => patchCustom("view", { type: "list" })}
			/>
		);
	}

	if (providers.length === 0) {
		return (
			<div className="flex h-full min-h-0 flex-col overflow-y-auto p-4">
				<div className="mb-3">
					<h2 className="text-[13px] font-medium">{t("settings.apiKeys")}</h2>
					<p className="text-[11px] text-muted-foreground">{t("settings.apiKeysDescription")}</p>
				</div>
				<div className="flex items-center justify-center py-12 text-[12px] text-muted-foreground">
					{t("common.loading")}
				</div>
			</div>
		);
	}

	return (
		<>
			<div className="flex h-full min-h-0 flex-col overflow-y-auto p-0">
				<div className="px-3 pt-3 pb-2">
					<h2 className="text-[13px] font-medium">{t("settings.apiKeys")}</h2>
					<p className="text-[11px] text-muted-foreground">{t("settings.apiKeysDescription")}</p>
				</div>
				<div className="flex flex-col gap-2 p-3 pt-0">
					<CustomProvidersSection
						customProviders={custom.list}
						expanded={accordion.customProviders}
						customStats={customStats}
						onToggleExpand={toggleCustomProviderExpand}
						onEdit={(cp) => patchCustom("view", { type: "form", editing: cp })}
						onRemove={(name) => patchCustom("confirmRemove", name)}
						onAdd={() => patchCustom("view", { type: "form" })}
					/>

					<div className="flex items-center justify-between border-b border-hairline px-1 pb-1">
						<span className="text-[11px] font-medium text-muted-foreground">{t("settings.providers.title")}</span>
						<span className="text-[10px] text-muted-foreground">
							{t("settings.providers.summary", {
								configured: allProviders.filter((p) => p.hasKey).length,
								total: allProviders.length,
							})}
						</span>
					</div>

					<BuiltInProviderList
						providers={allProviders}
						accordionProviders={accordion.providers}
						keyEdit={keyEdit}
						ui={ui}
						patchKeyEdit={patchKeyEdit}
						toggleProviderExpand={toggleProviderExpand}
						openEditor={openEditor}
						closeEditor={closeEditor}
						handleSave={handleSave}
						handleForceSave={handleForceSave}
						handleToggleReveal={handleToggleReveal}
						handleCopyKey={handleCopyKey}
						onClearClick={(p) => patchCustom("confirmClear", p)}
						onLoginClick={handleLogin}
						onLogoutClick={handleLogout}
					/>
				</div>
			</div>

			<ApiKeysTabDialogs
				confirmClear={custom.confirmClear}
				confirmRemove={custom.confirmRemove}
				onCloseClear={() => patchCustom("confirmClear", null)}
				onConfirmClear={handleClearKey}
				onCloseRemove={() => patchCustom("confirmRemove", null)}
				onConfirmRemove={handleRemoveCustom}
				t={t}
			/>
		</>
	);
}

interface BuiltInProviderListProps {
	providers: ProviderInfo[];
	accordionProviders: Record<string, boolean>;
	keyEdit: KeyEditState;
	ui: UiState;
	patchKeyEdit: <K extends keyof KeyEditState>(key: K, value: KeyEditState[K]) => void;
	toggleProviderExpand: (id: string) => void;
	openEditor: (provider: ProviderInfo) => void;
	closeEditor: () => void;
	handleSave: () => void;
	handleForceSave: () => void;
	handleToggleReveal: () => void;
	handleCopyKey: () => void;
	onClearClick: (provider: ProviderInfo) => void;
	onLoginClick: (provider: ProviderInfo) => void;
	onLogoutClick: (provider: ProviderInfo) => void;
}

function BuiltInProviderList({
	providers,
	accordionProviders,
	keyEdit,
	ui,
	patchKeyEdit,
	toggleProviderExpand,
	openEditor,
	closeEditor,
	handleSave,
	handleForceSave,
	handleToggleReveal,
	handleCopyKey,
	onClearClick,
	onLoginClick,
	onLogoutClick,
}: BuiltInProviderListProps) {
	return (
		<>
			{providers.map((p) => {
				const isEditing = keyEdit.editing === p.id;
				const isExpanded = !!accordionProviders[p.id];
				return (
					<BuiltInProviderRow
						key={p.id}
						provider={p}
						isEditing={isEditing}
						isExpanded={isExpanded}
						testStatus={ui.testStatus}
						editor={{
							editing: keyEdit.editing,
							input: keyEdit.input,
							showKey: keyEdit.showKey,
							masked: keyEdit.masked,
							originalInput: keyEdit.originalInput,
							revealing: ui.revealing,
							setInput: (v) => patchKeyEdit("input", v),
							onToggleReveal: () => void handleToggleReveal(),
							onCopyKey: handleCopyKey,
						}}
						saving={ui.saving}
						loadingKey={ui.loadingKey}
						forceSave={ui.forceSave}
						onToggleExpand={() => toggleProviderExpand(p.id)}
						onOpenEditor={() => openEditor(p)}
						onCloseEditor={closeEditor}
						onSave={handleSave}
						onForceSave={handleForceSave}
						onClearClick={() => onClearClick(p)}
						onLoginClick={() => onLoginClick(p)}
						onLogoutClick={() => onLogoutClick(p)}
					/>
				);
			})}
		</>
	);
}

interface ApiKeysTabDialogsProps {
	confirmClear: ProviderInfo | null;
	confirmRemove: string | null;
	onCloseClear: () => void;
	onConfirmClear: () => void;
	onCloseRemove: () => void;
	onConfirmRemove: () => void;
	t: TFunction;
}

function ApiKeysTabDialogs({
	confirmClear,
	confirmRemove,
	onCloseClear,
	onConfirmClear,
	onCloseRemove,
	onConfirmRemove,
	t,
}: ApiKeysTabDialogsProps) {
	return (
		<>
			<Dialog open={confirmClear !== null} onOpenChange={(o) => !o && onCloseClear()}>
				<DialogContent className="sm:max-w-sm" showCloseButton={false}>
					<DialogHeader>
						<DialogTitle>{t("settings.confirmClear.title")}</DialogTitle>
						<DialogDescription>
							{t("settings.confirmClear.body", { provider: confirmClear?.name ?? "" })}
						</DialogDescription>
					</DialogHeader>
					<DialogFooter className="gap-2">
						<Button variant="line" size="sm" onClick={onCloseClear}>
							{t("common.cancel")}
						</Button>
						<Button variant="line-filled" size="sm" onClick={onConfirmClear}>
							{t("settings.clearKey")}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>

			<Dialog open={confirmRemove !== null} onOpenChange={(o) => !o && onCloseRemove()}>
				<DialogContent className="sm:max-w-sm" showCloseButton={false}>
					<DialogHeader>
						<DialogTitle>{t("settings.customProviders.confirmRemove.title")}</DialogTitle>
						<DialogDescription>
							{t("settings.customProviders.confirmRemove.body", { name: confirmRemove ?? "" })}
						</DialogDescription>
					</DialogHeader>
					<DialogFooter className="gap-2">
						<Button variant="line" size="sm" onClick={onCloseRemove}>
							{t("common.cancel")}
						</Button>
						<Button variant="line-filled" size="sm" onClick={onConfirmRemove}>
							{t("common.delete")}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</>
	);
}
