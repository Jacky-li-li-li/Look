import { cn } from "@look/ui";
import { Button } from "@look/ui/components/ui/button";
import { ArrowLeft, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

type WorkspacePageHeaderProps = {
	title: string;
	description?: string;
	backLabel: string;
	onBack: () => void;
	sidebarCollapsed?: boolean;
	icon?: LucideIcon;
	stats?: ReactNode;
	action?: ReactNode;
	className?: string;
};

export function WorkspacePageHeader({
	title,
	description,
	backLabel,
	onBack,
	sidebarCollapsed = false,
	icon: Icon,
	stats,
	action,
	className,
}: WorkspacePageHeaderProps) {
	return (
		<header
			data-page-header
			className={cn(
				"session-sheet-bar app-drag flex min-h-14 shrink-0 items-center justify-between gap-3 border-b border-hairline bg-background/80 px-3 py-2.5 backdrop-blur-xl sm:px-5",
				sidebarCollapsed && "mac-titlebar-pad",
				className,
			)}
		>
			<div className="flex min-w-0 flex-1 items-center gap-2.5">
				<Button variant="line" size="sm" className="gap-1 px-2 sm:px-2.5" onClick={onBack} aria-label={backLabel}>
					<ArrowLeft className="size-3.5" />
					<span className="hidden sm:inline">{backLabel}</span>
				</Button>
				{Icon && (
					<span className="hidden size-8 shrink-0 items-center justify-center rounded-lg border border-primary/20 bg-primary/10 text-primary sm:inline-flex">
						<Icon className="size-4" />
					</span>
				)}
				<div className="min-w-0 flex-1">
					<h1 className="truncate text-[15px] font-semibold tracking-tight text-foreground">{title}</h1>
					{description && (
						<p className="mt-0.5 line-clamp-1 max-w-[62ch] text-[11px] leading-4 text-muted-foreground">
							{description}
						</p>
					)}
				</div>
			</div>
			{(stats || action) && (
				<div className="flex shrink-0 items-center gap-2">
					{stats}
					{action}
				</div>
			)}
		</header>
	);
}

type WorkspaceStatProps = {
	value: ReactNode;
	label: string;
	tone?: "neutral" | "success" | "warning";
};

export function WorkspaceStat({ value, label, tone = "neutral" }: WorkspaceStatProps) {
	const toneClass = {
		neutral: "bg-muted/60 text-muted-foreground",
		success: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
		warning: "bg-amber-500/10 text-amber-700 dark:text-amber-300",
	}[tone];

	return (
		<div className={cn("hidden items-center gap-1.5 rounded-full px-2.5 py-1 text-[10px] sm:flex", toneClass)}>
			<span className="font-semibold tabular-nums text-foreground">{value}</span>
			<span>{label}</span>
		</div>
	);
}

type WorkspaceEmptyStateProps = {
	icon: LucideIcon;
	title: string;
	description?: string;
	action?: ReactNode;
	className?: string;
};

export function WorkspaceEmptyState({ icon: Icon, title, description, action, className }: WorkspaceEmptyStateProps) {
	return (
		<div
			className={cn(
				"flex min-h-[260px] flex-1 flex-col items-center justify-center px-6 py-12 text-center",
				className,
			)}
		>
			<div className="flex size-12 items-center justify-center rounded-2xl border border-dashed border-primary/30 bg-primary/8 text-primary">
				<Icon className="size-5" />
			</div>
			<p className="mt-4 text-[13px] font-semibold text-foreground">{title}</p>
			{description && (
				<p className="mt-1 max-w-sm text-[11px] leading-relaxed text-muted-foreground">{description}</p>
			)}
			{action && <div className="mt-4">{action}</div>}
		</div>
	);
}

export function WorkspaceLoadingState({ label }: { label: string }) {
	return (
		<div
			className="flex min-h-[260px] flex-1 flex-col items-center justify-center gap-3"
			role="status"
			aria-label={label}
		>
			<div className="flex items-center gap-1.5">
				<span className="size-1.5 animate-pulse rounded-full bg-primary" />
				<span className="size-1.5 animate-pulse rounded-full bg-primary [animation-delay:120ms]" />
				<span className="size-1.5 animate-pulse rounded-full bg-primary [animation-delay:240ms]" />
			</div>
			<span className="text-[11px] text-muted-foreground">{label}</span>
		</div>
	);
}

export function WorkspaceSectionHeading({
	icon: Icon,
	title,
	count,
}: {
	icon?: LucideIcon;
	title: string;
	count?: ReactNode;
}) {
	return (
		<div className="flex items-center justify-between gap-3 px-1">
			<div className="flex min-w-0 items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
				{Icon && <Icon className="size-3.5 text-primary" />}
				<span className="truncate">{title}</span>
			</div>
			{count !== undefined && <span className="text-[10px] tabular-nums text-muted-foreground/70">{count}</span>}
		</div>
	);
}
