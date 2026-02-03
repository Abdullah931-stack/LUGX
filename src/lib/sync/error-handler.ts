/**
 * Sync Error Handler
 * 
 * Centralized error handling for the synchronization system.
 * Provides typed errors, recovery strategies, and user notifications.
 */

/**
 * Types of sync errors
 */
export enum SyncErrorType {
    /** Network connectivity issues */
    NETWORK_ERROR = 'NETWORK_ERROR',
    /** ETag mismatch - conflict detected */
    CONFLICT_ERROR = 'CONFLICT_ERROR',
    /** IndexedDB quota exceeded */
    QUOTA_EXCEEDED = 'QUOTA_EXCEEDED',
    /** Encryption/decryption failure */
    ENCRYPTION_ERROR = 'ENCRYPTION_ERROR',
    /** Database operation failure */
    DATABASE_ERROR = 'DATABASE_ERROR',
    /** Local storage operation failure */
    STORAGE_ERROR = 'STORAGE_ERROR',
    /** Server returned error response */
    SERVER_ERROR = 'SERVER_ERROR',
    /** Authentication/authorization failure */
    AUTH_ERROR = 'AUTH_ERROR',
    /** Rate limit exceeded */
    RATE_LIMIT_ERROR = 'RATE_LIMIT_ERROR',
    /** Unknown error */
    UNKNOWN_ERROR = 'UNKNOWN_ERROR',
}

/**
 * Sync error structure
 */
export interface SyncError {
    /** Error type for categorization */
    type: SyncErrorType;
    /** Human-readable error message */
    message: string;
    /** Whether the error can be recovered from automatically */
    recoverable: boolean;
    /** Seconds to wait before retrying (if recoverable) */
    retryAfter?: number;
    /** HTTP status code if applicable */
    statusCode?: number;
    /** Additional error metadata */
    metadata?: Record<string, unknown>;
    /** Original error if available */
    originalError?: Error;
    /** Timestamp when error occurred */
    timestamp: number;
}

/**
 * Error handler callback type
 */
export type ErrorCallback = (error: SyncError) => void;

/**
 * Sync Error Handler Class
 * Manages error handling, logging, and recovery
 */
export class SyncErrorHandler {
    private errorCallbacks: ErrorCallback[] = [];
    private errorLog: SyncError[] = [];
    private maxLogSize = 100;

    /**
     * Create a SyncError from various error sources
     */
    createError(
        type: SyncErrorType,
        message: string,
        options: Partial<Omit<SyncError, 'type' | 'message' | 'timestamp'>> = {}
    ): SyncError {
        return {
            type,
            message,
            recoverable: options.recoverable ?? this.isRecoverableType(type),
            retryAfter: options.retryAfter,
            statusCode: options.statusCode,
            metadata: options.metadata,
            originalError: options.originalError,
            timestamp: Date.now(),
        };
    }

    /**
     * Determine if an error type is typically recoverable
     */
    private isRecoverableType(type: SyncErrorType): boolean {
        switch (type) {
            case SyncErrorType.NETWORK_ERROR:
            case SyncErrorType.RATE_LIMIT_ERROR:
            case SyncErrorType.SERVER_ERROR:
                return true;
            case SyncErrorType.CONFLICT_ERROR:
            case SyncErrorType.QUOTA_EXCEEDED:
            case SyncErrorType.AUTH_ERROR:
            case SyncErrorType.ENCRYPTION_ERROR:
            case SyncErrorType.DATABASE_ERROR:
            case SyncErrorType.UNKNOWN_ERROR:
                return false;
            default:
                return false;
        }
    }

    /**
     * Handle a sync error
     */
    async handle(error: SyncError): Promise<void> {
        // Log the error
        this.logError(error);
        console.error('[Sync Error]', error.type, error.message, error.metadata);

        // Notify all registered callbacks
        for (const callback of this.errorCallbacks) {
            try {
                callback(error);
            } catch (callbackError) {
                console.error('[Sync Error] Callback error:', callbackError);
            }
        }

        // Handle specific error types
        switch (error.type) {
            case SyncErrorType.AUTH_ERROR:
                // Auth errors should redirect to login
                await this.handleAuthError(error);
                break;
            case SyncErrorType.QUOTA_EXCEEDED:
                // Quota errors need user intervention
                await this.handleQuotaError(error);
                break;
            case SyncErrorType.CONFLICT_ERROR:
                // Conflicts are handled by the conflict resolver
                break;
            default:
                // Other errors may trigger retry logic
                break;
        }
    }

    /**
     * Handle authentication errors
     */
    private async handleAuthError(error: SyncError): Promise<void> {
        console.warn('[Sync] Auth error - user may need to re-login', error);
        // The UI layer should handle redirecting to login
    }

    /**
     * Handle quota exceeded errors
     */
    private async handleQuotaError(error: SyncError): Promise<void> {
        console.warn('[Sync] Storage quota exceeded', error);
        // The UI layer should prompt user to clean up storage
    }

    /**
     * Add error log entry
     */
    private logError(error: SyncError): void {
        this.errorLog.push(error);
        // Keep log size bounded
        if (this.errorLog.length > this.maxLogSize) {
            this.errorLog.shift();
        }
    }

    /**
     * Register an error callback
     */
    onError(callback: ErrorCallback): () => void {
        this.errorCallbacks.push(callback);
        // Return unsubscribe function
        return () => {
            const index = this.errorCallbacks.indexOf(callback);
            if (index > -1) {
                this.errorCallbacks.splice(index, 1);
            }
        };
    }

    /**
     * Get recent errors
     */
    getRecentErrors(count = 10): SyncError[] {
        return this.errorLog.slice(-count);
    }

    /**
     * Clear error log
     */
    clearLog(): void {
        this.errorLog = [];
    }

    /**
     * Create error from HTTP response
     */
    async fromResponse(response: Response, context?: string): Promise<SyncError> {
        let type: SyncErrorType;
        let message: string;
        let recoverable = false;
        let retryAfter: number | undefined;

        switch (response.status) {
            case 401:
            case 403:
                type = SyncErrorType.AUTH_ERROR;
                message = 'Authentication required';
                break;
            case 409:
            case 412:
                type = SyncErrorType.CONFLICT_ERROR;
                message = 'Conflict detected - file was modified on server';
                break;
            case 429:
                type = SyncErrorType.RATE_LIMIT_ERROR;
                message = 'Rate limit exceeded';
                recoverable = true;
                retryAfter = parseInt(response.headers.get('Retry-After') || '60', 10);
                break;
            case 500:
            case 502:
            case 503:
            case 504:
                type = SyncErrorType.SERVER_ERROR;
                message = 'Server error';
                recoverable = true;
                retryAfter = 5;
                break;
            default:
                type = SyncErrorType.UNKNOWN_ERROR;
                message = `Request failed with status ${response.status}`;
        }

        if (context) {
            message = `${context}: ${message}`;
        }

        return this.createError(type, message, {
            recoverable,
            retryAfter,
            statusCode: response.status,
            metadata: {
                url: response.url,
                statusText: response.statusText,
            },
        });
    }

    /**
     * Create error from caught exception
     */
    fromException(error: unknown, context?: string): SyncError {
        const originalError = error instanceof Error ? error : new Error(String(error));
        let type = SyncErrorType.UNKNOWN_ERROR;
        let message = originalError.message;

        // Detect network errors
        if (
            originalError.name === 'TypeError' &&
            (message.includes('fetch') || message.includes('network'))
        ) {
            type = SyncErrorType.NETWORK_ERROR;
            message = 'Network connection failed';
        }

        // Detect quota errors
        if (message.includes('quota') || message.includes('QuotaExceeded')) {
            type = SyncErrorType.QUOTA_EXCEEDED;
        }

        if (context) {
            message = `${context}: ${message}`;
        }

        return this.createError(type, message, {
            originalError,
        });
    }
}

// Export singleton instance
export const syncErrorHandler = new SyncErrorHandler();
