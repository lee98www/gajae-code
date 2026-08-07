import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { UsageProvider } from "@gajae-code/ai";
import * as oauth from "@gajae-code/ai/utils/oauth";
import type { OAuthCredentials } from "@gajae-code/ai/utils/oauth/types";
import { AuthStorage } from "@gajae-code/coding-agent/session/auth-storage";
import { Snowflake } from "@gajae-code/utils";

describe("AuthStorage account rotation", () => {
	let tempDir: string;
	let authStorage: AuthStorage;
	let usageExhausted = false;
	let usageByAccount: Map<string, number>;

	const usageProvider: UsageProvider = {
		id: "openai-codex",
		async fetchUsage(params) {
			const accountId = params.credential.accountId ?? "unknown";
			return {
				provider: "openai-codex",
				fetchedAt: Date.now(),
				limits: [
					{
						id: `requests-${accountId}`,
						label: "Requests",
						scope: { provider: "openai-codex", accountId },
						amount: {
							unit: "requests",
							used: usageExhausted ? 100 : (usageByAccount.get(accountId) ?? 10),
							limit: 100,
						},
						status: usageExhausted || (usageByAccount.get(accountId) ?? 10) >= 100 ? "exhausted" : "ok",
					},
				],
			};
		},
	};

	beforeEach(async () => {
		tempDir = path.join(os.tmpdir(), `pi-test-auth-rotation-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
		usageExhausted = false;
		usageByAccount = new Map();

		authStorage = await AuthStorage.create(path.join(tempDir, "testauth.db"), {
			usageProviderResolver: provider => (provider === "openai-codex" ? usageProvider : undefined),
		});

		// Stub the refresh path so AuthStorage doesn't hit a real OAuth endpoint
		// when the credential lands inside the 60s skew. Returning the credential
		// unchanged preserves the test's deterministic accountId routing.
		vi.spyOn(oauth, "refreshOAuthToken").mockImplementation(async (_provider, credential) => {
			return credential;
		});
		vi.spyOn(oauth, "getOAuthApiKey").mockImplementation(async (_provider, credentials) => {
			const credential = credentials["openai-codex"] as OAuthCredentials | undefined;
			if (!credential) return null;
			return {
				apiKey: `api-${credential.accountId ?? "unknown"}`,
				newCredentials: credential,
			};
		});
	});

	afterEach(() => {
		vi.restoreAllMocks();
		authStorage.close();
		if (tempDir && fs.existsSync(tempDir)) {
			fs.rmSync(tempDir, { recursive: true });
		}
	});

	test("returns a fallback key when every OAuth account is usage-limited", async () => {
		await authStorage.set("openai-codex", [
			{
				type: "oauth",
				access: "access-1",
				refresh: "refresh-1",
				expires: Date.now() + 60_000,
				accountId: "acct-1",
			},
			{
				type: "oauth",
				access: "access-2",
				refresh: "refresh-2",
				expires: Date.now() + 60_000,
				accountId: "acct-2",
			},
		]);

		const sessionId = "issue-55-session";
		const firstKey = await authStorage.getApiKey("openai-codex", sessionId);
		expect(firstKey).toMatch(/^api-acct-/);

		usageExhausted = true;
		const switched = await authStorage.markUsageLimitReached("openai-codex", sessionId);
		expect(switched).toBe(true);

		const exhaustedFallbackKey = await authStorage.getApiKey("openai-codex", sessionId);
		expect(exhaustedFallbackKey).toMatch(/^api-acct-/);
	});

	test("round-robins fresh session assignments and keeps session stickiness", async () => {
		await authStorage.set("openai-codex", [
			{
				type: "oauth",
				access: "access-1",
				refresh: "refresh-1",
				expires: Date.now() + 60 * 60_000,
				accountId: "acct-1",
			},
			{
				type: "oauth",
				access: "access-2",
				refresh: "refresh-2",
				expires: Date.now() + 60 * 60_000,
				accountId: "acct-2",
			},
		]);

		const firstSessionKey = await authStorage.getApiKey("openai-codex", "fresh-session-a");
		const secondSessionKey = await authStorage.getApiKey("openai-codex", "fresh-session-b");
		const firstSessionAgain = await authStorage.getApiKey("openai-codex", "fresh-session-a");

		expect(firstSessionKey).toBe("api-acct-1");
		expect(secondSessionKey).toBe("api-acct-2");
		expect(firstSessionAgain).toBe(firstSessionKey);
	});

	test("balanced usage checks preserve round-robin across healthy accounts", async () => {
		usageByAccount.set("acct-1", 1);
		usageByAccount.set("acct-2", 90);
		usageByAccount.set("acct-3", 50);

		await authStorage.set("openai-codex", [
			{
				type: "oauth",
				access: "access-1",
				refresh: "refresh-1",
				expires: Date.now() + 60 * 60_000,
				accountId: "acct-1",
			},
			{
				type: "oauth",
				access: "access-2",
				refresh: "refresh-2",
				expires: Date.now() + 60 * 60_000,
				accountId: "acct-2",
			},
			{
				type: "oauth",
				access: "access-3",
				refresh: "refresh-3",
				expires: Date.now() + 60 * 60_000,
				accountId: "acct-3",
			},
		]);

		const keys = [
			await authStorage.getApiKey("openai-codex", "fresh-session-a"),
			await authStorage.getApiKey("openai-codex", "fresh-session-b"),
			await authStorage.getApiKey("openai-codex", "fresh-session-c"),
			await authStorage.getApiKey("openai-codex", "fresh-session-d"),
		];

		expect(keys).toEqual(["api-acct-1", "api-acct-2", "api-acct-3", "api-acct-1"]);
	});

	test("soft-blocks a transient-failed credential so retry uses another account", async () => {
		await authStorage.set("openai-codex", [
			{
				type: "oauth",
				access: "access-1",
				refresh: "refresh-1",
				expires: Date.now() + 60 * 60_000,
				accountId: "acct-1",
			},
			{
				type: "oauth",
				access: "access-2",
				refresh: "refresh-2",
				expires: Date.now() + 60 * 60_000,
				accountId: "acct-2",
			},
		]);

		const sessionId = "first-event-timeout-session";
		const firstKey = await authStorage.getApiKey("openai-codex", sessionId);
		const switched = authStorage.markTransientCredentialFailure("openai-codex", sessionId);
		const retryKey = await authStorage.getApiKey("openai-codex", sessionId);

		expect(switched).toBe(true);
		expect(retryKey).toMatch(/^api-acct-/);
		expect(retryKey).not.toBe(firstKey);
	});
});
