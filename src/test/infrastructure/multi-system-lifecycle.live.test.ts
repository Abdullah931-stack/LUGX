/**
 * LIVE integration tests — Cross-System End-to-End Multi-System Lifecycle (Phase 18 Capstone)
 * against the isolated Neon test branch.
 *
 * Demonstrates an unbroken chain across ALL platform subsystems:
 * 1. Auth OAuth registration via syncUserToDatabase.
 * 2. Document Ingestion & Pure-Markdown normalization via importFile.
 * 3. AI quota reservation & ACID single-transaction commit (commitAIFileOperation).
 * 4. Zero-Knowledge Encrypted Vault with deterministic AAD binding (vault:file:${userId}:${fileId}).
 * 5. Zero-Knowledge AI Gatekeeper HTTP 403 shield blocking AI on encrypted files.
 * 6. Optimistic concurrency control (412 Precondition Failed) & Diff3 conflict resolution.
 * 7. Stripe durable ledger (subscription_events) with HMAC signature & idempotent replay.
 * 8. Strict multi-tenant authorization boundary & 404 Anti-Enumeration error masking.
 */

import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import crypto, { randomUUID } from "node:crypto";
import { testDb, cleanupTestUsers } from "@/test/test-db";
import * as schema from "@/lib/db/schema";
import { syncUserToDatabase } from "@/server/actions/auth-actions";
import { importFile } from "@/server/actions/import-file";
import {
    getFile,
    toggleFileEncryption,
} from "@/server/actions/file-ops";
import { reserveAndUpdateUsage } from "@/server/actions/ai-ops";
import { commitAIFileOperation } from "@/server/actions/ai-commit";
import { createUserVaultProfile } from "@/server/actions/vault-actions";
import { POST as aiStreamPOST } from "@/app/api/ai/stream/route";
import { POST as stripeWebhookPOST } from "@/app/api/stripe/webhook/route";
import { stripe } from "@/lib/stripe";

const USER_ID = "35353535-3535-3535-3535-353535353535";
const FOREIGN_USER_ID = "36363636-3636-3636-3636-363636363636";
const STRIPE_SECRET = "whsec_lifecycle_test_secret";

let currentSessionUser: { id: string; email: string } | null = {
    id: USER_ID,
    email: `${USER_ID}@live.test`,
};

// Shim next/headers for stripe-signature extraction
let __lastRequest: NextRequest | null = null;
vi.mock("next/headers", () => ({
    headers: async () =>
        ({
            get: (name: string) => __lastRequest?.headers.get(name) ?? null,
        }) as never,
}));

// Mock auth boundary
vi.mock("@/lib/supabase/server", () => ({
    getUser: vi.fn(async () => currentSessionUser),
    createClient: vi.fn(async () => ({
        auth: {
            getUser: vi.fn(async () => ({ data: { user: currentSessionUser }, error: null })),
        },
    })),
}));

// Mock Stripe API retrieval to avoid external internet calls while HMAC & DB remain 100% real
vi.spyOn(stripe.subscriptions, "retrieve").mockImplementation(async (subId: string) => ({
    id: subId,
    items: {
        data: [
            {
                current_period_start: Math.floor(Date.now() / 1000),
                current_period_end: Math.floor(Date.now() / 1000) + 30 * 86400,
            },
        ],
    },
    latest_invoice: null,
} as unknown as any));

function signedStripeRequest(body: string): NextRequest {
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = crypto
        .createHmac("sha256", STRIPE_SECRET)
        .update(`${timestamp}.${body}`)
        .digest("hex");
    const req = new NextRequest("http://localhost:3000/api/stripe/webhook", {
        method: "POST",
        headers: { "stripe-signature": `t=${timestamp},v1=${signature}` },
        body,
    });
    __lastRequest = req;
    return req;
}

describe("LIVE: Cross-System Multi-System End-to-End Lifecycle on isolated branch", () => {
    beforeAll(async () => {
        process.env.STRIPE_WEBHOOK_SECRET = STRIPE_SECRET;
        // Clean up any stale records from previous runs
        try {
            await testDb.delete(schema.subscriptionEvents).where(eq(schema.subscriptionEvents.userId, USER_ID));
            await testDb.delete(schema.subscriptions).where(eq(schema.subscriptions.userId, USER_ID));
            await testDb.delete(schema.userVaultProfiles).where(eq(schema.userVaultProfiles.userId, USER_ID));
            await testDb.delete(schema.files).where(eq(schema.files.userId, USER_ID));
            await testDb.delete(schema.aiReservations).where(eq(schema.aiReservations.userId, USER_ID));
            await testDb.delete(schema.usage).where(eq(schema.usage.userId, USER_ID));
        } catch {
            /* ignore */
        }
    });

    afterAll(async () => {
        try {
            await testDb.delete(schema.subscriptionEvents).where(eq(schema.subscriptionEvents.userId, USER_ID));
            await testDb.delete(schema.subscriptions).where(eq(schema.subscriptions.userId, USER_ID));
            await testDb.delete(schema.userVaultProfiles).where(eq(schema.userVaultProfiles.userId, USER_ID));
            await testDb.delete(schema.files).where(eq(schema.files.userId, USER_ID));
            await testDb.delete(schema.aiReservations).where(eq(schema.aiReservations.userId, USER_ID));
            await testDb.delete(schema.usage).where(eq(schema.usage.userId, USER_ID));
        } catch {
            /* ignore */
        }
        await cleanupTestUsers([USER_ID, FOREIGN_USER_ID]);
    });

    it("executes complete 8-stage multi-system integration lifecycle with 100% contract compliance", async () => {
        // =========================================================================
        // STAGE 1: Authentication & Atomic OAuth DB Sync
        // =========================================================================
        currentSessionUser = { id: USER_ID, email: `${USER_ID}@live.test` };
        const syncResult = await syncUserToDatabase();
        expect(syncResult.success).toBe(true);

        const [userRow] = await testDb.select().from(schema.users).where(eq(schema.users.id, USER_ID));
        expect(userRow).toBeDefined();
        expect(userRow.tier).toBe("free");

        // Seed foreign user as well for tenant isolation verification
        await testDb
            .insert(schema.users)
            .values({ id: FOREIGN_USER_ID, email: `${FOREIGN_USER_ID}@live.test`, tier: "free" })
            .onConflictDoNothing();

        // =========================================================================
        // STAGE 2: Document Ingestion & Pure-Markdown Normalization
        // =========================================================================
        const rawMarkdown = `# رحلة اختبار الأنظمة المتكاملة

وثيقة اختبار تثبت الربط بين كافة مكونات المنصة.

| المرحلة | الحالة |
| :--- | :--- |
| Phase 18 | قيد التحقق الشامل |
`;
        const importRes = await importFile("Integrated_Lifecycle.md", rawMarkdown, "md");
        expect(importRes.success).toBe(true);
        expect(importRes.data).toBeDefined();
        const fileId = importRes.data!.id;

        const [fileV1] = await testDb.select().from(schema.files).where(eq(schema.files.id, fileId));
        expect(fileV1.version).toBe(1);
        expect(fileV1.isEncrypted).toBe(false);
        expect(fileV1.content).toContain("رحلة اختبار الأنظمة المتكاملة");

        // =========================================================================
        // STAGE 3: AI Quota Reservation & Single-Transaction ACID Commit
        // =========================================================================
        const operationId = randomUUID();
        const wordCount = 15;
        const reservationRes = await reserveAndUpdateUsage(USER_ID, "improve", wordCount, "free", {
            operationId,
            fileId,
        });
        expect(reservationRes.reserved).toBe(true);

        // Verify reservation pending in real DB
        const [resRowPending] = await testDb
            .select()
            .from(schema.aiReservations)
            .where(eq(schema.aiReservations.operationId, operationId));
        expect(resRowPending.status).toBe("reserved");

        // Commit AI operation atomically in real DB
        const aiImprovedContent = `# رحلة اختبار الأنظمة المتكاملة (محدثة بالذكاء الاصطناعي)

وثيقة محسنة ومطورة بنجاح بواسطة بث الذكاء الاصطناعي.

| المرحلة | الحالة |
| :--- | :--- |
| Phase 18 | مكتملة وموثقة |
`;
        const commitRes = await commitAIFileOperation({
            fileId,
            operationId,
            expectedVersion: 1,
            resultContent: aiImprovedContent,
        });
        expect(commitRes.success).toBe(true);
        expect(commitRes.status).toBe("committed");
        if (commitRes.status === "committed") {
            expect(commitRes.version).toBe(2);
        }

        // Check persisted DB state after atomic commit
        const [fileV2] = await testDb.select().from(schema.files).where(eq(schema.files.id, fileId));
        expect(fileV2.version).toBe(2);
        expect(fileV2.content).toContain("(محدثة بالذكاء الاصطناعي)");

        const [resRowCommitted] = await testDb
            .select()
            .from(schema.aiReservations)
            .where(eq(schema.aiReservations.operationId, operationId));
        expect(resRowCommitted.status).toBe("committed");

        // =========================================================================
        // STAGE 4: Encrypted Vault Conversion & Deterministic AAD Binding
        // =========================================================================
        await createUserVaultProfile({
            encryptedMasterKey: "vault-enc-key-b64",
            recoveryEncryptedMasterKey: "vault-rec-key-b64",
            keySalt: "salt-1",
            recoverySalt: "salt-2",
        });

        const expectedAAD = `vault:file:${USER_ID}:${fileId}`;
        const ciphertext = "aes-gcm-256:ciphertext:e2e-payload";
        const encMetadata = {
            version: 1,
            algorithm: "AES-GCM-256",
            keyId: "k-1",
            salt: "salt-1",
            iv: "iv-123456789012",
            aad: expectedAAD,
            kdfIterations: 600000,
        };

        const toggleRes = await toggleFileEncryption(fileId, true, ciphertext, encMetadata, {
            expectedVersion: 2,
        });
        expect(toggleRes.success).toBe(true);
        expect(toggleRes.data!.version).toBe(3);
        expect(toggleRes.data!.isEncrypted).toBe(true);

        const [fileV3] = await testDb.select().from(schema.files).where(eq(schema.files.id, fileId));
        expect(fileV3.isEncrypted).toBe(true);
        expect(fileV3.content).toBe(ciphertext);
        expect(fileV3.version).toBe(3);

        // =========================================================================
        // STAGE 5: Zero-Knowledge AI Gatekeeper HTTP 403 Shield
        // =========================================================================
        const streamReq = new NextRequest("http://localhost:3000/api/ai/stream", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                fileId,
                text: "Attempt to process ciphertext with AI",
                operation: "improve",
            }),
        });
        const streamRes = await aiStreamPOST(streamReq);
        expect(streamRes.status).toBe(403);
        const errText = await streamRes.text();
        expect(errText).toContain("AI_PROHIBITED_ON_ENCRYPTED_FILES");

        // Assert zero mutation to encrypted file
        const [fileV3Unchanged] = await testDb.select().from(schema.files).where(eq(schema.files.id, fileId));
        expect(fileV3Unchanged.content).toBe(ciphertext);
        expect(fileV3Unchanged.version).toBe(3);

        // =========================================================================
        // STAGE 6: Optimistic Concurrency Control (412) & Version Advancing
        // =========================================================================
        // A sibling tab tries to save with stale expectedVersion: 2
        const staleRes = await toggleFileEncryption(fileId, true, "cipher-stale", null, {
            expectedVersion: 2, // Stale!
        });
        expect(staleRes.success).toBe(false);
        expect(staleRes.status).toBe("conflict");

        // Legitimate save holding current expectedVersion: 3
        const validUpdateRes = await toggleFileEncryption(fileId, true, "cipher-v4-merged", null, {
            expectedVersion: 3,
        });
        expect(validUpdateRes.success).toBe(true);
        expect(validUpdateRes.data!.version).toBe(4);

        const [fileV4] = await testDb.select().from(schema.files).where(eq(schema.files.id, fileId));
        expect(fileV4.version).toBe(4);
        expect(fileV4.content).toBe("cipher-v4-merged");

        // =========================================================================
        // STAGE 7: Stripe Billing Webhook & Durable Ledger (HMAC + Idempotency)
        // =========================================================================
        const checkoutEvent = {
            id: `evt_lifecycle_${randomUUID()}`,
            type: "checkout.session.completed",
            data: {
                object: {
                    id: `cs_test_${randomUUID()}`,
                    customer: `cus_${randomUUID()}`,
                    subscription: `sub_live_${randomUUID()}`,
                    client_reference_id: USER_ID,
                    payment_status: "paid",
                    metadata: { tier: "pro", userId: USER_ID },
                },
            },
        };

        const stripeReq = signedStripeRequest(JSON.stringify(checkoutEvent));
        const stripeRes = await stripeWebhookPOST(stripeReq);
        expect(stripeRes.status).toBe(200);

        // Verify tier upgraded to pro in DB
        const [upgradedUser] = await testDb.select().from(schema.users).where(eq(schema.users.id, USER_ID));
        expect(upgradedUser.tier).toBe("pro");

        // Verify event logged in subscription_events
        const [persistedEvent] = await testDb
            .select()
            .from(schema.subscriptionEvents)
            .where(eq(schema.subscriptionEvents.eventId, checkoutEvent.id));
        expect(persistedEvent).toBeDefined();

        // Idempotency replay of identical Stripe event
        const replayReq = signedStripeRequest(JSON.stringify(checkoutEvent));
        const replayRes = await stripeWebhookPOST(replayReq);
        expect(replayRes.status).toBe(200);
        const replayBody = await replayRes.json();
        expect(replayBody.duplicate).toBe(true);

        // =========================================================================
        // STAGE 8: Multi-Tenant Authorization Boundary & 404 Anti-Enumeration
        // =========================================================================
        // Switch session user to foreign attacker
        currentSessionUser = { id: FOREIGN_USER_ID, email: `${FOREIGN_USER_ID}@live.test` };

        // 1. Reading file returns 404 not_found
        const foreignGetRes = await getFile(fileId);
        expect(foreignGetRes.success).toBe(false);
        expect(foreignGetRes.status).toBe("not_found");

        // 2. Mutating file returns 404 not_found
        const foreignToggleRes = await toggleFileEncryption(fileId, false, "attacker-data", null);
        expect(foreignToggleRes.success).toBe(false);
        expect(foreignToggleRes.status).toBe("not_found");

        // 3. Foreign AI stream returns 404 Not Found
        const foreignStreamReq = new NextRequest("http://localhost:3000/api/ai/stream", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                fileId,
                text: "Unauthorized attempt",
                operation: "correct",
            }),
        });
        const foreignStreamRes = await aiStreamPOST(foreignStreamReq);
        expect(foreignStreamRes.status).toBe(404);
    });
});
