/**
 * Standardized Authenticated Additional Data (AAD) Context Builders & Validators
 *
 * Enforces the canonical structure: lugx:v1:<domain>:<userId>[:<resourceId>]
 * Provides backward-compatible legacy constants to support adaptive dual-try migrations.
 */

export const AAD_VERSION_V1 = 'lugx:v1';

export class AADValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AADValidationError';
  }
}

export const AAD = {
  /**
   * Canonical password-derived KEK envelope AAD
   * Format: lugx:v1:pass:<userId>
   */
  passwordWrap(userId: string): string {
    const cleanId = userId?.trim();
    if (!cleanId) {
      throw new AADValidationError('userId is required for passwordWrap AAD');
    }
    return `${AAD_VERSION_V1}:pass:${cleanId}`;
  },

  /**
   * Canonical recovery seed-derived KEK envelope AAD
   * Format: lugx:v1:recovery:<userId>
   */
  recoveryWrap(userId: string): string {
    const cleanId = userId?.trim();
    if (!cleanId) {
      throw new AADValidationError('userId is required for recoveryWrap AAD');
    }
    return `${AAD_VERSION_V1}:recovery:${cleanId}`;
  },

  /**
   * Canonical trusted device PIN/hardware envelope AAD
   * Format: lugx:v1:device:<userId>:<epoch>
   */
  deviceWrap(userId: string, epoch = 1): string {
    const cleanId = userId?.trim();
    if (!cleanId) {
      throw new AADValidationError('userId is required for deviceWrap AAD');
    }
    const safeEpoch = Math.max(1, Math.floor(epoch));
    return `${AAD_VERSION_V1}:device:${cleanId}:${safeEpoch}`;
  },

  /**
   * Canonical file ciphertext authenticated envelope AAD
   * Format: lugx:v1:file:<userId>:<fileId>
   */
  file(userId: string, fileId: string): string {
    const cleanUserId = userId?.trim();
    const cleanFileId = fileId?.trim();
    if (!cleanUserId || !cleanFileId) {
      throw new AADValidationError('Both userId and fileId are required for file AAD');
    }
    return `${AAD_VERSION_V1}:file:${cleanUserId}:${cleanFileId}`;
  },

  /**
   * Legacy AAD builders used strictly for adaptive backward-compatibility decryptions.
   */
  legacy: {
    /**
     * Legacy seed wrapping context used prior to Phase 9 remediation (LUGX-005)
     */
    seedWrap(userId: string): string {
      return `vault:seed:${userId?.trim() || ''}`;
    },

    /**
     * Legacy password wrapping context
     */
    passWrap(userId: string): string {
      return `vault:pass:${userId?.trim() || ''}`;
    },

    /**
     * Legacy recovery unwrapping attempt context (which previously caused LUGX-005)
     */
    recoveryWrap(userId: string): string {
      return `vault:recovery:${userId?.trim() || ''}`;
    },

    /**
     * Legacy file encryption context
     */
    file(userId: string, fileId: string): string {
      return `vault:file:${userId?.trim() || ''}:${fileId?.trim() || ''}`;
    },

    /**
     * Legacy master key password context from initial encryption library
     */
    masterKey(userId: string): string {
      return `master_key:${userId?.trim() || ''}`;
    },

    /**
     * Legacy master key recovery context from initial encryption library
     */
    recoveryMasterKey(userId: string): string {
      return `recovery_master_key:${userId?.trim() || ''}`;
    }
  }
} as const;

/**
 * Validates that an AAD string conforms to the canonical v1 schema
 */
export function isCanonicalAAD(aad: string): boolean {
  if (typeof aad !== 'string') return false;
  return aad.startsWith(`${AAD_VERSION_V1}:`);
}
