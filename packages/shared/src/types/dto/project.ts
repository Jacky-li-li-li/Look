/** Project info — represents a workspace folder */
export interface ProjectInfo {
	id: string; // 8-char uuid, or "__default__" for the built-in default workspace
	name: string; // display name, derived from folder name
	cwd: string; // absolute path to project directory
	createdAt: number;
	valid: boolean; // whether cwd exists on disk (false if moved/deleted)
}
