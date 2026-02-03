/**
 * Connection Detector
 * 
 * Monitors network connectivity and provides hooks for online/offline events.
 * Implements exponential backoff for retry logic.
 */

/**
 * Connection state
 */
export type ConnectionState = 'online' | 'offline' | 'unknown';

/**
 * Connection change callback
 */
export type ConnectionCallback = (state: ConnectionState) => void;

/**
 * Exponential backoff configuration
 */
export interface BackoffConfig {
    /** Initial delay in milliseconds */
    initialDelayMs: number;
    /** Maximum delay in milliseconds */
    maxDelayMs: number;
    /** Multiplier for each retry */
    multiplier: number;
    /** Add random jitter to prevent thundering herd */
    jitter: boolean;
}

/**
 * Default backoff configuration
 */
const DEFAULT_BACKOFF: BackoffConfig = {
    initialDelayMs: 2000,  // 2 seconds
    maxDelayMs: 60000,     // 60 seconds
    multiplier: 2,
    jitter: true,
};

/**
 * Connection Detector Class
 * Singleton that monitors network state
 */
class ConnectionDetector {
    private state: ConnectionState = 'unknown';
    private callbacks: Set<ConnectionCallback> = new Set();
    private initialized = false;

    /**
     * Initialize the connection detector
     * Sets up event listeners for online/offline events
     */
    init(): void {
        if (this.initialized || typeof window === 'undefined') {
            return;
        }

        // Set initial state
        this.state = navigator.onLine ? 'online' : 'offline';

        // Listen for online/offline events
        window.addEventListener('online', this.handleOnline);
        window.addEventListener('offline', this.handleOffline);

        this.initialized = true;
        console.log('[ConnectionDetector] Initialized, state:', this.state);
    }

    /**
     * Cleanup event listeners
     */
    destroy(): void {
        if (typeof window === 'undefined') {
            return;
        }

        window.removeEventListener('online', this.handleOnline);
        window.removeEventListener('offline', this.handleOffline);
        this.callbacks.clear();
        this.initialized = false;
    }

    /**
     * Handle online event
     */
    private handleOnline = (): void => {
        this.state = 'online';
        console.log('[ConnectionDetector] Online');
        this.notifyCallbacks();
    };

    /**
     * Handle offline event
     */
    private handleOffline = (): void => {
        this.state = 'offline';
        console.log('[ConnectionDetector] Offline');
        this.notifyCallbacks();
    };

    /**
     * Notify all registered callbacks
     */
    private notifyCallbacks(): void {
        for (const callback of this.callbacks) {
            try {
                callback(this.state);
            } catch (error) {
                console.error('[ConnectionDetector] Callback error:', error);
            }
        }
    }

    /**
     * Get current connection state
     */
    getState(): ConnectionState {
        if (typeof navigator !== 'undefined') {
            return navigator.onLine ? 'online' : 'offline';
        }
        return this.state;
    }

    /**
     * Check if currently online
     */
    isOnline(): boolean {
        return this.getState() === 'online';
    }

    /**
     * Register a callback for connection state changes
     * Returns unsubscribe function
     */
    onChange(callback: ConnectionCallback): () => void {
        this.callbacks.add(callback);
        return () => {
            this.callbacks.delete(callback);
        };
    }

    /**
     * Wait for online state
     * Resolves immediately if already online
     */
    waitForOnline(): Promise<void> {
        return new Promise((resolve) => {
            if (this.isOnline()) {
                resolve();
                return;
            }

            const unsubscribe = this.onChange((state) => {
                if (state === 'online') {
                    unsubscribe();
                    resolve();
                }
            });
        });
    }
}

/**
 * Calculate exponential backoff delay
 * 
 * @param attempt - Current retry attempt (0-based)
 * @param config - Backoff configuration
 * @returns Delay in milliseconds
 */
export function calculateBackoffDelay(
    attempt: number,
    config: BackoffConfig = DEFAULT_BACKOFF
): number {
    // Calculate base delay with exponential growth
    let delay = config.initialDelayMs * Math.pow(config.multiplier, attempt);

    // Cap at maximum delay
    delay = Math.min(delay, config.maxDelayMs);

    // Add jitter if enabled (±25% randomization)
    if (config.jitter) {
        const jitterRange = delay * 0.25;
        delay = delay - jitterRange + Math.random() * jitterRange * 2;
    }

    return Math.round(delay);
}

/**
 * Execute a function with exponential backoff retry
 * 
 * @param fn - Async function to execute
 * @param maxAttempts - Maximum number of attempts
 * @param config - Backoff configuration
 * @returns Function result
 */
export async function withBackoff<T>(
    fn: () => Promise<T>,
    maxAttempts: number = 5,
    config: BackoffConfig = DEFAULT_BACKOFF
): Promise<T> {
    let lastError: Error | undefined;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        try {
            return await fn();
        } catch (error) {
            lastError = error instanceof Error ? error : new Error(String(error));

            // Don't wait after the last attempt
            if (attempt < maxAttempts - 1) {
                const delay = calculateBackoffDelay(attempt, config);
                console.log(`[Backoff] Attempt ${attempt + 1} failed, retrying in ${delay}ms`);
                await sleep(delay);
            }
        }
    }

    throw lastError || new Error('Max attempts reached');
}

/**
 * Sleep helper
 */
function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// Export singleton instance
export const connectionDetector = new ConnectionDetector();

// Export class for testing
export { ConnectionDetector };
