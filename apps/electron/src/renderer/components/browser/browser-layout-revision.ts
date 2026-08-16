// ============================================================
// Browser layout revision — renderer 布局代际（时间戳纪元）
//
// renderer 每次发布浏览器视图布局（browser:set-layout）都取一个
// 全局单调递增的 revision。主进程据此忽略晚到的旧布局，避免
// 跨会话/跨窗口的竞态（A 的旧 show 不能在 B 已显示后抢回前台）。
//
// 纪元 = Date.now() * 1000：主进程进程生命周期通常长于 renderer
// 页面（窗口刷新/重建），用启动时间戳做纪元可保证任何 renderer
// 发布的 revision 都大于主进程此前见过的任何值。进程内再按次递增。
// ============================================================

/** 纪元基线：模块加载时刻（renderer 一次页面生命周期的起点）。 */
const REVISION_EPOCH = Date.now() * 1000;

let revisionCounter = 0;

/** 取下一个布局 revision（严格递增，永不重复）。 */
export function nextLayoutRevision(): number {
	revisionCounter += 1;
	return REVISION_EPOCH + revisionCounter;
}
