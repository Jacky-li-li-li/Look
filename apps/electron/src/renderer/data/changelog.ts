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
		version: "2.1.0",
		date: "2026-08-09",
		items: [
			{
				zh: "新增「变更」面板与会话变更卡片：会话结束后卡片列出本轮改动的文件，点开即可查看逐行 diff；右侧面板常驻「变更」tab 展示项目全部未提交改动（新增/修改/删除/未跟踪），并可一键打开文件查看完整对比",
				en: "New “Changes” panel & session change card: after a turn, a card lists every file the agent touched with inline diff previews; a permanent “Changes” tab in the right panel shows all uncommitted project changes (added/modified/deleted/untracked) and opens any file for a full comparison",
				ja: "「変更」パネルとセッション変更カードを追加：ターン終了後にエージェントが触ったファイル一覧がカードで表示され、行単位の diff をその場で確認可能。右パネルに常設の「変更」タブで未コミットの変更（追加/変更/削除/未追跡）を一覧し、ファイルをワンクリックで全差分比較で開けます",
			},
			{
				zh: "文件查看器升级为完整文件 diff 视图：打开有变更的文件时展示全部行（带行号），变更行以绿/红底色标注，连续未变更段落自动折叠可展开；编辑保存后 diff 实时刷新",
				en: "File viewer now shows a full-file diff view: every line with line numbers, changed lines highlighted in green/red, long unchanged runs auto-collapsed with an expand button; the diff refreshes immediately after you save edits",
				ja: "ファイルビューアを完全なファイル diff ビューに刷新：全行を行番号付きで表示し、変更行を緑/赤でハイライト、長い未変更区間は自動で折りたたみ展開ボタンで表示。保存後は diff が即座に更新されます",
			},
			{
				zh: "变更卡片新增「审核」按钮：一键让 Reviewer 子会话审查本轮代码变更，审查过程与结论在子会话中完整呈现；同一轮次重复点击不会重复创建审核会话",
				en: "New “Review” button on the change card: start a Reviewer sub-session to audit the current turn's code changes with full visibility in the conversation; clicking again on the same turn reopens the same review instead of duplicating it",
				ja: "変更カードに「レビュー」ボタンを追加：ワンクリックで Reviewer サブセッションが今回のコード変更をレビューし、過程と結論は会話内に完全表示。同じターンで再クリックしてもレビューセッションは重複作成されません",
			},
			{
				zh: "修复 @文件引用：@文件名 紧贴中文时也正确显示为文件标签（此前会退化为纯文本）；拖入文件到输入框时自动补空格，避免粘连",
				en: "Fixed @file references: a file tag now renders correctly even when @filename directly follows CJK text (it previously degraded to plain text); dragging a file into the input adds a separating space automatically",
				ja: "@ファイル参照を修正：@ファイル名 が日本語/中国語テキストに隣接していてもファイルタグとして正しく表示（従来はプレーンテキストに退化）。入力欄へのファイルドラッグ時に自動でスペースを補います",
			},
			{
				zh: "其他稳定性改进：点击不存在的文件路径显示友好提示而非报错页；Plan 模式的 AskUserQuestion 问答现可在任意权限模式使用，并新增 5 分钟超时兜底；重启后子会话层级与文件路径正确恢复",
				en: "More stability fixes: clicking a missing file path shows a friendly notice instead of an error page; AskUserQuestion now works in any permission mode with a 5-minute fallback timeout; sub-session hierarchy and file paths restore correctly after restart",
				ja: "その他の安定性改善：存在しないファイルパスをクリックするとエラーページではなく親切な通知を表示。AskUserQuestion が任意の権限モードで利用可能になり 5 分のフォールバックタイムアウトを追加。再起動後もサブセッション階層とファイルパスが正しく復元されます",
			},
			{
				zh: "Reviewer 默认 Agent 更新：审查者现在可以在你明确要求时直接修改代码（此前仅限只读）；版本升级将在下次启动时自动生效",
				en: "Reviewer default agent updated: the reviewer can now edit code directly when you explicitly ask it to (previously read-only); the upgrade applies automatically on next launch",
				ja: "Reviewer デフォルトエージェントを更新：レビュー担当者があなたの明示的な指示でコードを直接修正できるようになりました（従来は読み取り専用）。アップグレードは次回起動時に自動適用されます",
			},
		],
	},
	{
		version: "2.0.0",
		date: "2026-08-09",
		items: [
			{
				zh: "新增文件查看器 Dock 面板：点击文件后直接在主窗口右侧面板中打开，面板宽度可拖拽并自动记忆；可与独立查看器窗口双向切换（合并到主窗口 / 弹出为独立窗口）",
				en: "New file viewer Dock panel: files open in a docked panel on the right side of the main window with a draggable, remembered width; swap freely between the docked panel and a standalone viewer window",
				ja: "ファイルビューアの Dock パネルを追加：ファイルがメインウィンドウ右側のパネルで開き、幅はドラッグで調整でき自動で記憶。パネルと独立ビューアウィンドウを相互に切り替え可能",
			},
			{
				zh: "支持只读查看项目目录以外的文件：打开项目外文件时显示「项目外 · 只读」标识，编辑与保存保持禁用，临时文件也能放心查看",
				en: "You can now open files outside the current project in read-only mode, with an “Outside project · Read-only” badge; editing and saving stay disabled",
				ja: "プロジェクト外のファイルも読み取り専用で閲覧可能に：「プロジェクト外・読み取り専用」バッジを表示し、編集・保存は無効のまま安全に閲覧できます",
			},
			{
				zh: "左侧面板体验升级：会话按最近内容变化排序，浏览会话不再导致列表跳动；新增项目头部（当前项目、运行/错误状态、会话与运行数量）；错误会话保持可见，直到你打开该会话或恢复对话",
				en: "Sidebar overhaul: sessions sort by recent activity without the list jumping around as you browse; a new project header shows the current project, running/error state and session counts; error sessions stay visible until you open them or resume chatting",
				ja: "サイドバーを刷新：セッションは直近の活動順に並び、閲覧してもリストが動きません。プロジェクトヘッダー（現在のプロジェクト、実行中/エラー状態、セッション数）を追加し、エラーセッションは開くか会話を再開するまで表示を維持",
			},
			{
				zh: "修复模型显示异常：会话模型缺失时自动选择可用模型，不再出现「?」图标；子会话默认继承父会话当前使用的模型",
				en: "Fixed model display issues: sessions with a missing model now automatically fall back to an available one (no more “?” icon); sub-sessions inherit the parent's current model by default",
				ja: "モデル表示の不具合を修正：モデル未設定のセッションは利用可能なモデルを自動選択し、「?」アイコンを表示しないように。サブセッションは親セッションのモデルをデフォルトで継承",
			},
			{
				zh: "启动与会话历史恢复大幅提速：打开会话时先展示最近内容，更早的历史按需分页加载，长会话首次打开不再卡顿、不再触发整屏滚动动画",
				en: "Much faster startup and session restore: recent messages appear immediately while older history loads page-by-page on demand — long sessions open without stutter and without full-screen scroll animations",
				ja: "起動とセッション履歴の復元を大幅高速化：開いた直後に直近の内容を表示し、過去の履歴は必要に応じてページ単位で読み込み。長いセッションもカクつきや全画面スクロールアニメーションなしで開きます",
			},
			{
				zh: "面板拖拽与消息渲染性能优化：拖拽右侧面板更跟手、响应更及时；拖动面板时消息区只重排可见内容，长会话不再整体卡顿",
				en: "Smoother panel dragging and message rendering: panels follow the pointer more responsively, and dragging no longer reflows the whole message list in long sessions",
				ja: "パネルのドラッグとメッセージ描画を最適化：パネルがより滑らかに追従し、ドラッグ中もメッセージエリアは表示中の内容だけを再描画するため、長いセッションでもカクつきません",
			},
			{
				zh: "修复多项会话稳定性问题：排队消息在会话重新激活后仍然保留、队列状态显示更准确、会话结束状态同步更可靠、diff 预览兼容更多补丁格式",
				en: "Session stability fixes: queued messages survive session reactivation, queue state display is more accurate, session completion state sync is more reliable, and the diff preview now handles more patch formats",
				ja: "セッション安定性を修正：キューされたメッセージが再アクティブ後も保持され、キュー状態の表示が正確に、セッション終了状態の同期が信頼性アップ、diff プレビューはより多くのパッチ形式に対応",
			},
			{
				zh: "其他修复与优化：共享区文件刷新更及时且样式与文件树统一、文件修改后切换查看不再丢失未保存内容、窄窗口下面板不再溢出、界面细节清理（移除冗余提示、消息区滚动条隐藏）",
				en: "Other fixes and polish: the shared files area refreshes promptly with styling unified to the file tree, unsaved edits are protected when switching files, panels no longer overflow on narrow windows, and UI cleanup (redundant tooltips removed, message-area scrollbar hidden)",
				ja: "その他の修正と改善：共有エリアのファイル更新が即時に反映されスタイルも統一、ファイル切替時に未保存の編集が失われないよう保護、狭いウィンドウでパネルがはみ出さないよう修正、UI を整理（冗長なツールチップ削除、メッセージエリアのスクロールバー非表示）",
			},
		],
	},
	{
		version: "1.8.0",
		date: "2026-08-05",
		items: [
			{
				zh: "新增会话底部 Git 状态栏：自动识别当前项目的仓库与分支，实时显示文件修改状态（+新增行 -删除行），非 Git 项目自动隐藏",
				en: "New Git status bar at the bottom of the chat: auto-detects your project's repository and branch and shows live file-change status (+added lines -deleted lines); hidden automatically for non-Git projects",
				ja: "チャット下部に Git ステータスバーを追加：プロジェクトのリポジトリとブランチを自動検出し、ファイル変更状態（+追加行 -削除行）をリアルタイム表示。Git でないプロジェクトでは自動的に非表示",
			},
			{
				zh: "消息区体验升级：右侧新增垂直刻度条，可快速定位任意用户消息；滚动条静止时自动隐藏、滚动或悬停时显示，更窄更美观",
				en: "Chat area polish: a new vertical tick ruler on the right lets you jump to any user message; the scrollbar now auto-hides when idle and reappears on scroll or hover, slimmer and cleaner",
				ja: "メッセージエリアを改善：右側に縦の目盛りバーを追加し、任意のユーザーメッセージへ素早く移動可能。スクロールバーは静止時に自動で隠れ、スクロール/ホバーで表示、よりスリムに",
			},
			{
				zh: "Agent 运行状态显示升级：3×3 九宫格顺时针动画配合阶段状态（思考中 / 调用工具 / 输出中）与已等待时长，运行过程一目了然",
				en: "Upgraded agent progress display: a 3×3 clockwise scanning animation with the current phase (thinking / running tool / streaming) and elapsed time, so you always know what the agent is doing",
				ja: "エージェントの実行表示を刷新：3×3 グリッドの時計回りアニメーションと現在のフェーズ（思考中/ツール実行中/出力中）、経過時間を表示",
			},
			{
				zh: "新增「显示工具组」开关（设置 → 通用）：关闭后对话中只显示文本与图片，工具调用和思考过程被隐藏，界面更清爽",
				en: "New “Show tool execution” toggle (Settings → General): turn it off to hide tool calls and thinking from the conversation, keeping only text and images",
				ja: "「ツール実行を表示」トグルを追加（設定 → 一般）：オフにすると会話にはテキストと画像のみが表示され、ツール呼び出しや思考プロセスが隠れてすっきり",
			},
			{
				zh: "新增「会话显示模式」设置（通用 → 外观）：支持消息气泡左对齐或左右对齐（用户右侧 / AI 左侧），选择即时生效",
				en: "New “Message alignment” setting (General → Appearance): left-aligned bubbles or left/right split (user right / AI left); changes apply instantly",
				ja: "「メッセージ表示モード」設定を追加（一般 → 外観）：吹き出しを左揃えにするか左右分割（ユーザー右/AI 左）にするかを選択可能、即時反映",
			},
			{
				zh: "会话栏移到窗口顶部，按钮悬停提示统一为 Tooltip；编辑工具卡新增 Proma 同款的 diff 预览，改动前后对比更直观",
				en: "The session bar moved to the top of the window with unified hover tooltips; editing tool cards now show a Proma-style diff preview for clearer before/after comparison",
				ja: "セッションバーをウィンドウ上部に移動し、ボタンのホバー表示を統一。ツールカード編集時に Proma と同じ diff プレビューを表示し、変更前後の比較が分かりやすく",
			},
			{
				zh: "移除 macOS 灵动岛（Look Island）功能：该方案不再维护，升级后不再显示；桌面通知等其他功能不受影响",
				en: "Removed the macOS Look Island feature: it is no longer maintained and disappears after upgrading; desktop notifications and other features are unaffected",
				ja: "macOS の Look Island 機能を削除：今後はメンテナンスされず、アップデート後は表示されません。デスクトップ通知などの他の機能には影響ありません",
			},
			{
				zh: "修复多项问题：Plan 模式切换模型不生效、应用更新后重启偶尔失败、消息区悬停布局膨胀、显示工具组开关关闭不生效等",
				en: "Various fixes: Plan-mode model switching not applying, occasional app-update restart failures, message area layout expanding on hover, the Show tool execution toggle not applying, and more",
				ja: "複数の問題を修正：Plan モードでのモデル切り替えが反映されない、アプリ更新後の再起動が失敗することがある、ホバー時にメッセージ領域が膨張する、「ツール実行を表示」トグルが効かない等",
			},
		],
	},
	{
		version: "1.7.3",
		date: "2026-08-04",
		items: [
			{
				zh: "修复启动后消息区不自动加载最近会话的问题：之前冷启动时可能一直停留在空状态，需要手动点击左侧会话才能看到消息，现在启动后会立即自动打开最近会话",
				en: "Fix the chat area not loading your most recent session after launch: a cold start could leave it stuck on the empty state until you manually clicked a session in the sidebar — now it opens the latest session automatically",
				ja: "起動後にチャットエリアが最新セッションを自動で読み込まない問題を修正：コールドスタート時に空状態のまま止まり、サイドバーのセッションを手動でクリックするまで表示されないことがあったが、起動後すぐに最新セッションを自動で開くように",
			},
		],
	},
	{
		version: "1.7.2",
		date: "2026-08-03",
		items: [
			{
				zh: "修复重启后首屏误显示“欢迎页”、提示重新添加项目的问题（项目数据并未丢失）；优化冷启动速度：不再等待模型目录网络刷新（最长 15 秒），侧边栏项目列表秒出",
				en: "Fix the welcome screen flashing after launch with a prompt to re-add projects (your data was never lost); speed up cold start by not waiting on the model-catalog network refresh (up to 15s) — the project list now appears instantly",
				ja: "再起動後に「ようこそ画面」が一瞬表示されプロジェクトの再追加を求められる問題を修正（データは失われていません）；モデルカタログのネットワーク更新（最大15秒）を待たずに起動を高速化、プロジェクト一覧が即座に表示されるように",
			},
		],
	},
	{
		version: "1.7.1",
		date: "2026-08-03",
		items: [
			{
				zh: "修复正式版灵动岛不显示的问题：打包流程遗漏了原生 helper 编译，现已补上，更新后灵动岛即可正常使用",
				en: "Fix Look Island not showing in the release build: the packaging pipeline missed compiling the native helper; now included so the island works after updating",
				ja: "正式版で Look Island が表示されない問題を修正：パッケージングでネイティブヘルパーのコンパイルが漏れていたため追加、更新後はアイランドが正常に動作",
			},
		],
	},
	{
		version: "1.7.0",
		date: "2026-08-03",
		items: [
			{
				zh: "新增 macOS 灵动岛（Look Island）：在灵动岛区域实时展示 Agent 运行状态与关键事件，设置页可开关（默认关闭）",
				en: "New macOS Look Island: real-time agent status and key events on the Dynamic Island; toggle in Settings (off by default)",
				ja: "macOS の Look Island を追加：ダイナミックアイランドでエージェントの実行状態と重要イベントをリアルタイム表示、設定ページで切り替え可能（初期状態はオフ）",
			},
			{
				zh: "新增桌面系统通知：应用在后台或最小化时，Agent 完成任务、请求你操作或出错都会通知，可在设置中选择通知级别",
				en: "New desktop notifications: when the app is in the background, get notified when the agent finishes a task, needs your action, or hits an error; pick the level in Settings",
				ja: "デスクトップ通知を追加：アプリがバックグラウンドのとき、エージェントのタスク完了・操作要求・エラーを通知、設定で通知レベルを選択可能",
			},
			{
				zh: "开发版与正式版数据目录隔离：开发模式使用独立的 ~/.look-dev，测试数据不再污染正式版",
				en: "Separate data directories for dev and release builds: dev mode now uses ~/.look-dev so test data never pollutes your real data",
				ja: "開発版と正式版のデータディレクトリを分離：開発モードは ~/.look-dev を使用し、テストデータが正式版を汚さないように",
			},
			{
				zh: "侧边栏体验优化：创建子会话时自动展开，修复折叠状态在重启间的竞态",
				en: "Sidebar polish: new subagent sessions expand automatically and collapse state no longer races across restarts",
				ja: "サイドバー改善：サブセッション作成時に自動展開、再起動時の折りたたみ状態の競合を修正",
			},
			{
				zh: "修复运行中的子会话短暂显示为顶层父会话的问题，会话层级即时准确",
				en: "Fix subagent sessions briefly showing as top-level sessions while running; hierarchy now reflects correctly immediately",
				ja: "実行中のサブセッションが一時的にトップレベルとして表示される問題を修正し、階層表示が即時に正しくなるように",
			},
			{
				zh: "重写项目 README，介绍更清晰",
				en: "Rewrite the project README for a clearer introduction",
				ja: "プロジェクト README を書き直し、紹介をより明確に",
			},
		],
	},
	{
		version: "1.6.0",
		date: "2026-08-02",
		items: [
			{
				zh: "新增浏览器自动化工具集：Agent 可打开网页、读取页面快照、截图并执行脚本",
				en: "New browser automation toolset: the agent can open pages, read page snapshots, take screenshots, and run scripts",
				ja: "ブラウザ自動化ツール集を追加：エージェントがページを開き、スナップショットを取得し、スクリーンショットやスクリプト実行が可能に",
			},
			{
				zh: "子会话总指挥模式：长任务按汇报点持续续等，可用 status/cancel 工具随时查看进度或取消",
				en: "Subagent commander mode: long-running tasks keep waiting at checkpoints; use status/cancel tools to view progress or cancel anytime",
				ja: "サブエージェント指揮モード：長時間タスクをチェックポイントで継続待機し、status/cancel ツールで進捗確認やキャンセルが可能に",
			},
			{
				zh: "关于页新增飞书联系卡片，版本记录展示最近 5 个版本并带渐变入场效果",
				en: "About page adds a Feishu contact card and shows the latest 5 versions with a gradient reveal",
				ja: "バージョン情報ページに Feishu 連絡先カードを追加、直近 5 バージョンをグラデーション演出付きで表示",
			},
			{
				zh: "切换会话更丝滑：同项目切换零事件风暴、免闪烁过渡，连点不再错乱",
				en: "Smoother session switching: zero event storms within a project, flicker-free transitions, and rapid-click protection",
				ja: "セッション切替がより滑らかに：同一プロジェクト内でイベント嵐を排除し、ちらつきのない遷移と連打保護を実装",
			},
			{
				zh: "修复工具组展开时页面被拽到空白区的问题，展开后面板就地呈现不再跳动",
				en: "Fix the page being pulled to blank space when expanding tool groups; panels now expand in place",
				ja: "ツールグループ展開時に空白領域へスクロールされる問題を修正し、その場で展開されるように",
			},
			{
				zh: "消息运行时长稳定常驻显示，消息渲染底层重构更稳健",
				en: "Message duration now reliably persists on display; message rendering internals rebuilt for stability",
				ja: "メッセージの実行時間表示を安定化し、レンダリング基盤を再構築して堅牢に",
			},
			{
				zh: "修复启动竞态、队列串行化与凭据容错，升级 pi SDK 0.83，深色主题 chip 恢复轮廓",
				en: "Fix startup race, serialize queue operations with credential tolerance, upgrade pi SDK 0.83, and restore chip outlines in dark theme",
				ja: "起動競合の修正、キュー操作の直列化と認証情報の耐障害性向上、pi SDK 0.83 へ更新、ダークテーマのチップ輪郭を復元",
			},
		],
	},
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
