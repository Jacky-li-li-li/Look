// ============================================================
// CHANGELOG — 版本记录（设置 → 关于 页展示）
//
// 每次发版时在数组头部追加一条。items 面向用户描述"改了什么、
// 对你有什么影响"，不要写内部实现细节。ja 缺省时回退到 en。
// ============================================================

export interface ChangelogItem {
	zh: string;
	en: string;
	ja?: string;
}

export interface ChangelogEntry {
	version: string;
	/** YYYY-MM-DD */
	date: string;
	items: ChangelogItem[];
}

export const CHANGELOG: ChangelogEntry[] = [
	{
		version: "1.3.8",
		date: "2026-07-26",
		items: [
			{
				zh: "「关于」页重新设计：新增版本记录，点击可展开每版更新内容",
				en: "Redesigned About page with release notes — tap a version to expand its changes",
				ja: "「About」ページを刷新：リリースノートを追加、バージョンをタップで変更内容を展開",
			},
			{
				zh: "更新下载进度改为进度条展示",
				en: "Update download progress now shows a progress bar",
				ja: "ダウンロード進捗をプログレスバーで表示",
			},
			{
				zh: "权限弹窗选择「本次会话始终允许」后，输入框权限指示同步切换",
				en: "Choosing \"Always allow this session\" now updates the permission indicator",
				ja: "「このセッションでは常に許可」選択後、権限インジケーターが連動",
			},
			{
				zh: "个人信息页显示完整登录邮箱",
				en: "Profile page now shows the full login email",
				ja: "プロフィールページにログインメールを全文表示",
			},
		],
	},
	{
		version: "1.3.7",
		date: "2026-07-26",
		items: [
			{
				zh: "更新下载完成后 5 秒自动重启安装，可一键取消",
				en: "Updates now restart and install automatically 5s after download — cancellable",
				ja: "ダウンロード完了後5秒で自動的に再起動・インストール（キャンセル可）",
			},
		],
	},
	{
		version: "1.3.6",
		date: "2026-07-26",
		items: [
			{
				zh: "新增应用内自动更新：发现新版本可一键下载并重启安装",
				en: "In-app auto-update: download and restart to install with one click",
				ja: "アプリ内自動更新：ワンクリックでダウンロード・再起動インストール",
			},
			{
				zh: "修复设置弹窗位置偏移的问题",
				en: "Fixed the Settings dialog being off-center",
				ja: "設定ダイアログの位置ずれを修正",
			},
		],
	},
	{
		version: "1.3.4",
		date: "2026-07-25",
		items: [
			{
				zh: "首个经过 Apple 签名与公证的公开版本",
				en: "First public release, signed and notarized by Apple",
				ja: "Apple 署名・公証済みの初公開バージョン",
			},
		],
	},
];
