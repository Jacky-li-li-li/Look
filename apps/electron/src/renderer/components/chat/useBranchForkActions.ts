import { useAtomValue } from "jotai";
import { type RefObject, useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { appStore } from "../../store/appStore";
import { activeAgentIdAtom, forkingEntryAtomFamily, navigatingEntryAtomFamily } from "../../store/atoms";
import type { BranchConfirmRequest, BranchConfirmResult } from "../dialogs/BranchConfirmDialog";
import type { ChatInputHandle } from "./ChatInput";

/**
 * 分支 / 复刻 / 确认对话框状态机：busy 与 navigating/forking 互斥门闩。
 */
export function useBranchForkActions(options: {
	agentId: string;
	isBusy: boolean;
	inputRef: RefObject<ChatInputHandle | null>;
	onSend: (text: string) => Promise<boolean>;
	scrollToMessage: (entryId: string) => void;
	flashEntry: (entryId: string) => void;
}) {
	const { agentId, isBusy, inputRef, onSend, scrollToMessage, flashEntry } = options;
	const { t } = useTranslation();
	const navigatingEntry = useAtomValue(navigatingEntryAtomFamily(agentId));
	const forkingEntry = useAtomValue(forkingEntryAtomFamily(agentId));
	const [pendingConfirm, setPendingConfirm] = useState<BranchConfirmRequest | null>(null);
	const [pendingBranchEntryId, setPendingBranchEntryId] = useState<string | null>(null);

	const handleBranchFromHere = useCallback(
		(entryId: string) => {
			if (isBusy) return void toast(t("chat.stopFirstToNavigate"));
			if (navigatingEntry || forkingEntry) return;
			setPendingBranchEntryId(entryId);
			setPendingConfirm(inputRef.current?.getText().trim() ? { kind: "input-not-empty" } : { kind: "summary" });
		},
		[isBusy, navigatingEntry, forkingEntry, inputRef, t],
	);

	const handleForkToNewChat = useCallback(
		async (entryId: string) => {
			if (isBusy) return void toast(t("chat.stopFirstToNavigate"));
			if (navigatingEntry || forkingEntry) return;
			appStore.set(forkingEntryAtomFamily(agentId), entryId);
			const toastId = toast.loading(t("chat.forking"));
			try {
				const result = await window.look.createFork(agentId, entryId, {});
				toast.dismiss(toastId);
				if (!result?.success) throw new Error(result?.error ?? "unknown");
				if (result.agentId) appStore.set(activeAgentIdAtom, result.agentId);
				toast.success(t("chat.forkCreated"), { duration: 1500 });
			} catch (error) {
				toast.dismiss(toastId);
				toast.error(t("chat.forkFailed", { message: error instanceof Error ? error.message : "unknown" }));
			} finally {
				appStore.set(forkingEntryAtomFamily(agentId), null);
			}
		},
		[agentId, forkingEntry, isBusy, navigatingEntry, t],
	);

	const handleConfirmResolve = useCallback(
		async (result: BranchConfirmResult) => {
			const entryId = pendingBranchEntryId;
			const confirm = pendingConfirm;
			setPendingConfirm(null);
			setPendingBranchEntryId(null);
			if (!entryId || !confirm || result.kind === "summary-cancel" || result.kind === "input-cancel") return;
			if (confirm.kind === "input-not-empty" && result.kind === "input-send-first") {
				const draft = inputRef.current?.getText().trim() ?? "";
				if (draft && (await onSend(draft))) inputRef.current?.setText("");
				setPendingBranchEntryId(entryId);
				setPendingConfirm({ kind: "summary" });
				return;
			}
			appStore.set(navigatingEntryAtomFamily(agentId), entryId);
			const toastId = toast.loading(t("chat.navigating"));
			try {
				const response = await window.look.navigateTree(agentId, entryId, {
					summarize: result.kind === "summary-generate",
				});
				toast.dismiss(toastId);
				if (!response?.success) throw new Error(response?.error ?? "unknown");
				if (response.result?.cancelled) return;
				if (typeof response.result?.editorText === "string") {
					inputRef.current?.setText(response.result.editorText);
					inputRef.current?.focus();
				}
				scrollToMessage(entryId);
				flashEntry(entryId);
				toast.success(t("chat.branched"), { duration: 1500 });
			} catch (error) {
				toast.dismiss(toastId);
				toast.error(t("chat.navigatingFailed", { message: error instanceof Error ? error.message : "unknown" }));
				appStore.set(navigatingEntryAtomFamily(agentId), null);
			}
		},
		[pendingBranchEntryId, pendingConfirm, inputRef, onSend, agentId, t, scrollToMessage, flashEntry],
	);

	return {
		navigatingEntry,
		forkingEntry,
		pendingConfirm,
		handleBranchFromHere,
		handleForkToNewChat,
		handleConfirmResolve,
	};
}
