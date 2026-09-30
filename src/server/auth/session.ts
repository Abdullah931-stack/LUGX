/**
 * Server-Authoritative Identity and Ownership Guard Module
 *
 * Implements strict server-side session resolution and resource ownership guards
 * to eliminate client-driven identity parameters and cross-tenant information leakage.
 */

import { getUser } from "@/lib/supabase/server";
import { db, schema } from "@/server/db";
import { eq, and, isNull } from "drizzle-orm";
import type { User } from "@supabase/supabase-js";

export class AuthenticationRequiredError extends Error {
    readonly statusCode = 401;
    constructor(message = "Authentication required") {
        super(message);
        this.name = "AuthenticationRequiredError";
    }
}

export class ForbiddenResourceError extends Error {
    readonly statusCode = 403;
    constructor(message = "Access denied: insufficient permissions or unowned resource") {
        super(message);
        this.name = "ForbiddenResourceError";
    }
}

export class ResourceNotFoundError extends Error {
    readonly statusCode = 404;
    constructor(message = "Resource not found") {
        super(message);
        this.name = "ResourceNotFoundError";
    }
}

/**
 * Extracts and verifies the authenticated user strictly from the server-side session.
 * Throws `AuthenticationRequiredError` (HTTP 401) if no valid session is present.
 */
export async function requireAuthenticatedUser(): Promise<User> {
    const user = await getUser();
    if (!user || !user.id) {
        throw new AuthenticationRequiredError("Authentication required: no active server session");
    }
    return user;
}

/**
 * Resolves the authenticated user from the server session or returns null without throwing.
 */
export async function getSessionUser(): Promise<User | null> {
    const user = await getUser();
    return user && user.id ? user : null;
}

export interface RequireOwnedFileOptions {
    /** Allow folder entities in addition to standard file nodes (default: true) */
    allowFolder?: boolean;
    /** Whether to include soft-deleted records (default: false) */
    includeDeleted?: boolean;
}

/**
 * Validates that the requested file exists and belongs exclusively to the authenticated user.
 * Returns the file record on success or throws `ResourceNotFoundError` (HTTP 404) on missing
 * or cross-tenant foreign records to prevent resource enumeration attacks.
 */
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function requireOwnedFile(
    fileId: string,
    userId: string,
    options: RequireOwnedFileOptions = {}
): Promise<typeof schema.files.$inferSelect> {
    const { allowFolder = true, includeDeleted = false } = options;

    if (!fileId || typeof fileId !== "string" || !UUID_REGEX.test(fileId)) {
        throw new ResourceNotFoundError("Invalid file identifier or file not found");
    }

    const conditions = [
        eq(schema.files.id, fileId),
        eq(schema.files.userId, userId),
    ];

    if (!includeDeleted) {
        conditions.push(isNull(schema.files.deletedAt));
    }

    const file = await db.query.files.findFirst({
        where: and(...conditions),
    });

    if (!file) {
        // Uniform 404 to ensure zero information leakage regarding existence of foreign records
        throw new ResourceNotFoundError("File not found or unowned");
    }

    if (!allowFolder && file.isFolder) {
        throw new ResourceNotFoundError("Requested resource is a directory, not a document");
    }

    return file;
}
