// ============================================================
// ErrorBoundary — crash-safe wrapper for key component trees
// ============================================================

import { AlertTriangle, RefreshCw } from "lucide-react";
import { Component, type ErrorInfo, type ReactNode } from "react";

interface ErrorBoundaryProps {
	children: ReactNode;
	/** Custom fallback UI. If omitted, renders the default crash screen. */
	fallback?: ReactNode;
	/** Called when an error is caught (e.g. for logging). */
	onError?: (error: Error, info: ErrorInfo) => void;
}

interface ErrorBoundaryState {
	hasError: boolean;
	error: Error | null;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
	constructor(props: ErrorBoundaryProps) {
		super(props);
		this.state = { hasError: false, error: null };
	}

	static getDerivedStateFromError(error: Error): ErrorBoundaryState {
		return { hasError: true, error };
	}

	componentDidCatch(error: Error, info: ErrorInfo) {
		console.error("[ErrorBoundary] Unhandled render error:", error, info.componentStack);
		this.props.onError?.(error, info);
	}

	handleReset = () => {
		this.setState({ hasError: false, error: null });
	};

	render() {
		if (this.state.hasError) {
			if (this.props.fallback) {
				return this.props.fallback;
			}

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

		return this.props.children;
	}
}

export default ErrorBoundary;
