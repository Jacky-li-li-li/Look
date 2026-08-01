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
		version: "1.5.0",
		date: "2026-08-02",
		items: [
			{
				zh: "应用更新体验升级：发现新版本后自动下载，顶部胶囊实时显示进度，下载完成一键重启安装",
				en: "Update UX upgrade: new versions download automatically with a live progress pill in the header; one click restarts to install when ready",
				ja: "アップデート体験を刷新：新バージョンを自動ダウンロードし、ヘッダーのピルで進捗を表示、準備完了後ワンクリックで再起動してインストール",
			},
			{
				zh: "聊天中的工具结果与图片消息支持点击放大预览",
				en: "Tool results and image messages in chat can be clicked to preview enlarged",
				ja: "チャット内のツール結果や画像メッセージをクリックして拡大プレビュー可能に",
			},
			{
				zh: "文件查看器支持图片预览",
				en: "File viewer now previews images",
				ja: "ファイルビューアが画像プレビューに対応",
			},
			{
				zh: "新增 macOS 桌面操作工具集：支持屏幕截图与模拟键鼠操作",
				en: "New macOS desktop automation toolset: screen capture and simulated keyboard/mouse actions",
				ja: "macOS デスクトップ操作ツール集を追加：スクリーンショットとキーボード/マウス操作をシミュレート",
			},
			{
				zh: "输入框快捷工具收敛为 Tool 按钮面板，文件拖拽体验优化",
				en: "Input quick tools consolidated into a Tool button panel; better file drag-and-drop",
				ja: "入力欄のクイックツールを Tool ボタンパネルに整理し、ファイルのドラッグ＆ドロップを改善",
			},
			{
				zh: "空状态问候按时段自动切换，新增深夜档文案",
				en: "Empty-state greetings switch by time of day, with a new late-night message",
				ja: "時間帯に応じて空状態の挨拶を自動切替、深夜向けメッセージを追加",
			},
		],
	},
	{
		version: "1.4.0",
		date: "2026-07-31",
		items: [
			{
				zh: "新增 Plan 模式专属模型选择功能，可在 Plan 模式下独立配置使用的模型",
				en: "Plan mode now has its own model selector — configure a separate model for planning sessions",
				ja: "Plan モード専用のモデル選択機能を追加。Plan モードで使用するモデルを個別に設定可能",
			},
			{
				zh: "子代理修复：解决 pending 泄漏、委托状态异常、错误路径覆盖不全的问题",
				en: "Subagent fixes: resolved pending leaks, delegation state errors, and uncovered error paths",
				ja: "サブエージェント修正：pending リーク、委任状態の異常、エラーパスの不備を解消",
			},
			{
				zh: "修复 Plan 模式下权限许可后交互卡死及跨会话阻塞的问题",
				en: "Fixed interaction hangs after granting permissions in Plan mode and cross-session blocking",
				ja: "Plan モードでの権限許可後の操作不能とセッション間ブロッキングを修正",
			},
			{
				zh: "会话压缩（compaction）重构：与 pi SDK 设计对齐，新增结果捕获与设置界面",
				en: "Session compaction refactored to align with pi SDK design: added result capture and settings UI",
				ja: "セッション圧縮（compaction）をリファクタリング：pi SDK 設計に準拠、結果キャプチャと設定 UI を追加",
			},
			{
				zh: "macOS 窗口控制按钮垂直对齐调整",
				en: "Adjusted macOS traffic-light button vertical alignment",
				ja: "macOS のウィンドウ制御ボタンの垂直配置を調整",
			},
			{
				zh: "侧栏修复：收起时打开文件夹按钮不再隐藏，展开动画改为 grid + translateX 消除闪烁",
				en: "Sidebar fixes: open-folder button no longer hides on collapse, expand animation switched to grid + translateX to eliminate flicker",
				ja: "サイドバー修正：折りたたみ時にフォルダボタンが非表示にならないよう改善、展開アニメーションを grid + translateX に変更しちらつきを解消",
			},
		],
	},
	{
		version: "1.3.12",
		date: "2026-07-27",
		items: [
			{
				zh: "修复应用常驻后台（关闭窗口未退出）时检测不到新版本的问题：现在打开窗口或系统唤醒后会自动补检，更新提示更及时可靠",
				en: "Fixed missed update detection while the app stayed in the background (window closed without quitting): it now re-checks when a window opens or the system wakes, so update prompts arrive reliably",
				ja: "アプリがバックグラウンド常駐（ウィンドウを閉じただけ）の間に新バージョンを検出できない問題を修正：ウィンドウ表示やシステム復帰時に自動で再確認し、更新通知が確実に届くようになりました",
			},
		],
	},
	{
		version: "1.3.11",
		date: "2026-07-27",
		items: [
			{
				zh: "新增 GitHub 和 Google OAuth 登录，支持浏览器窗口 PKCE 安全授权流程",
				en: "New GitHub and Google OAuth login with secure PKCE flow via browser window",
				ja: "GitHub および Google OAuth ログイン追加、ブラウザウィンドウによる安全な PKCE フローに対応",
			},
			{
				zh: "子代理调用卡片：消息流中的子代理工具调用以分组头像卡片展示，点击可查看任务摘要",
				en: "Subagent call cards: subagent tool calls now appear as grouped avatar cards, tap to inspect task brief",
				ja: "サブエージェント呼び出しカード：サブエージェントのツール呼び出しをグループ化されたアバターカードで表示、タップでタスク概要を確認可能",
			},
			{
				zh: "子代理会话统一使用「Agent：标题」命名，标题更清晰可辨识",
				en: 'Subagent sessions now consistently named "Agent: <title>" for better identification',
				ja: "サブエージェントセッションを「Agent：<タイトル>」で統一命名、識別性を向上",
			},
			{
				zh: "聊天中的 /skill:name 指令以标签芯片展示，不再展开完整内容",
				en: "Chat /skill:name commands now render as tag chips instead of expanded content",
				ja: "チャット内の /skill:name コマンドをタグチップで表示、全文展開しないように改善",
			},
			{
				zh: "多项修复：skill 菜单去重防冲突、段落渲染兼容外部图片、OAuth 报错优化、代码格式化修正",
				en: "Fixes: skill menu deduplication, paragraph rendering for external images, improved OAuth error messages, and code formatting",
				ja: "複数の修正：スキルメニュー重複排除、外部画像対応の段落レンダリング、OAuth エラー表示改善、コード整形修正",
			},
		],
	},
	{
		version: "1.3.10",
		date: "2026-07-26",
		items: [
			{
				zh: "消息队列修复：忙碌时 Enter 为打断式引导，Ctrl+Enter 为排队追加；每条排队消息可撤回或立即插入",
				en: "Message queue fix: Enter while busy sends a steering interrupt, Ctrl+Enter queues a follow-up; each queued message can be recalled or inserted immediately",
				ja: "メッセージキュー修正：ビジー中は Enter で割り込み誘導、Ctrl+Enter でフォローアップキュー；各キューイングメッセージは撤回または即時挿入可能",
			},
		],
	},
	{
		version: "1.3.9",
		date: "2026-07-26",
		items: [
			{
				zh: "修复自动更新：取消自动重启后界面状态与实际行为保持一致",
				en: "Auto-update fix: cancelling auto-restart now stays in sync with actual behavior",
				ja: "自動更新の修正：自動再起動のキャンセル後、表示と実際の動作が一致するように",
			},
			{
				zh: "修复窗口已关闭时更新下载完成会无预警自动重启的问题",
				en: "Fixed the app auto-restarting without warning when an update finishes while the window is closed",
				ja: "ウィンドウを閉じた状態で更新が完了すると予告なく自動再起動する問題を修正",
			},
		],
	},
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
				en: 'Choosing "Always allow this session" now updates the permission indicator',
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
		version: "1.3.5",
		date: "2026-07-26",
		items: [
			{
				zh: "修复构建与 CI 发布流程问题（无功能变更）",
				en: "Build and CI release pipeline fixes (no functional changes)",
				ja: "ビルドと CI リリースフローの修正（機能変更なし）",
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
