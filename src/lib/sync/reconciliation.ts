/**
 * Local-First Remote Update Reconciliation Policy
 *
 * Classifies an incoming remote (server) file state against the local
 * editor/IndexedDB state into ONE outcome from a CLOSED decision matrix:
 *
 * | localBaseline | isDirty | remote vs local       | action                    |
 * |---------------|---------|-----------------------|---------------------------|
 * | null          | clean   | (anything)            | bootstrap_server          |
 * | null          | dirty   | (anything)            | adopt_metadata_keep_edits |
 * | present       | clean   | verified newer        | apply                     |
 * | present       | clean   | identical content     | adopt_metadata            |
 * | present       | clean   | not newer / regressed | keep_local                |
 * | present       | dirty   | (any divergence)      | keep_local                |
 *
 * "Newer" is decided by the per-file MONOTONIC server version counter
 * corroborated by a real ETag change - NEVER by wall-clock timestamps.
 * A clean local snapshot IS the last-synced ancestor by contract, so any
 * strictly higher server revision is built on top of it (safe fast-forward).
 * Equal version + differing content means we already hold the latest known
 * revision: keep_local, and the next optimistic write surfaces a genuine
 * 412 Precondition Failed, routing into explicit three-way conflict
 * resolution instead of silent loss.
 *
 * COLD START (localBaseline === null): there is NO baseline to compare
 * against - fabricating one (v1/null) would misclassify a server v1 file
 * as not-newer and strand the editor empty forever. The server document
 * is therefore the ONLY truth: bootstrap it authoritatively when the editor
 * is clean, or adopt only its metadata anchors while preserving eager
 * in-flight user edits.
 *
 * This function is pure and side-effect free so the decision matrix is
 * unit-testable in isolation from React, IndexedDB, and network layers.
 */

export type RemoteUpdateAction =
    | 'bootstrap_server'
    | 'apply'
    | 'adopt_metadata'
    | 'adopt_metadata_keep_edits'
    | 'keep_local';

export type RemoteUpdateReason =
    | 'no_local_baseline_clean'
    | 'no_local_baseline_eager'
    | 'fast_forward_clean'
    | 'identical_content_metadata_drift'
    | 'dirty_local_divergent'
    | 'remote_not_newer';

export interface RemoteUpdateDecision {
    action: RemoteUpdateAction;
    reason: RemoteUpdateReason;
}

/** Last-synced local snapshot. null = cold start (nothing painted locally). */
export interface LocalBaseline {
    version: number;
    etag: string | null;
    content: string;
}

export interface ClassifyRemoteUpdateParams {
    /** Last-synced local snapshot, or null on cold start (no IndexedDB record). */
    localBaseline: LocalBaseline | null;
    /** Whether the local document has unsaved (dirty) user edits. */
    isDirty: boolean;
    /** Remote version number (monotonic, server-authoritative). */
    remoteVersion: number;
    /** Remote ETag. */
    remoteEtag: string | null;
    /** Remote content (already sanitized upstream). */
    remoteContent: string;
}

export function classifyRemoteUpdate(
    params: ClassifyRemoteUpdateParams
): RemoteUpdateDecision {
    const { localBaseline, isDirty, remoteVersion, remoteEtag, remoteContent } = params;

    // --- Cold start: no baseline exists to reconcile against ---------------------
    if (!localBaseline) {
        return isDirty
            ? { action: 'adopt_metadata_keep_edits', reason: 'no_local_baseline_eager' }
            : { action: 'bootstrap_server', reason: 'no_local_baseline_clean' };
    }

    const { version: localVersion, etag: localEtag, content: localContent } = localBaseline;

    // --- Identical payload: metadata-only drift ----------------------------------
    if (localContent === remoteContent) {
        return { action: 'adopt_metadata', reason: 'identical_content_metadata_drift' };
    }

    // --- Freshness verification ---------------------------------------------------
    // Monotonic version must strictly advance AND the ETag must differ (guards
    // against version counters advancing without a real content mutation).
    const etagChanged =
        !!remoteEtag && !!localEtag
            ? normalize(localEtag) !== normalize(remoteEtag)
            : remoteEtag !== null || localEtag !== null;

    const versionAdvanced = remoteVersion > localVersion;

    if (!(versionAdvanced && etagChanged)) {
        return { action: 'keep_local', reason: 'remote_not_newer' };
    }

    // --- Dirty local over a superseded base: never silently overwrite --------------
    if (isDirty) {
        return { action: 'keep_local', reason: 'dirty_local_divergent' };
    }

    // --- Clean local + verified newer server => Fast-Forward -----------------------
    return { action: 'apply', reason: 'fast_forward_clean' };
}

/** Strips weak validators (W/) and surrounding quotes before comparison. */
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
