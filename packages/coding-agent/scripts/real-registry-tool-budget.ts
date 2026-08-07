/**
 * Real-registry counterpart to `scripts/token-budget-harness.ts`.
 *
 * The token harness deliberately measures a synthetic 12-tool fixture and says
 * so in its own `limitations`. This script measures the ACTUAL built-in tool
 * registry in provider wire form, so the discovery/caps story can be quoted
 * against the tools gjc really ships instead of a fixture.
 *
 * Conditions:
 *   eager        — every built-in tool on the wire (tools.discoveryMode = "off")
 *   discovery    — essential tools only (tools.discoveryMode = "all" steady state)
 *   cap-ceiling  — essential + the 8 largest discoverable schemas (worst case the
 *                  MAX_SELECTED_DISCOVERED_TOOLS cap still admits)
 *   uncapped     — essential + every discoverable tool activated at once, i.e.
 *                  what an unbounded selection could have carried before the cap
 *
 * Offline and deterministic: no provider call, no session, schema serialization
 * only.
 */
import { estimateTextTokensHeuristic } from "@gajae-code/agent-core/compaction";
import { toolWireSchema } from "@gajae-code/ai/utils/schema/wire";
import { Settings } from "../src/config/settings";
import { BUILTIN_TOOLS, DEFAULT_ESSENTIAL_TOOL_NAMES } from "../src/tools";

interface WireTool {
	name: string;
	loadMode: string;
	bytes: number;
	tokens: number;
}

function serializeWireBatch(tools: Array<{ name: string; description?: string; strict?: boolean }>): string {
	return JSON.stringify(
		tools.map(tool => ({
			type: "function",
			name: tool.name,
			description: tool.description ?? "",
			parameters: toolWireSchema(tool as never),
			strict: tool.strict !== false,
		})),
	);
}

const settings = Settings.isolated({ "tools.discoveryMode": "all" });
const stubSession = {
	cwd: process.cwd(),
	settings,
	sessionId: "real-registry-measurement",
	isToolDiscoveryEnabled: () => true,
	getDiscoverableTools: () => [],
	getActiveToolNames: () => [],
	getModel: () => undefined,
	emitNotice: () => {},
	on: () => () => {},
} as never;

const instantiated: Array<{ tool: any; measured: WireTool }> = [];
const skipped: string[] = [];
for (const [name, factory] of Object.entries(BUILTIN_TOOLS)) {
	let tool: any;
	try {
		tool = (factory as (session: never) => unknown)(stubSession);
	} catch {
		skipped.push(name);
		continue;
	}
	if (!tool) {
		skipped.push(name);
		continue;
	}
	let bytes: number;
	try {
		bytes = Buffer.byteLength(serializeWireBatch([tool]), "utf8");
	} catch {
		skipped.push(name);
		continue;
	}
	instantiated.push({
		tool,
		measured: {
			name: tool.name ?? name,
			loadMode: tool.loadMode ?? "unknown",
			bytes,
			tokens: estimateTextTokensHeuristic(serializeWireBatch([tool])),
		},
	});
}

const essentialNames = new Set<string>(DEFAULT_ESSENTIAL_TOOL_NAMES);
const essential = instantiated.filter(
	entry => entry.measured.loadMode === "essential" || essentialNames.has(entry.measured.name),
);
const discoverable = instantiated.filter(entry => !essential.includes(entry));
const largest8 = [...discoverable].sort((a, b) => b.measured.bytes - a.measured.bytes).slice(0, 8);

function measure(label: string, entries: typeof instantiated) {
	const payload = serializeWireBatch(entries.map(entry => entry.tool));
	return {
		condition: label,
		tools: entries.length,
		bytes: Buffer.byteLength(payload, "utf8"),
		estTokens: estimateTextTokensHeuristic(payload),
	};
}

const rows = [
	measure("eager (discoveryMode=off)", instantiated),
	measure("discovery steady (essential only)", essential),
	measure("cap-ceiling (essential + 8 largest)", [...essential, ...largest8]),
	measure("uncapped (essential + all discoverable)", instantiated),
];
const eager = rows[0]!;

console.log(`instantiated ${instantiated.length} builtin tools (skipped ${skipped.length}: ${skipped.join(", ")})`);
console.log(`essential ${essential.length} / discoverable ${discoverable.length}`);
console.log("");
console.log("condition".padEnd(40), "tools".padStart(6), "bytes".padStart(9), "estTok".padStart(8), "vs eager".padStart(10));
for (const row of rows) {
	const delta = eager.estTokens === 0 ? 0 : (100 * (row.estTokens - eager.estTokens)) / eager.estTokens;
	console.log(
		row.condition.padEnd(40),
		String(row.tools).padStart(6),
		String(row.bytes).padStart(9),
		String(row.estTokens).padStart(8),
		`${delta.toFixed(1)}%`.padStart(10),
	);
}
console.log("");
console.log("largest discoverable schemas (bytes):");
for (const entry of largest8) console.log(`  ${entry.measured.name.padEnd(24)} ${String(entry.measured.bytes).padStart(7)}`);
