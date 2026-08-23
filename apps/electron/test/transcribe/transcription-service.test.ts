// ============================================================
// transcription-service tests — serial queue + model reuse/swap
// ============================================================

import { describe, expect, it, vi } from "vitest";
import { TranscriptionService } from "../../src/main/transcribe/transcription-service.js";

type Backend = {
	prepare: ReturnType<typeof vi.fn>;
	transcribe: ReturnType<typeof vi.fn>;
	dispose: ReturnType<typeof vi.fn>;
};

function makeBackend(): Backend {
	return {
		prepare: vi.fn().mockResolvedValue(undefined),
		transcribe: vi.fn().mockResolvedValue("hello"),
		dispose: vi.fn().mockResolvedValue(undefined),
	};
}

describe("TranscriptionService", () => {
	it("串行执行任务（同一模型复用，不重复加载）", async () => {
		const backend = makeBackend();
		const createBackend = vi.fn(() => backend);
		const service = new TranscriptionService(createBackend);
		const pcm = new Float32Array(1600);

		const [a, b, c] = await Promise.all([
			service.transcribeFile("/models/a.gguf", pcm),
			service.transcribeFile("/models/a.gguf", pcm),
			service.transcribeFile("/models/a.gguf", pcm),
		]);
		expect([a, b, c]).toEqual(["hello", "hello", "hello"]);
		expect(createBackend).toHaveBeenCalledTimes(1); // 单模型驻留，只创建一次
		expect(backend.dispose).not.toHaveBeenCalled();
	});

	it("切换模型时卸载旧模型并加载新模型", async () => {
		const backendA = makeBackend();
		const backendB = makeBackend();
		const service = new TranscriptionService((path) => (path.includes("a") ? backendA : backendB));

		await service.transcribeFile("/models/a.gguf", new Float32Array(1600));
		await service.transcribeFile("/models/b.gguf", new Float32Array(1600));

		expect(backendA.dispose).toHaveBeenCalledTimes(1);
		expect(backendB.prepare).toHaveBeenCalledTimes(1);
	});

	it("任务中止：排队中 abort 直接拒绝且不执行", async () => {
		const backend = makeBackend();
		backend.transcribe.mockImplementation(() => new Promise((resolve) => setTimeout(() => resolve("done"), 50)));
		const service = new TranscriptionService(() => backend);
		const controller = new AbortController();

		const first = service.transcribeFile("/models/a.gguf", new Float32Array(1600));
		const second = service.transcribeFile("/models/a.gguf", new Float32Array(1600), {
			signal: controller.signal,
		});
		controller.abort();

		await expect(second).rejects.toThrow(/aborted|cancelled/i);
		await first;
		// 只执行了第一个任务
		expect(backend.transcribe).toHaveBeenCalledTimes(1);
	});

	it("shutdown 拒绝剩余任务并卸载模型", async () => {
		const backend = makeBackend();
		backend.transcribe.mockImplementation(
			() => new Promise((resolve) => setTimeout(() => resolve({ text: "done" }), 30)),
		);
		const service = new TranscriptionService(() => backend);

		const pending = service.transcribeFile("/models/a.gguf", new Float32Array(1600));
		await new Promise((r) => setTimeout(r, 5)); // 让第一个任务开始执行
		const queuedPromise = service.transcribeFile("/models/a.gguf", new Float32Array(1600));
		queuedPromise.catch(() => undefined); // 先占位，避免 shutdown 立即 reject 产生 unhandled rejection

		await service.shutdown();
		await expect(queuedPromise).rejects.toThrow(/shutting down/);
		await pending;
		expect(backend.dispose).toHaveBeenCalled();
	});
});
