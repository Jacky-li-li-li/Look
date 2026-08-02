// ============================================================
// Browser Launch — puppeteer-core Chromium 启动器
//
// 使用 puppeteer-core 连接本地 Chromium。
// 优先检测环境变量 BROWSER_EXECUTABLE_PATH，其次自动探测
// 系统安装的 Chrome（macOS 常见路径 / @puppeteer/browsers）。
// ============================================================

import type { Browser, PuppeteerNode } from "puppeteer-core";

let puppeteerModule: PuppeteerNode | null = null;

async function loadPuppeteer(): Promise<PuppeteerNode> {
	if (!puppeteerModule) {
		const mod = await import("puppeteer-core");
		// puppeteer-core 的 CJS/ESM 导出结构导致 `mod.default` 被推断为整个
		// 模块类型；运行时它确实是 PuppeteerNode 实例，这里显式收窄。
		puppeteerModule = mod.default as unknown as PuppeteerNode;
	}
	return puppeteerModule;
}

export interface LaunchResult {
	browser: Browser;
	headless: boolean;
}

const DEFAULT_VIEWPORT = { width: 1280, height: 720 };

/** 查找可用的 Chromium 可执行文件路径。 */
async function findChromiumPath(): Promise<string> {
	// 1. 环境变量
	const envPath = process.env.BROWSER_EXECUTABLE_PATH;
	if (envPath) return envPath;

	// 2. 系统安装的 Chrome（@puppeteer/browsers 计算标准安装路径）
	try {
		const { computeSystemExecutablePath, Browser: B, ChromeReleaseChannel } = await import("@puppeteer/browsers");
		const systemPath = computeSystemExecutablePath({
			browser: B.CHROME,
			channel: ChromeReleaseChannel.STABLE,
		});
		return systemPath;
	} catch {
		// fall through
	}

	// 3. macOS 常见路径
	const { platform } = process;
	if (platform === "darwin") {
		const macPaths = [
			"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
			"/Applications/Chromium.app/Contents/MacOS/Chromium",
			"/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
		];
		const { existsSync } = await import("node:fs");
		for (const p of macPaths) {
			if (existsSync(p)) return p;
		}
	} else if (platform === "linux") {
		return "google-chrome";
	} else if (platform === "win32") {
		return "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
	}

	throw new Error(
		"No Chromium binary found. Set BROWSER_EXECUTABLE_PATH env var " +
			"or install one of: google-chrome, chromium, @puppeteer/browsers",
	);
}

export async function launch(options: {
	headless?: boolean;
	viewport?: { width: number; height: number };
}): Promise<LaunchResult> {
	const puppeteer = await loadPuppeteer();
	const executablePath = await findChromiumPath();
	const headless = options.headless ?? true;
	const viewport = options.viewport ?? DEFAULT_VIEWPORT;

	const browser = await puppeteer.launch({
		executablePath,
		headless,
		args: [
			"--no-sandbox",
			"--disable-setuid-sandbox",
			"--disable-dev-shm-usage",
			"--disable-gpu",
			`--window-size=${viewport.width},${viewport.height}`,
		],
		defaultViewport: viewport,
	});

	return { browser, headless };
}
