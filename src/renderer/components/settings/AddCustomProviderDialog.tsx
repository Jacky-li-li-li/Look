// ============================================================
// AddCustomProviderDialog — form for adding/editing custom providers
// ============================================================

import { Button } from "@shared/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@shared/components/ui/dialog";
import { Input } from "@shared/components/ui/input";
import { Label } from "@shared/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@shared/components/ui/select";
import { Switch } from "@shared/components/ui/switch";
import { cn } from "@shared/lib/utils";
import {
	AlertCircle,
	ArrowLeft,
	CheckCircle2,
	ChevronRight,
	Eye,
	EyeOff,
	Info,
	Loader2,
	Plus,
	Trash2,
	XCircle,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import type { CustomProviderInput, CustomProviderModelInput, TestCustomProviderResult } from "./types";

const api = (window as any).look;

type ApiProtocol = CustomProviderInput["api"];

const API_PROTOCOL_LABELS: Record<ApiProtocol, string> = {
	"openai-completions": "OpenAI Chat Completions",
	"anthropic-messages": "Anthropic Messages",
	"google-generative-ai": "Google Generative AI",
	"openai-responses": "OpenAI Responses",
};

const API_PROTOCOLS: readonly ApiProtocol[] = [
	"openai-completions",
	"anthropic-messages",
	"google-generative-ai",
	"openai-responses",
];

function normalizeApiProtocol(value: unknown, fallback: ApiProtocol = "openai-completions"): ApiProtocol {
	return typeof value === "string" && (API_PROTOCOLS as readonly string[]).includes(value)
		? (value as ApiProtocol)
		: fallback;
}

interface Props {
	open: boolean;
	onClose: () => void;
	/** Editing mode: pre-fill form with existing provider */
	initial?: CustomProviderInput;
	/** Called after successful add/update to refresh provider list */
	onSaved: () => void;
	/** Render mode: dialog popup (default) or inline page */
	mode?: "dialog" | "inline";
	/** Back button handler (inline mode only) */
	onBack?: () => void;
}

// ── Section header helper ──

function SectionLabel({ children, className }: { children: React.ReactNode; className?: string }) {
	return (
		<div className={cn("mb-2 flex items-center gap-2", className)}>
			<div className="h-3 w-0.5 rounded-full bg-border" />
			<span className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider">{children}</span>
		</div>
	);
}

export default function AddCustomProviderDialog({ open, onClose, initial, onSaved, mode = "dialog", onBack }: Props) {
	const { t } = useTranslation();
	const isEdit = !!initial;
	const isInline = mode === "inline";

	// ── Form state ──
	const [name, setName] = useState(() => initial?.name ?? "");
	const [baseUrl, setBaseUrl] = useState(() => initial?.baseUrl ?? "");
	const [apiProtocol, setApiProtocol] = useState<ApiProtocol>(() => normalizeApiProtocol(initial?.api));
	const [apiKeyVal, setApiKeyVal] = useState(() => initial?.apiKey ?? "");
	const [showKey, setShowKey] = useState(false);
	const [headers, setHeaders] = useState<Array<{ id: number; key: string; value: string }>>(() =>
		initial?.headers ? Object.entries(initial.headers).map(([k, v], i) => ({ id: i + 1, key: k, value: v })) : [],
	);
	const [models, setModels] = useState<Array<CustomProviderModelInput & { _key: number }>>(
		() => initial?.models.map((m, i) => ({ ...m, _key: i + 1 })) ?? [],
	);
	const [compatSection, setCompatSection] = useState(false);
	const [headersOpen, setHeadersOpen] = useState(false);
	// Compat toggles
	const [supportsDeveloperRole, setSupportsDeveloperRole] = useState(
		() => initial?.compat?.supportsDeveloperRole !== false,
	);
	const [supportsReasoningEffort, setSupportsReasoningEffort] = useState(
		() => initial?.compat?.supportsReasoningEffort !== false,
	);
	const [forceAdaptiveThinking, setForceAdaptiveThinking] = useState(() => !!initial?.compat?.forceAdaptiveThinking);
	const [supportsEagerToolInputStreaming, setSupportsEagerToolInputStreaming] = useState(
		() => initial?.compat?.supportsEagerToolInputStreaming !== false,
	);
	const [allowEmptySignature, setAllowEmptySignature] = useState(() => !!initial?.compat?.allowEmptySignature);

	// ── Submission state ──
	const [saving, setSaving] = useState(false);
	const [testResult, setTestResult] = useState<TestCustomProviderResult | null>(null);

	// ── Init / reset on open ──
	useEffect(() => {
		if (!open) return;
		setSaving(false);
		setTestResult(null);
		setCompatSection(false);
		setHeadersOpen(false);
	}, [open]);

	// ── Model helpers ──
	let _modelKeyCounter = 0;
	const newModelKey = () => ++_modelKeyCounter + Date.now();
	const addModel = () => {
		setModels((prev) => [
			...prev,
			{
				_key: newModelKey(),
				id: "",
				name: "",
				reasoning: false,
				input: ["text"],
				contextWindow: 128000,
				maxTokens: 16384,
			},
		]);
	};
	const updateModel = (key: number, patch: Partial<CustomProviderModelInput>) => {
		setModels((prev) => prev.map((m) => (m._key === key ? { ...m, ...patch } : m)));
	};
	const removeModel = (key: number) => {
		setModels((prev) => prev.filter((m) => m._key !== key));
	};

	// ── Header helpers ──
	const addHeader = () => setHeaders((prev) => [...prev, { id: newModelKey(), key: "", value: "" }]);
	const updateHeader = (id: number, field: "key" | "value", val: string) => {
		setHeaders((prev) => prev.map((h) => (h.id === id ? { ...h, [field]: val } : h)));
	};
	const removeHeader = (id: number) => setHeaders((prev) => prev.filter((h) => h.id !== id));

	// ── Build input ──
	const buildInput = useCallback((): CustomProviderInput => {
		const compat: Record<string, unknown> = {};
		if (apiProtocol === "anthropic-messages") {
			if (forceAdaptiveThinking) compat.forceAdaptiveThinking = true;
			if (!supportsEagerToolInputStreaming) compat.supportsEagerToolInputStreaming = false;
			if (allowEmptySignature) compat.allowEmptySignature = true;
		}
		if (apiProtocol === "openai-completions") {
			if (!supportsDeveloperRole) compat.supportsDeveloperRole = false;
			if (!supportsReasoningEffort) compat.supportsReasoningEffort = false;
		}
		const headerObj: Record<string, string> | undefined =
			headers.length > 0
				? Object.fromEntries(headers.filter((h) => h.key.trim()).map((h) => [h.key.trim(), h.value]))
				: undefined;
		return {
			name,
			baseUrl,
			api: apiProtocol,
			apiKey: apiKeyVal.trim() || undefined,
			headers: headerObj,
			authHeader: !!apiKeyVal,
			models: models.map(({ _key, ...m }) => ({
				id: m.id.trim(),
				name: m.name || undefined,
				reasoning: m.reasoning ?? false,
				input: m.input ?? ["text"],
				contextWindow: m.contextWindow ?? 128000,
				maxTokens: m.maxTokens ?? 16384,
			})),
			compat: Object.keys(compat).length > 0 ? compat : undefined,
		};
	}, [
		name,
		baseUrl,
		apiProtocol,
		apiKeyVal,
		headers,
		models,
		forceAdaptiveThinking,
		supportsEagerToolInputStreaming,
		allowEmptySignature,
		supportsDeveloperRole,
		supportsReasoningEffort,
	]);

	// ── Validate ──
	const validationErrors: string[] = [];
	if (!/^[a-z0-9][a-z0-9-]{0,40}$/.test(name))
		validationErrors.push(t("settings.customProviders.dialog.validation.nameFormat"));
	if (!/^https?:\/\//.test(baseUrl))
		validationErrors.push(t("settings.customProviders.dialog.validation.baseUrlFormat"));
	if (!apiKeyVal.trim()) validationErrors.push(t("settings.customProviders.dialog.validation.apiKeyRequired"));
	if (models.length === 0) validationErrors.push(t("settings.customProviders.dialog.validation.modelsRequired"));
	const modelIds = new Set<string>();
	for (const m of models) {
		if (!m.id.trim()) validationErrors.push(t("settings.customProviders.dialog.validation.modelIdEmpty"));
		else if (modelIds.has(m.id.trim()))
			validationErrors.push(t("settings.customProviders.dialog.validation.modelIdDuplicate", { id: m.id }));
		else modelIds.add(m.id.trim());
	}

	// ── Submit ──
	const handleSubmit = async () => {
		if (validationErrors.length > 0 || !api) return;
		setSaving(true);
		setTestResult(null);
		const input = buildInput();

		// Step 1: self-test all models (方案B)
		let test: TestCustomProviderResult;
		try {
			const r = await api.testCustomProvider(input);
			if (!r?.success) throw new Error(r?.error ?? t("settings.customProviders.toast.selfTestFailed"));
			test = r.result;
		} catch (e: any) {
			toast.error(e?.message ?? t("settings.customProviders.toast.selfTestUnavailable"));
			setSaving(false);
			return;
		}
		setTestResult(test);

		if (test.overall === "ok") {
			// Step 2: persist
			try {
				let persistResult: { success?: boolean; error?: string } | undefined;
				if (isEdit) {
					persistResult = await api.updateCustomProvider(initial!.name, input);
				} else {
					persistResult = await api.addCustomProvider(input);
				}
				if (persistResult?.success) {
					toast.success(t(`settings.customProviders.toast.${isEdit ? "updated" : "added"}`));
					onSaved();
					onClose();
				} else {
					toast.error(persistResult?.error ?? t("settings.customProviders.toast.saveFailed"));
				}
			} catch (e: any) {
				toast.error(e?.message ?? t("settings.customProviders.toast.saveFailed"));
			}
		}
		setSaving(false);
	};

	const handleClose = () => {
		if (saving) return;
		setTestResult(null);
		onClose();
	};

	// ═══════════════════════════════════════
	// RENDER
	// ═══════════════════════════════════════

	if (isInline && !open) return null;

	// ── Header block (shared) ──
	const headerBlock = (
		<>
			{isInline && (
				<button
					type="button"
					onClick={onBack}
					className="mb-3 flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground transition-colors"
				>
					<ArrowLeft className="size-3" />
					{t("settings.customProviders.dialog.backToApiKeys")}
				</button>
			)}
			<div className="shrink-0">
				<div className="mb-1 text-[15px] font-semibold">
					{t(isEdit ? "settings.customProviders.dialog.titleEdit" : "settings.customProviders.dialog.titleAdd")}
				</div>
				<p className="text-[12px] text-muted-foreground">
					{isEdit
						? t("settings.customProviders.dialog.titleEdit")
						: t("settings.customProviders.dialog.description")}
				</p>
			</div>
		</>
	);

	// ── Inline mode ──
	if (isInline) {
		return (
			<div className="flex h-full flex-col overflow-y-auto p-4">
				{headerBlock}

				<form className="flex-1 space-y-5" onSubmit={(e) => e.preventDefault()}>
					{/* ══ Connection ══ */}
					<section>
						<SectionLabel>{t("settings.customProviders.dialog.connection")}</SectionLabel>
						<div className="grid grid-cols-2 gap-3">
							<div className="space-y-1">
								<Label className="text-[11px] text-muted-foreground">
									{t("settings.customProviders.dialog.field.api")}
								</Label>
								<Select value={apiProtocol} onValueChange={(v) => setApiProtocol(v as ApiProtocol)}>
									<SelectTrigger className="h-8 text-[12px]">
										<SelectValue placeholder={t("settings.customProviders.dialog.placeholder.api")}>
											{`[${apiProtocol}] ${API_PROTOCOL_LABELS[apiProtocol] ?? ""}`}
										</SelectValue>
									</SelectTrigger>
									<SelectContent>
										<SelectItem value="openai-completions">OpenAI Chat Completions</SelectItem>
										<SelectItem value="anthropic-messages">Anthropic Messages</SelectItem>
										<SelectItem value="google-generative-ai">Google Generative AI</SelectItem>
										<SelectItem value="openai-responses">OpenAI Responses</SelectItem>
									</SelectContent>
								</Select>
							</div>
							<div className="space-y-1">
								<Label className="text-[11px] text-muted-foreground">
									{t("settings.customProviders.dialog.field.name")} <span className="text-rose-500">*</span>
								</Label>
								<Input
									value={name}
									onChange={(e) => setName(e.target.value)}
									placeholder={t("settings.customProviders.dialog.placeholder.name")}
									disabled={isEdit}
									className="h-8 text-[12px] font-mono"
								/>
								<p className="text-[10px] text-muted-foreground/60 leading-tight">
									{t("settings.customProviders.dialog.field.nameHint")}
								</p>
							</div>
						</div>

						<div className="mt-3 grid grid-cols-2 gap-3">
							<div className="space-y-1">
								<Label className="text-[11px] text-muted-foreground">
									{t("settings.customProviders.dialog.field.baseUrl")} <span className="text-rose-500">*</span>
								</Label>
								<Input
									value={baseUrl}
									onChange={(e) => setBaseUrl(e.target.value)}
									placeholder={t("settings.customProviders.dialog.placeholder.baseUrl")}
									className="h-8 text-[12px] font-mono"
								/>
							</div>
							<div className="space-y-1">
								<Label className="text-[11px] text-muted-foreground">
									{t("settings.customProviders.dialog.field.apiKey")}
								</Label>
								<div className="relative">
									<Input
										type={showKey ? "text" : "password"}
										autoComplete="new-password"
										value={apiKeyVal}
										onChange={(e) => setApiKeyVal(e.target.value)}
										placeholder={t("settings.customProviders.dialog.placeholder.apiKey")}
										className="h-8 pr-9 text-[12px] font-mono"
									/>
									<Button
										variant="ghost"
										size="icon"
										className="absolute right-0 top-0 size-8"
										onClick={() => setShowKey(!showKey)}
										tabIndex={-1}
									>
										{showKey ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
									</Button>
								</div>
								<p className="text-[10px] text-muted-foreground/60 leading-tight">
									{t("settings.customProviders.dialog.field.apiKeyHint")}
								</p>
							</div>
						</div>
					</section>

					{/* ══ Custom Headers (collapsible) ══ */}
					<section>
						<button
							type="button"
							className="group mb-2 flex w-full items-center gap-1.5 text-[11px] font-medium text-muted-foreground hover:text-foreground"
							onClick={() => setHeadersOpen(!headersOpen)}
						>
							<ChevronRight className={cn("size-3 transition-transform", headersOpen && "rotate-90")} />
							<div className="h-3 w-0.5 rounded-full bg-border group-hover:bg-foreground/20 transition-colors" />
							<span className="uppercase tracking-wider">
								{t("settings.customProviders.dialog.field.headers")}
							</span>
							{headers.length > 0 && (
								<span className="rounded-full bg-muted px-1.5 text-[10px]">{headers.length}</span>
							)}
						</button>
						{headersOpen && (
							<div className="space-y-1.5 pl-5">
								{headers.map((h) => (
									<div key={h.id} className="flex items-center gap-1.5">
										<Input
											value={h.key}
											onChange={(e) => updateHeader(h.id, "key", e.target.value)}
											placeholder={t("settings.customProviders.dialog.placeholder.headerKey")}
											className="h-7 flex-1 text-[11px] font-mono"
										/>
										<Input
											value={h.value}
											onChange={(e) => updateHeader(h.id, "value", e.target.value)}
											placeholder={t("settings.customProviders.dialog.placeholder.headerValue")}
											className="h-7 flex-1 text-[11px] font-mono"
										/>
										<Button
											variant="line-ghost"
											size="icon-xs"
											className="h-7 w-7 shrink-0 text-muted-foreground hover:text-destructive"
											onClick={() => removeHeader(h.id)}
										>
											<Trash2 className="size-3" />
										</Button>
									</div>
								))}
								{headers.length === 0 && (
									<p className="py-1 text-[10px] text-muted-foreground/60">
										{t("settings.customProviders.dialog.noCustomHeaders")}
									</p>
								)}
								<Button variant="line" size="xs" onClick={addHeader} className="text-[10px]">
									<Plus className="size-3" /> {t("settings.customProviders.dialog.addHeader")}
								</Button>
							</div>
						)}
					</section>

					{/* ══ Models ══ */}
					<section>
						<div className="mb-2 flex items-center justify-between">
							<div className="flex items-center gap-2">
								<div className="h-3 w-0.5 rounded-full bg-border" />
								<span className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider">
									{t("settings.customProviders.dialog.field.models")}
								</span>
								<span className="rounded-full bg-muted px-1.5 text-[10px] font-medium text-muted-foreground">
									{models.length}
								</span>
							</div>
							<Button variant="line" size="xs" onClick={addModel} className="h-6 text-[10px]">
								<Plus className="size-3" /> {t("settings.customProviders.dialog.addModel")}
							</Button>
						</div>

						{models.length === 0 ? (
							<div className="rounded-lg border border-dashed border-hairline py-6 text-center">
								<p className="text-[11px] text-muted-foreground/60">
									{t("settings.customProviders.dialog.noModels")}
								</p>
								<Button variant="line" size="xs" onClick={addModel} className="mt-2 text-[10px]">
									<Plus className="size-3" /> {t("settings.customProviders.dialog.addFirstModel")}
								</Button>
							</div>
						) : (
							<div className="space-y-1">
								{models.map((m) => (
									<div
										key={m._key}
										className="group flex items-center gap-2 rounded-md border border-transparent bg-muted/30 px-2.5 py-1.5 transition-colors hover:border-hairline hover:bg-muted/50"
									>
										{/* Model ID */}
										<Input
											value={m.id}
											onChange={(e) => updateModel(m._key, { id: e.target.value })}
											placeholder={t("settings.customProviders.dialog.placeholder.modelId")}
											className="h-7 min-w-0 flex-[2] text-[12px] font-mono"
										/>
										{/* Display name */}
										<Input
											value={m.name ?? ""}
											onChange={(e) => updateModel(m._key, { name: e.target.value || undefined })}
											placeholder={t("settings.customProviders.dialog.placeholder.modelName")}
											className="h-7 min-w-0 flex-[1.5] text-[12px]"
										/>
										{/* Reasoning toggle */}
										<div className="flex shrink-0 items-center gap-1.5">
											<span className="text-[10px] text-muted-foreground/60 select-none">
												{t("settings.customProviders.dialog.think")}
											</span>
											<Switch
												checked={m.reasoning ?? false}
												onCheckedChange={(v) => updateModel(m._key, { reasoning: v })}
												className="scale-75"
											/>
										</div>
										{/* Delete */}
										<Button
											variant="line-ghost"
											size="icon-xs"
											className="h-7 w-7 shrink-0 opacity-0 transition-opacity group-hover:opacity-100 text-muted-foreground hover:text-destructive"
											onClick={() => removeModel(m._key)}
										>
											<Trash2 className="size-3" />
										</Button>
									</div>
								))}
							</div>
						)}
					</section>

					{/* ══ Advanced Compatibility ══ */}
					<section>
						<button
							type="button"
							className="group mb-2 flex w-full items-center gap-1.5 text-[11px] font-medium text-muted-foreground hover:text-foreground"
							onClick={() => setCompatSection(!compatSection)}
						>
							<ChevronRight className={cn("size-3 transition-transform", compatSection && "rotate-90")} />
							<div className="h-3 w-0.5 rounded-full bg-border group-hover:bg-foreground/20 transition-colors" />
							<span className="uppercase tracking-wider">
								{t("settings.customProviders.dialog.field.compat")}
							</span>
						</button>

						{compatSection && (
							<div className="space-y-1.5 rounded-lg border border-hairline bg-muted/20 p-3 pl-5">
								{apiProtocol === "anthropic-messages" && (
									<>
										<CompatToggle
											checked={forceAdaptiveThinking}
											onChange={setForceAdaptiveThinking}
											label={t("settings.customProviders.compat.anthropic.forceAdaptiveThinking")}
											tip={t("settings.customProviders.compat.anthropic.forceAdaptiveThinkingTip")}
										/>
										<CompatToggle
											checked={supportsEagerToolInputStreaming}
											onChange={setSupportsEagerToolInputStreaming}
											label={t("settings.customProviders.compat.anthropic.supportsEagerToolInputStreaming")}
											tip={t("settings.customProviders.compat.anthropic.supportsEagerToolInputStreamingTip")}
										/>
										<CompatToggle
											checked={allowEmptySignature}
											onChange={setAllowEmptySignature}
											label={t("settings.customProviders.compat.anthropic.allowEmptySignature")}
											tip={t("settings.customProviders.compat.anthropic.allowEmptySignatureTip")}
										/>
									</>
								)}
								{apiProtocol === "openai-completions" && (
									<>
										<CompatToggle
											checked={supportsDeveloperRole}
											onChange={setSupportsDeveloperRole}
											label={t("settings.customProviders.compat.openai.supportsDeveloperRole")}
											tip={t("settings.customProviders.compat.openai.supportsDeveloperRoleTip")}
										/>
										<CompatToggle
											checked={supportsReasoningEffort}
											onChange={setSupportsReasoningEffort}
											label={t("settings.customProviders.compat.openai.supportsReasoningEffort")}
											tip={t("settings.customProviders.compat.openai.supportsReasoningEffortTip")}
										/>
									</>
								)}
								{apiProtocol === "openai-responses" && (
									<CompatToggle
										checked={supportsDeveloperRole}
										onChange={setSupportsDeveloperRole}
										label={t("settings.customProviders.compat.openai.supportsDeveloperRole")}
										tip={t("settings.customProviders.compat.openai.supportsDeveloperRoleTip")}
									/>
								)}
								{apiProtocol === "google-generative-ai" && (
									<p className="py-1 text-[10px] text-muted-foreground/60">
										{t("settings.customProviders.dialog.noCompatOptions")}
									</p>
								)}
							</div>
						)}
					</section>

					{/* ══ Validation errors ══ */}
					{validationErrors.length > 0 && (
						<div className="rounded-lg border border-rose-500/20 bg-rose-500/[0.04] p-3 space-y-1">
							{validationErrors.map((e, i) => (
								<p key={i} className="flex items-center gap-1.5 text-[11px] text-rose-600 dark:text-rose-400">
									<AlertCircle className="size-3 shrink-0" /> {e}
								</p>
							))}
						</div>
					)}

					{/* ══ Self-test results ══ */}
				</form>

				<div className="sticky bottom-0 mt-4 border-t border-hairline bg-background pt-3">
					<div className="flex items-center justify-between gap-3">
						<p className="text-[10px] text-muted-foreground/60">
							{validationErrors.length > 0
								? t("settings.customProviders.dialog.issuesToFix", { count: validationErrors.length })
								: t("settings.customProviders.dialog.readyToTest", { count: models.length })}
						</p>
						<div className="flex items-center gap-2">
							<Button variant="line" size="sm" onClick={onBack} disabled={saving} className="h-7 text-[11px]">
								{t("settings.customProviders.dialog.action.cancel")}
							</Button>
							<Button
								variant="line-filled"
								size="sm"
								onClick={handleSubmit}
								disabled={saving || validationErrors.length > 0}
								className="h-7 text-[11px]"
							>
								{saving ? (
									<>
										<Loader2 className="size-3 animate-spin" data-icon="inline-start" />
										{t("settings.customProviders.dialog.testing")}
									</>
								) : (
									t("settings.customProviders.dialog.action.testAndSave")
								)}
							</Button>
						</div>
					</div>
				</div>
			</div>
		);
	}

	// ── Dialog mode ──
	return (
		<Dialog open={open} onOpenChange={(o) => !o && handleClose()}>
			<DialogContent className="sm:max-w-xl max-h-[92vh] overflow-hidden flex flex-col" showCloseButton={!saving}>
				{/* ── Header ── */}
				<DialogHeader className="shrink-0">
					<DialogTitle>
						{t(isEdit ? "settings.customProviders.dialog.titleEdit" : "settings.customProviders.dialog.titleAdd")}
					</DialogTitle>
					<DialogDescription className="text-[12px]">
						{isEdit
							? t("settings.customProviders.dialog.titleEdit")
							: t("settings.customProviders.dialog.description")}
					</DialogDescription>
				</DialogHeader>

				{/* ── Scrollable form body ── */}
				<div className="flex-1 overflow-y-auto px-0.5 py-4 space-y-5">
					{/* ══ Connection ══ */}
					<section>
						<SectionLabel>{t("settings.customProviders.dialog.connection")}</SectionLabel>
						<div className="grid grid-cols-2 gap-3">
							<div className="space-y-1">
								<Label className="text-[11px] text-muted-foreground">
									{t("settings.customProviders.dialog.field.api")}
								</Label>
								<Select value={apiProtocol} onValueChange={(v) => setApiProtocol(v as ApiProtocol)}>
									<SelectTrigger className="h-8 text-[12px]">
										<SelectValue placeholder={t("settings.customProviders.dialog.placeholder.api")}>
											{`[${apiProtocol}] ${API_PROTOCOL_LABELS[apiProtocol] ?? ""}`}
										</SelectValue>
									</SelectTrigger>
									<SelectContent>
										<SelectItem value="openai-completions">OpenAI Chat Completions</SelectItem>
										<SelectItem value="anthropic-messages">Anthropic Messages</SelectItem>
										<SelectItem value="google-generative-ai">Google Generative AI</SelectItem>
										<SelectItem value="openai-responses">OpenAI Responses</SelectItem>
									</SelectContent>
								</Select>
							</div>
							<div className="space-y-1">
								<Label className="text-[11px] text-muted-foreground">
									{t("settings.customProviders.dialog.field.name")} <span className="text-rose-500">*</span>
								</Label>
								<Input
									value={name}
									onChange={(e) => setName(e.target.value)}
									placeholder={t("settings.customProviders.dialog.placeholder.name")}
									disabled={isEdit}
									className="h-8 text-[12px] font-mono"
								/>
								<p className="text-[10px] text-muted-foreground/60 leading-tight">
									{t("settings.customProviders.dialog.field.nameHint")}
								</p>
							</div>
						</div>

						<div className="mt-3 grid grid-cols-2 gap-3">
							<div className="space-y-1">
								<Label className="text-[11px] text-muted-foreground">
									{t("settings.customProviders.dialog.field.baseUrl")} <span className="text-rose-500">*</span>
								</Label>
								<Input
									value={baseUrl}
									onChange={(e) => setBaseUrl(e.target.value)}
									placeholder={t("settings.customProviders.dialog.placeholder.baseUrl")}
									className="h-8 text-[12px] font-mono"
								/>
							</div>
							<div className="space-y-1">
								<Label className="text-[11px] text-muted-foreground">
									{t("settings.customProviders.dialog.field.apiKey")}
								</Label>
								<div className="relative">
									<Input
										type={showKey ? "text" : "password"}
										autoComplete="new-password"
										value={apiKeyVal}
										onChange={(e) => setApiKeyVal(e.target.value)}
										placeholder={t("settings.customProviders.dialog.placeholder.apiKey")}
										className="h-8 pr-9 text-[12px] font-mono"
									/>
									<Button
										variant="ghost"
										size="icon"
										className="absolute right-0 top-0 size-8"
										onClick={() => setShowKey(!showKey)}
										tabIndex={-1}
									>
										{showKey ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
									</Button>
								</div>
								<p className="text-[10px] text-muted-foreground/60 leading-tight">
									{t("settings.customProviders.dialog.field.apiKeyHint")}
								</p>
							</div>
						</div>
					</section>

					{/* ══ Custom Headers (collapsible) ══ */}
					<section>
						<button
							type="button"
							className="group mb-2 flex w-full items-center gap-1.5 text-[11px] font-medium text-muted-foreground hover:text-foreground"
							onClick={() => setHeadersOpen(!headersOpen)}
						>
							<ChevronRight className={cn("size-3 transition-transform", headersOpen && "rotate-90")} />
							<div className="h-3 w-0.5 rounded-full bg-border group-hover:bg-foreground/20 transition-colors" />
							<span className="uppercase tracking-wider">
								{t("settings.customProviders.dialog.field.headers")}
							</span>
							{headers.length > 0 && (
								<span className="rounded-full bg-muted px-1.5 text-[10px]">{headers.length}</span>
							)}
						</button>
						{headersOpen && (
							<div className="space-y-1.5 pl-5">
								{headers.map((h) => (
									<div key={h.id} className="flex items-center gap-1.5">
										<Input
											value={h.key}
											onChange={(e) => updateHeader(h.id, "key", e.target.value)}
											placeholder={t("settings.customProviders.dialog.placeholder.headerKey")}
											className="h-7 flex-1 text-[11px] font-mono"
										/>
										<Input
											value={h.value}
											onChange={(e) => updateHeader(h.id, "value", e.target.value)}
											placeholder={t("settings.customProviders.dialog.placeholder.headerValue")}
											className="h-7 flex-1 text-[11px] font-mono"
										/>
										<Button
											variant="line-ghost"
											size="icon-xs"
											className="h-7 w-7 shrink-0 text-muted-foreground hover:text-destructive"
											onClick={() => removeHeader(h.id)}
										>
											<Trash2 className="size-3" />
										</Button>
									</div>
								))}
								{headers.length === 0 && (
									<p className="py-1 text-[10px] text-muted-foreground/60">
										{t("settings.customProviders.dialog.noCustomHeaders")}
									</p>
								)}
								<Button variant="line" size="xs" onClick={addHeader} className="text-[10px]">
									<Plus className="size-3" /> {t("settings.customProviders.dialog.addHeader")}
								</Button>
							</div>
						)}
					</section>

					{/* ══ Models ══ */}
					<section>
						<div className="mb-2 flex items-center justify-between">
							<div className="flex items-center gap-2">
								<div className="h-3 w-0.5 rounded-full bg-border" />
								<span className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider">
									{t("settings.customProviders.dialog.field.models")}
								</span>
								<span className="rounded-full bg-muted px-1.5 text-[10px] font-medium text-muted-foreground">
									{models.length}
								</span>
							</div>
							<Button variant="line" size="xs" onClick={addModel} className="h-6 text-[10px]">
								<Plus className="size-3" /> {t("settings.customProviders.dialog.addModel")}
							</Button>
						</div>

						{models.length === 0 ? (
							<div className="rounded-lg border border-dashed border-hairline py-6 text-center">
								<p className="text-[11px] text-muted-foreground/60">
									{t("settings.customProviders.dialog.noModels")}
								</p>
								<Button variant="line" size="xs" onClick={addModel} className="mt-2 text-[10px]">
									<Plus className="size-3" /> {t("settings.customProviders.dialog.addFirstModel")}
								</Button>
							</div>
						) : (
							<div className="space-y-1">
								{models.map((m) => (
									<div
										key={m._key}
										className="group flex items-center gap-2 rounded-md border border-transparent bg-muted/30 px-2.5 py-1.5 transition-colors hover:border-hairline hover:bg-muted/50"
									>
										{/* Model ID */}
										<Input
											value={m.id}
											onChange={(e) => updateModel(m._key, { id: e.target.value })}
											placeholder={t("settings.customProviders.dialog.placeholder.modelId")}
											className="h-7 min-w-0 flex-[2] text-[12px] font-mono"
										/>
										{/* Display name */}
										<Input
											value={m.name ?? ""}
											onChange={(e) => updateModel(m._key, { name: e.target.value || undefined })}
											placeholder={t("settings.customProviders.dialog.placeholder.modelName")}
											className="h-7 min-w-0 flex-[1.5] text-[12px]"
										/>
										{/* Reasoning toggle */}
										<div className="flex shrink-0 items-center gap-1.5">
											<span className="text-[10px] text-muted-foreground/60 select-none">
												{t("settings.customProviders.dialog.think")}
											</span>
											<Switch
												checked={m.reasoning ?? false}
												onCheckedChange={(v) => updateModel(m._key, { reasoning: v })}
												className="scale-75"
											/>
										</div>
										{/* Delete */}
										<Button
											variant="line-ghost"
											size="icon-xs"
											className="h-7 w-7 shrink-0 opacity-0 transition-opacity group-hover:opacity-100 text-muted-foreground hover:text-destructive"
											onClick={() => removeModel(m._key)}
										>
											<Trash2 className="size-3" />
										</Button>
									</div>
								))}
							</div>
						)}
					</section>

					{/* ══ Advanced Compatibility ══ */}
					<section>
						<button
							type="button"
							className="group mb-2 flex w-full items-center gap-1.5 text-[11px] font-medium text-muted-foreground hover:text-foreground"
							onClick={() => setCompatSection(!compatSection)}
						>
							<ChevronRight className={cn("size-3 transition-transform", compatSection && "rotate-90")} />
							<div className="h-3 w-0.5 rounded-full bg-border group-hover:bg-foreground/20 transition-colors" />
							<span className="uppercase tracking-wider">
								{t("settings.customProviders.dialog.field.compat")}
							</span>
						</button>

						{compatSection && (
							<div className="space-y-1.5 rounded-lg border border-hairline bg-muted/20 p-3 pl-5">
								{apiProtocol === "anthropic-messages" && (
									<>
										<CompatToggle
											checked={forceAdaptiveThinking}
											onChange={setForceAdaptiveThinking}
											label={t("settings.customProviders.compat.anthropic.forceAdaptiveThinking")}
											tip={t("settings.customProviders.compat.anthropic.forceAdaptiveThinkingTip")}
										/>
										<CompatToggle
											checked={supportsEagerToolInputStreaming}
											onChange={setSupportsEagerToolInputStreaming}
											label={t("settings.customProviders.compat.anthropic.supportsEagerToolInputStreaming")}
											tip={t("settings.customProviders.compat.anthropic.supportsEagerToolInputStreamingTip")}
										/>
										<CompatToggle
											checked={allowEmptySignature}
											onChange={setAllowEmptySignature}
											label={t("settings.customProviders.compat.anthropic.allowEmptySignature")}
											tip={t("settings.customProviders.compat.anthropic.allowEmptySignatureTip")}
										/>
									</>
								)}
								{apiProtocol === "openai-completions" && (
									<>
										<CompatToggle
											checked={supportsDeveloperRole}
											onChange={setSupportsDeveloperRole}
											label={t("settings.customProviders.compat.openai.supportsDeveloperRole")}
											tip={t("settings.customProviders.compat.openai.supportsDeveloperRoleTip")}
										/>
										<CompatToggle
											checked={supportsReasoningEffort}
											onChange={setSupportsReasoningEffort}
											label={t("settings.customProviders.compat.openai.supportsReasoningEffort")}
											tip={t("settings.customProviders.compat.openai.supportsReasoningEffortTip")}
										/>
									</>
								)}
								{apiProtocol === "openai-responses" && (
									<CompatToggle
										checked={supportsDeveloperRole}
										onChange={setSupportsDeveloperRole}
										label={t("settings.customProviders.compat.openai.supportsDeveloperRole")}
										tip={t("settings.customProviders.compat.openai.supportsDeveloperRoleTip")}
									/>
								)}
								{apiProtocol === "google-generative-ai" && (
									<p className="py-1 text-[10px] text-muted-foreground/60">
										{t("settings.customProviders.dialog.noCompatOptions")}
									</p>
								)}
							</div>
						)}
					</section>

					{/* ══ Validation errors ══ */}
					{validationErrors.length > 0 && (
						<div className="rounded-lg border border-rose-500/20 bg-rose-500/[0.04] p-3 space-y-1">
							{validationErrors.map((e, i) => (
								<p key={i} className="flex items-center gap-1.5 text-[11px] text-rose-600 dark:text-rose-400">
									<AlertCircle className="size-3 shrink-0" /> {e}
								</p>
							))}
						</div>
					)}

					{/* ══ Self-test results ══ */}
					{testResult && <TestResultsPanel result={testResult} t={t} />}
				</div>

				{/* ── Footer ── */}
				<div className="shrink-0 border-t border-hairline bg-muted/20 px-6 py-3">
					<div className="flex items-center justify-between gap-3">
						<p className="text-[10px] text-muted-foreground/60">
							{validationErrors.length > 0
								? t("settings.customProviders.dialog.issuesToFix", { count: validationErrors.length })
								: t("settings.customProviders.dialog.readyToTest", { count: models.length })}
						</p>
						<div className="flex items-center gap-2">
							<Button
								variant="line"
								size="sm"
								onClick={handleClose}
								disabled={saving}
								className="h-7 text-[11px]"
							>
								{t("settings.customProviders.dialog.action.cancel")}
							</Button>
							<Button
								variant="line-filled"
								size="sm"
								onClick={handleSubmit}
								disabled={saving || validationErrors.length > 0}
								className="h-7 text-[11px]"
							>
								{saving ? (
									<>
										<Loader2 className="size-3 animate-spin" data-icon="inline-start" />
										{t("settings.customProviders.dialog.testing")}
									</>
								) : (
									t("settings.customProviders.dialog.action.testAndSave")
								)}
							</Button>
						</div>
					</div>
				</div>
			</DialogContent>
		</Dialog>
	);
}

// ═══════════════════════════════════════
// Sub-components
// ═══════════════════════════════════════

function CompatToggle({
	checked,
	onChange,
	label,
	tip,
}: {
	checked: boolean;
	onChange: (v: boolean) => void;
	label: string;
	tip: string;
}) {
	return (
		<label className="flex cursor-pointer items-center justify-between gap-4 rounded-md px-2 py-1.5 transition-colors hover:bg-muted/30">
			<span className="flex min-w-0 items-center gap-1.5 text-[11px]" title={tip}>
				<Info className="size-3 text-muted-foreground/40" />
				{label}
			</span>
			<Switch checked={checked} onCheckedChange={onChange} className="scale-75" />
		</label>
	);
}

function TestResultsPanel({
	result,
	t,
}: {
	result: TestCustomProviderResult;
	t: (k: string, opts?: Record<string, unknown>) => string;
}) {
	const ok = result.overall === "ok";
	return (
		<div className="space-y-1.5">
			<div className="flex items-center gap-2">
				<div className={cn("h-3 w-0.5 rounded-full", ok ? "bg-emerald-500" : "bg-rose-500")} />
				<span
					className={cn(
						"text-[11px] font-medium",
						ok ? "text-emerald-600 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400",
					)}
				>
					{ok
						? t("settings.customProviders.test.summaryAllOk", { count: result.results.length })
						: t("settings.customProviders.test.summaryPartialFail", {
								failCount: result.results.filter((r) => !r.ok).length,
							})}
				</span>
			</div>
			<div className="space-y-0.5 pl-5">
				{result.results.map((r) => (
					<div
						key={r.modelId}
						className={cn(
							"flex items-center gap-2 rounded-md border-l-2 px-2.5 py-1.5 text-[11px]",
							r.ok ? "border-l-emerald-500 bg-emerald-500/[0.04]" : "border-l-rose-500 bg-rose-500/[0.04]",
						)}
					>
						{r.ok ? (
							<CheckCircle2 className="size-3.5 shrink-0 text-emerald-500" />
						) : (
							<XCircle className="size-3.5 shrink-0 text-rose-500" />
						)}
						<span className="min-w-0 truncate font-mono font-medium">{r.modelId}</span>
						{r.ok && r.latencyMs !== undefined && (
							<span className="ml-auto rounded-full bg-muted px-1.5 py-0 text-[10px] font-mono text-muted-foreground">
								{r.latencyMs}ms
							</span>
						)}
						{!r.ok && r.error && (
							<span className="ml-auto max-w-[180px] truncate text-right text-rose-600/70 dark:text-rose-400/70">
								{r.error}
							</span>
						)}
					</div>
				))}
			</div>
		</div>
	);
}
