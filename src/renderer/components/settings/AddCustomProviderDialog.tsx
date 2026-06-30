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
import type { TFunction } from "i18next";
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
import { useCallback, useRef, useState } from "react";
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
	initial?: CustomProviderInput;
	onSaved: () => void;
	mode?: "dialog" | "inline";
	onBack?: () => void;
}

function SectionLabel({ children, className }: { children: React.ReactNode; className?: string }) {
	return (
		<div className={cn("mb-2 flex items-center gap-2", className)}>
			<div className="h-3 w-0.5 rounded-full bg-border" />
			<span className="text-[11px] font-medium text-muted-foreground">{children}</span>
		</div>
	);
}

function FormBody({
	apiProtocol,
	setApiProtocol,
	name,
	setName,
	hasNameError,
	baseUrl,
	setBaseUrl,
	hasBaseUrlError,
	apiKeyVal,
	setApiKeyVal,
	hasApiKeyError,
	showKey,
	setShowKey,
	headers,
	setHeaders,
	headersOpen,
	setHeadersOpen,
	models,
	setModels,
	newItemKey,
	addModel,
	updateModel,
	removeModel,
	addHeader,
	updateHeader,
	removeHeader,
	supportsDeveloperRole,
	setSupportsDeveloperRole,
	supportsReasoningEffort,
	setSupportsReasoningEffort,
	forceAdaptiveThinking,
	setForceAdaptiveThinking,
	supportsEagerToolInputStreaming,
	setSupportsEagerToolInputStreaming,
	allowEmptySignature,
	setAllowEmptySignature,
	validationErrors,
	testResult,
	isEdit,
	t,
}: {
	apiProtocol: ApiProtocol;
	setApiProtocol: (v: ApiProtocol) => void;
	name: string;
	setName: (v: string) => void;
	hasNameError: boolean;
	baseUrl: string;
	setBaseUrl: (v: string) => void;
	hasBaseUrlError: boolean;
	apiKeyVal: string;
	setApiKeyVal: (v: string) => void;
	hasApiKeyError: boolean;
	showKey: boolean;
	setShowKey: (v: boolean) => void;
	headers: Array<{ id: number; key: string; value: string }>;
	setHeaders: React.Dispatch<React.SetStateAction<Array<{ id: number; key: string; value: string }>>>;
	headersOpen: boolean;
	setHeadersOpen: (v: boolean) => void;
	models: Array<CustomProviderModelInput & { _key: number }>;
	setModels: React.Dispatch<React.SetStateAction<Array<CustomProviderModelInput & { _key: number }>>>;
	newItemKey: () => number;
	addModel: () => void;
	updateModel: (key: number, patch: Partial<CustomProviderModelInput>) => void;
	removeModel: (key: number) => void;
	addHeader: () => void;
	updateHeader: (id: number, field: "key" | "value", val: string) => void;
	removeHeader: (id: number) => void;
	supportsDeveloperRole: boolean;
	setSupportsDeveloperRole: (v: boolean) => void;
	supportsReasoningEffort: boolean;
	setSupportsReasoningEffort: (v: boolean) => void;
	forceAdaptiveThinking: boolean;
	setForceAdaptiveThinking: (v: boolean) => void;
	supportsEagerToolInputStreaming: boolean;
	setSupportsEagerToolInputStreaming: (v: boolean) => void;
	allowEmptySignature: boolean;
	setAllowEmptySignature: (v: boolean) => void;
	validationErrors: string[];
	testResult: TestCustomProviderResult | null;
	isEdit: boolean;
	t: TFunction;
}) {
	return (
		<form className="space-y-5" onSubmit={(e) => e.preventDefault()}>
			<section>
				<SectionLabel>{t("settings.customProviders.dialog.connection")}</SectionLabel>
				<div className="space-y-3">
					<div className="space-y-1">
						<Label className="text-[11px] text-muted-foreground">
							{t("settings.customProviders.dialog.field.api")}
						</Label>
						<Select value={apiProtocol} onValueChange={(v) => setApiProtocol(v as ApiProtocol)}>
							<SelectTrigger className="h-8 w-full text-[12px]">
								<SelectValue placeholder={t("settings.customProviders.dialog.placeholder.api")}>
									{t(
										`settings.customProviders.dialog.protocol.${apiProtocol}`,
										API_PROTOCOL_LABELS[apiProtocol] ?? "",
									)}
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

					<div className="grid grid-cols-1 gap-3 min-[560px]:grid-cols-2">
						<div className="space-y-1">
							<Label className="text-[11px] text-muted-foreground">
								{t("settings.customProviders.dialog.field.name")} <span className="text-rose-500">*</span>
							</Label>
							<Input
								value={name}
								onChange={(e) => setName(e.target.value)}
								placeholder={t("settings.customProviders.dialog.placeholder.name")}
								disabled={isEdit}
								aria-invalid={hasNameError}
								className="h-8 text-[12px] font-mono"
							/>
							<p
								className={cn(
									"text-[10px] leading-tight",
									hasNameError ? "text-rose-600 dark:text-rose-400" : "text-muted-foreground/60",
								)}
							>
								{t("settings.customProviders.dialog.field.nameHint")}
							</p>
						</div>
						<div className="space-y-1">
							<Label className="text-[11px] text-muted-foreground">
								{t("settings.customProviders.dialog.field.baseUrl")} <span className="text-rose-500">*</span>
							</Label>
							<Input
								value={baseUrl}
								onChange={(e) => setBaseUrl(e.target.value)}
								placeholder={t("settings.customProviders.dialog.placeholder.baseUrl")}
								aria-invalid={hasBaseUrlError}
								className="h-8 text-[12px] font-mono"
							/>
						</div>
					</div>

					<div className="space-y-1">
						<Label className="text-[11px] text-muted-foreground">
							{t("settings.customProviders.dialog.field.apiKey")} <span className="text-rose-500">*</span>
						</Label>
						<div className="relative">
							<Input
								type={showKey ? "text" : "password"}
								autoComplete="new-password"
								value={apiKeyVal}
								onChange={(e) => setApiKeyVal(e.target.value)}
								placeholder={t("settings.customProviders.dialog.placeholder.apiKey")}
								aria-invalid={hasApiKeyError}
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

			<section>
				<button
					type="button"
					className="group mb-2 flex w-full items-center gap-1.5 text-[11px] font-medium text-muted-foreground hover:text-foreground"
					onClick={() => setHeadersOpen(!headersOpen)}
					aria-expanded={headersOpen}
				>
					<ChevronRight className={cn("size-3 transition-transform", headersOpen && "rotate-90")} />
					<div className="h-3 w-0.5 rounded-full bg-border transition-colors group-hover:bg-foreground/20" />
					<span>{t("settings.customProviders.dialog.field.headers")}</span>
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

			<section>
				<div className="mb-2 flex items-center justify-between">
					<div className="flex items-center gap-2">
						<div className="h-3 w-0.5 rounded-full bg-border" />
						<span className="text-[11px] font-medium text-muted-foreground">
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
								className="group grid grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)_auto_auto] items-center gap-2 rounded-md border border-transparent bg-muted/30 px-2.5 py-1.5 transition-colors hover:border-hairline hover:bg-muted/50"
							>
								<Input
									value={m.id}
									onChange={(e) => updateModel(m._key, { id: e.target.value })}
									placeholder={t("settings.customProviders.dialog.placeholder.modelId")}
									title={m.id || undefined}
									aria-invalid={!m.id.trim()}
									className="h-7 min-w-0 truncate text-[12px] font-mono"
								/>
								<Input
									value={m.name ?? ""}
									onChange={(e) => updateModel(m._key, { name: e.target.value || undefined })}
									placeholder={t("settings.customProviders.dialog.placeholder.modelName")}
									title={m.name ?? undefined}
									className="h-7 min-w-0 truncate text-[12px]"
								/>
								<Switch
									checked={m.reasoning ?? false}
									onCheckedChange={(v) => updateModel(m._key, { reasoning: v })}
									className="scale-75"
									aria-label={t("settings.customProviders.dialog.think")}
								/>
								<Button
									variant="line-ghost"
									size="icon-xs"
									className="h-7 w-7 shrink-0 text-muted-foreground opacity-0 transition-opacity hover:text-destructive group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100"
									onClick={() => removeModel(m._key)}
									aria-label={t("settings.customProviders.dialog.field.removeModel")}
								>
									<Trash2 className="size-3" />
								</Button>
							</div>
						))}
					</div>
				)}
			</section>

			<section>
				<SectionLabel>{t("settings.customProviders.dialog.field.compat")}</SectionLabel>
				<p className="mb-2 text-[10px] leading-snug text-muted-foreground/60">
					{t("settings.customProviders.dialog.compatHint")}
				</p>
				<div className="space-y-1.5 rounded-md border border-hairline bg-muted/15 p-2.5">
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
			</section>

			{validationErrors.length > 0 && (
				<div className="space-y-1 rounded-lg border border-rose-500/20 bg-rose-500/[0.04] p-3">
					{validationErrors.map((e, i) => (
						<p
							key={`${e}-${i}`}
							className="flex items-center gap-1.5 text-[11px] text-rose-600 dark:text-rose-400"
						>
							<AlertCircle className="size-3 shrink-0" /> {e}
						</p>
					))}
				</div>
			)}

			{testResult && <TestResultsPanel result={testResult} t={t} />}
		</form>
	);
}

export default function AddCustomProviderDialog({ open, onClose, initial, onSaved, mode = "dialog", onBack }: Props) {
	const { t } = useTranslation();
	const isEdit = !!initial;
	const isInline = mode === "inline";
	const keyCounterRef = useRef<number>(null!);
	if (keyCounterRef.current === null) keyCounterRef.current = Date.now();

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
	const [headersOpen, setHeadersOpen] = useState(false);

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

	const [saving, setSaving] = useState(false);
	const [testResult, setTestResult] = useState<TestCustomProviderResult | null>(null);

	// Adjust state when dialog opens (inline during render — no useEffect)
	const prevOpen = useRef(open);
	if (open !== prevOpen.current) {
		prevOpen.current = open;
		if (open) {
			setSaving(false);
			setTestResult(null);
			setHeadersOpen(false);
		}
	}

	const newItemKey = () => {
		keyCounterRef.current += 1;
		return keyCounterRef.current;
	};

	const addModel = () => {
		setModels((prev) => [
			...prev,
			{
				_key: newItemKey(),
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

	const addHeader = () => setHeaders((prev) => [...prev, { id: newItemKey(), key: "", value: "" }]);
	const updateHeader = (id: number, field: "key" | "value", val: string) => {
		setHeaders((prev) => prev.map((h) => (h.id === id ? { ...h, [field]: val } : h)));
	};
	const removeHeader = (id: number) => setHeaders((prev) => prev.filter((h) => h.id !== id));

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
		if (apiProtocol === "openai-responses" && !supportsDeveloperRole) {
			compat.supportsDeveloperRole = false;
		}
		const headerObj: Record<string, string> | undefined =
			headers.length > 0
				? Object.fromEntries(headers.flatMap((h) => (h.key.trim() ? [[h.key.trim(), h.value]] : [])))
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

	const validationErrors: string[] = [];
	const hasNameError = !/^[a-z0-9][a-z0-9-]{0,40}$/.test(name);
	const hasBaseUrlError = !/^https?:\/\//.test(baseUrl);
	const hasApiKeyError = !apiKeyVal.trim();
	if (hasNameError) validationErrors.push(t("settings.customProviders.dialog.validation.nameFormat"));
	if (hasBaseUrlError) validationErrors.push(t("settings.customProviders.dialog.validation.baseUrlFormat"));
	if (hasApiKeyError) validationErrors.push(t("settings.customProviders.dialog.validation.apiKeyRequired"));
	if (models.length === 0) validationErrors.push(t("settings.customProviders.dialog.validation.modelsRequired"));
	const modelIds = new Set<string>();
	for (const m of models) {
		if (!m.id.trim()) validationErrors.push(t("settings.customProviders.dialog.validation.modelIdEmpty"));
		else if (modelIds.has(m.id.trim()))
			validationErrors.push(t("settings.customProviders.dialog.validation.modelIdDuplicate", { id: m.id }));
		else modelIds.add(m.id.trim());
	}

	const handleSubmit = async () => {
		if (validationErrors.length > 0 || !api) return;
		setSaving(true);
		setTestResult(null);
		const input = buildInput();

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

	if (isInline && !open) return null;

	const headerBlock = (
		<>
			{isInline && (
				<button
					type="button"
					onClick={onBack}
					className="mb-3 flex items-center gap-1 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
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
						? t("settings.customProviders.dialog.descriptionEdit", { name: initial?.name ?? "" })
						: t("settings.customProviders.dialog.description")}
				</p>
			</div>
		</>
	);

	const formBody = (
		<FormBody
			apiProtocol={apiProtocol}
			setApiProtocol={setApiProtocol}
			name={name}
			setName={setName}
			hasNameError={hasNameError}
			baseUrl={baseUrl}
			setBaseUrl={setBaseUrl}
			hasBaseUrlError={hasBaseUrlError}
			apiKeyVal={apiKeyVal}
			setApiKeyVal={setApiKeyVal}
			hasApiKeyError={hasApiKeyError}
			showKey={showKey}
			setShowKey={setShowKey}
			headers={headers}
			setHeaders={setHeaders}
			headersOpen={headersOpen}
			setHeadersOpen={setHeadersOpen}
			models={models}
			setModels={setModels}
			newItemKey={newItemKey}
			addModel={addModel}
			updateModel={updateModel}
			removeModel={removeModel}
			addHeader={addHeader}
			updateHeader={updateHeader}
			removeHeader={removeHeader}
			supportsDeveloperRole={supportsDeveloperRole}
			setSupportsDeveloperRole={setSupportsDeveloperRole}
			supportsReasoningEffort={supportsReasoningEffort}
			setSupportsReasoningEffort={setSupportsReasoningEffort}
			forceAdaptiveThinking={forceAdaptiveThinking}
			setForceAdaptiveThinking={setForceAdaptiveThinking}
			supportsEagerToolInputStreaming={supportsEagerToolInputStreaming}
			setSupportsEagerToolInputStreaming={setSupportsEagerToolInputStreaming}
			allowEmptySignature={allowEmptySignature}
			setAllowEmptySignature={setAllowEmptySignature}
			validationErrors={validationErrors}
			testResult={testResult}
			isEdit={isEdit}
			t={t}
		/>
	);

	const footer = (
		<div
			className={cn(
				"shrink-0 border-t border-hairline bg-background",
				isInline
					? "sticky bottom-0 z-10 -mx-4 mt-4 px-4 pt-3 shadow-[0_-8px_12px_-8px_rgba(0,0,0,0.08)]"
					: "px-6 py-3",
			)}
		>
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
						onClick={isInline ? onBack : handleClose}
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
	);

	if (isInline) {
		return (
			<div className="flex h-full min-h-0 flex-col overflow-hidden p-4">
				{headerBlock}
				<div className="mt-4 flex-1 overflow-y-auto">{formBody}</div>
				{footer}
			</div>
		);
	}

	return (
		<Dialog open={open} onOpenChange={(o) => !o && handleClose()}>
			<DialogContent className="flex max-h-[92vh] flex-col overflow-hidden sm:max-w-2xl" showCloseButton={!saving}>
				<DialogHeader className="shrink-0">
					<DialogTitle>
						{t(isEdit ? "settings.customProviders.dialog.titleEdit" : "settings.customProviders.dialog.titleAdd")}
					</DialogTitle>
					<DialogDescription className="text-[12px]">
						{isEdit
							? t("settings.customProviders.dialog.descriptionEdit", { name: initial?.name ?? "" })
							: t("settings.customProviders.dialog.description")}
					</DialogDescription>
				</DialogHeader>
				<div className="flex-1 space-y-5 overflow-y-auto px-0.5 py-4">{formBody}</div>
				{footer}
			</DialogContent>
		</Dialog>
	);
}

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
		<div className="group flex items-center justify-between gap-3 rounded-md px-2 py-1.5 transition-colors hover:bg-muted/30">
			<button
				type="button"
				title={tip}
				onClick={() => onChange(!checked)}
				className="flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 text-left text-[11px] text-muted-foreground transition-colors group-hover:text-foreground"
			>
				<Info className="size-3 shrink-0 text-muted-foreground/40" />
				<span className="truncate">{label}</span>
			</button>
			<Switch checked={checked} onCheckedChange={onChange} className="scale-75 shrink-0" />
		</div>
	);
}

function TestResultsPanel({ result, t }: { result: TestCustomProviderResult; t: TFunction }) {
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
							<span className="ml-auto rounded-full bg-muted px-1.5 py-0 font-mono text-[10px] text-muted-foreground">
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
