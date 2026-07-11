// Shared package entry point — re-exports non-React modules.
// UI components remain available via subpath imports (e.g. @look/shared/components/ui/button).
export * from "./types.js";
export * from "./look-storage.js";
export * from "./session-defaults.js";
export * from "./lib/utils.js";

// Generic UI components
export { default as UserAvatar } from "./components/UserAvatar.js";
export { ErrorBoundary } from "./components/ErrorBoundary.js";
export { SkillTag } from "./components/SkillTag.js";
export { AgentTag } from "./components/AgentTag.js";
export { FileTag } from "./components/FileTag.js";
export { McpTag } from "./components/McpTag.js";
