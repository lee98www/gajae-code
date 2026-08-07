import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "bun:test";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import type { ToolSession } from "@gajae-code/coding-agent/tools";
import { CwdTool } from "@gajae-code/coding-agent/tools/cwd";
import { ToolError } from "@gajae-code/coding-agent/tools/tool-errors";

function createSession(cwd: string, overrides: Partial<ToolSession> = {}): ToolSession {
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated(),
		...overrides,
	};
}

describe("CwdTool", () => {
	it("moves the session to an existing directory", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "cwd-tool-"));
		const target = path.join(root, "target");
		await fs.mkdir(target);
		const moved: string[] = [];
		const tool = new CwdTool(
			createSession(root, {
				moveSessionCwd: async cwd => {
					moved.push(cwd);
					return { cwd };
				},
			}),
		);

		const result = await tool.execute("call-1", { path: target });

		expect(moved).toEqual([target]);
		expect(result.content).toEqual([{ type: "text", text: `Session working directory moved from ${root} to ${target}` }]);
	});

	it("resolves relative paths against the session cwd", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "cwd-tool-"));
		const target = path.join(root, "target");
		await fs.mkdir(target);
		let moved: string | undefined;
		const tool = new CwdTool(
			createSession(root, {
				moveSessionCwd: async cwd => {
					moved = cwd;
					return { cwd };
				},
			}),
		);

		await tool.execute("call-1", { path: "target" });

		expect(moved).toBe(target);
	});

	it("rejects a nonexistent directory", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "cwd-tool-"));
		const moved: string[] = [];
		const tool = new CwdTool(
			createSession(root, {
				moveSessionCwd: async cwd => {
					moved.push(cwd);
					return { cwd };
				},
			}),
		);

		await expect(tool.execute("call-1", { path: "missing" })).rejects.toBeInstanceOf(ToolError);
		expect(moved).toEqual([]);
	});

	it("rejects a file path", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "cwd-tool-"));
		const file = path.join(root, "file");
		await Bun.write(file, "file");
		const tool = new CwdTool(createSession(root, { moveSessionCwd: async cwd => ({ cwd }) }));

		await expect(tool.execute("call-1", { path: file })).rejects.toBeInstanceOf(ToolError);
	});

	it("does not move when the requested directory is already active", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "cwd-tool-"));
		const moved: string[] = [];
		const tool = new CwdTool(
			createSession(root, {
				moveSessionCwd: async cwd => {
					moved.push(cwd);
					return { cwd };
				},
			}),
		);

		const result = await tool.execute("call-1", { path: "." });

		expect(moved).toEqual([]);
		expect(result.content).toEqual([{ type: "text", text: `Session is already using working directory: ${root}` }]);
	});

	it("rejects sessions without runtime cwd move support", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "cwd-tool-"));
		const target = path.join(root, "target");
		await fs.mkdir(target);
		const tool = new CwdTool(createSession(root));

		await expect(tool.execute("call-1", { path: target })).rejects.toThrow("session does not support runtime cwd moves");
	});
});
