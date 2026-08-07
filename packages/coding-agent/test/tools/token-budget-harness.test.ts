import { describe, expect, it } from "bun:test";
import * as crypto from "node:crypto";
import { CANONICALIZATION_VERSION, runHarness } from "../../scripts/token-budget-harness";

describe("token budget harness", () => {
	it("produces deterministic cold request receipts with monotonic tool budgets", async () => {
		const result = await runHarness({ repetitions: 3 });
		const { conditions } = result.summary;

		for (const condition of Object.values(conditions)) expect(condition.distinctSha256).toBe(1);
		expect(conditions.eager.bytes.p50).toBeGreaterThan(conditions["selected-8"].bytes.p50);
		expect(conditions["selected-8"].bytes.p50).toBeGreaterThan(conditions["selected-1"].bytes.p50);
		expect(conditions["selected-1"].bytes.p50).toBeGreaterThan(conditions["selected-0"].bytes.p50);
		expect(conditions["selected-0"].bytes.p50).toBeGreaterThanOrEqual(conditions["catalog-only"].bytes.p50);
		expect(conditions["catalog-only"].bytes.p50).toBeGreaterThanOrEqual(conditions["no-tools"].bytes.p50);

		for (const [condition, expectedCount] of [
			["selected-0", 1],
			["selected-1", 2],
			["selected-8", 9],
		] as const) {
			expect(
				result.receipts.filter(receipt => receipt.condition === condition).map(receipt => receipt.wireToolCount),
			).toEqual([expectedCount, expectedCount, expectedCount]);
		}

		// Receipt self-verifiability: persisted raw bytes reproduce sha/bytes.
		const sample = result.receipts[0]!;
		expect(sample.canonicalization).toBe(CANONICALIZATION_VERSION);
		expect(Buffer.byteLength(sample.raw, "utf8")).toBe(sample.bytes);
		expect(crypto.createHash("sha256").update(sample.raw).digest("hex")).toBe(sample.sha256);

		// Cold epoch cost is aggregated with an all-equal oracle.
		for (const condition of Object.values(conditions)) expect(condition.epochColdCost.allEqual).toBe(true);
		expect(conditions["selected-1"].epochColdCost.first).toBe(1);
		expect(conditions["selected-8"].epochColdCost.first).toBe(1);
		expect(conditions.eager.epochColdCost.first).toBe(0);

		// Provenance format guard: silent unknown-revision degradation must fail.
		expect(result.summary.identity.source).toMatch(/^gjc-054-patch@[0-9a-f]{7,40}$/);

		// Fixture scope/limitations are durable metadata.
		expect(result.summary.scope.canonicalization).toBe(CANONICALIZATION_VERSION);
		expect(result.summary.scope.limitations.length).toBeGreaterThanOrEqual(3);
	});
});
