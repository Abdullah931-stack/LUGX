/**
 * Single File API Route with ETag and optimistic version lock support
 */

import { NextRequest, NextResponse } from 'next/server';
import { db, schema } from '@/lib/db';
import { getUser } from '@/lib/supabase/server';
import { eq, and, isNull } from 'drizzle-orm';
import { generateETagSync, parseETagHeader, formatETagHeader } from '@/lib/sync/etag-generator';
import { fileApiRateLimiter, addRateLimitHeaders, rateLimitExceededResponse } from '@/lib/rate-limit';

interface RouteParams {
    params: Promise<{ id: string }>;
}

export async function GET(request: NextRequest, { params }: RouteParams) {
    try {
        const { id: fileId } = await params;
        const user = await getUser();
        if (!user) return NextResponse.json({ error: 'Authentication required' }, { status: 401 });

        const rateLimitResult = await fileApiRateLimiter.limit(user.id);
        if (!rateLimitResult.success) return rateLimitExceededResponse(rateLimitResult);

        const file = await db.query.files.findFirst({
            where: and(
                eq(schema.files.id, fileId),
                eq(schema.files.userId, user.id),
                isNull(schema.files.deletedAt)
            ),
        });

        if (!file) return NextResponse.json({ error: 'File not found' }, { status: 404 });

        const ifNoneMatch = parseETagHeader(request.headers.get('If-None-Match'));
        if (ifNoneMatch && file.etag && ifNoneMatch === file.etag) {
            const headers = new Headers();
            headers.set('ETag', formatETagHeader(file.etag));
            addRateLimitHeaders(headers, rateLimitResult);
            return new Response(null, { status: 304, headers });
        }

        const responseData = {
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
        };

        const headers = new Headers({
            'Content-Type': 'application/json',
            'Cache-Control': 'private, must-revalidate, max-age=0',
            'Vary': 'If-None-Match',
            'Last-Modified': file.updatedAt.toUTCString(),
        });
        if (file.etag) headers.set('ETag', formatETagHeader(file.etag));
        addRateLimitHeaders(headers, rateLimitResult);

        return new Response(JSON.stringify(responseData), { status: 200, headers });
    } catch (error) {
        console.error('[File API GET] Error:', error);
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
    }
}

export async function PUT(request: NextRequest, { params }: RouteParams) {
    try {
        const { id: fileId } = await params;
        const user = await getUser();
        if (!user) return NextResponse.json({ error: 'Authentication required' }, { status: 401 });

        const rateLimitResult = await fileApiRateLimiter.limit(user.id);
        if (!rateLimitResult.success) return rateLimitExceededResponse(rateLimitResult);

        const body = await request.json().catch(() => ({}));
        const { content, title, expectedVersion, baseVersion } = body as {
            content?: string;
            title?: string;
            expectedVersion?: number;
            baseVersion?: number;
        };

        const ifMatch = parseETagHeader(request.headers.get('If-Match'));
        const requestedVersion = expectedVersion !== undefined ? expectedVersion : baseVersion;

        // PHASE 3: Mandatory If-Match or expectedVersion on file updates
        if (!ifMatch && requestedVersion === undefined) {
            const headers = new Headers({ 'Content-Type': 'application/json' });
            addRateLimitHeaders(headers, rateLimitResult);
            return new Response(JSON.stringify({
                error: 'Precondition Required: If-Match header or expectedVersion is required for file updates',
            }), { status: 428, headers });
        }

        const currentFile = await db.query.files.findFirst({
            where: and(
                eq(schema.files.id, fileId),
                eq(schema.files.userId, user.id),
                isNull(schema.files.deletedAt)
            ),
        });

        if (!currentFile) return NextResponse.json({ error: 'File not found' }, { status: 404 });

        if (currentFile.isFolder) {
            return NextResponse.json({ error: 'Cannot update content of a folder' }, { status: 400 });
        }

        // Check If-Match condition
        if (ifMatch && currentFile.etag && ifMatch !== currentFile.etag) {
            const headers = new Headers({ 'Content-Type': 'application/json', 'ETag': formatETagHeader(currentFile.etag) });
            addRateLimitHeaders(headers, rateLimitResult);
            return new Response(JSON.stringify({
                error: 'Precondition Failed: ETag mismatch',
                serverVersion: {
                    etag: currentFile.etag,
                    version: currentFile.version,
                    content: currentFile.content,
                    updatedAt: currentFile.updatedAt.toISOString(),
                },
            }), { status: 412, headers });
        }

        // Check expectedVersion condition
        if (requestedVersion !== undefined && currentFile.version !== requestedVersion) {
            const headers = new Headers({ 'Content-Type': 'application/json' });
            if (currentFile.etag) headers.set('ETag', formatETagHeader(currentFile.etag));
            addRateLimitHeaders(headers, rateLimitResult);
            return new Response(JSON.stringify({
                error: 'Precondition Failed: version mismatch',
                serverVersion: {
                    etag: currentFile.etag,
                    version: currentFile.version,
                    content: currentFile.content,
                    updatedAt: currentFile.updatedAt.toISOString(),
                },
            }), { status: 412, headers });
        }

        // Optimistic-locking atomic update
        const now = new Date();
        const currentVersion = currentFile.version || 0;
        const newVersion = currentVersion + 1;
        const newContent = content !== undefined ? content : currentFile.content;
        const newTitle = title !== undefined ? title.trim().slice(0, 500) : currentFile.title;
        const newEtag = generateETagSync({ id: fileId, content: newContent || '', updatedAt: now });

        const [updatedFile] = await db.update(schema.files)
            .set({
                content: newContent,
                title: newTitle,
                etag: newEtag,
                version: newVersion,
                updatedAt: now,
            })
            .where(and(
                eq(schema.files.id, fileId),
                eq(schema.files.userId, user.id),
                eq(schema.files.version, currentVersion),
                isNull(schema.files.deletedAt)
            ))
            .returning();

        if (!updatedFile) {
            // Concurrent writer raced inside the read-write window
            const refreshed = await db.query.files.findFirst({
                where: and(eq(schema.files.id, fileId), eq(schema.files.userId, user.id)),
            });
            const headers = new Headers({ 'Content-Type': 'application/json' });
            if (refreshed && !refreshed.deletedAt) {
                if (refreshed.etag) headers.set('ETag', formatETagHeader(refreshed.etag));
                addRateLimitHeaders(headers, rateLimitResult);
                return new Response(JSON.stringify({
                    error: 'Conflict: this file was modified by another session. Please reload and try again',
                    serverVersion: {
                        etag: refreshed.etag,
                        version: refreshed.version,
                        content: refreshed.content,
                        updatedAt: refreshed.updatedAt.toISOString(),
                    },
                }), { status: 412, headers });
            }
            return NextResponse.json({ error: 'File not found' }, { status: 404 });
        }

        const headers = new Headers({
            'Content-Type': 'application/json',
            'ETag': formatETagHeader(updatedFile.etag!),
            'Cache-Control': 'private, must-revalidate, max-age=0',
        });
        addRateLimitHeaders(headers, rateLimitResult);

        return new Response(JSON.stringify({
            id: updatedFile.id,
            title: updatedFile.title,
            etag: updatedFile.etag,
            version: updatedFile.version,
            updatedAt: updatedFile.updatedAt.toISOString(),
        }), { status: 200, headers });
    } catch (error) {
        console.error('[File API PUT] Error:', error);
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
    }
}
