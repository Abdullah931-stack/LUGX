/**
 * Application Feature Flags Configuration
 *
 * Controls gradual rollouts, experimental capabilities, and kill-switches.
 * AI Streaming is gated behind `AI_STREAMING_ENABLED` (default: false)
 * until all Go/No-Go readiness gates (G1-G10) are validated.
 */

export const FEATURES = {
    /**
     * UI AI Streaming with ephemeral preview and atomic commit.
     * Default: false (falls back to safe buffered accumulator path).
     */
    AI_STREAMING_ENABLED: process.env.NEXT_PUBLIC_AI_STREAMING_ENABLED === "true",

    /**
     * Maximum duration in milliseconds for an in-flight reservation before expiry.
     * Default: 5 minutes (300,000ms).
     */
    RESERVATION_TTL_MS: 5 * 60 * 1000,

    /**
     * Memory ceiling for ephemeral text preview buffer (characters).
     * Protects client memory from unbounded buffer growth.
     */
    PREVIEW_BUFFER_MAX_CHARS: 500_000,
} as const;
