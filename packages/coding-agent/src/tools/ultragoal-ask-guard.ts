import type { AgentTool } from "@gajae-code/agent-core";
import {
	consumeUltragoalAskNudge,
	isUltragoalAskBlocked,
	type UltragoalAskBlockDiagnostic,
} from "../gjc-runtime/ultragoal-guard";
import { ToolError } from "./tool-errors";

const ULTRAGOAL_ASK_GUARD = Symbol.for("gajae-code.ultragoalAskGuard");

type GuardedTool = AgentTool & { [ULTRAGOAL_ASK_GUARD]?: true };

export interface UltragoalAskGuardContext {
	activeSkillState?: { skill?: string; session_id?: string } | null;
	sessionId?: string | null;
}

function sessionScopedAskGuardId(context: UltragoalAskGuardContext): string | undefined {
	// The live AgentSession id is authoritative. Active workflow state can be
	// absent when a root-launched session operates on a repo-scoped workflow,
	// and falling back to ambient/latest-session resolution in that case lets an
	// unrelated Ultragoal run hijack this session's ask calls.
	const sessionId = context.sessionId?.trim();
	if (sessionId) return sessionId;
	const activeSessionId = context.activeSkillState?.session_id?.trim();
	return activeSessionId || undefined;
}

export function formatUltragoalAskBlockMessage(diagnostic: UltragoalAskBlockDiagnostic): string {
	return [
		diagnostic.message,
		`Ultragoal ask guard blocked ask (source: ${diagnostic.source}; reason: ${diagnostic.reason}).`,
		"Use `gjc ultragoal record-review-blockers` to record the blocker instead of asking the user.",
	].join("\n");
}

export async function assertUltragoalAskAllowed(cwd: string, context: UltragoalAskGuardContext = {}): Promise<void> {
	// Always scope the check to the live agent session when one is available.
	// Callers without session context retain legacy ambient resolution.
	const sessionId = sessionScopedAskGuardId(context);
	const diagnostic = await isUltragoalAskBlocked(cwd, { sessionId });
	if (!diagnostic.active) return;
	const nudge = await consumeUltragoalAskNudge(cwd, sessionId);
	if (nudge.nudged) throw new ToolError(nudge.message);
	throw new ToolError(formatUltragoalAskBlockMessage(diagnostic));
}

export function guardToolForUltragoalAsk<T extends AgentTool>(
	tool: T,
	getCwd: () => string,
	getContext: () => UltragoalAskGuardContext = () => ({}),
): T {
	if (tool.name !== "ask") return tool;
	const candidate = tool as GuardedTool;
	if (candidate[ULTRAGOAL_ASK_GUARD]) return tool;
	const wrapped = new Proxy(tool, {
		get(target, prop, receiver) {
			if (prop === ULTRAGOAL_ASK_GUARD) return true;
			if (prop !== "execute") return Reflect.get(target, prop, receiver);
			return async (...args: unknown[]): Promise<unknown> => {
				await assertUltragoalAskAllowed(getCwd(), getContext());
				return Reflect.apply(target.execute, target, args);
			};
		},
	}) as T & GuardedTool;
	wrapped[ULTRAGOAL_ASK_GUARD] = true;
	return wrapped as T;
}
