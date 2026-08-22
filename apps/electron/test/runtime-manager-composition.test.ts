import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(resolve(import.meta.dirname, "../src/main/session/composition/builder.ts"), "utf8");
const runtimeManagerSource = readFileSync(
	resolve(import.meta.dirname, "../src/main/session/runtime/runtime-manager.ts"),
	"utf8",
);
const compositionSource = readFileSync(
	resolve(import.meta.dirname, "../src/main/session/runtime-manager-composition.ts"),
	"utf8",
);

describe("RuntimeManagerComposition", () => {
	it("constructs agent definitions before injecting them into the subagent service", () => {
		const definitionIndex = source.indexOf("this.agentDefinitionService = new AgentDefinitionService");
		const subagentIndex = source.indexOf("this.sessionSubagentService = new SessionSubagentService");
		expect(definitionIndex).toBeGreaterThan(-1);
		expect(subagentIndex).toBeGreaterThan(definitionIndex);
		expect(source.slice(subagentIndex)).toContain("agentDefinitionService: this.agentDefinitionService");
	});

	it("builds with an internal CompositionHost instead of escaping the partially initialized manager", () => {
		expect(source).toContain("new CompositionHost(");
		expect(source).toContain("host.bindRuntimeServices");
		expect(compositionSource).not.toContain("RuntimeManagerCompositionHost");
		expect(runtimeManagerSource).not.toContain("RuntimeManagerComposition.create(\n\t\t\tsrt,");
	});

	it("constructs AttachmentService before every injection site reads it", () => {
		const constructionIndex = source.indexOf("this.attachmentService = new AttachmentService()");
		expect(constructionIndex).toBeGreaterThan(-1);

		const injectionPattern = /attachments: this\.attachmentService/g;
		const injections = source.match(injectionPattern) ?? [];
		// lifecycle / project-deletion / messaging 三处注入都必须出现在构造之后
		expect(injections.length).toBeGreaterThanOrEqual(3);
		for (const match of injections) {
			const index = source.indexOf(match);
			expect(index).toBeGreaterThan(constructionIndex);
		}
	});

	it("only requires the platform-optional computerUseService in validate() on darwin", () => {
		// computerUseService 在非 darwin 上合法为 null；必填表必须按平台条件收录，
		// 否则 Windows/Linux 会在 CompositionBuilder.validate() 直接启动失败。
		expect(source).toContain(
			'...(process.platform === "darwin" ? { computerUseService: this.computerUseService } : {})',
		);
		const validateStart = source.indexOf("validate(): this {");
		expect(validateStart).toBeGreaterThan(-1);
		const unconditionalEntry = /^\t\t\tcomputerUseService: this\.computerUseService,$/m;
		expect(unconditionalEntry.test(source.slice(validateStart))).toBe(false);
	});
});
