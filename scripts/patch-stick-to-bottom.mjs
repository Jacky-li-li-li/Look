#!/usr/bin/env node
/**
 * 幂等 vendor patch — use-stick-to-bottom@1.1.6
 *
 * 修复导致"流式输出不跟随 / 输出完不贴底"的三个缺陷：
 *
 * 1) RO positive-resize 分支恢复 near-bottom 贴底状态
 *    库的 handleScroll 恢复检测在流式期间几乎总是被 `resizeDifference`
 *    拦截吞掉（内容每帧增长 → RO 每帧置非零 → 恢复窗口 <2%）。一旦用户
 *    向上滚过（哪怕 1px），内部 isAtBottom 永久卡 false，所有跟随动画
 *    第一帧直接放弃 → 流式完全不跟随、输出完不贴底。
 *    修复：内容增长时若视口仍 near-bottom 且未逃逸，直接恢复 isAtBottom。
 *
 * 2) window blur / documentElement mouseleave 重置 mouseDown
 *    拖选文本时把鼠标拖出窗口，mouseup 永远不派发 → 模块级 mouseDown 卡
 *    true → isSelecting() 让动画无限等待，之后所有流式"不跟随"。
 *    修复：窗口失焦或指针离开文档时重置 mouseDown。
 *
 * 3) 组件卸载后停止动画链（state.disposed）
 *    contentRef 回调在卸载（content=null）时只断开 ResizeObserver，已排队的
 *    scrollToBottom 动画 promise 链不会取消。React StrictMode 双挂载下旧实例
 *    的动画链与新的并发写同一 scrollTop，位移叠加导致强弹簧过冲（测试环境
 *    复现 scrollTop 冲到容器 clamp 上限）；生产环境切会话也会残留写入。
 *    修复：content=null 时置 state.disposed=true，动画帧首行检查并停止；
 *    重新挂载（content 非 null）时重置为 false。
 *
 * 用法：node scripts/patch-stick-to-bottom.mjs（幂等，可重复执行）
 * 已接入根 package.json 的 postinstall，npm install 后自动生效。
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const target = resolve(__dirname, "../node_modules/use-stick-to-bottom/dist/useStickToBottom.js");

const patches = [
	{
		name: "restore isAtBottom on positive resize near bottom",
		marker: "Proma patch: restore sticky state on content growth",
		search: `            if (difference >= 0) {
                /**
                 * If it's a positive resize, scroll to the bottom when
                 * we're already at the bottom.
                 */`,
		replace: `            if (difference >= 0) {
                /**
                 * Proma patch: restore sticky state on content growth.
                 * The handleScroll recovery check is swallowed by resizeDifference
                 * while content grows every frame (streaming); if the viewport is
                 * still near the bottom and the user has not escaped, restore
                 * isAtBottom here so follow animations are not dropped.
                 */
                if (state.isNearBottom && !state.escapedFromLock) {
                    setIsAtBottom(true);
                }
                /**
                 * If it's a positive resize, scroll to the bottom when
                 * we're already at the bottom.
                 */`,
	},
	{
		name: "reset mouseDown on blur / mouseleave",
		marker: "Proma patch: reset mouseDown on blur/mouseleave",
		search: `globalThis.document?.addEventListener("click", () => {
    mouseDown = false;
});`,
		replace: `globalThis.document?.addEventListener("click", () => {
    mouseDown = false;
});
// Proma patch: reset mouseDown on blur/mouseleave so a lost mouseup
// (e.g. dragging outside the window) cannot stall the animation loop.
globalThis.window?.addEventListener("blur", () => {
    mouseDown = false;
});
globalThis.document?.addEventListener("mouseleave", () => {
    mouseDown = false;
});`,
	},
	{
		name: "mark disposed on unmount (contentRef=null)",
		marker: "Proma patch: dispose animation chain on unmount (contentRef)",
		search: `    const contentRef = useRefCallback((content) => {
        state.resizeObserver?.disconnect();
        state.resizeObserver = undefined;
        if (!content) {
            return;
        }`,
		replace: `    const contentRef = useRefCallback((content) => {
        state.resizeObserver?.disconnect();
        state.resizeObserver = undefined;
        // Proma patch: dispose animation chain on unmount (contentRef)
        if (!content) {
            state.disposed = true;
            return;
        }
        state.disposed = false;`,
	},
	{
		name: "stop animation loop when disposed",
		marker: "Proma patch: dispose animation chain on unmount (loop check)",
		search: `        const promise = new Promise(requestAnimationFrame).then(() => {
                if (!state.isAtBottom) {`,
		replace: `        const promise = new Promise(requestAnimationFrame).then(() => {
                // Proma patch: dispose animation chain on unmount (loop check)
                if (state.disposed) {
                    state.animation = undefined;
                    return false;
                }
                if (!state.isAtBottom) {`,
	},
];

if (!existsSync(target)) {
	console.error(`[patch-stick-to-bottom] target not found: ${target}`);
	process.exit(1);
}

let src = readFileSync(target, "utf8");
let changed = false;
let failed = false;

for (const patch of patches) {
	if (src.includes(patch.marker)) {
		console.log(`[patch-stick-to-bottom] already patched: ${patch.name}`);
		continue;
	}
	if (!src.includes(patch.search)) {
		console.error(`[patch-stick-to-bottom] pattern not found for: ${patch.name} — library version may have changed`);
		failed = true;
		continue;
	}
	src = src.replace(patch.search, patch.replace);
	changed = true;
	console.log(`[patch-stick-to-bottom] patched: ${patch.name}`);
}

if (failed) process.exitCode = 1;
if (changed) {
	writeFileSync(target, src);
	console.log(`[patch-stick-to-bottom] wrote ${target}`);
}
