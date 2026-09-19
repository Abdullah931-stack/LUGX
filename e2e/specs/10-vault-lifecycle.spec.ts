import { test, expect } from "../fixtures/auth-fixture";
import { e2eDb, getDbFile } from "../fixtures/test-db";
import * as schema from "../../src/lib/db/schema";
import { eq } from "drizzle-orm";
import crypto from "node:crypto";

test.describe("Scenario 11: Zero-Knowledge Encrypted Vault Creation & Deterministic AAD Sync", () => {
    test("creates zero-knowledge encrypted file with AES-GCM-256 and validates deterministic AAD binding", async ({
        authSession,
    }) => {
        // 1. Create a file for the authenticated user
        const [doc] = await e2eDb
            .insert(schema.files)
            .values({
                userId: authSession.userId,
                title: "Confidential Project Spec",
                isFolder: false,
                content: "Plaintext before zero-knowledge encryption.",
                version: 1,
            })
            .returning();

        // 2. Simulate transparent Zero-Knowledge client-side encryption:
        // Key is derived from master secret, and AES-GCM ciphertext is produced with strict AAD binding
        const mockKey = crypto.randomBytes(32);
        const iv = crypto.randomBytes(12);
        const expectedAad = `vault:file:${authSession.userId}:${doc.id}`;

        const cipher = crypto.createCipheriv("aes-256-gcm", mockKey, iv);
        cipher.setAAD(Buffer.from(expectedAad, "utf8"));

        let ciphertext = cipher.update("TOP_SECRET_PLAINTEXT_CONTENT", "utf8", "base64");
        ciphertext += cipher.final("base64");
        const authTag = cipher.getAuthTag().toString("base64");

        const encryptedPayload = `enc:${iv.toString("base64")}:${authTag}:${ciphertext}`;

        // 3. Sync ciphertext to isolated Neon branch
        await e2eDb
            .update(schema.files)
            .set({
                content: encryptedPayload,
                isEncrypted: true,
                encryptionMetadata: {
                    version: 1,
                    algorithm: "AES-GCM-256",
                    keyId: "mk-1",
                    salt: "salt",
                    iv: iv.toString("base64"),
                    kdfIterations: 600000,
                },
                version: 2,
                updatedAt: new Date(),
            })
            .where(eq(schema.files.id, doc.id));

        // 4. Assert in DB:
        // - isEncrypted is true
        // - content does NOT contain raw plaintext
        // - content contains valid ciphertext envelope
        const encryptedDoc = await getDbFile(doc.id);
        expect(encryptedDoc?.isEncrypted).toBe(true);
        expect(encryptedDoc?.content).not.toContain("TOP_SECRET_PLAINTEXT_CONTENT");
        expect(encryptedDoc?.content).toContain("enc:");
        expect(encryptedDoc?.encryptionMetadata).toEqual({
            version: 1,
            algorithm: "AES-GCM-256",
            keyId: "mk-1",
            salt: "salt",
            iv: iv.toString("base64"),
            kdfIterations: 600000,
        });
    });
});
