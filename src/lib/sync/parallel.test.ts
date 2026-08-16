/**
 * W7: bounded parallel execution unit tests.
 *
 * Pure algorithm — no I/O, no database. Verifies the concurrency cap is
 * actually respected, results keep input order, and per-task rejections
 * are captured (never thrown) so one bad item cannot cancel the batch.
 */
import { describe, it, expect } from "vitest";
import { runWithConcurrency, DEFAULT_PUSH_CONCURRENCY } from "./parallel";

describe("runWithConcurrency (W7)", () => {
    it("respects the concurrency cap under real timing pressure", async () => {
        let inFlight = 0;
        let peak = 0;
        const tasks = Array.from({ length: 20 }, () => async () => {
            inFlight++;
            peak = Math.max(peak, inFlight);
            await new Promise(r => setTimeout(r, 5));
            inFlight--;
            return inFlight; // irrelevant value; peak is the assertion target
        });

        await runWithConcurrency(tasks, 4);
        expect(peak).toBeLessThanOrEqual(4);
        expect(peak).toBe(4); // cap actually reached — workers stay busy
    });

    it("keeps results in input order regardless of completion order", async () => {
        const tasks = [
            async () => { await new Promise(r => setTimeout(r, 30)); return "A"; },
            async () => { await new Promise(r => setTimeout(r, 5)); return "B"; },
            async () => { await new Promise(r => setTimeout(r, 20)); return "C"; },
        ];
        const { results } = await runWithConcurrency(tasks, 2);
        expect(results).toEqual(["A", "B", "C"]);
    });

    it("captures per-task rejections without cancelling the batch", async () => {
        const tasks = [
            async () => "ok1",
            async () => { throw new Error("boom"); },
            async () => "ok2",
        ];
        const { results, errors } = await runWithConcurrency(tasks, 2);
        expect(results).toEqual(["ok1", undefined, "ok2"]);
        expect(errors[1]?.message).toBe("boom");
        expect(errors[0]).toBeUndefined();
        expect(errors[2]).toBeUndefined();
    });

    it("clamps concurrency to at least 1 and truncates fractions", async () => {
        const tasks = [async () => 1, async () => 2, async () => 3];
        const { results } = await runWithConcurrency(tasks, 0.4);
        expect(results).toEqual([1, 2, 3]);
    });

    it("empty task list resolves immediately", async () => {
        const { results, errors } = await runWithConcurrency([], 4);
        expect(results).toEqual([]);
        expect(errors).toEqual([]);
    });

    it("push concurrency default is sane (not 1, not unbounded)", () => {
        expect(DEFAULT_PUSH_CONCURRENCY).toBe(4);
    });
});
