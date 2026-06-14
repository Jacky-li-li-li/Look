import { describe, expect, it } from "vitest";
import { checkPermission } from "../src/main/permissions/permission-gate";

describe("permission-gate", () => {
	describe("block-destructive-filesystem", () => {
		it("blocks rm -rf /", () => {
			const result = checkPermission("bash", { command: "rm -rf /" });
			expect(result.action).toBe("deny");
		});

		it("blocks rm -rf / with double spaces (bypass attempt)", () => {
			const result = checkPermission("bash", { command: "rm  -rf /" });
			expect(result.action).toBe("deny");
		});

		it("blocks rm -rf / wrapped in parentheses (subshell bypass)", () => {
			const result = checkPermission("bash", { command: "(rm -rf /)" });
			expect(result.action).toBe("deny");
		});

		it("blocks rm -r -f / (split flags)", () => {
			const result = checkPermission("bash", { command: "rm -r -f /" });
			expect(result.action).toBe("deny");
		});

		it("blocks rm -rf / via eval", () => {
			const result = checkPermission("bash", { command: 'eval "rm -rf /"' });
			expect(result.action).toBe("deny");
		});

		it("blocks rm -rf / via bash -c", () => {
			const result = checkPermission("bash", { command: 'bash -c "rm -rf /"' });
			expect(result.action).toBe("deny");
		});

		it("blocks rm -rf / with tabs/extra whitespace", () => {
			const result = checkPermission("bash", { command: "rm \t -rf \t /" });
			expect(result.action).toBe("deny");
		});

		it("blocks mkfs commands", () => {
			const result = checkPermission("bash", { command: "mkfs.ext4 /dev/sda1" });
			expect(result.action).toBe("deny");
		});

		it("blocks dd if= commands", () => {
			const result = checkPermission("bash", { command: "dd if=/dev/zero of=/dev/sda" });
			expect(result.action).toBe("deny");
		});

		it("blocks > /dev/sda", () => {
			const result = checkPermission("bash", { command: "cat something > /dev/sda" });
			expect(result.action).toBe("deny");
		});

		it("allows safe rm commands", () => {
			const result = checkPermission("bash", { command: "rm -rf ./build" });
			expect(result.action).toBe("allow");
		});

		it("allows rm on specific file", () => {
			const result = checkPermission("bash", { command: "rm temp.txt" });
			expect(result.action).toBe("allow");
		});
	});

	describe("block-git-force-push", () => {
		it("blocks force push to main", () => {
			const result = checkPermission("bash", { command: "git push --force origin main" });
			expect(result.action).toBe("deny");
		});

		it("blocks force push to master", () => {
			const result = checkPermission("bash", { command: "git push --force origin master" });
			expect(result.action).toBe("deny");
		});

		it("blocks force push with extra whitespace", () => {
			const result = checkPermission("bash", { command: "git  push  --force  origin  main" });
			expect(result.action).toBe("deny");
		});

		it("allows force push to feature branch", () => {
			const result = checkPermission("bash", { command: "git push --force origin feature/my-branch" });
			expect(result.action).toBe("allow");
		});

		it("allows normal push to main", () => {
			const result = checkPermission("bash", { command: "git push origin main" });
			expect(result.action).toBe("allow");
		});
	});

	describe("block-env-overwrite (write tool)", () => {
		it("blocks writing to .env", () => {
			const result = checkPermission("write", { path: "/project/.env" });
			expect(result.action).toBe("deny");
		});

		it("blocks writing to .env.local", () => {
			const result = checkPermission("write", { path: "/project/.env.local" });
			expect(result.action).toBe("deny");
		});

		it("blocks writing to .env.production", () => {
			const result = checkPermission("write", { path: "/project/.env.production" });
			expect(result.action).toBe("deny");
		});

		it("allows writing to env.ts (not a dotenv file)", () => {
			const result = checkPermission("write", { path: "/project/src/env.ts" });
			expect(result.action).not.toBe("deny");
		});
	});

	describe("block-env-overwrite (edit tool)", () => {
		it("blocks editing .env via file_path", () => {
			const result = checkPermission("edit", { file_path: "/project/.env" });
			expect(result.action).toBe("deny");
		});

		it("blocks editing .env.local via file_path", () => {
			const result = checkPermission("edit", { file_path: "/project/.env.local" });
			expect(result.action).toBe("deny");
		});

		it("blocks editing .env via path arg", () => {
			const result = checkPermission("edit", { path: "/project/.env" });
			expect(result.action).toBe("deny");
		});
	});

	describe("block-env-overwrite (bash)", () => {
		it("blocks echo >> .env", () => {
			const result = checkPermission("bash", { command: 'echo "SECRET=xxx" >> .env' });
			expect(result.action).toBe("deny");
		});

		it("blocks echo > .env.local", () => {
			const result = checkPermission("bash", { command: 'echo "KEY=val" > .env.local' });
			expect(result.action).toBe("deny");
		});

		it("blocks sed -i on .env", () => {
			const result = checkPermission("bash", { command: "sed -i 's/old/new/' .env" });
			expect(result.action).toBe("deny");
		});

		it("blocks tee to .env", () => {
			const result = checkPermission("bash", { command: "cat secrets | tee .env" });
			expect(result.action).toBe("deny");
		});

		it("blocks tee -a to .env.production", () => {
			const result = checkPermission("bash", { command: "echo x | tee -a .env.production" });
			expect(result.action).toBe("deny");
		});

		it("allows cat .env (read-only)", () => {
			const result = checkPermission("bash", { command: "cat .env" });
			expect(result.action).toBe("allow");
		});

		it("allows echo mentioning .env without redirect (read-only context)", () => {
			const result = checkPermission("bash", { command: 'echo "see .env for config"' });
			expect(result.action).toBe("allow");
		});

		it("allows grep in .env (read-only)", () => {
			const result = checkPermission("bash", { command: "grep KEY .env" });
			expect(result.action).toBe("allow");
		});
	});

	describe("global deny without agentRole", () => {
		it("blocks rm -rf / even when no role is provided", () => {
			const result = checkPermission("bash", { command: "rm -rf /" });
			expect(result.action).toBe("deny");
		});

		it("blocks .env write even when no role is provided", () => {
			const result = checkPermission("write", { path: "/project/.env" });
			expect(result.action).toBe("deny");
		});
	});

	describe("role-based rules", () => {
		it("denies write for reviewer role", () => {
			const result = checkPermission("write", { path: "/project/README.md" }, "reviewer");
			expect(result.action).toBe("deny");
		});

		it("denies edit for reviewer role", () => {
			const result = checkPermission("edit", { file_path: "/project/src/app.ts" }, "reviewer");
			expect(result.action).toBe("deny");
		});

		it("allows write for non-reviewer role", () => {
			const result = checkPermission("write", { path: "/project/README.md" }, "coder");
			expect(result.action).not.toBe("deny");
		});
	});

	describe("protected paths", () => {
		it("asks for confirmation on package.json write", () => {
			const result = checkPermission("write", { path: "/project/package.json" });
			expect(result.action).toBe("ask");
		});

		it("asks for confirmation on .ts file edit via path", () => {
			const result = checkPermission("edit", { path: "/project/src/index.ts" });
			expect(result.action).toBe("ask");
		});

		it("asks for confirmation on .ts file edit via file_path", () => {
			const result = checkPermission("edit", { file_path: "/project/src/index.ts" });
			expect(result.action).toBe("ask");
		});

		it("asks for confirmation on Dockerfile write", () => {
			const result = checkPermission("write", { path: "/project/Dockerfile" });
			expect(result.action).toBe("ask");
		});

		it("asks for confirmation on .yml write", () => {
			const result = checkPermission("write", { path: "/project/.github/workflows/ci.yml" });
			expect(result.action).toBe("ask");
		});
	});

	describe("normalizeCommand edge cases", () => {
		it("blocks rm -rf / with tabs", () => {
			const result = checkPermission("bash", { command: "rm\t-rf\t/" });
			expect(result.action).toBe("deny");
		});

		it("blocks nested parentheses", () => {
			const result = checkPermission("bash", { command: "((rm -rf /))" });
			expect(result.action).toBe("deny");
		});

		it("blocks bash -c wrapping rm -rf", () => {
			const result = checkPermission("bash", { command: "bash -c 'rm -rf /'" });
			expect(result.action).toBe("deny");
		});

		it("blocks zsh -c wrapping rm -rf", () => {
			const result = checkPermission("bash", { command: "zsh -c 'rm -rf /'" });
			expect(result.action).toBe("deny");
		});
	});

	describe("default allow", () => {
		it("allows read tool", () => {
			const result = checkPermission("read", { path: "/project/src/index.ts" });
			expect(result.action).toBe("allow");
		});

		it("allows safe bash commands", () => {
			const result = checkPermission("bash", { command: "ls -la" });
			expect(result.action).toBe("allow");
		});

		it("allows glob tool", () => {
			const result = checkPermission("glob", { pattern: "**/*.ts" });
			expect(result.action).toBe("allow");
		});
	});
});
