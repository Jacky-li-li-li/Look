import { AlertTriangle, RefreshCw } from "lucide-react";
import { Component, type ErrorInfo, type ReactNode } from "react";

export interface ErrorBoundaryProps {
	children: ReactNode;
	fallback?: ReactNode;
	onError?: (error: Error, info: ErrorInfo) => void;
}

interface ErrorBoundaryState {
	hasError: boolean;
	error: Error | null;
}

/** Shared base class for ErrorBoundary and ErrorBoundarySection — eliminates duplicate constructor / getDerivedStateFromError / handleReset boilerplate. */
abstract class ErrorBoundaryBase extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
	abstract logPrefix: string;

	constructor(props: ErrorBoundaryProps) {
		super(props);
		this.state = { hasError: false, error: null };
	}

	static getDerivedStateFromError(error: Error): ErrorBoundaryState {
		return { hasError: true, error };
	}

	componentDidCatch(error: Error, info: ErrorInfo) {
		console.error(`[${this.logPrefix}] Render error:`, error, info.componentStack);
		this.props.onError?.(error, info);
	}

	handleReset = () => {
		this.setState({ hasError: false, error: null });
	};

	protected abstract renderError(): ReactNode;

	render() {
		if (this.state.hasError) {
			if (this.props.fallback) return this.props.fallback;
			return this.renderError();
		}
		return this.props.children;
	}
}

export class ErrorBoundary extends ErrorBoundaryBase {
	logPrefix = "ErrorBoundary";

	protected renderError(): ReactNode {
		return (
			<div className="flex h-full w-full flex-col items-center justify-center gap-4 p-8 text-center">
				<AlertTriangle className="size-12 text-destructive" />
				<div className="max-w-md">
					<h2 className="text-lg font-semibold text-foreground">Something went wrong</h2>
					<p className="mt-2 text-sm text-muted-foreground">
						An unexpected error occurred while rendering this section.
					</p>
					{this.state.error && (
						<pre className="mt-3 max-h-32 overflow-y-auto rounded-md border border-hairline bg-muted p-3 text-[11px] text-muted-foreground">
							{this.state.error.message}
						</pre>
					)}
				</div>
				<button
					type="button"
					onClick={this.handleReset}
					className="inline-flex items-center gap-2 rounded-md border border-hairline bg-card px-4 py-2 text-sm text-foreground hover:bg-accent transition-colors"
				>
					<RefreshCw className="size-3.5" />
					Try again
				</button>
			</div>
		);
	}
}

/**
 * Lightweight error boundary for UI sections (Sidebar, ChatPanel, etc.).
 * Shows a compact inline error card instead of a full-page takeover.
 * Multiple ErrorBoundarySections can coexist — a crash in one section
 * won't take down the others.
 */
export class ErrorBoundarySection extends ErrorBoundaryBase {
	logPrefix = "ErrorBoundarySection";

	protected renderError(): ReactNode {
		return (
			<div className="flex h-full w-full items-center justify-center p-4">
				<div className="rounded-md border border-destructive/30 bg-destructive/5 px-4 py-3 text-center">
					<p className="text-sm text-destructive">This section encountered an error.</p>
					<button
						type="button"
						onClick={this.handleReset}
						className="mt-2 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
					>
						<RefreshCw className="size-3" />
						Retry
					</button>
				</div>
			</div>
		);
	}
}
