import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { setAgentDir } from "@gajae-code/utils";
import { resolveAuthBrokerConfig } from "../src/session/auth-broker-config";

/**
 * Regression guard for the silent-broker-bypass bug (2026-07-04): the Settings
 * system writes/reads config.yml as NESTED YAML (dotted schema keys resolve by
 * path traversal), but `readConfigYaml` in auth-broker-config.ts only looked up
 * the flat literal key `"auth.broker.url"`. A canonically written config was
 * therefore invisible, `resolveAuthBrokerConfig()` returned null, and every
 * process silently fell back to the local SQLite store — concurrent processes
 * then raced the single-use OAuth refresh rotation and permanently invalidated
 * vault credentials while the broker idled.
 */
describe("resolveAuthBrokerConfig config.yml shapes", () => {
	let agentDir = "";
	let savedUrl: string | undefined;
	let savedToken: string | undefined;

	beforeEach(async () => {
		agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-broker-config-"));
		setAgentDir(agentDir);
		savedUrl = process.env.GJC_AUTH_BROKER_URL;
		savedToken = process.env.GJC_AUTH_BROKER_TOKEN;
		delete process.env.GJC_AUTH_BROKER_URL;
		process.env.GJC_AUTH_BROKER_TOKEN = "test-bearer";
	});

	afterEach(async () => {
		if (savedUrl === undefined) delete process.env.GJC_AUTH_BROKER_URL;
		else process.env.GJC_AUTH_BROKER_URL = savedUrl;
		if (savedToken === undefined) delete process.env.GJC_AUTH_BROKER_TOKEN;
		else process.env.GJC_AUTH_BROKER_TOKEN = savedToken;
		await fs.rm(agentDir, { recursive: true, force: true });
	});

	test("reads the nested shape the Settings system writes", async () => {
		await Bun.write(path.join(agentDir, "config.yml"), "auth:\n  broker:\n    url: http://127.0.0.1:8766\n");
		const cfg = await resolveAuthBrokerConfig();
		expect(cfg?.url).toBe("http://127.0.0.1:8766");
		expect(cfg?.token).toBe("test-bearer");
	});

	test("still reads the flat dotted-literal key", async () => {
		await Bun.write(path.join(agentDir, "config.yml"), '"auth.broker.url": http://127.0.0.1:9999\n');
		const cfg = await resolveAuthBrokerConfig();
		expect(cfg?.url).toBe("http://127.0.0.1:9999");
	});

	test("nested token is honoured when env token is absent", async () => {
		delete process.env.GJC_AUTH_BROKER_TOKEN;
		await Bun.write(
			path.join(agentDir, "config.yml"),
			"auth:\n  broker:\n    url: http://127.0.0.1:8766\n    token: from-config\n",
		);
		const cfg = await resolveAuthBrokerConfig();
		expect(cfg?.url).toBe("http://127.0.0.1:8766");
		expect(cfg?.token).toBe("from-config");
	});

	test("returns null when no broker url is configured anywhere", async () => {
		await Bun.write(path.join(agentDir, "config.yml"), "serviceTier: priority\n");
		expect(await resolveAuthBrokerConfig()).toBeNull();
	});

	test("returns null when auth.broker exists but url is not a string", async () => {
		await Bun.write(path.join(agentDir, "config.yml"), "auth:\n  broker:\n    url:\n      nested: wrong\n");
		expect(await resolveAuthBrokerConfig()).toBeNull();
	});

	test("env var still wins over the nested config value", async () => {
		process.env.GJC_AUTH_BROKER_URL = "http://env-wins:1";
		await Bun.write(path.join(agentDir, "config.yml"), "auth:\n  broker:\n    url: http://127.0.0.1:8766\n");
		const cfg = await resolveAuthBrokerConfig();
		expect(cfg?.url).toBe("http://env-wins:1");
	});
});
