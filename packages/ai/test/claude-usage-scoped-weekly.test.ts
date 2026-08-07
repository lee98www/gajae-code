import { describe, expect, it } from "bun:test";
import type { UsageFetchContext, UsageReport } from "../src/usage";
import { claudeRankingStrategy, claudeUsageProvider } from "../src/usage/claude";

// Mirrors the live /api/oauth/usage response shape (captured 2026-07-04): the
// legacy top-level buckets carry 5h/7d/opus/sonnet only, while model-scoped
// weekly caps (e.g. Fable) arrive exclusively inside the modern `limits[]`.
const RESET_5H = new Date(Date.now() + 3 * 60 * 60_000).toISOString();
const RESET_7D = new Date(Date.now() + 6 * 24 * 60 * 60_000).toISOString();

function scopedPayload(overrides?: { fablePercent?: number; sevenDayPercent?: number }) {
	const fablePercent = overrides?.fablePercent ?? 100;
	const sevenDayPercent = overrides?.sevenDayPercent ?? 78;
	return {
		five_hour: { utilization: 8, resets_at: RESET_5H },
		seven_day: { utilization: sevenDayPercent, resets_at: RESET_7D },
		seven_day_opus: null,
		seven_day_sonnet: null,
		limits: [
			{ kind: "session", percent: 8, resets_at: RESET_5H },
			{ kind: "weekly_all", percent: sevenDayPercent, resets_at: RESET_7D },
			{
				kind: "weekly_scoped",
				percent: fablePercent,
				resets_at: RESET_7D,
				scope: { model: { display_name: "Fable" } },
			},
		],
	};
}

function makeContext(body: unknown): UsageFetchContext {
	const fetchImpl = (async () =>
		new Response(JSON.stringify(body), {
			status: 200,
			headers: { "Content-Type": "application/json" },
		})) as unknown as typeof fetch;
	return { fetch: fetchImpl };
}

function baseParams() {
	return {
		provider: "anthropic" as const,
		credential: {
			type: "oauth" as const,
			accessToken: "oat-test",
			accountId: "org_test",
			email: "user@example.com",
			expiresAt: Date.now() + 60_000,
		},
	};
}

async function fetchReport(body: unknown): Promise<UsageReport> {
	const report = await claudeUsageProvider.fetchUsage(baseParams(), makeContext(body));
	expect(report).not.toBeNull();
	return report as UsageReport;
}

describe("claude usage model-scoped weekly limits", () => {
	it("emits a UsageLimit for a weekly_scoped model cap missing from legacy fields", async () => {
		const report = await fetchReport(scopedPayload());
		const fable = report.limits.find(l => l.id === "anthropic:7d:fable");
		expect(fable).toBeDefined();
		expect(fable?.scope.tier).toBe("fable");
		expect(fable?.scope.windowId).toBe("7d");
		expect(fable?.amount.usedFraction).toBe(1);
		expect(fable?.status).toBe("exhausted");
		expect(fable?.window?.resetsAt).toBe(Date.parse(RESET_7D));
	});

	it("does not duplicate limits already covered by legacy buckets", async () => {
		const payload = scopedPayload();
		payload.limits.push({
			kind: "weekly_scoped",
			percent: 33,
			resets_at: RESET_7D,
			scope: { model: { display_name: "Sonnet" } },
		});
		(payload as Record<string, unknown>).seven_day_sonnet = { utilization: 30, resets_at: RESET_7D };
		const report = await fetchReport(payload);
		const sonnetLimits = report.limits.filter(l => l.id === "anthropic:7d:sonnet");
		expect(sonnetLimits).toHaveLength(1);
		// Legacy bucket wins on collision (existing behavior preserved).
		expect(sonnetLimits[0]?.amount.used).toBe(30);
	});

	it("keeps working when the modern limits array is absent (legacy-only payload)", async () => {
		const report = await fetchReport({
			five_hour: { utilization: 8, resets_at: RESET_5H },
			seven_day: { utilization: 78, resets_at: RESET_7D },
		});
		expect(report.limits.map(l => l.id)).toEqual(["anthropic:5h", "anthropic:7d"]);
	});

	it("ignores malformed limits entries without crashing", async () => {
		const report = await fetchReport({
			five_hour: { utilization: 8, resets_at: RESET_5H },
			limits: [null, 42, "x", { kind: "weekly_scoped" }, { kind: "weekly_scoped", percent: "NaNish", scope: {} }],
		});
		expect(report.limits.map(l => l.id)).toEqual(["anthropic:5h"]);
	});
});

describe("claudeRankingStrategy most-constrained weekly window", () => {
	it("selects the exhausted model-scoped weekly over a healthy shared 7d", async () => {
		const report = await fetchReport(scopedPayload({ fablePercent: 100, sevenDayPercent: 78 }));
		const { primary, secondary } = claudeRankingStrategy.findWindowLimits(report);
		expect(primary?.id).toBe("anthropic:5h");
		expect(secondary?.id).toBe("anthropic:7d:fable");
		expect(secondary?.amount.usedFraction).toBe(1);
	});

	it("keeps the shared 7d as secondary when it is the tightest bucket", async () => {
		const report = await fetchReport(scopedPayload({ fablePercent: 9, sevenDayPercent: 78 }));
		const { secondary } = claudeRankingStrategy.findWindowLimits(report);
		expect(secondary?.id).toBe("anthropic:7d");
	});

	it("falls back to legacy behavior when no scoped limits exist", async () => {
		const report = await fetchReport({
			five_hour: { utilization: 8, resets_at: RESET_5H },
			seven_day: { utilization: 78, resets_at: RESET_7D },
		});
		const { primary, secondary } = claudeRankingStrategy.findWindowLimits(report);
		expect(primary?.id).toBe("anthropic:5h");
		expect(secondary?.id).toBe("anthropic:7d");
	});
});
