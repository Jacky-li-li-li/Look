import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(resolve(import.meta.dirname, "../src/main/session/composition/builder.ts"), "utf8");
const runtimeManagerSource = readFileSync(
	resolve(import.meta.dirname, "../src/main/session/runtime-manager.ts"),
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
		expect(source).toContain("this.host!.bindRuntimeServices");
		expect(compositionSource).not.toContain("RuntimeManagerCompositionHost");
		expect(runtimeManagerSource).not.toContain("RuntimeManagerComposition.create(\n\t\t\tsrt,");
	});
});
