import path from "node:path";

export interface BundledResourcePathOptions {
	isPackaged: boolean;
	resourcesPath: string;
	developmentRoot: string;
}

/**
 * Resolves the directory that contains assets shipped with Look.
 *
 * Development reads assets from the repository root. Packaged applications
 * receive them through electron-builder's extraResources in resourcesPath.
 */
export function getBundledResourceRoot(options: BundledResourcePathOptions): string {
	return options.isPackaged ? options.resourcesPath : path.resolve(options.developmentRoot);
}
