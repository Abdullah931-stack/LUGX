import { describe, it, expect } from "vitest";
import {
    classifyRemoteUpdate,
    type ClassifyRemoteUpdateParams,
} from "./reconciliation";

function base(overrides: Partial<ClassifyRemoteUpdateParams> = {}): ClassifyRemoteUpdateParams {
    return {
        localBaseline: { version: 3, etag: '"etag-v3"', content: "<p>Local content</p>" },
        isDirty: false,
        remoteVersion: 4,
        remoteEtag: '"etag-v4"',
        remoteContent: "<p>Remote content</p>",
        ...overrides,
    };
}

describe("Local-First Remote Update Reconciliation Policy", () => {
    it("fast-forwards when local is clean and the server holds a verified-newer revision", () => {
        expect(classifyRemoteUpdate(base())).toEqual({
            action: "apply",
            reason: "fast_forward_clean",
        });
    });

    // --- Cold-start matrix (localBaseline === null) ------------------------------

    it("BOOTSTRAPS from the server on a clean cold start (no local baseline at all)", () => {
        expect(classifyRemoteUpdate(base({ localBaseline: null }))).toEqual({
            action: "bootstrap_server",
            reason: "no_local_baseline_clean",
        });
    });

    it("keeps eager in-flight edits and adopts only metadata anchors on a dirty cold start", () => {
        expect(classifyRemoteUpdate(base({ localBaseline: null, isDirty: true }))).toEqual({
            action: "adopt_metadata_keep_edits",
            reason: "no_local_baseline_eager",
        });
    });

    it("bootstraps even when the server file is still at version 1 (lost-local regression guard)", () => {
        const decision = classifyRemoteUpdate(
            base({
                localBaseline: null,
                remoteVersion: 1,
                remoteEtag: '"etag-server-v1"',
                remoteContent: "<p>Server authoritative content</p>",
            })
        );
        expect(decision.action).toBe("bootstrap_server");
    });

    // --- Valid-baseline matrix ----------------------------------------------------

    it("adopts metadata silently when contents are identical", () => {
        expect(
            classifyRemoteUpdate(
                base({
                    localBaseline: { version: 9, etag: '"etag-v9"', content: "<p>Same</p>" },
                    remoteVersion: 9,
                    remoteEtag: '"etag-v9b"',
                    remoteContent: "<p>Same</p>",
                    isDirty: true,
                })
            )
        ).toEqual({
            action: "adopt_metadata",
            reason: "identical_content_metadata_drift",
        });
    });

    it("keeps local truth when the document is dirty over a superseded base", () => {
        expect(classifyRemoteUpdate(base({ isDirty: true }))).toEqual({
            action: "keep_local",
            reason: "dirty_local_divergent",
        });
    });

    it("keeps local truth when the remote is not newer than local", () => {
        expect(classifyRemoteUpdate(base({ remoteVersion: 3 }))).toEqual({
            action: "keep_local",
            reason: "remote_not_newer",
        });
    });

    it("keeps local truth when only the version advanced without an ETag change", () => {
        expect(classifyRemoteUpdate(base({ remoteEtag: '"etag-v3"' }))).toEqual({
            action: "keep_local",
            reason: "remote_not_newer",
        });
    });

    it("keeps local truth when the remote version regressed", () => {
        expect(classifyRemoteUpdate(base({ remoteVersion: 2 }))).toEqual({
            action: "keep_local",
            reason: "remote_not_newer",
        });
    });

    it("normalizes weak validators and surrounding quotes before ETag comparison", () => {
        const b = base();
        if (!b.localBaseline) throw new Error("unreachable");

        // W/-prefixed local vs quoted remote: same effective validator ladder.
        const weakLocal = classifyRemoteUpdate({
            ...b,
            localBaseline: { ...b.localBaseline, etag: 'W/"etag-v3"' },
        });
        expect(weakLocal.action).toBe("apply");

        // Same effective validator after normalization + differing content:
        // equal version means we already hold the latest known revision.
        const sameAfterNormalize = classifyRemoteUpdate({
            ...b,
            localBaseline: { ...b.localBaseline, etag: '"etag-v4"' },
            remoteEtag: 'W/"etag-v4"',
        });
        expect(sameAfterNormalize).toEqual({
            action: "keep_local",
            reason: "remote_not_newer",
        });
    });
});
