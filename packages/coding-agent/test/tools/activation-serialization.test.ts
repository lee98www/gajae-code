import { afterEach, describe, expect, it } from "bun:test";
import type { AgentSession } from "../../src/session/agent-session";
import {
	createDiscoverableTool,
	createDiscoverySession,
	createMcpDiscoverableTool,
	type RebuildCounter,
} from "./discovery-test-harness";

describe("discovered tool activation serialization", () => {
	const sessions: AgentSession[] = [];

	afterEach(async () => {
		for (const session of sessions.splice(0)) await session.dispose();
	});

	it("preserves disjoint concurrent activations and leaves the applied signature current", async () => {
		const counter: RebuildCounter = { count: 0 };
		const tools = [createDiscoverableTool("concurrent_a"), createDiscoverableTool("concurrent_b")];
		const { session } = createDiscoverySession(tools, counter);
		sessions.push(session);

		const activated = await Promise.all(tools.map(tool => session.activateDiscoveredTools([tool.name])));

		expect(activated).toEqual([[tools[0].name], [tools[1].name]]);
		expect(session.getActiveToolNames()).toEqual(expect.arrayContaining(tools.map(tool => tool.name)));
		expect(counter.count).toBe(2);

		await session.setActiveToolsByName(session.getActiveToolNames());
		expect(counter.count).toBe(2);
	});

	it("charges exactly one rebuild and epoch per accepted concurrent batch", async () => {
		const counter: RebuildCounter = { count: 0 };
		const tools = [createDiscoverableTool("epoch_a"), createDiscoverableTool("epoch_b")];
		const { session } = createDiscoverySession(tools, counter);
		sessions.push(session);
		const before = session.getDiscoveredToolEpoch();

		await Promise.all(tools.map(tool => session.activateDiscoveredTools([tool.name])));

		expect(counter.count).toBe(2);
		expect(session.getDiscoveredToolEpoch()).toEqual({
			epoch: before.epoch + 2,
			reason: `activation:${tools[1].name}`,
		});
	});

	it("propagates a rebuild error without poisoning later activation", async () => {
		const counter: RebuildCounter = { count: 0 };
		const failedTool = createDiscoverableTool("fails_rebuild");
		const successfulTool = createDiscoverableTool("survives_rebuild");
		let throwNext = true;
		const { session } = createDiscoverySession([failedTool, successfulTool], counter, {
			onRebuild: () => {
				if (throwNext) {
					throwNext = false;
					throw new Error("injected rebuild failure");
				}
			},
		});
		sessions.push(session);

		const epochBeforeFailure = session.getDiscoveredToolEpoch();
		await expect(session.activateDiscoveredTools([failedTool.name])).rejects.toThrow("injected rebuild failure");
		expect(counter.count).toBe(0);
		// A failed apply must not leave an epoch describing tools that never activated.
		expect(session.getDiscoveredToolEpoch()).toEqual(epochBeforeFailure);

		expect(await session.activateDiscoveredTools([successfulTool.name])).toEqual([successfulTool.name]);
		expect(counter.count).toBe(1);
		expect(session.getActiveToolNames()).toContain(successfulTool.name);
		expect(session.getActiveToolNames()).not.toContain(failedTool.name);
	});
	it("runs an already queued follower after an asynchronous rebuild rejection", async () => {
		const counter: RebuildCounter = { count: 0 };
		const failedTool = createDiscoverableTool("async_fails_rebuild");
		const followerTool = createDiscoverableTool("queued_after_async_failure");
		let releaseFailure: () => void = () => {};
		let signalEntered: () => void = () => {};
		const failureGate = new Promise<void>(resolve => {
			releaseFailure = resolve;
		});
		const entered = new Promise<void>(resolve => {
			signalEntered = resolve;
		});
		let first = true;
		const { session } = createDiscoverySession([failedTool, followerTool], counter, {
			onRebuild: async () => {
				if (!first) return;
				first = false;
				signalEntered();
				await failureGate;
				throw new Error("injected async rebuild failure");
			},
		});
		sessions.push(session);

		const failed = session.activateDiscoveredTools([failedTool.name]);
		await entered;
		const follower = session.activateDiscoveredTools([followerTool.name]);
		releaseFailure();

		await expect(failed).rejects.toThrow("injected async rebuild failure");
		expect(await follower).toEqual([followerTool.name]);
		expect(session.getActiveToolNames()).toContain(followerTool.name);
		expect(session.getActiveToolNames()).not.toContain(failedTool.name);
		expect(counter.count).toBe(1);
	});

	it("runs sequentially submitted activations in FIFO order", async () => {
		const counter: RebuildCounter = { count: 0 };
		const rebuildOrder: string[] = [];
		const resolutionOrder: string[] = [];
		const tools = ["fifo_a", "fifo_b", "fifo_c"].map(name => createDiscoverableTool(name));
		const { session } = createDiscoverySession(tools, counter, {
			onRebuild: toolNames => {
				rebuildOrder.push(toolNames[toolNames.length - 1] ?? "missing");
			},
		});
		sessions.push(session);

		await Promise.all(
			tools.map(tool =>
				session.activateDiscoveredTools([tool.name]).then(result => {
					resolutionOrder.push(tool.name);
					return result;
				}),
			),
		);

		expect(rebuildOrder).toEqual(tools.map(tool => tool.name));
		expect(resolutionOrder).toEqual(tools.map(tool => tool.name));
		expect(counter.count).toBe(3);
		expect(session.getActiveToolNames()).toEqual(expect.arrayContaining(tools.map(tool => tool.name)));
	});

	it("keeps serial single-batch and no-op rebuild behavior unchanged", async () => {
		const counter: RebuildCounter = { count: 0 };
		const tool = createDiscoverableTool("serial_tool");
		const { session } = createDiscoverySession([tool], counter);
		sessions.push(session);

		expect(await session.activateDiscoveredTools([tool.name])).toEqual([tool.name]);
		expect(counter.count).toBe(1);
		expect(await session.activateDiscoveredTools([tool.name])).toEqual([]);
		expect(counter.count).toBe(1);
	});

	it("enforces the cumulative N cap across concurrent batches (no cap bypass by merging)", async () => {
		const counter: RebuildCounter = { count: 0 };
		const tools = Array.from({ length: 10 }, (_, index) => createDiscoverableTool(`cap_${index + 1}`));
		const { session } = createDiscoverySession(tools, counter);
		sessions.push(session);
		const notices: string[] = [];
		session.subscribe(event => {
			if (event.type === "notice") notices.push(event.message);
		});

		// Two concurrent 5-tool batches: pre-queue cap checks would each see an
		// empty selection and pass, merging to 10 selected tools (cap bypass).
		const results = await Promise.all([
			session.activateDiscoveredTools(tools.slice(0, 5).map(tool => tool.name)),
			session.activateDiscoveredTools(tools.slice(5, 10).map(tool => tool.name)),
		]);

		const selected = session.getSelectedDiscoveredToolNames();
		expect(selected.length).toBeLessThanOrEqual(8);
		// FIFO: first batch accepted (5), second rejected whole (would total 10).
		expect(results[0]).toEqual(tools.slice(0, 5).map(tool => tool.name));
		expect(results[1]).toEqual([]);
		expect(selected).toHaveLength(5);
		expect(counter.count).toBe(1);
		// Rejected for the N cap on the MERGED set, not the byte/token cap.
		expect(notices).toHaveLength(1);
		expect(notices[0]).toContain("selected discoverable tool limit is 8 (requested 10)");
		const active = session.getActiveToolNames();
		for (const tool of tools.slice(5, 10)) expect(active).not.toContain(tool.name);
	});

	it("does not lose an accepted activation to a concurrently queued explicit set", async () => {
		const counter: RebuildCounter = { count: 0 };
		const activatedTool = createDiscoverableTool("mixed_activated");
		const explicitTool = createDiscoverableTool("mixed_set");
		const { session } = createDiscoverySession([activatedTool, explicitTool], counter);
		sessions.push(session);

		// Adversarial ordering found by red-team QA: the explicit setter captures a
		// baseline BEFORE the activation commits, so a pre-lock snapshot would
		// replace the active set and silently drop the accepted activation.
		const baseline = session.getActiveToolNames();
		const [activated] = await Promise.all([
			session.activateDiscoveredTools([activatedTool.name]),
			session.setActiveToolsByName([...baseline, explicitTool.name]),
		]);

		expect(activated).toEqual([activatedTool.name]);
		const active = session.getActiveToolNames();
		expect(active).toContain(explicitTool.name);
		expect(active).toContain(activatedTool.name);
	});

	it("serializes the apply wrapper itself against a gated concurrent activation", async () => {
		const counter: RebuildCounter = { count: 0 };
		const activatedTool = createDiscoverableTool("wrapper_activated");
		const explicitTool = createDiscoverableTool("wrapper_set");
		const rebuildSnapshots: string[][] = [];
		let releaseGate: () => void = () => {};
		let signalEntered: () => void = () => {};
		const gate = new Promise<void>(resolve => {
			releaseGate = resolve;
		});
		const firstRebuildEntered = new Promise<void>(resolve => {
			signalEntered = resolve;
		});
		let gated = false;
		const { session } = createDiscoverySession([activatedTool, explicitTool], counter, {
			onRebuild: async toolNames => {
				rebuildSnapshots.push([...toolNames]);
				if (!gated) {
					gated = true;
					signalEntered();
					await gate;
				}
			},
		});
		sessions.push(session);

		// Hold the lock inside the activation's rebuild, then submit the explicit
		// setter: it must queue behind the wrapper rather than interleave.
		const activation = session.activateDiscoveredTools([activatedTool.name]);
		await firstRebuildEntered;
		const explicitSet = session.setActiveToolsByName([...session.getActiveToolNames(), explicitTool.name]);
		releaseGate();

		expect(await activation).toEqual([activatedTool.name]);
		await explicitSet;

		expect(counter.count).toBe(2);
		// First rebuild sees the activation only; the queued setter's rebuild sees both.
		expect(rebuildSnapshots).toHaveLength(2);
		expect(rebuildSnapshots[0]).toContain(activatedTool.name);
		expect(rebuildSnapshots[0]).not.toContain(explicitTool.name);
		expect(rebuildSnapshots[1]).toContain(activatedTool.name);
		expect(rebuildSnapshots[1]).toContain(explicitTool.name);
		const active = session.getActiveToolNames();
		expect(active).toContain(activatedTool.name);
		expect(active).toContain(explicitTool.name);
	});

	it("does not lose an accepted MCP-discoverable activation to a stale explicit set", async () => {
		const counter: RebuildCounter = { count: 0 };
		// Real MCP bridge tool (mcp__ name + mcpServerName/mcpToolName) with MCP
		// discovery enabled, so it takes the MCP selection path: such names never
		// enter the builtin selection set, and a builtin-only preservation read
		// would leave this arm of the drop-tools race open.
		const mcpTool = createMcpDiscoverableTool("server", "activated");
		const explicitTool = createDiscoverableTool("mcp_race_set");
		const { session } = createDiscoverySession([mcpTool, explicitTool], counter, {
			mcpDiscoveryEnabled: true,
		});
		sessions.push(session);
		expect(session.getSelectedMCPToolNames()).not.toContain(mcpTool.name);

		const baseline = session.getActiveToolNames();
		const [activated] = await Promise.all([
			session.activateDiscoveredTools([mcpTool.name]),
			session.setActiveToolsByName([...baseline, explicitTool.name]),
		]);

		expect(activated).toEqual([mcpTool.name]);
		// Proves the MCP branch was taken: the name is visible only through the
		// MCP selection accessor, not the builtin discovered set.
		expect(session.getSelectedMCPToolNames()).toContain(mcpTool.name);
		const active = session.getActiveToolNames();
		expect(active).toContain(mcpTool.name);
		expect(active).toContain(explicitTool.name);
	});

	it("still honors explicit deselection of a committed discovered tool", async () => {
		const counter: RebuildCounter = { count: 0 };
		const tool = createDiscoverableTool("deselect_me");
		const { session } = createDiscoverySession([tool], counter);
		sessions.push(session);

		expect(await session.activateDiscoveredTools([tool.name])).toEqual([tool.name]);
		expect(session.getActiveToolNames()).toContain(tool.name);

		// Sequential (post-commit) deselection must remove it: the preservation
		// union only protects names that appeared AFTER the caller's snapshot.
		await session.setActiveToolsByName(session.getActiveToolNames().filter(name => name !== tool.name));
		expect(session.getActiveToolNames()).not.toContain(tool.name);
		expect(session.getSelectedDiscoveredToolNames()).not.toContain(tool.name);
	});

	it("treats a queued activation as a no-op once the session is disposed", async () => {
		const counter: RebuildCounter = { count: 0 };
		const gatedTool = createDiscoverableTool("gated_during_dispose");
		const queuedTool = createDiscoverableTool("queued_after_dispose");
		let releaseGate: () => void = () => {};
		let signalEntered: () => void = () => {};
		const gate = new Promise<void>(resolve => {
			releaseGate = resolve;
		});
		const entered = new Promise<void>(resolve => {
			signalEntered = resolve;
		});
		const { session } = createDiscoverySession([gatedTool, queuedTool], counter, {
			onRebuild: async () => {
				signalEntered();
				await gate;
			},
		});

		// The first apply is suspended INSIDE its rebuild when dispose() lands, so
		// resuming it must hit the post-await disposal re-check; the second link is
		// queued behind and must hit the entry fence.
		const gatedApply = session.activateDiscoveredTools([gatedTool.name]);
		await entered;
		const queuedApply = session.activateDiscoveredTools([queuedTool.name]);
		await session.dispose();
		releaseGate();

		// Post-await fence: the gated apply resumed after disposal and must not
		// have installed its tool or advanced selections.
		expect(await gatedApply).toEqual([gatedTool.name]);
		expect(session.getSelectedDiscoveredToolNames()).not.toContain(gatedTool.name);
		expect(session.getActiveToolNames()).not.toContain(gatedTool.name);
		// Entry fence: the queued link short-circuits entirely.
		expect(await queuedApply).toEqual([]);
		expect(session.getSelectedDiscoveredToolNames()).not.toContain(queuedTool.name);
	});
	it("runs lock-scoped transforms against the latest queued active set", async () => {
		const counter: RebuildCounter = { count: 0 };
		const activatedTool = createDiscoverableTool("transform_activated");
		const controllerTool = createDiscoverableTool("transform_controller");
		let releaseGate: () => void = () => {};
		let signalEntered: () => void = () => {};
		const gate = new Promise<void>(resolve => {
			releaseGate = resolve;
		});
		const entered = new Promise<void>(resolve => {
			signalEntered = resolve;
		});
		let gated = false;
		const { session } = createDiscoverySession([activatedTool, controllerTool], counter, {
			onRebuild: async () => {
				if (gated) return;
				gated = true;
				signalEntered();
				await gate;
			},
		});
		sessions.push(session);

		const activation = session.activateDiscoveredTools([activatedTool.name]);
		await entered;
		const controllerUpdate = session.updateActiveToolsByName(
			current => [...current, controllerTool.name],
			"test:controller-update",
		);
		releaseGate();

		await Promise.all([activation, controllerUpdate]);
		expect(session.getActiveToolNames()).toEqual(expect.arrayContaining([activatedTool.name, controllerTool.name]));
		expect(counter.count).toBe(2);
	});

	it("does not poison the mutation queue when a lock-scoped transform throws", async () => {
		const counter: RebuildCounter = { count: 0 };
		const tool = createDiscoverableTool("after_transform_failure");
		const { session } = createDiscoverySession([tool], counter);
		sessions.push(session);

		await expect(
			session.updateActiveToolsByName(() => {
				throw new Error("injected transform failure");
			}, "test:throw"),
		).rejects.toThrow("injected transform failure");

		expect(await session.activateDiscoveredTools([tool.name])).toEqual([tool.name]);
		expect(session.getActiveToolNames()).toContain(tool.name);
		expect(counter.count).toBe(1);
	});

	it("serializes explicit prompt refresh behind an in-flight tool apply", async () => {
		const counter: RebuildCounter = { count: 0 };
		const tool = createDiscoverableTool("refresh_race_tool");
		let releaseGate: () => void = () => {};
		let signalEntered: () => void = () => {};
		const gate = new Promise<void>(resolve => {
			releaseGate = resolve;
		});
		const entered = new Promise<void>(resolve => {
			signalEntered = resolve;
		});
		let rebuildIndex = 0;
		const { session } = createDiscoverySession([tool], counter, {
			onRebuild: async () => {
				rebuildIndex++;
				if (rebuildIndex === 1) {
					signalEntered();
					await gate;
				}
			},
		});
		sessions.push(session);

		const activation = session.activateDiscoveredTools([tool.name]);
		await entered;
		const refresh = session.refreshBaseSystemPrompt();
		releaseGate();
		await Promise.all([activation, refresh]);

		expect(counter.count).toBe(2);
		expect(session.agent.state.systemPrompt).toEqual([expect.stringContaining(tool.name)]);
		await session.setActiveToolsByName(session.getActiveToolNames());
		expect(counter.count).toBe(2);
	});
	it("lets a queued activation supersede an earlier in-flight explicit refresh", async () => {
		const counter: RebuildCounter = { count: 0 };
		const tool = createDiscoverableTool("activation_after_refresh");
		let releaseRefresh: () => void = () => {};
		let signalEntered: () => void = () => {};
		const refreshGate = new Promise<void>(resolve => {
			releaseRefresh = resolve;
		});
		const entered = new Promise<void>(resolve => {
			signalEntered = resolve;
		});
		let first = true;
		const { session } = createDiscoverySession([tool], counter, {
			onRebuild: async () => {
				if (!first) return;
				first = false;
				signalEntered();
				await refreshGate;
			},
		});
		sessions.push(session);

		const refresh = session.refreshBaseSystemPrompt();
		await entered;
		const activation = session.activateDiscoveredTools([tool.name]);
		releaseRefresh();
		await Promise.all([refresh, activation]);

		expect(counter.count).toBe(2);
		expect(session.getActiveToolNames()).toContain(tool.name);
		expect(session.agent.state.systemPrompt).toEqual([expect.stringContaining(tool.name)]);
		await session.setActiveToolsByName(session.getActiveToolNames());
		expect(counter.count).toBe(2);
	});

	it("does not install a prompt when disposal lands during explicit refresh", async () => {
		const counter: RebuildCounter = { count: 0 };
		let releaseGate: () => void = () => {};
		let signalEntered: () => void = () => {};
		const gate = new Promise<void>(resolve => {
			releaseGate = resolve;
		});
		const entered = new Promise<void>(resolve => {
			signalEntered = resolve;
		});
		const { session } = createDiscoverySession([], counter, {
			onRebuild: async () => {
				signalEntered();
				await gate;
			},
		});

		const refresh = session.refreshBaseSystemPrompt();
		await entered;
		await session.dispose();
		releaseGate();
		await refresh;

		expect(session.agent.state.systemPrompt).toEqual(["initial"]);
	});
	it("skips apply, epoch, and rebuild work when a lock-scoped transform returns undefined", async () => {
		const counter: RebuildCounter = { count: 0 };
		const { session } = createDiscoverySession([], counter);
		sessions.push(session);
		const activeBefore = session.getActiveToolNames();
		const epochBefore = session.getDiscoveredToolEpoch();

		await session.updateActiveToolsByName(() => undefined, "test:no-op");

		expect(session.getActiveToolNames()).toEqual(activeBefore);
		expect(session.getDiscoveredToolEpoch()).toEqual(epochBefore);
		expect(counter.count).toBe(0);
	});
});
