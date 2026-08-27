import { loadTestEnv } from "./src/test/load-test-env";

// Phase 10 (Neon Branch isolation): load the isolated test-branch environment
// BEFORE any test module — and its database pool — is imported.
// Priority: shell TEST_DATABASE_URL > .env.test.local > .env.test > .env.local > .env
// Then DATABASE_URL is hard-bound to TEST_DATABASE_URL (fail-closed binding).
loadTestEnv();

// Global JSDOM polyfills for CodeMirror 6 DOM measurements
if (typeof Range !== "undefined") {
    if (typeof Range.prototype.getClientRects !== "function") {
        Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
    }
    if (typeof Range.prototype.getBoundingClientRect !== "function") {
        Range.prototype.getBoundingClientRect = () => ({
            top: 0,
            bottom: 0,
            left: 0,
            right: 0,
            width: 0,
            height: 0,
            x: 0,
            y: 0,
            toJSON: () => ({}),
        });
    }
}
