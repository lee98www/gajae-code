import type { Stats } from "node:fs";
import * as fs from "node:fs/promises";
import type { AgentTool, AgentToolResult } from "@gajae-code/agent-core";
import * as z from "zod/v4";
import type { ToolSession } from ".";
import type { OutputMeta } from "./output-meta";
import { resolveToCwd } from "./path-utils";
import { ToolError } from "./tool-errors";
import { toolResult } from "./tool-result";

const cwdSchema = z.object({
	path: z.string().describe("working directory path"),
});

type CwdToolInput = z.infer<typeof cwdSchema>;

export interface CwdToolDetails {
	cwd: string;
	meta?: OutputMeta;
}

export class CwdTool implements AgentTool<typeof cwdSchema, CwdToolDetails> {
	readonly name = "cwd";
	readonly label = "Cwd";
	readonly summary = "Rescope this session to a different working directory";
	readonly description =
		"Rescope this session to a different working directory (like /move). All relative paths and new bash calls resolve against the new directory afterward. Use when the active project changes. Do not move while background jobs run.";
	readonly parameters = cwdSchema;
	readonly strict = true;
	readonly loadMode = "essential";

	constructor(private readonly session: ToolSession) {}

	static createIf(session: ToolSession): CwdTool | null {
		return session.moveSessionCwd ? new CwdTool(session) : null;
	}

	async execute(_toolCallId: string, params: CwdToolInput): Promise<AgentToolResult<CwdToolDetails>> {
		const oldCwd = this.session.cwd;
		const cwd = resolveToCwd(params.path, oldCwd);
		let stat: Stats;
		try {
			stat = await fs.stat(cwd);
		} catch {
			throw new ToolError(`Directory does not exist: ${cwd}`);
		}
		if (!stat.isDirectory()) {
			throw new ToolError(`Path is not a directory: ${cwd}`);
		}
		if (cwd === oldCwd) {
			return toolResult<CwdToolDetails>({ cwd }).text(`Session is already using working directory: ${cwd}`).done();
		}
		if (!this.session.moveSessionCwd) {
			throw new ToolError("session does not support runtime cwd moves");
		}
		const moved = await this.session.moveSessionCwd(cwd);
		return toolResult<CwdToolDetails>({ cwd: moved.cwd })
			.text(`Session working directory moved from ${oldCwd} to ${moved.cwd}`)
			.done();
	}
}
