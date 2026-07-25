// ============================================================
// BranchConfirmDialog — Lightweight confirm sheet for v0.4
// session-tree branching. Handles two distinct prompts:
//
//   - "summary" mode: shown when the user clicks "Branch from
//     here" on an assistant bubble. Asks whether to generate an
//     LLM-written summary of the abandoned branch.
//
//   - "input-not-empty" mode: shown when the user has un-sent
//     text in the composer AND is about to switch branches.
//     Avoids silently overwriting their draft.
//
// Both modes share the same visual treatment so a single modal
// is enough — no need for separate dialog components.
// ============================================================

import { Button } from "@look/ui/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@look/ui/components/ui/dialog";
import { useTranslation } from "react-i18next";

export type BranchConfirmKind = "summary" | "input-not-empty";

export interface BranchConfirmRequest {
	kind: BranchConfirmKind;
}

interface BranchConfirmDialogProps {
	request: BranchConfirmRequest | null;
	/** Called when the user picks a final action. The dialog
	 *  itself closes after the resolve; the parent owns the state. */
	onResolve: (result: BranchConfirmResult) => void;
}

export type BranchConfirmResult =
	| { kind: "summary-generate" }
	| { kind: "summary-skip" }
	| { kind: "summary-cancel" }
	| { kind: "input-send-first" }
	| { kind: "input-overwrite" }
	| { kind: "input-cancel" };

export function BranchConfirmDialog({ request, onResolve }: BranchConfirmDialogProps) {
	const { t } = useTranslation();
	const open = request !== null;

	return (
		<Dialog
			open={open}
			onOpenChange={(o) => {
				if (!o) {
					onResolve(request?.kind === "input-not-empty" ? { kind: "input-cancel" } : { kind: "summary-cancel" });
				}
			}}
		>
			<DialogContent className="max-w-md">
				{request?.kind === "summary" ? (
					<>
						<DialogHeader>
							<DialogTitle>{t("chat.summaryTitle")}</DialogTitle>
							<DialogDescription>{t("chat.summaryDesc")}</DialogDescription>
						</DialogHeader>
						<DialogFooter>
							<Button variant="line-ghost" size="sm" onClick={() => onResolve({ kind: "summary-skip" })}>
								{t("chat.summarySkip")}
							</Button>
							<Button variant="line-filled" size="sm" onClick={() => onResolve({ kind: "summary-generate" })}>
								{t("chat.summaryGenerate")}
							</Button>
						</DialogFooter>
					</>
				) : request?.kind === "input-not-empty" ? (
					<>
						<DialogHeader>
							<DialogTitle>{t("chat.inputNotEmptyTitle")}</DialogTitle>
							<DialogDescription>{t("chat.inputNotEmptyDesc")}</DialogDescription>
						</DialogHeader>
						<DialogFooter>
							<Button variant="line-ghost" size="sm" onClick={() => onResolve({ kind: "input-cancel" })}>
								{t("chat.inputNotEmptyCancel")}
							</Button>
							<Button variant="line" size="sm" onClick={() => onResolve({ kind: "input-overwrite" })}>
								{t("chat.inputNotEmptyOverwrite")}
							</Button>
							<Button variant="line-filled" size="sm" onClick={() => onResolve({ kind: "input-send-first" })}>
								{t("chat.inputNotEmptySendFirst")}
							</Button>
						</DialogFooter>
					</>
				) : null}
			</DialogContent>
		</Dialog>
	);
}

export default BranchConfirmDialog;
