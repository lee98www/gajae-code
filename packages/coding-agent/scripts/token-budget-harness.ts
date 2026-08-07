import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Agent, type AgentTool, estimateTextTokensHeuristic } from "@gajae-code/agent-core";
import { createMockModel } from "@gajae-code/ai/providers/mock";
import { toolWireSchema } from "@gajae-code/ai/utils/schema/wire";
import * as z from "zod/v4";
import { Settings } from "../src/config/settings";
import { AgentSession } from "../src/session/agent-session";
import { SessionManager } from "../src/session/session-manager";

const MODEL_ID = "token-budget-mock";
const CONTEXT_WINDOW = 8192;
const MAX_TOKENS = 2048;
const DEFAULT_OUT_DIR = ".gjc/_session-019fae5d-5279-7000-a4f2-3acd30ea9b83/artifacts/stage1/measurement";
const CONDITIONS = ["eager", "no-tools", "catalog-only", "selected-0", "selected-1", "selected-8"] as const;

type Condition = (typeof CONDITIONS)[number];

export const CANONICALIZATION_VERSION = "gjc-stage1-canonical-json-v1" as const;

export interface TokenReceipt {
	condition: Condition;
	repetition: number;
	bytes: number;
	sha256: string;
	estTokens: number;
	usage: { input: number; output: number; cacheRead: number; cacheWrite: number };
	epoch: { before: unknown; after: unknown; coldCost: number };
	wireToolCount: number;
	/** Exact canonical UTF-8 payload whose hash/bytes/tokens are recorded. */
	raw: string;
	canonicalization: typeof CANONICALIZATION_VERSION;
	request: unknown;
}

export interface TokenSummary {
	identity: {
		provider: "mock";
		modelId: string;
		contextWindow: number;
		maxTokens: number;
		tokenizer: "estimateTextTokensHeuristic";
		/** Actual measured product revision, resolved from git HEAD at run time. */
		source: string;
	};
	scope: {
		fixture: string;
		canonicalization: typeof CANONICALIZATION_VERSION;
		limitations: string[];
	};
	conditions: Record<
		Condition,
		{
			bytes: { p50: number; p95: number; min: number; max: number };
			estTokens: { p50: number; p95: number; min: number; max: number };
			distinctSha256: number;
			epochColdCost: { first: number; min: number; max: number; allEqual: boolean };
			cacheUsage: { cacheRead: number; cacheWrite: number };
		}
	>;
}

export interface HarnessResult {
	receipts: TokenReceipt[];
	summary: TokenSummary;
}

export interface RunHarnessOptions {
	repetitions?: number;
	outDir?: string;
	writeArtifacts?: boolean;
}

function createTool(name: string, loadMode: "essential" | "discoverable" = "discoverable"): AgentTool {
	return {
		name,
		label: name,
		description: `Deterministic ${name} fixture tool for token budget measurement.`,
		parameters: z.object({
			path: z.string().describe("A deterministic fixture path."),
			limit: z.number().int().min(1).max(100).describe("Maximum deterministic result count."),
		}),
		strict: true,
		loadMode,
		async execute() {
			return { content: [{ type: "text", text: `${name} fixture result` }] };
		},
	};
}

function stableJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
	if (value && typeof value === "object") {
		const object = value as Record<string, unknown>;
		return `{${Object.keys(object)
			.sort()
			.map(key => `${JSON.stringify(key)}:${stableJson(object[key])}`)
			.join(",")}}`;
	}
	return JSON.stringify(value);
}

async function resolveMeasuredRevision(): Promise<string> {
	try {
		const proc = Bun.spawn(["git", "rev-parse", "--short", "HEAD"], {
			cwd: import.meta.dir,
			stdout: "pipe",
			stderr: "ignore",
		});
		const head = (await new Response(proc.stdout).text()).trim();
		if ((await proc.exited) === 0 && /^[0-9a-f]{7,40}$/.test(head)) return `gjc-054-patch@${head}`;
	} catch {}
	return "gjc-054-patch@unknown-revision";
}

function percentile(values: number[], quantile: number): number {
	const sorted = [...values].sort((left, right) => left - right);
	return sorted[Math.ceil(quantile * sorted.length) - 1] ?? 0;
}

function summary(values: number[]): { p50: number; p95: number; min: number; max: number } {
	return {
		p50: percentile(values, 0.5),
		p95: percentile(values, 0.95),
		min: Math.min(...values),
		max: Math.max(...values),
	};
}

async function runCondition(condition: Condition, repetition: number): Promise<TokenReceipt> {
	const discovered = Array.from({ length: 12 }, (_, index) => createTool(`fixture_tool_${index + 1}`));
	const resident = createTool("search_tool_bm25", "essential");
	const eagerTools = discovered;
	const initialTools = condition === "eager" ? eagerTools : condition === "no-tools" ? [] : [resident];
	const registry = new Map<string, AgentTool>([...[resident, ...discovered].map(tool => [tool.name, tool] as const)]);
	const mock = createMockModel({
		id: MODEL_ID,
		contextWindow: CONTEXT_WINDOW,
		maxTokens: MAX_TOKENS,
		responses: [{ content: ["measured"], usage: { input: 321, output: 13, cacheRead: 144, cacheWrite: 55 } }],
	});
	const agent = new Agent({
		initialState: {
			model: mock.model,
			systemPrompt: [`fixture-tools:${initialTools.map(tool => tool.name).join(",")}`],
			tools: initialTools,
			messages: [],
		},
		streamFn: mock.stream,
	});
	let rebuilds = 0;
	const session = new AgentSession({
		agent,
		sessionManager: SessionManager.inMemory(),
		settings: Settings.isolated({ "tools.discoveryMode": "all" }),
		modelRegistry: { getApiKey: async () => "mock-key" } as never,
		toolRegistry: registry,
		rebuildSystemPrompt: async toolNames => {
			rebuilds += 1;
			return { systemPrompt: [`fixture-tools:${toolNames.join(",")}`] };
		},
	});
	try {
		const before = session.getDiscoveredToolEpoch();
		const selected =
			condition === "selected-1" ? discovered.slice(0, 1) : condition === "selected-8" ? discovered.slice(0, 8) : [];
		if (condition.startsWith("selected-")) await session.activateDiscoveredTools(selected.map(tool => tool.name));
		await session.prompt("Measure the deterministic request fixture.", { expandPromptTemplates: false });
		const call = mock.calls[0];
		if (!call) throw new Error(`Mock model did not receive a request for ${condition}.`);
		const request = {
			model: {
				id: mock.id,
				api: mock.api,
				provider: mock.provider,
				contextWindow: mock.contextWindow,
				maxTokens: mock.maxTokens,
			},
			systemPrompt: call.context.systemPrompt ?? [],
			messages: call.context.messages.map(({ timestamp: _timestamp, ...message }) => message),
			tools: (call.context.tools ?? []).map(tool => ({
				type: "function" as const,
				name: tool.name,
				description: tool.description,
				parameters: toolWireSchema(tool),
				strict: tool.strict !== false,
			})),
		};
		const raw = stableJson(request);
		const usage = { input: 321, output: 13, cacheRead: 144, cacheWrite: 55 };
		return {
			condition,
			request,
			repetition,
			bytes: Buffer.byteLength(raw, "utf8"),
			sha256: crypto.createHash("sha256").update(raw).digest("hex"),
			estTokens: estimateTextTokensHeuristic(raw),
			usage,
			epoch: { before, after: session.getDiscoveredToolEpoch(), coldCost: rebuilds },
			wireToolCount: request.tools.length,
			raw,
			canonicalization: CANONICALIZATION_VERSION,
		};
	} finally {
		await session.dispose();
	}
}

export async function runHarness(options: RunHarnessOptions = {}): Promise<HarnessResult> {
	const repetitions = options.repetitions ?? 30;
	if (!Number.isInteger(repetitions) || repetitions < 1) throw new Error("repetitions must be a positive integer.");
	const receipts: TokenReceipt[] = [];
	for (const condition of CONDITIONS) {
		for (let repetition = 1; repetition <= repetitions; repetition += 1)
			receipts.push(await runCondition(condition, repetition));
	}
	const identity = {
		provider: "mock" as const,
		modelId: MODEL_ID,
		contextWindow: CONTEXT_WINDOW,
		maxTokens: MAX_TOKENS,
		tokenizer: "estimateTextTokensHeuristic" as const,
		source: await resolveMeasuredRevision(),
	};
	const scope = {
		fixture: "synthetic 12 discoverable fixture tools + resident search_tool_bm25; mock model 8192-token window",
		canonicalization: CANONICALIZATION_VERSION,
		limitations: [
			"mock-identity canonical-serialization fixture; NOT the real native registry",
			"NOT a provider/B200 budget measurement; real-model budget claims belong to the disposition story",
			"usage numbers are scripted mock values proving receipt plumbing, not provider billing",
		],
	};
	const conditions = Object.fromEntries(
		CONDITIONS.map(condition => {
			const conditionReceipts = receipts.filter(receipt => receipt.condition === condition);
			return [
				condition,
				{
					bytes: summary(conditionReceipts.map(receipt => receipt.bytes)),
					estTokens: summary(conditionReceipts.map(receipt => receipt.estTokens)),
					distinctSha256: new Set(conditionReceipts.map(receipt => receipt.sha256)).size,
					epochColdCost: {
						first: conditionReceipts[0]?.epoch.coldCost ?? 0,
						min: Math.min(...conditionReceipts.map(receipt => receipt.epoch.coldCost)),
						max: Math.max(...conditionReceipts.map(receipt => receipt.epoch.coldCost)),
						allEqual: new Set(conditionReceipts.map(receipt => receipt.epoch.coldCost)).size === 1,
					},
					cacheUsage: {
						cacheRead: conditionReceipts[0]?.usage.cacheRead ?? 0,
						cacheWrite: conditionReceipts[0]?.usage.cacheWrite ?? 0,
					},
				},
			];
		}),
	) as TokenSummary["conditions"];
	const result = { receipts, summary: { identity, scope, conditions } };
	if (options.writeArtifacts ?? options.outDir !== undefined) {
		const outDir = options.outDir ?? DEFAULT_OUT_DIR;
		await fs.mkdir(outDir, { recursive: true });
		await Bun.write(path.join(outDir, "token-receipts.json"), `${JSON.stringify(receipts, null, 2)}\n`);
		await Bun.write(path.join(outDir, "token-summary.json"), `${JSON.stringify(result.summary, null, 2)}\n`);
	}
	if (CONDITIONS.some(condition => conditions[condition].distinctSha256 !== 1))
		throw new Error("Token measurement harness detected non-deterministic request receipts.");
	if (CONDITIONS.some(condition => !conditions[condition].epochColdCost.allEqual))
		throw new Error("Token measurement harness detected non-deterministic cold epoch costs.");
	return result;
}

if (import.meta.main) {
	const outIndex = Bun.argv.indexOf("--out");
	const outDir = outIndex === -1 ? DEFAULT_OUT_DIR : Bun.argv[outIndex + 1];
	if (!outDir) throw new Error("--out requires a directory.");
	await runHarness({ outDir, writeArtifacts: true });
}
