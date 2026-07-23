import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(resolve(import.meta.dirname, "../src/main/session/composition/builder.ts"), "utf8");

describe("RuntimeManagerComposition", () => {
	it("constructs agent definitions before injecting them into the subagent service", () => {
		const definitionIndex = source.indexOf("this.agentDefinitionService = new AgentDefinitionService");
		const subagentIndex = source.indexOf("this.sessionSubagentService = new SessionSubagentService");
		expect(definitionIndex).toBeGreaterThan(-1);
		expect(subagentIndex).toBeGreaterThan(definitionIndex);
		expect(source.slice(subagentIndex)).toContain("agentDefinitionService: this.agentDefinitionService");
	});
});
