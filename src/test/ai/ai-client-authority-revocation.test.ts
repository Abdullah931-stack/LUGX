import { describe, it, expect } from "vitest";
import * as aiCommitActions from "@/server/actions/ai-commit";
import * as aiOpsActions from "@/server/actions/ai-ops";
import fs from "node:fs";
import path from "node:path";

describe("Phase 11: Revocation of Client-Side Financial Authority", () => {
    it("ensures refundAIReservation is NOT exported from ai-commit Server Actions", () => {
        expect("refundAIReservation" in aiCommitActions).toBe(false);
    });

    it("ensures refundAIReservation and commitAIReservation are NOT exported from ai-ops Server Actions", () => {
        expect("refundAIReservation" in aiOpsActions).toBe(false);
        expect("commitAIReservation" in aiOpsActions).toBe(false);
        expect("reserveAndUpdateUsage" in aiOpsActions).toBe(false);
    });

    it("verifies ai-settlement-service is strictly server-only", () => {
        const filePath = path.resolve(process.cwd(), "src/server/services/ai-settlement-service.ts");
        const content = fs.readFileSync(filePath, "utf-8");
        expect(content).toContain('import "server-only";');
    });

    it("verifies use-ai-stream hook source code contains zero direct refund or commit calls", () => {
        const hookPath = path.resolve(process.cwd(), "src/hooks/use-ai-stream.ts");
        const hookSource = fs.readFileSync(hookPath, "utf-8");

        // Hook must not import or invoke server financial actions
        expect(hookSource).not.toMatch(/refundAIReservation/);
        expect(hookSource).not.toMatch(/commitAIReservation/);
    });
});
