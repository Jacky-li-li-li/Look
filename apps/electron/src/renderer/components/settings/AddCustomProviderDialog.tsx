// ============================================================
// AddCustomProviderDialog — form for adding/editing custom providers
// ============================================================

import { Button } from "@look/ui/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@look/ui/components/ui/dialog";
import { cn } from "@look/ui";
import type { TFunction } from "i18next";
import { AlertCircle, ArrowLeft, CheckCircle2, Loader2, XCircle } from "lucide-react";
import type React from "react";
import { useCallback, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import ProviderCompatSection from "./ProviderCompatSection";
import ProviderConnectionFields from "./ProviderConnectionFields";
import ProviderHeadersSection from "./ProviderHeadersSection";
import ProviderModelsSection from "./ProviderModelsSection";
import {
	buildInitialForm,
	type ProviderCompatState,
	type ProviderFormErrors,
	type ProviderFormState,
} from "./provider-form-state";
import type { CustomProviderInput, CustomProviderModelInput, TestCustomProviderResult } from "./types";

const api = window.look;

interface Props {
	open: boolean;
	onClose: () => void;
	initial?: CustomProviderInput;
	onSaved: () => void;
	mode?: "dialog" | "inline";
	onBack?: () => void;
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

interface FormBodyProps {
	form: ProviderFormState;
	patchForm: <K extends keyof ProviderFormState>(key: K, value: ProviderFormState[K]) => void;
	patchCompat: <K extends keyof ProviderCompatState>(key: K, value: boolean) => void;
	errors: ProviderFormErrors;
	validationErrors: string[];
	testResult: TestCustomProviderResult | null;
	isEdit: boolean;
	newItemKey: () => number;
	addModel: () => void;
	updateModel: (key: number, patch: Partial<CustomProviderModelInput>) => void;
	removeModel: (key: number) => void;
	addHeader: () => void;
	updateHeader: (id: number, field: "key" | "value", val: string) => void;
	removeHeader: (id: number) => void;
	t: TFunction;
}

function FormBody({
	form,
	patchForm,
	patchCompat,
	errors,
	validationErrors,
	testResult,
	isEdit,
	addModel,
	updateModel,
	removeModel,
	addHeader,
	updateHeader,
	removeHeader,
	t,
}: FormBodyProps) {
	return (
		<form className="space-y-5" onSubmit={(e) => e.preventDefault()}>
			<ProviderConnectionFields form={form} patchForm={patchForm} errors={errors} isEdit={isEdit} t={t} />
			<ProviderHeadersSection
				headers={form.headers}
				headersOpen={form.headersOpen}
				onToggleOpen={() => patchForm("headersOpen", !form.headersOpen)}
				onAdd={addHeader}
				onUpdate={updateHeader}
				onRemove={removeHeader}
				t={t}
			/>
			<ProviderModelsSection
				models={form.models}
				onAdd={addModel}
				onUpdate={updateModel}
				onRemove={removeModel}
				t={t}
			/>
			<ProviderCompatSection compat={form.compat} api={form.api} onChange={patchCompat} t={t} />
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

	// ── grouped state ──
	const [form, setForm] = useState<ProviderFormState>(() => buildInitialForm(initial));
	const [saving, setSaving] = useState(false);
	const [testResult, setTestResult] = useState<TestCustomProviderResult | null>(null);

	const patchForm = useCallback(<K extends keyof ProviderFormState>(key: K, value: ProviderFormState[K]) => {
		setForm((prev) => ({ ...prev, [key]: value }));
	}, []);

	const patchCompat = useCallback(<K extends keyof ProviderCompatState>(key: K, value: boolean) => {
		setForm((prev) => ({ ...prev, compat: { ...prev.compat, [key]: value } }));
	}, []);

	// ── reset on open ──
	const prevOpen = useRef(open);
	if (open !== prevOpen.current) {
		prevOpen.current = open;
		if (open) {
			setSaving(false);
			setTestResult(null);
			patchForm("headersOpen", false);
		}
	}

	// ── key counter ──
	const newItemKey = () => {
		keyCounterRef.current += 1;
		return keyCounterRef.current;
	};

	// ── model / header crud ──
	const addModel = () => {
		setForm((prev) => ({
			...prev,
			models: [
				...prev.models,
				{
					_key: newItemKey(),
					id: "",
					name: "",
					reasoning: false,
					input: ["text"],
					contextWindow: 128000,
					maxTokens: 16384,
				},
			],
		}));
	};
	const updateModel = (key: number, patch: Partial<CustomProviderModelInput>) => {
		setForm((prev) => ({
			...prev,
			models: prev.models.map((m) => (m._key === key ? { ...m, ...patch } : m)),
		}));
	};
	const removeModel = (key: number) => {
		setForm((prev) => ({ ...prev, models: prev.models.filter((m) => m._key !== key) }));
	};

	const addHeader = () => {
		setForm((prev) => ({
			...prev,
			headers: [...prev.headers, { id: newItemKey(), key: "", value: "" }],
		}));
	};
	const updateHeader = (id: number, field: "key" | "value", val: string) => {
		setForm((prev) => ({
			...prev,
			headers: prev.headers.map((h) => (h.id === id ? { ...h, [field]: val } : h)),
		}));
	};
	const removeHeader = (id: number) => {
		setForm((prev) => ({ ...prev, headers: prev.headers.filter((h) => h.id !== id) }));
	};

	// ── validation ──
	const validationErrors = useMemo(() => {
		const errs: string[] = [];
		if (!/^[a-z0-9][a-z0-9-]{0,40}$/.test(form.name))
			errs.push(t("settings.customProviders.dialog.validation.nameFormat"));
		if (!/^https?:\/\//.test(form.baseUrl)) errs.push(t("settings.customProviders.dialog.validation.baseUrlFormat"));
		if (!form.apiKey.trim()) errs.push(t("settings.customProviders.dialog.validation.apiKeyRequired"));
		if (form.models.length === 0) errs.push(t("settings.customProviders.dialog.validation.modelsRequired"));
		const modelIds = new Set<string>();
		for (const m of form.models) {
			if (!m.id.trim()) errs.push(t("settings.customProviders.dialog.validation.modelIdEmpty"));
			else if (modelIds.has(m.id.trim()))
				errs.push(t("settings.customProviders.dialog.validation.modelIdDuplicate", { id: m.id }));
			else modelIds.add(m.id.trim());
		}
		return errs;
	}, [form.name, form.baseUrl, form.apiKey, form.models, t]);

	const errors: ProviderFormErrors = useMemo(
		() => ({
			name: validationErrors.some((e) => e.includes("name")),
			baseUrl: validationErrors.some((e) => e.includes("baseUrl")),
			apiKey: validationErrors.some((e) => e.includes("apiKey")),
		}),
		[validationErrors],
	);

	// ── build payload ──
	const buildInput = useCallback((): CustomProviderInput => {
		const compat: Record<string, unknown> = {};
		if (form.api === "anthropic-messages") {
			if (form.compat.forceAdaptiveThinking) compat.forceAdaptiveThinking = true;
			if (!form.compat.supportsEagerToolInputStreaming) compat.supportsEagerToolInputStreaming = false;
			if (form.compat.allowEmptySignature) compat.allowEmptySignature = true;
		}
		if (form.api === "openai-completions") {
			if (!form.compat.supportsDeveloperRole) compat.supportsDeveloperRole = false;
			if (!form.compat.supportsReasoningEffort) compat.supportsReasoningEffort = false;
		}
		if (form.api === "openai-responses" && !form.compat.supportsDeveloperRole) {
			compat.supportsDeveloperRole = false;
		}
		const headerObj: Record<string, string> | undefined =
			form.headers.length > 0
				? Object.fromEntries(form.headers.flatMap((h) => (h.key.trim() ? [[h.key.trim(), h.value]] : [])))
				: undefined;
		return {
			name: form.name,
			baseUrl: form.baseUrl,
			api: form.api,
			apiKey: form.apiKey.trim() || undefined,
			headers: headerObj,
			authHeader: !!form.apiKey,
			models: form.models.map(({ _key, ...m }) => ({
				id: m.id.trim(),
				name: m.name || undefined,
				reasoning: m.reasoning ?? false,
				input: m.input ?? ["text"],
				contextWindow: m.contextWindow ?? 128000,
				maxTokens: m.maxTokens ?? 16384,
			})),
			compat: Object.keys(compat).length > 0 ? compat : undefined,
		};
	}, [form]);

	// ═══════════════════════════════════════════
	// handlers
	// ═══════════════════════════════════════════

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
		} catch (e) {
			toast.error(e instanceof Error ? e.message : t("settings.customProviders.toast.selfTestUnavailable"));
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
			} catch (e) {
				toast.error(e instanceof Error ? e.message : t("settings.customProviders.toast.saveFailed"));
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

	// ── header / footer / form ──
	const formBody = (
		<FormBody
			form={form}
			patchForm={patchForm}
			patchCompat={patchCompat}
			errors={errors}
			validationErrors={validationErrors}
			testResult={testResult}
			isEdit={isEdit}
			newItemKey={newItemKey}
			addModel={addModel}
			updateModel={updateModel}
			removeModel={removeModel}
			addHeader={addHeader}
			updateHeader={updateHeader}
			removeHeader={removeHeader}
			t={t}
		/>
	);

	if (isInline) {
		return (
			<ProviderDialogShell
				isInline
				header={<DialogHeaderBlock isEdit={isEdit} initialName={initial?.name} isInline onBack={onBack} t={t} />}
				form={formBody}
				footer={
					<DialogFooterBlock
						isInline
						saving={saving}
						validationErrors={validationErrors}
						modelsCount={form.models.length}
						onCancel={onBack}
						onSubmit={handleSubmit}
						t={t}
					/>
				}
			/>
		);
	}

	return (
		<ProviderDialogShell
			form={formBody}
			footer={
				<DialogFooterBlock
					isInline={false}
					saving={saving}
					validationErrors={validationErrors}
					modelsCount={form.models.length}
					onCancel={handleClose}
					onSubmit={handleSubmit}
					t={t}
				/>
			}
			dialogProps={{
				open,
				onOpenChange: (o: boolean) => !o && handleClose(),
				showCloseButton: !saving,
				isEdit,
				initialName: initial?.name,
				t,
			}}
		/>
	);
}

interface DialogHeaderBlockProps {
	isEdit: boolean;
	initialName?: string;
	isInline: boolean;
	onBack?: () => void;
	t: TFunction;
}

function DialogHeaderBlock({ isEdit, initialName, isInline, onBack, t }: DialogHeaderBlockProps) {
	return (
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
						? t("settings.customProviders.dialog.descriptionEdit", { name: initialName ?? "" })
						: t("settings.customProviders.dialog.description")}
				</p>
			</div>
		</>
	);
}

interface DialogFooterBlockProps {
	isInline: boolean;
	saving: boolean;
	validationErrors: string[];
	modelsCount: number;
	onCancel?: () => void;
	onSubmit: () => void;
	t: TFunction;
}

function DialogFooterBlock({
	isInline,
	saving,
	validationErrors,
	modelsCount,
	onCancel,
	onSubmit,
	t,
}: DialogFooterBlockProps) {
	return (
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
						: t("settings.customProviders.dialog.readyToTest", { count: modelsCount })}
				</p>
				<div className="flex items-center gap-2">
					<Button variant="line" size="sm" onClick={onCancel} disabled={saving} className="h-7 text-[11px]">
						{t("settings.customProviders.dialog.action.cancel")}
					</Button>
					<Button
						variant="line-filled"
						size="sm"
						onClick={onSubmit}
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
}

interface ProviderDialogShellProps {
	isInline?: boolean;
	header?: React.ReactNode;
	form: React.ReactNode;
	footer: React.ReactNode;
	dialogProps?: {
		open: boolean;
		onOpenChange: (open: boolean) => void;
		showCloseButton: boolean;
		isEdit: boolean;
		initialName?: string;
		t: TFunction;
	};
}

function ProviderDialogShell({ isInline, header, form, footer, dialogProps }: ProviderDialogShellProps) {
	if (isInline) {
		return (
			<div className="flex h-full min-h-0 flex-col overflow-hidden p-4">
				{header}
				<div className="mt-4 flex-1 overflow-y-auto">{form}</div>
				{footer}
			</div>
		);
	}

	if (!dialogProps) return null;
	const { open, onOpenChange, showCloseButton, isEdit, initialName, t } = dialogProps;
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent
				className="flex max-h-[92vh] flex-col overflow-hidden sm:max-w-2xl"
				showCloseButton={showCloseButton}
			>
				<DialogHeader className="shrink-0">
					<DialogTitle>
						{t(isEdit ? "settings.customProviders.dialog.titleEdit" : "settings.customProviders.dialog.titleAdd")}
					</DialogTitle>
					<DialogDescription className="text-[12px]">
						{isEdit
							? t("settings.customProviders.dialog.descriptionEdit", { name: initialName ?? "" })
							: t("settings.customProviders.dialog.description")}
					</DialogDescription>
				</DialogHeader>
				<div className="flex-1 space-y-5 overflow-y-auto px-0.5 py-4">{form}</div>
				{footer}
			</DialogContent>
		</Dialog>
	);
}
