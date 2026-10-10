import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const compositionDir = resolve(import.meta.dirname, "../src/main/session/composition");
const builderSource =
	readFileSync(resolve(compositionDir, "builder.ts"), "utf8") +
	readFileSync(resolve(compositionDir, "builder-context.ts"), "utf8");
const phaseSource = readdirSync(resolve(compositionDir, "builder-phases"))
	.filter((name) => name.endsWith(".ts"))
	.map((name) => readFileSync(resolve(compositionDir, "builder-phases", name), "utf8"))
	.join("\n");
/** builder.ts thin wrappers + phase bodies — 顺序断言扫整个装配源码。 */
const source = `${builderSource}\n${phaseSource}`;
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
		const definitionIndex = source.indexOf("b.agentDefinitionService = new AgentDefinitionService");
		const subagentIndex = source.indexOf("b.sessionSubagentService = new SessionSubagentService");
		expect(definitionIndex).toBeGreaterThan(-1);
		expect(subagentIndex).toBeGreaterThan(definitionIndex);
		expect(source.slice(subagentIndex)).toContain("agentDefinitionService: b.agentDefinitionService");
	});

	it("builds with an internal CompositionHost instead of escaping the partially initialized manager", () => {
		expect(source).toContain("new CompositionHost(");
		expect(source).toContain("host.bindRuntimeServices");
		expect(compositionSource).not.toContain("RuntimeManagerCompositionHost");
		expect(runtimeManagerSource).not.toContain("RuntimeManagerComposition.create(\n\t\t\tsrt,");
	});

	it("constructs AttachmentService before every injection site reads it", () => {
		const constructionIndex = source.indexOf("b.attachmentService = new AttachmentService()");
		expect(constructionIndex).toBeGreaterThan(-1);

		const injectionPattern = /attachments: b\.(?:req\(b\.)?attachmentService/g;
		const injections = source.match(injectionPattern) ?? [];
		expect(injections.length).toBeGreaterThanOrEqual(3);
		for (const match of injections) {
			const index = source.indexOf(match);
			expect(index).toBeGreaterThan(constructionIndex);
		}
	});

	it("only requires the platform-optional computerUseService in validate() on darwin", () => {
		expect(builderSource).toContain(
			'...(process.platform === "darwin" ? { computerUseService: this.computerUseService } : {})',
		);
		const validateStart = builderSource.indexOf("validate(): this {");
		expect(validateStart).toBeGreaterThan(-1);
		const unconditionalEntry = /^\t\t\tcomputerUseService: this\.computerUseService,$/m;
		expect(unconditionalEntry.test(builderSource.slice(validateStart))).toBe(false);
	});

	it("delegates each build phase to a dedicated module", () => {
		for (const phase of [
			"buildInfraPhase",
			"buildModelPhase",
			"buildExtensionsPhase",
			"buildCorePhase",
			"buildUIPhase",
		]) {
			expect(builderSource).toContain(phase);
			expect(phaseSource).toContain(`function ${phase}`);
		}
	});
});
