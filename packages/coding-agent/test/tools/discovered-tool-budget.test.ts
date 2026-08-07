import { afterEach, describe, expect, it } from "bun:test";
import type { AgentTool } from "@gajae-code/agent-core";
import * as z from "zod/v4";
import type { AgentSession } from "../../src/session/agent-session";
import {
	createDiscoverySession as createSession,
	createDiscoverableTool as createTool,
} from "./discovery-test-harness";

describe("discovered tool activation budgets", () => {
	const sessions: AgentSession[] = [];

	afterEach(async () => {
		for (const session of sessions.splice(0)) await session.dispose();
	});

	it("accepts eight selected discoverable tools and rejects a ninth batch without partial activation", async () => {
		const tools = Array.from({ length: 10 }, (_, index) => createTool(`discoverable_${index + 1}`));
		const { session } = createSession(tools);
		sessions.push(session);

		const firstBatch = tools.slice(0, 8).map(tool => tool.name);
		expect(await session.activateDiscoveredTools(firstBatch)).toEqual(firstBatch);
		expect(session.getSelectedDiscoveredToolNames()).toEqual(firstBatch);

		expect(await session.activateDiscoveredTools([tools[8].name, tools[9].name])).toEqual([]);
		expect(session.getSelectedDiscoveredToolNames()).toEqual(firstBatch);
		expect(session.getActiveToolNames()).not.toContain(tools[8].name);
		expect(session.getActiveToolNames()).not.toContain(tools[9].name);
	});

	it("rejects oversized schemas as a whole activation batch", async () => {
		const smallTool = createTool("small");
		const oversizedTool = createTool("oversized", {
			parameters: z.object({ payload: z.string().describe("x".repeat(70_000)) }),
		});
		const { session } = createSession([smallTool, oversizedTool]);
		sessions.push(session);

		expect(await session.activateDiscoveredTools([smallTool.name, oversizedTool.name])).toEqual([]);
		expect(session.getSelectedDiscoveredToolNames()).toEqual([]);
		expect(session.getActiveToolNames()).not.toContain(smallTool.name);
		expect(session.getActiveToolNames()).not.toContain(oversizedTool.name);
	});

	it("does not count the resident search tool toward the discovered selection budget", async () => {
		const tools = Array.from({ length: 8 }, (_, index) => createTool(`discoverable_${index + 1}`));
		const { session } = createSession(tools);
		sessions.push(session);

		expect(await session.activateDiscoveredTools(tools.map(tool => tool.name))).toEqual(tools.map(tool => tool.name));
		expect(session.getSelectedDiscoveredToolNames()).toHaveLength(8);
		expect(session.getActiveToolNames()).toContain("search_tool_bm25");
	});

	it("increments the discovered tool epoch for activation changes and remains stable for no-op activation", async () => {
		const discoveredTool = createTool("discoverable");
		const { session } = createSession([discoveredTool]);
		sessions.push(session);
		const before = session.getDiscoveredToolEpoch();

		await session.activateDiscoveredTools([discoveredTool.name]);
		const afterActivation = session.getDiscoveredToolEpoch();
		expect(afterActivation).toEqual({ epoch: before.epoch + 1, reason: "activation:discoverable" });

		await session.activateDiscoveredTools([discoveredTool.name]);
		expect(session.getDiscoveredToolEpoch()).toEqual(afterActivation);
	});

	it("emits a warning notice when an activation batch is rejected", async () => {
		const tools = Array.from({ length: 9 }, (_, index) => createTool(`discoverable_${index + 1}`));
		const { session } = createSession(tools);
		sessions.push(session);
		const notices: Array<{ level: string; source?: string; message: string }> = [];
		session.subscribe(event => {
			if (event.type === "notice") {
				notices.push({ level: event.level, source: event.source, message: event.message });
			}
		});

		await session.activateDiscoveredTools(tools.slice(0, 8).map(tool => tool.name));
		expect(notices).toHaveLength(0);

		expect(await session.activateDiscoveredTools([tools[8].name])).toEqual([]);
		expect(notices).toHaveLength(1);
		expect(notices[0].level).toBe("warning");
		expect(notices[0].source).toBe("tool-discovery");
		expect(notices[0].message).toContain("limit is 8");
	});

	it("leaves explicit user selection via setActiveToolsByName unrestricted", async () => {
		const tools = Array.from({ length: 9 }, (_, index) => createTool(`discoverable_${index + 1}`));
		const { session } = createSession(tools);
		sessions.push(session);

		await session.setActiveToolsByName(["search_tool_bm25", ...tools.map(tool => tool.name)]);
		const active = session.getActiveToolNames();
		for (const tool of tools) expect(active).toContain(tool.name);
	});

	it("rejects a token-dense batch under the byte cap via the independent token estimate", async () => {
		// Hangul: ~3 UTF-8 bytes but ~1 estimated token per character, so ~20k
		// characters stay under the 65,536-byte cap while exceeding 16,384 tokens.
		const denseTool = createTool("dense", {
			parameters: z.object({ payload: z.string().describe("가".repeat(20_000)) }),
		});
		const { session } = createSession([denseTool]);
		sessions.push(session);
		const notices: string[] = [];
		session.subscribe(event => {
			if (event.type === "notice") notices.push(event.message);
		});

		expect(await session.activateDiscoveredTools([denseTool.name])).toEqual([]);
		expect(session.getSelectedDiscoveredToolNames()).toEqual([]);
		expect(notices).toHaveLength(1);
		expect(notices[0]).toContain("estimated tokens");
	});

	it("increments the epoch when a same-name tool's wire schema changes", async () => {
		const original = createTool("mutating", { parameters: z.object({ a: z.string() }) });
		const { session, toolRegistry } = createSession([original]);
		sessions.push(session);

		await session.activateDiscoveredTools([original.name]);
		const afterActivation = session.getDiscoveredToolEpoch();

		// Same name/label/description, different parameters: only the wire schema
		// fingerprint distinguishes the two registrations.
		const mutated = createTool("mutating", { parameters: z.object({ a: z.string(), b: z.number() }) });
		toolRegistry.set(mutated.name, mutated);
		await session.setActiveToolsByName(session.getActiveToolNames());

		const afterMutation = session.getDiscoveredToolEpoch();
		expect(afterMutation.epoch).toBe(afterActivation.epoch + 1);
		expect(afterMutation.reason).toBe("set-active-tools");
	});

	it("increments the epoch when a same-object tool's dynamic parameters getter changes its schema", async () => {
		const schemaA = z.object({ a: z.string() });
		const schemaB = z.object({ a: z.string(), b: z.number() });
		let currentSchema: z.ZodType = schemaA;
		const dynamicTool: AgentTool = {
			name: "dynamic",
			label: "dynamic",
			description: "dynamic tool",
			get parameters() {
				return currentSchema;
			},
			strict: true,
			loadMode: "discoverable",
			async execute() {
				return { content: [{ type: "text", text: "dynamic executed" }] };
			},
		};
		const { session } = createSession([dynamicTool]);
		sessions.push(session);

		await session.activateDiscoveredTools([dynamicTool.name]);
		const afterActivation = session.getDiscoveredToolEpoch();

		// Same tool object, same name/label/description: only the parameters
		// getter result changes (Ask/Task/Edit-style dynamic schemas).
		currentSchema = schemaB;
		await session.setActiveToolsByName(session.getActiveToolNames());

		const afterMutation = session.getDiscoveredToolEpoch();
		expect(afterMutation.epoch).toBe(afterActivation.epoch + 1);
	});

	it("increments the epoch when a same-name tool flips strict from undefined to false", async () => {
		const sharedSchema = z.object({ a: z.string() });
		const defaultStrict: AgentTool = { ...createTool("strictness", { parameters: sharedSchema }) };
		delete (defaultStrict as { strict?: boolean }).strict;
		const { session, toolRegistry } = createSession([defaultStrict]);
		sessions.push(session);

		await session.activateDiscoveredTools([defaultStrict.name]);
		const afterActivation = session.getDiscoveredToolEpoch();

		// Provider strict mode treats undefined as strict and only explicit false
		// as non-strict, so undefined -> false is a provider-visible change even
		// with an identical parameters object.
		const nonStrict: AgentTool = { ...defaultStrict, strict: false };
		toolRegistry.set(nonStrict.name, nonStrict);
		await session.setActiveToolsByName(session.getActiveToolNames());

		const afterMutation = session.getDiscoveredToolEpoch();
		expect(afterMutation.epoch).toBe(afterActivation.epoch + 1);
	});

	it("fails closed when wire serialization of a selected tool throws", async () => {
		const healthyTool = createTool("healthy");
		const poisonedTool: AgentTool = {
			name: "poisoned",
			label: "poisoned",
			description: "poisoned tool",
			get parameters(): z.ZodType {
				throw new Error("schema conversion exploded");
			},
			strict: true,
			loadMode: "discoverable",
			async execute() {
				return { content: [{ type: "text", text: "poisoned executed" }] };
			},
		};
		const { session } = createSession([healthyTool, poisonedTool]);
		sessions.push(session);
		const notices: string[] = [];
		session.subscribe(event => {
			if (event.type === "notice") notices.push(event.message);
		});

		expect(await session.activateDiscoveredTools([healthyTool.name, poisonedTool.name])).toEqual([]);
		expect(session.getSelectedDiscoveredToolNames()).toEqual([]);
		expect(notices).toHaveLength(1);
		expect(notices[0]).toContain("wire serialization failed");
	});
});
