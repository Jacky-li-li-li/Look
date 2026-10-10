/** transcribe:set-settings 的补丁载荷（独立文件：events/renderer-to-main 直接引用，避免 contracts/ipc ↔ types 循环）。 */
export interface TranscribeSettingsPatch {
	modelId?: string;
	transcriptionLanguage?: string;
	chineseOutput?: "simplified" | "traditional-taiwan" | "traditional-hong-kong";
}
