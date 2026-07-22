import { join } from "node:path";

/** Resolves Vite's renderer output from the compiled main-process directory. */
export function getPackagedRendererIndexPath(mainModuleDir: string): string {
	return join(mainModuleDir, "../../renderer", "index.html");
}
