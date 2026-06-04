import { scan } from "react-scan";
import React from "react";
import { createRoot } from "react-dom/client";
import { TooltipProvider } from "@shared/components/ui/tooltip";
import { Toaster } from "@shared/components/ui/sonner";
import App from "./App";
import "./App.css";

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
    <TooltipProvider>
      <App />
      <Toaster />
    </TooltipProvider>
  </React.StrictMode>
);
