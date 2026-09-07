"use server";

/**
 * Server Actions for Zero-Knowledge User Vault Profiles
 *
 * Provides atomic server actions for retrieving, creating, and updating
 * dual-wrapped master key profiles (password KEK + BIP-39 recovery seed KEK).
 * Zero plaintext or master keys ever touch this layer.
 */

import { db, schema } from "@/lib/db";
import { getUser } from "@/lib/supabase/server";
import { eq } from "drizzle-orm";

export interface VaultActionResult<T = any> {
    success: boolean;
    data?: T;
    error?: string;
    status?: "unauthorized" | "not_found" | "conflict" | "error";
}

export interface CreateVaultProfileInput {
    encryptedMasterKey: string;
    recoveryEncryptedMasterKey: string;
    keySalt: string;
    recoverySalt: string;
    kdfIterations?: number;
    keyVersion?: number;
}

export interface UpdateVaultPasswordInput {
    encryptedMasterKey: string;
    keySalt: string;
    kdfIterations?: number;
}

/**
 * Retrieves the current authenticated user's vault profile if initialized.
 */
export async function getUserVaultProfile(): Promise<VaultActionResult<typeof schema.userVaultProfiles.$inferSelect | null>> {
    try {
        const user = await getUser();
        if (!user) {
            return { success: false, status: "unauthorized", error: "Authentication required" };
        }

        const profile = await db.query.userVaultProfiles.findFirst({
            where: eq(schema.userVaultProfiles.userId, user.id),
        });

        return { success: true, data: profile || null };
    } catch (error) {
        console.error("[VaultActions] getUserVaultProfile error:", error);
        return { success: false, status: "error", error: "Failed to retrieve vault profile" };
    }
}

/**
 * Atomically initializes a user vault profile with dual-wrapped envelopes.
 */
export async function createUserVaultProfile(
    input: CreateVaultProfileInput
): Promise<VaultActionResult<typeof schema.userVaultProfiles.$inferSelect>> {
    try {
        const user = await getUser();
        if (!user) {
            return { success: false, status: "unauthorized", error: "Authentication required" };
        }

        if (
            !input.encryptedMasterKey?.trim() ||
            !input.recoveryEncryptedMasterKey?.trim() ||
            !input.keySalt?.trim() ||
            !input.recoverySalt?.trim()
        ) {
            return { success: false, status: "error", error: "Missing required cryptographic parameters" };
        }

        // Check if vault profile already exists
        const existing = await db.query.userVaultProfiles.findFirst({
            where: eq(schema.userVaultProfiles.userId, user.id),
        });

        if (existing) {
            return { success: false, status: "conflict", error: "User vault profile is already initialized" };
        }

        const now = new Date();
        const [profile] = await db
            .insert(schema.userVaultProfiles)
            .values({
                userId: user.id,
                encryptedMasterKey: input.encryptedMasterKey.trim(),
                recoveryEncryptedMasterKey: input.recoveryEncryptedMasterKey.trim(),
                keySalt: input.keySalt.trim(),
                recoverySalt: input.recoverySalt.trim(),
                kdfIterations: input.kdfIterations ?? 600000,
                keyVersion: input.keyVersion ?? 1,
                createdAt: now,
                updatedAt: now,
            })
            .returning();

        return { success: true, data: profile };
    } catch (error) {
        console.error("[VaultActions] createUserVaultProfile error:", error);
        return { success: false, status: "error", error: "Failed to create vault profile" };
    }
}

/**
 * Updates the password-wrapped master key envelope (e.g. after recovery seed reset).
 */
export async function updateVaultPassword(
    input: UpdateVaultPasswordInput
): Promise<VaultActionResult<typeof schema.userVaultProfiles.$inferSelect>> {
    try {
        const user = await getUser();
        if (!user) {
            return { success: false, status: "unauthorized", error: "Authentication required" };
        }

        if (!input.encryptedMasterKey?.trim() || !input.keySalt?.trim()) {
            return { success: false, status: "error", error: "Missing required cryptographic parameters" };
        }

        const existing = await db.query.userVaultProfiles.findFirst({
            where: eq(schema.userVaultProfiles.userId, user.id),
        });

        if (!existing) {
            return { success: false, status: "not_found", error: "Vault profile not found" };
        }

        const now = new Date();
        const [updated] = await db
            .update(schema.userVaultProfiles)
            .set({
                encryptedMasterKey: input.encryptedMasterKey.trim(),
                keySalt: input.keySalt.trim(),
                kdfIterations: input.kdfIterations ?? existing.kdfIterations,
                updatedAt: now,
            })
            .where(eq(schema.userVaultProfiles.userId, user.id))
            .returning();

        return { success: true, data: updated };
    } catch (error) {
        console.error("[VaultActions] updateVaultPassword error:", error);
        return { success: false, status: "error", error: "Failed to update vault password" };
    }
}

/**
 * Globally revokes all trusted devices for the authenticated user by incrementing deviceTrustEpoch.
 * This instantly invalidates all local device PIN envelopes across all devices.
 */
export async function revokeAllTrustedDevices(): Promise<VaultActionResult<{ newEpoch: number }>> {
    try {
        const user = await getUser();
        if (!user) {
            return { success: false, status: "unauthorized", error: "Authentication required" };
        }

        const existing = await db.query.userVaultProfiles.findFirst({
            where: eq(schema.userVaultProfiles.userId, user.id),
        });

        if (!existing) {
            return { success: false, status: "not_found", error: "Vault profile not found" };
        }

        const nextEpoch = (existing.deviceTrustEpoch || 1) + 1;
        const now = new Date();

        await db
            .update(schema.userVaultProfiles)
            .set({
                deviceTrustEpoch: nextEpoch,
                updatedAt: now,
            })
            .where(eq(schema.userVaultProfiles.userId, user.id));

        return { success: true, data: { newEpoch: nextEpoch } };
    } catch (error) {
        console.error("[VaultActions] revokeAllTrustedDevices error:", error);
        return { success: false, status: "error", error: "Failed to revoke trusted devices" };
    }
}
