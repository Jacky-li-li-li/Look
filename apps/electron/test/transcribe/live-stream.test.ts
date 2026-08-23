// ============================================================
// live-stream tests — stop() 的最终冲刷不被 stopping 守卫拦截
//
// 回归点：stop() 先把 stopping 置 true（用于停掉 feed 循环），随后
// "最后消费一次 live 文件"的 pump 若仍走同一守卫会直接 return ——
// worker 退出前 appendLive(true) 冲刷的尾部音频（最多 ~1s）将永远
// 进不了流式会话，finalize 定稿会截掉最后一个词。
//
// 测试直接装配内部状态（TS private 仅编译期生效），绕过 start() 的
// 真实定时器，确定性验证 stop() 的最终 pump 读完整文件并 feed 全部样本。
// ============================================================

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LiveStreamController } from "../../src/main/transcribe/live-stream.js";

type MutableController = {
	model: { dispose: ReturnType<typeof vi.fn> } | undefined;
	session: { dispose: ReturnType<typeof vi.fn> } | undefined;
	stream:
		| {
				feed: ReturnType<typeof vi.fn>;
				finalize: ReturnType<typeof vi.fn>;
				reset: ReturnType<typeof vi.fn>;
				text: { committed: string; tentative: string; full: string };
		  }
		| undefined;
	livePath: string | undefined;
	feedPromise: Promise<void>;
	lastFed: number;
	stopping: boolean;
	committed: string;
	tentative: string;
};

function assembleController(controller: LiveStreamController, livePath: string): MutableController {
	const state = controller as unknown as MutableController;
	state.model = { dispose: vi.fn() };
	state.session = { dispose: vi.fn() };
	state.stream = {
		feed: vi.fn(async () => ({
			resultChanged: false,
			isFinal: false,
			revision: 1,
			inputReceivedMs: 0,
			audioCommittedMs: 0,
			bufferedMs: 0,
			committedChanged: false,
			tentativeChanged: false,
		})),
		finalize: vi.fn(async () => ({
			resultChanged: true,
			isFinal: true,
			revision: 2,
			inputReceivedMs: 0,
			audioCommittedMs: 0,
			bufferedMs: 0,
			committedChanged: true,
			tentativeChanged: false,
		})),
		reset: vi.fn(),
		text: { committed: "你好", tentative: "", full: "你好" },
	};
	state.livePath = livePath;
	state.feedPromise = Promise.resolve();
	state.lastFed = 0;
	state.stopping = false;
	state.committed = "";
	state.tentative = "";
	return state;
}

describe("LiveStreamController.stop", () => {
	let dir: string;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "look-live-stream-test-"));
	});

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it("stop 的最终冲刷消费全部尾部音频（stopping 守卫不拦截）", async () => {
		const controller = new LiveStreamController();
		const livePath = join(dir, "live.f32");
		const samples = 24_000; // 1.5s @16k
		await writeFile(livePath, Buffer.from(new Float32Array(samples).fill(0.01).buffer));
		const state = assembleController(controller, livePath);
		// stop() 会把内部 stream/session/model 字段置 undefined，先捕获引用再断言。
		const stream = state.stream!;
		const model = state.model!;
		const session = state.session!;

		const { text, seconds } = await controller.stop();

		// 最终 pump 必须真正读文件并 feed（修复前：feed 从未被调用，text 为空）。
		expect(stream.feed).toHaveBeenCalledTimes(1);
		const fed = stream.feed.mock.calls[0]?.[0] as Float32Array | undefined;
		expect(fed).toBeDefined();
		expect(fed.length).toBe(samples);
		expect(text).toBe("你好");
		expect(seconds).toBe(1.5);
		expect(stream.finalize).toHaveBeenCalledTimes(1);
		expect(stream.reset).toHaveBeenCalledTimes(1);
		expect(model.dispose).toHaveBeenCalledTimes(1);
		expect(session.dispose).toHaveBeenCalledTimes(1);
		// live 临时文件已清理。
		await expect(readFile(livePath)).rejects.toThrow();
	});

	it("未在流式时不抛错以外行为：stop 抛 not streaming", async () => {
		const controller = new LiveStreamController();
		await expect(controller.stop()).rejects.toThrow(/not streaming/);
	});

	it("dispose 释放模型/会话并清理 live 文件，不执行 finalize", async () => {
		const controller = new LiveStreamController();
		const livePath = join(dir, "live.f32");
		await writeFile(livePath, Buffer.from(new Float32Array(8000).fill(0.01).buffer));
		const state = assembleController(controller, livePath);
		const stream = state.stream!;
		const model = state.model!;
		const session = state.session!;

		await controller.dispose();

		expect(model.dispose).toHaveBeenCalledTimes(1);
		expect(session.dispose).toHaveBeenCalledTimes(1);
		expect(stream.feed).not.toHaveBeenCalled();
		expect(stream.finalize).not.toHaveBeenCalled();
		await expect(readFile(livePath)).rejects.toThrow();
	});
});
