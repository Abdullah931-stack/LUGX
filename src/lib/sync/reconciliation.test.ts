import { describe, it, expect } from "vitest";
import {
    classifyRemoteUpdate,
    type ClassifyRemoteUpdateParams,
} from "./reconciliation";

function base(overrides: Partial<ClassifyRemoteUpdateParams> = {}): ClassifyRemoteUpdateParams {
    return {
        isDirty: false,
        localVersion: 3,
        localEtag: '"etag-v3"',
        localContent: "<p>Local content</p>",
        remoteVersion: 4,
        remoteEtag: '"etag-v4"',
        remoteContent: "<p>Remote content</p>",
        ...overrides,
    };
}

describe("Local-First Remote Update Reconciliation Policy", () => {
    it("fast-forwards when local is clean and the server holds a verified-newer revision", () => {
        const decision = classifyRemoteUpdate(base());
        expect(decision).toEqual({
            action: "apply",
            reason: "fast_forward_clean",
        });
    });

    it("corroborates freshness with server timestamps when both are available", () => {
        const newer = classifyRemoteUpdate(
            base({ remoteUpdatedAt: 5_000, localLastModified: 1_000 })
        );
        expect(newer.action).toBe("apply");

        // A server timestamp OLDER than the local one contradicts the version ladder
        // (clock-skewed replica) -> refuse the fast-forward, keep local truth.
        const staleTimestamp = classifyRemoteUpdate(
            base({ remoteUpdatedAt: 500, localLastModified: 9_000 })
        );
        expect(staleTimestamp).toEqual({ action: "keep_local", reason: "remote_not_newer" });
    });

    it("adopts metadata silently when contents are identical", () => {
        const decision = classifyRemoteUpdate(
            base({
                localContent: "<p>Same</p>",
                remoteContent: "<p>Same</p>",
                remoteVersion: 9,
                isDirty: true,
            })
        );
        expect(decision).toEqual({
            action: "adopt_metadata",
            reason: "identical_content_metadata_drift",
        });
    });

    it("keeps local truth when the document is dirty over a superseded base", () => {
        const decision = classifyRemoteUpdate(base({ isDirty: true }));
        expect(decision).toEqual({ action: "keep_local", reason: "dirty_local_divergent" });
    });

    it("keeps local truth when the remote is not newer than local", () => {
        const decision = classifyRemoteUpdate(base({ remoteVersion: 3 }));
        expect(decision).toEqual({ action: "keep_local", reason: "remote_not_newer" });
    });

    it("keeps local truth when only the version advanced without an ETag change", () => {
        const decision = classifyRemoteUpdate(base({ remoteEtag: '"etag-v3"' }));
        expect(decision).toEqual({ action: "keep_local", reason: "remote_not_newer" });
    });

    it("keeps local truth when the remote version regressed", () => {
        const decision = classifyRemoteUpdate(base({ remoteVersion: 2 }));
        expect(decision).toEqual({ action: "keep_local", reason: "remote_not_newer" });
    });

    it("normalizes weak validators and surrounding quotes before ETag comparison", () => {
        const weakForm = classifyRemoteUpdate(
            base({ localEtag: "W/\"etag-v3\"", remoteEtag: "\"etag-v4\"" })
        );
        expect(weakForm.action).toBe("apply");

        const sameAfterNormalize = classifyRemoteUpdate(
            base({ localEtag: '"etag-v4"', remoteEtag: "W/\"etag-v4\"" })
        );
        // Same effective validator + differing content + equal version -> remote not newer
        expect(sameAfterNormalize).toEqual({
            action: "keep_local",
            reason: "remote_not_newer",
        });
    });
});
