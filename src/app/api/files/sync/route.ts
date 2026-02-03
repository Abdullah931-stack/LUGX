/**
 * Sync API Route
 * 
 * GET /api/files/sync - Fetch files updated after a timestamp
 * Supports pagination and rate limiting
 */

import { NextRequest, NextResponse } from 'next/server';
import { db, schema } from '@/lib/db';
import { getUser } from '@/lib/supabase/server';
import { eq, and, gt, isNull, or } from 'drizzle-orm';
import {
    syncApiRateLimiter,
    addRateLimitHeaders,
    rateLimitExceededResponse
} from '@/lib/rate-limit';

/**
 * Default and maximum page sizes
 */
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

/**
 * GET /api/files/sync
 * 
 * Query Parameters:
 * - updated_after: ISO timestamp to fetch updates after
 * - limit: Number of files to return (max 100)
 * - cursor: Pagination cursor for next page
 * 
 * Response:
 * - files: Array of file objects with sync metadata
 * - has_more: Whether more files are available
 * - next_cursor: Cursor for next page (if has_more is true)
 */
export async function GET(request: NextRequest) {
    try {
        // Authenticate user
        const user = await getUser();
        if (!user) {
            return NextResponse.json(
                { error: 'Authentication required' },
                { status: 401 }
            );
        }

        // Apply rate limiting
        const rateLimitResult = await syncApiRateLimiter.limit(user.id);
        if (!rateLimitResult.success) {
            return rateLimitExceededResponse(rateLimitResult);
        }

        // Parse query parameters
        const { searchParams } = new URL(request.url);
        const updatedAfterParam = searchParams.get('updated_after');
        const limitParam = searchParams.get('limit');
        const cursor = searchParams.get('cursor');

        // Parse updated_after timestamp
        let updatedAfter: Date | null = null;
        if (updatedAfterParam) {
            const parsed = new Date(updatedAfterParam);
            if (!isNaN(parsed.getTime())) {
                updatedAfter = parsed;
            }
        }

        // Parse limit with bounds
        let limit = DEFAULT_LIMIT;
        if (limitParam) {
            const parsedLimit = parseInt(limitParam, 10);
            if (!isNaN(parsedLimit) && parsedLimit > 0) {
                limit = Math.min(parsedLimit, MAX_LIMIT);
            }
        }

        // Build query conditions
        const conditions = [
            eq(schema.files.userId, user.id),
            // Exclude soft-deleted files unless they were deleted after updatedAfter
            or(
                isNull(schema.files.deletedAt),
                updatedAfter ? gt(schema.files.deletedAt, updatedAfter) : undefined
            ),
        ].filter(Boolean);

        // Add updated_after condition
        if (updatedAfter) {
            conditions.push(gt(schema.files.updatedAt, updatedAfter));
        }

        // Add cursor condition for pagination
        if (cursor) {
            try {
                const cursorData = JSON.parse(Buffer.from(cursor, 'base64').toString());
                if (cursorData.updatedAt && cursorData.id) {
                    conditions.push(
                        or(
                            gt(schema.files.updatedAt, new Date(cursorData.updatedAt)),
                            and(
                                eq(schema.files.updatedAt, new Date(cursorData.updatedAt)),
                                gt(schema.files.id, cursorData.id)
                            )
                        )!
                    );
                }
            } catch {
                // Invalid cursor, ignore
            }
        }

        // Fetch files with limit + 1 to check for more
        const files = await db.query.files.findMany({
            where: and(...conditions),
            orderBy: (files, { asc }) => [asc(files.updatedAt), asc(files.id)],
            limit: limit + 1,
        });

        // Check if there are more results
        const hasMore = files.length > limit;
        const resultFiles = hasMore ? files.slice(0, limit) : files;

        // Generate next cursor if there are more results
        let nextCursor: string | null = null;
        if (hasMore && resultFiles.length > 0) {
            const lastFile = resultFiles[resultFiles.length - 1];
            const cursorData = {
                updatedAt: lastFile.updatedAt.toISOString(),
                id: lastFile.id,
            };
            nextCursor = Buffer.from(JSON.stringify(cursorData)).toString('base64');
        }

        // Format response
        const responseFiles = resultFiles.map(file => ({
            id: file.id,
            title: file.title,
            content: file.content,
            etag: file.etag,
            version: file.version,
            parentFolderId: file.parentFolderId,
            isFolder: file.isFolder,
            deletedAt: file.deletedAt?.toISOString() || null,
            updatedAt: file.updatedAt.toISOString(),
            createdAt: file.createdAt.toISOString(),
        }));

        // Build response with rate limit headers
        const responseHeaders = new Headers({
            'Content-Type': 'application/json',
            'Cache-Control': 'private, no-cache, no-store, must-revalidate',
        });
        addRateLimitHeaders(responseHeaders, rateLimitResult);

        return new Response(
            JSON.stringify({
                files: responseFiles,
                has_more: hasMore,
                next_cursor: nextCursor,
                sync_timestamp: new Date().toISOString(),
            }),
            {
                status: 200,
                headers: responseHeaders,
            }
        );

    } catch (error) {
        console.error('[Sync API] Error:', error);
        return NextResponse.json(
            { error: 'Internal server error' },
            { status: 500 }
        );
    }
}
