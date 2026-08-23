/**
 * Local-First Remote Update Reconciliation Policy
 *
 * Classifies an incoming remote (server) file state against the local editor/IndexedDB
 * state into one of three deterministic outcomes:
 *
 * 1. `apply` (Fast-Forward): The local document is clean (no unsaved edits) AND the
 *    server holds a verified-newer version (higher monotonic version, distinct ETag,
 *    corroborated by server timestamps when both are available). Because a clean local
 *    copy IS the last-synced ancestor, any strictly newer server revision is by
 *    definition built on top of it — safe to fast-forward into the editor.
 *
 * 2. `adopt_metadata` (Silent Metadata Adoption): Contents are byte-identical; only
 *    version/ETag metadata drifted (e.g. another tab committed identical content).
 *    Server metadata is adopted without touching the document or alarming the user.
 *
 * 3. `keep_local` (Retain Local Truth): Either the local document has unsaved edits
 *    overwriting a superseded base, or the remote is not ahead of local. The editor
 *    keeps rendering local content. Version anchors are NOT advanced, so the next
 *    optimistic write surfaces a genuine `412 Precondition Failed`, routing the case
 *    through the explicit three-way conflict resolution flow instead of silent loss.
 *
 * This function is pure and side-effect free so the decision matrix is unit-testable
 * in isolation from React, IndexedDB, and network layers.
 */

export type RemoteUpdateAction = 'apply' | 'adopt_metadata' | 'keep_local';

export type RemoteUpdateReason =
    | 'fast_forward_clean'
    | 'identical_content_metadata_drift'
    | 'dirty_local_divergent'
    | 'remote_not_newer';

export interface RemoteUpdateDecision {
    action: RemoteUpdateAction;
    reason: RemoteUpdateReason;
}

export interface ClassifyRemoteUpdateParams {
    /** Whether the local document has unsaved (dirty) user edits. */
    isDirty: boolean;
    /** Local last-synced version number. */
    localVersion: number;
    /** Local last-synced ETag (weak/quoted forms tolerated). */
    localEtag: string | null;
    /** Local document content as currently rendered in the editor. */
    localContent: string;
    /** Remote version number. */
    remoteVersion: number;
    /** Remote ETag. */
    remoteEtag: string | null;
    /** Remote content (already sanitized upstream). */
    remoteContent: string;
    /** Optional server `updatedAt` epoch-ms — corroborating freshness evidence. */
    remoteUpdatedAt?: number | null;
    /** Optional local `lastModified` epoch-ms — corroborating evidence. */
    localLastModified?: number | null;
}

export function classifyRemoteUpdate(
    params: ClassifyRemoteUpdateParams
): RemoteUpdateDecision {
    const {
        isDirty,
        localVersion,
        localEtag,
        localContent,
        remoteVersion,
        remoteEtag,
        remoteContent,
        remoteUpdatedAt,
        localLastModified,
    } = params;

    // --- Case B: identical payload, metadata-only drift ---------------------------
    if (localContent === remoteContent) {
        return { action: 'adopt_metadata', reason: 'identical_content_metadata_drift' };
    }

    // --- Freshness verification ---------------------------------------------------
    // Monotonic version must strictly advance AND the ETag must differ (guards against
    // version counters advancing without a real content mutation).
    const etagChanged =
        !!remoteEtag && !!localEtag
            ? normalize(localEtag) !== normalize(remoteEtag)
            : remoteEtag !== null || localEtag !== null;

    const versionAdvanced = remoteVersion > localVersion;

    // Timestamps are supporting evidence only (client clocks drift); when both sides
    // provide them, the server timestamp must not be older than the local one.
    let timestampsCorroborate = true;
    if (
        typeof remoteUpdatedAt === 'number' &&
        typeof localLastModified === 'number' &&
        remoteUpdatedAt > 0 &&
        localLastModified > 0
    ) {
        timestampsCorroborate = remoteUpdatedAt >= localLastModified;
    }

    const serverVerifiedNewer = versionAdvanced && etagChanged && timestampsCorroborate;

    // --- Remote not newer: keep local truth (offline-first) ------------------------
    if (!serverVerifiedNewer) {
        return { action: 'keep_local', reason: 'remote_not_newer' };
    }

    // --- Dirty local over a superseded base: never silently overwrite --------------
    if (isDirty) {
        return { action: 'keep_local', reason: 'dirty_local_divergent' };
    }

    // --- Case A: clean local + verified newer server => Fast-Forward ---------------
    return { action: 'apply', reason: 'fast_forward_clean' };
}

/** Strips weak validators (`W/`) and surrounding quotes before comparison. */
function normalize(etag: string): string {
    let normalized = etag.trim();
    if (normalized.startsWith('W/')) {
        normalized = normalized.slice(2);
    }
    if (normalized.startsWith('"') && normalized.endsWith('"') && normalized.length >= 2) {
        normalized = normalized.slice(1, -1);
    }
    return normalized;
}
