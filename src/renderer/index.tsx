import { Toaster } from "@shared/components/ui/sonner";
import { TooltipProvider } from "@shared/components/ui/tooltip";
import { Provider } from "jotai";
import React from "react";
import { createRoot } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { scan } from "react-scan";
import App from "./App";
import "./App.css";
import i18n from "./i18n";
import { appStore, initAppData, initIpcHandlers } from "./store/ipcHandler";

if (import.meta.env.DEV) {
	scan({
		enabled: true,
		log: true,
		showToolbar: true,
	});
}

const api = (window as any).look;

// IPC event handlers run outside React lifecycle via vanilla Jotai store.
// This decouples high-frequency events (agent:usage-update, etc.) from the
// component tree, so e.g. token usage updates only re-render the Sidebar row
// instead of the entire ChatPanel.
// Register IPC handlers outside React lifecycle.
if (api) initIpcHandlers(api);

// Start loading persistent data (agents, history, settings) immediately.
// This was previously split across multiple useEffect hooks in App.tsx.
if (api) {
	initAppData(api);
}

const root = createRoot(document.getElementById("root")!);
root.render(
	<React.StrictMode>
		<I18nextProvider i18n={i18n}>
			<TooltipProvider>
				<Provider store={appStore}>
					<App />
					<Toaster />
				</Provider>
			</TooltipProvider>
		</I18nextProvider>
	</React.StrictMode>,
);
