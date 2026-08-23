/**
 * Editor timing & behavior configuration.
 */

/**
 * Debounce window for the editor autosave, measured from the last user
 * keystroke/write before the debounced server write fires.
 *
 * History: raised from 400ms to 1000ms to reduce server write pressure during
 * fast typing sessions while keeping data-loss exposure bounded (~1s).
 * (Decision recorded 2026-08; verified against the Phase 9 orchestrator tests
 * which expect a 1000ms debounce window.)
 */
export const EDITOR_AUTOSAVE_DEBOUNCE_MS = 1000;