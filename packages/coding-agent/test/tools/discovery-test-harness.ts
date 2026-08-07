import { Agent, type AgentTool } from "@gajae-code/agent-core";
import type { Model } from "@gajae-code/ai";
import * as z from "zod/v4";
import { Settings } from "../../src/config/settings";
import { AgentSession } from "../../src/session/agent-session";
import { SessionManager } from "../../src/session/session-manager";

/** Mutable prompt-rebuild counter injected into the session harness. */
export interface RebuildCounter {
	count: number;
}

export function createDiscoveryTestModel(): Model<"openai-responses"> {
	return {
		id: "mock",
		name: "mock",
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://example.invalid",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8192,
		maxTokens: 2048,
	};
}

export function createDiscoverableTool(
	name: string,
	options?: { description?: string; parameters?: z.ZodType },
): AgentTool {
	return {
		name,
		label: name,
		description: options?.description ?? `${name} tool`,
		parameters: options?.parameters ?? z.object({ value: z.string() }),
		strict: true,
		loadMode: "discoverable",
		async execute() {
			return { content: [{ type: "text", text: `${name} executed` }] };
		},
	};
}

export function createResidentSearchTool(): AgentTool {
	return { ...createDiscoverableTool("search_tool_bm25"), loadMode: "essential" };
}

/**
 * Shared discovery-session harness for budget/efficiency contract tests.
 * `rebuildCounter` (optional) counts rebuildSystemPrompt invocations so tests
 * can assert prompt-rebuild economics alongside selection behavior.
 */
export function createDiscoverySession(
	tools: AgentTool[],
	rebuildCounter?: RebuildCounter,
): { session: AgentSession; toolRegistry: Map<string, AgentTool> } {
	const residentSearchTool = createResidentSearchTool();
	const toolRegistry = new Map<string, AgentTool>([
		[residentSearchTool.name, residentSearchTool],
		...tools.map(tool => [tool.name, tool] as const),
	]);
	const agent = new Agent({
		initialState: {
			model: createDiscoveryTestModel(),
			systemPrompt: ["initial"],
			tools: [residentSearchTool],
			messages: [],
		},
	});
	const session = new AgentSession({
		agent,
		sessionManager: SessionManager.inMemory(),
		settings: Settings.isolated({ "tools.discoveryMode": "all" }),
		modelRegistry: {} as never,
		toolRegistry,
		rebuildSystemPrompt: async toolNames => {
			if (rebuildCounter) rebuildCounter.count += 1;
			return { systemPrompt: [`tools:${toolNames.join(",")}`] };
		},
	});
	return { session, toolRegistry };
}
