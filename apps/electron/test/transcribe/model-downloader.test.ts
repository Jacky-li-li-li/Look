// ============================================================
// model-downloader tests — dual-source fallback + sha256/size verify
// ============================================================

import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TranscribeModelInfo } from "../../src/main/transcribe/model-catalog.js";
import { downloadModel, findDownloadedModel, transcribeModelPath } from "../../src/main/transcribe/model-downloader.js";

function makeModel(overrides: Partial<TranscribeModelInfo> = {}): TranscribeModelInfo {
	const content = Buffer.from("fake-model-content-0123456789");
	return {
		id: "test-model",
		name: "Test Model",
		description: "",
		repository: "test-org/test-model",
		revision: "a".repeat(40),
		filename: "model.gguf",
		size: content.length,
		sha256: createHash("sha256").update(content).digest("hex"),
		quant: "Q8_0",
		parameters: "1B",
		languages: ["en"],
		streaming: false,
		languageDetection: false,
		...overrides,
	};
}

function mockFetchWithBodies(bodies: Record<string, { status?: number; body?: Buffer | string }>): void {
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: string | URL | Request) => {
			const url = String(input);
			const hit = bodies[url];
			if (!hit) return new Response("not found", { status: 404 });
			if (hit.status !== undefined && hit.status >= 400) {
				return new Response("error", { status: hit.status });
			}
			const body = hit.body ?? Buffer.from("");
			return new Response(new Uint8Array(body as Uint8Array), {
				status: 200,
				headers: { "content-length": String(body.length) },
			});
		}),
	);
}

describe("model-downloader", () => {
	let lookDir: string;

	beforeEach(async () => {
		lookDir = await mkdtemp(join(tmpdir(), "look-transcribe-test-"));
		// 默认：官方源 404 → 自动回退镜像源成功（双源回退主路径）
		const model = makeModel();
		const mirrorUrl = `https://hf-mirror.com/${model.repository}/resolve/${model.revision}/${model.filename}`;
		mockFetchWithBodies({ [mirrorUrl]: { body: Buffer.from("fake-model-content-0123456789") } });
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("回退：官方源失败时自动从镜像源下载并校验", async () => {
		const model = makeModel();
		const progress: number[] = [];
		const path = await downloadModel(lookDir, model, {
			onProgress: (p) => progress.push(p.downloaded),
		});
		expect(path).toBe(transcribeModelPath(lookDir, model));
		expect(await readFile(path, "utf8")).toBe("fake-model-content-0123456789");
		expect(progress.at(-1)).toBe(model.size);
		// 官方源确实被尝试过（404），镜像源成功
		const fetchMock = vi.mocked(fetch);
		const urls = fetchMock.mock.calls.map((c) => String(c[0]));
		expect(urls).toHaveLength(2);
		expect(urls[0]).toContain("huggingface.co");
		expect(urls[1]).toContain("hf-mirror.com");
	});

	it("官方源直接成功（无需回退）", async () => {
		const model = makeModel();
		const officialUrl = `https://huggingface.co/${model.repository}/resolve/${model.revision}/${model.filename}`;
		mockFetchWithBodies({ [officialUrl]: { body: Buffer.from("fake-model-content-0123456789") } });
		const path = await downloadModel(lookDir, model);
		expect(await readFile(path, "utf8")).toBe("fake-model-content-0123456789");
	});

	it("两个源都失败时抛错并清理临时文件", async () => {
		const model = makeModel();
		mockFetchWithBodies({}); // 所有 URL 404
		await expect(downloadModel(lookDir, model)).rejects.toThrow(/模型下载失败/);
		const dir = join(lookDir, "models", model.id);
		const files = await import("node:fs/promises").then((fs) => fs.readdir(dir));
		expect(files.some((f) => f.includes(".incomplete"))).toBe(false);
	});

	it("sha256 不匹配时报错（防篡改/损坏）", async () => {
		const model = makeModel();
		const mirrorUrl = `https://hf-mirror.com/${model.repository}/resolve/${model.revision}/${model.filename}`;
		// 长度与 catalog 一致但内容不同 → 触发 sha256 校验失败
		mockFetchWithBodies({ [mirrorUrl]: { body: Buffer.from("x".repeat(model.size)) } });
		await expect(downloadModel(lookDir, model)).rejects.toThrow(/sha256 verification failed/);
	});

	it("size 不匹配时报错", async () => {
		const model = makeModel();
		const mirrorUrl = `https://hf-mirror.com/${model.repository}/resolve/${model.revision}/${model.filename}`;
		mockFetchWithBodies({ [mirrorUrl]: { body: Buffer.from("short") } });
		await expect(downloadModel(lookDir, model)).rejects.toThrow(/size mismatch/);
	});

	it("已存在完整模型时直接复用，不发请求", async () => {
		const model = makeModel();
		const finalPath = transcribeModelPath(lookDir, model);
		await import("node:fs/promises").then((fs) => fs.mkdir(join(lookDir, "models", model.id), { recursive: true }));
		await writeFile(finalPath, "fake-model-content-0123456789");
		const path = await downloadModel(lookDir, model);
		expect(path).toBe(finalPath);
		expect(vi.mocked(fetch)).not.toHaveBeenCalled();
		expect(await findDownloadedModel(lookDir, model)).toBe(finalPath);
	});

	it("AbortSignal 取消下载", async () => {
		const model = makeModel();
		const mirrorUrl = `https://hf-mirror.com/${model.repository}/resolve/${model.revision}/${model.filename}`;
		mockFetchWithBodies({ [mirrorUrl]: { body: Buffer.from("fake-model-content-0123456789") } });
		const controller = new AbortController();
		controller.abort();
		await expect(downloadModel(lookDir, model, { signal: controller.signal })).rejects.toThrow();
	});

	it("中途断流：官方源半程失败后从镜像源断点续传成功", async () => {
		const model = makeModel();
		const content = Buffer.from("fake-model-content-0123456789");
		const officialUrl = `https://huggingface.co/${model.repository}/resolve/${model.revision}/${model.filename}`;
		const mirrorUrl = `https://hf-mirror.com/${model.repository}/resolve/${model.revision}/${model.filename}`;
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL, init?: RequestInit) => {
				const url = String(input);
				if (url === officialUrl) {
					// 前 10 字节正常，随后连接被重置（大文件最常见的失败方式）。
					// 注意：pull 里先 enqueue 再 error —— 同步 error 会清空已入队
					// 的 chunk，第一个 read 就会 reject，模拟不出"半程落盘"。
					let served = false;
					return new Response(
						new ReadableStream({
							pull(controller) {
								if (!served) {
									served = true;
									controller.enqueue(new Uint8Array(content.subarray(0, 10)));
									return;
								}
								controller.error(new Error("connection reset"));
							},
						}),
						{ status: 200, headers: { "content-length": String(content.length) } },
					);
				}
				if (url === mirrorUrl) {
					const range = (init?.headers as Record<string, string> | undefined)?.Range;
					expect(range).toBe("bytes=10-"); // 必须从实际落盘位置续传
					return new Response(new Uint8Array(content.subarray(10)), {
						status: 206,
						headers: { "content-length": String(content.length - 10) },
					});
				}
				return new Response("not found", { status: 404 });
			}),
		);
		const path = await downloadModel(lookDir, model);
		expect(await readFile(path, "utf8")).toBe("fake-model-content-0123456789");
	});

	it("残留 .incomplete 文件可断点续传（跨调用）", async () => {
		const model = makeModel();
		const content = Buffer.from("fake-model-content-0123456789");
		// 预置上次中断留下的前 10 字节
		const dir = join(lookDir, "models", model.id);
		await mkdir(dir, { recursive: true });
		await writeFile(join(dir, `.${model.filename}.incomplete`), content.subarray(0, 10));
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL, init?: RequestInit) => {
				const url = String(input);
				if (url.includes("huggingface.co")) return new Response("not found", { status: 404 });
				const range = (init?.headers as Record<string, string> | undefined)?.Range;
				expect(range).toBe("bytes=10-");
				return new Response(new Uint8Array(content.subarray(10)), {
					status: 206,
					headers: { "content-length": String(content.length - 10) },
				});
			}),
		);
		const path = await downloadModel(lookDir, model);
		expect(await readFile(path, "utf8")).toBe("fake-model-content-0123456789");
	});

	it("服务端忽略 Range 返回 200 全量时作废断点整体重下", async () => {
		const model = makeModel();
		const content = Buffer.from("fake-model-content-0123456789");
		const dir = join(lookDir, "models", model.id);
		await mkdir(dir, { recursive: true });
		// 预置错误前缀（模拟内容不符的残留）：重下必须忽略它并完整校验通过
		await writeFile(join(dir, `.${model.filename}.incomplete`), Buffer.from("WRONGPREFIX"));
		const officialUrl = `https://huggingface.co/${model.repository}/resolve/${model.revision}/${model.filename}`;
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL, init?: RequestInit) => {
				const url = String(input);
				if (url === officialUrl) {
					const range = (init?.headers as Record<string, string> | undefined)?.Range;
					if (range) return new Response("range ignored", { status: 416 });
					return new Response(new Uint8Array(content), {
						status: 200,
						headers: { "content-length": String(content.length) },
					});
				}
				return new Response("not found", { status: 404 });
			}),
		);
		const path = await downloadModel(lookDir, model);
		expect(await readFile(path, "utf8")).toBe("fake-model-content-0123456789");
	});
});
