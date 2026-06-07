import { Toaster } from "@shared/components/ui/sonner";
import { TooltipProvider } from "@shared/components/ui/tooltip";
import React from "react";
import { createRoot } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { scan } from "react-scan";
import App from "./App";
import "./App.css";
import i18n from "./i18n";

if (import.meta.env.DEV) {
	scan({
		enabled: true,
		log: true,
		showToolbar: true,
	});
}

const root = createRoot(document.getElementById("root")!);
root.render(
	<React.StrictMode>
		<I18nextProvider i18n={i18n}>
			<TooltipProvider>
				<App />
				<Toaster />
			</TooltipProvider>
		</I18nextProvider>
	</React.StrictMode>,
);
