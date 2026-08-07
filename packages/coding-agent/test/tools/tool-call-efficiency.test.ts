import { afterEach, describe, expect, it } from "bun:test";
import * as z from "zod/v4";
import type { AgentSession } from "../../src/session/agent-session";
import { createDiscoverableTool, createDiscoverySession, type RebuildCounter } from "./discovery-test-harness";

describe("discovered tool-call efficiency", () => {
	const sessions: AgentSession[] = [];

	afterEach(async () => {
		for (const session of sessions.splice(0)) await session.dispose();
	});

	it("does not churn the epoch or rebuild the prompt for a no-op activation", async () => {
		const counter: RebuildCounter = { count: 0 };
		const tool = createDiscoverableTool("selected");
		const { session } = createDiscoverySession([tool], counter);
		sessions.push(session);

		expect(await session.activateDiscoveredTools([tool.name])).toEqual([tool.name]);
		const afterActivation = session.getDiscoveredToolEpoch();
		expect(afterActivation).toEqual({ epoch: 1, reason: "activation:selected" });
		expect(counter.count).toBe(1);

		expect(await session.activateDiscoveredTools([tool.name, tool.name])).toEqual([]);
		expect(session.getDiscoveredToolEpoch()).toEqual(afterActivation);
		expect(counter.count).toBe(1);
	});

	it("rejects over-count and oversized-schema batches before epoch churn or prompt rebuild", async () => {
		const counter: RebuildCounter = { count: 0 };
		const tools = Array.from({ length: 9 }, (_, index) => createDiscoverableTool(`discoverable_${index + 1}`));
		const { session } = createDiscoverySession(tools, counter);
		sessions.push(session);

		expect(await session.activateDiscoveredTools(tools.slice(0, 8).map(tool => tool.name))).toEqual(
			tools.slice(0, 8).map(tool => tool.name),
		);
		const afterEight = session.getDiscoveredToolEpoch();
		expect(counter.count).toBe(1);

		expect(await session.activateDiscoveredTools([tools[8].name])).toEqual([]);
		expect(session.getDiscoveredToolEpoch()).toEqual(afterEight);
		expect(counter.count).toBe(1);

		// Positive control: this session proves it CAN rebuild (small tool first),
		// so the zero-delta after the oversized batch is not vacuous.
		const oversizedCounter: RebuildCounter = { count: 0 };
		const small = createDiscoverableTool("small");
		const oversized = createDiscoverableTool("oversized", {
			parameters: z.object({ payload: z.string().describe("x".repeat(70_000)) }),
		});
		const { session: oversizedSession } = createDiscoverySession([small, oversized], oversizedCounter);
		sessions.push(oversizedSession);

		expect(await oversizedSession.activateDiscoveredTools([small.name])).toEqual([small.name]);
		const afterSmall = oversizedSession.getDiscoveredToolEpoch();
		expect(oversizedCounter.count).toBe(1);

		expect(await oversizedSession.activateDiscoveredTools([oversized.name])).toEqual([]);
		expect(oversizedSession.getDiscoveredToolEpoch()).toEqual(afterSmall);
		expect(oversizedCounter.count).toBe(1);
	});

	it("charges one rebuild and one epoch for a five-tool activation batch with faithful reason", async () => {
		const counter: RebuildCounter = { count: 0 };
		const tools = Array.from({ length: 5 }, (_, index) => createDiscoverableTool(`batch_${index + 1}`));
		const { session } = createDiscoverySession(tools, counter);
		sessions.push(session);
		const before = session.getDiscoveredToolEpoch();
		const names = tools.map(tool => tool.name);

		expect(await session.activateDiscoveredTools(names)).toEqual(names);
		expect(counter.count).toBe(1);
		expect(session.getDiscoveredToolEpoch()).toEqual({
			epoch: before.epoch + 1,
			reason: `activation:${names.join(",")}`,
		});
	});

	it("charges two rebuilds and two epochs for two sequential single-tool activations", async () => {
		const counter: RebuildCounter = { count: 0 };
		const tools = [createDiscoverableTool("first"), createDiscoverableTool("second")];
		const { session } = createDiscoverySession(tools, counter);
		sessions.push(session);
		const before = session.getDiscoveredToolEpoch();

		expect(await session.activateDiscoveredTools([tools[0].name])).toEqual([tools[0].name]);
		expect(await session.activateDiscoveredTools([tools[1].name])).toEqual([tools[1].name]);
		expect(counter.count).toBe(2);
		expect(session.getDiscoveredToolEpoch()).toEqual({ epoch: before.epoch + 2, reason: "activation:second" });
	});

	it("charges one rebuild and one epoch when an active tool wire schema mutates", async () => {
		const counter: RebuildCounter = { count: 0 };
		const original = createDiscoverableTool("mutating", { parameters: z.object({ a: z.string() }) });
		const { session, toolRegistry } = createDiscoverySession([original], counter);
		sessions.push(session);

		await session.activateDiscoveredTools([original.name]);
		const afterActivation = session.getDiscoveredToolEpoch();
		counter.count = 0;

		const mutated = createDiscoverableTool("mutating", { parameters: z.object({ a: z.string(), b: z.number() }) });
		toolRegistry.set(mutated.name, mutated);
		await session.setActiveToolsByName(session.getActiveToolNames());

		expect(counter.count).toBe(1);
		expect(session.getDiscoveredToolEpoch()).toEqual({
			epoch: afterActivation.epoch + 1,
			reason: "set-active-tools",
		});
	});
});
