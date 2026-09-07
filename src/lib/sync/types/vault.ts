/**
 * LUGX Dual-Tier Hybrid Encryption & Zero-Knowledge Vault Types
 *
 * Provides type contracts, state interfaces, and domain error classes
 * for isolated crypto worker operations, defensive RAM sanitization,
 * and encrypted file synchronization.
 */

export interface EncryptedEnvelope {
  readonly version: 1;
  readonly algorithm: 'AES-GCM-256';
  readonly keyId: string;
  readonly iv: string;            // Base64 (12 bytes CSPRNG)
  readonly salt: string;          // Base64 (16 bytes)
  readonly ciphertext: string;    // Base64 (Ciphertext + 16-byte Auth Tag)
  readonly kdfIterations: number; // Default: 600,000
}

export interface UserVaultProfile {
  readonly userId: string;
  readonly encryptedMasterKey: string;
  readonly recoveryEncryptedMasterKey: string;
  readonly keySalt: string;
  readonly recoverySalt: string;
  readonly kdfIterations: number;
  readonly keyVersion: number;
  readonly deviceTrustEpoch?: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export type DeviceTrustType = 'pin' | 'webauthn_prf';

export interface DeviceTrustEnvelope {
  readonly version: 1;
  readonly algorithm: 'AES-GCM-256';
  readonly trustType?: DeviceTrustType; // Defaults to 'pin' for backward compatibility
  readonly encryptedMasterKey: string; // Base64 wrapped master key
  readonly salt: string;               // Base64 16 bytes device salt or 32 bytes PRF salt
  readonly iv: string;                 // Base64 12 bytes IV
  readonly kdfIterations?: number;     // Default: 600,000 (for PIN)
  readonly credentialId?: string;      // Base64URL credential ID (for webauthn_prf)
  readonly deviceTrustEpoch: number;   // Epoch when trusted
  readonly trustedAt: number;          // Timestamp ms
  readonly expiresAt: number;          // Timestamp ms (e.g. 30 days)
  readonly failedAttempts: number;     // Anti-brute force counter (max 5 for PIN)
}

export interface VaultState {
  readonly isInitialized: boolean;
  readonly isUnlocked: boolean;
  readonly keyVersion: number;
}

export type EncryptedSyncStatus =
  | 'SYNCED'
  | 'SYNCING'
  | 'PENDING_UPLOAD'
  | 'CONFLICT_LOCKED'      // Isolated while vault is locked pending unlock
  | 'CONFLICT_MANUAL';     // Requires manual 3-way resolution after syntax check failure

export interface PendingEncryptedConflict {
  readonly fileId: string;
  readonly remoteEnvelope: EncryptedEnvelope;
  readonly baseEnvelope: EncryptedEnvelope;
  readonly localEnvelope: EncryptedEnvelope;
  readonly remoteEtag: string;
  readonly detectedAt: Date;
}

export interface SyntaxValidationResult {
  readonly isValid: boolean;
  readonly sanitizedContent: string;
  readonly syntaxErrors?: string[];
}

/**
 * Domain cryptographic error classes
 */

export class AADIntegrityError extends Error {
  readonly code = 'AAD_INTEGRITY_FAILURE';
  constructor(message = 'AAD integrity verification failed: document context mismatch or ciphertext substituted') {
    super(message);
    this.name = 'AADIntegrityError';
    Object.setPrototypeOf(this, AADIntegrityError.prototype);
  }
}

export class InvalidCiphertextOrKeyError extends Error {
  readonly code = 'INVALID_CIPHERTEXT_OR_KEY';
  constructor(message = 'Decryption failed: authentication tag mismatch or corrupted ciphertext/key') {
    super(message);
    this.name = 'InvalidCiphertextOrKeyError';
    Object.setPrototypeOf(this, InvalidCiphertextOrKeyError.prototype);
  }
}

export class CryptoWorkerBridgeError extends Error {
  readonly code = 'CRYPTO_WORKER_BRIDGE_ERROR';
  constructor(message: string, public readonly originalError?: unknown) {
    super(message);
    this.name = 'CryptoWorkerBridgeError';
    Object.setPrototypeOf(this, CryptoWorkerBridgeError.prototype);
  }
}

export class KeyDerivationError extends Error {
  readonly code = 'KEY_DERIVATION_ERROR';
  constructor(message: string) {
    super(message);
    this.name = 'KeyDerivationError';
    Object.setPrototypeOf(this, KeyDerivationError.prototype);
  }
}

export class SessionKeyStoreError extends Error {
  readonly code = 'SESSION_KEY_STORE_ERROR';
  constructor(message: string) {
    super(message);
    this.name = 'SessionKeyStoreError';
    Object.setPrototypeOf(this, SessionKeyStoreError.prototype);
  }
}

export class InvalidPinError extends Error {
  readonly code = 'INVALID_PIN';
  constructor(message = 'Invalid PIN provided for trusted device unlock', public readonly remainingAttempts?: number) {
    super(message);
    this.name = 'InvalidPinError';
    Object.setPrototypeOf(this, InvalidPinError.prototype);
  }
}

export class DeviceTrustRevokedError extends Error {
  readonly code = 'DEVICE_TRUST_REVOKED';
  constructor(message = 'Trusted device authorization has been revoked or expired') {
    super(message);
    this.name = 'DeviceTrustRevokedError';
    Object.setPrototypeOf(this, DeviceTrustRevokedError.prototype);
  }
}

/**
 * Worker RPC Protocol Types
 */

export type CryptoWorkerAction =
  | 'DERIVE_KEY_RAW'
  | 'ENCRYPT_AES_GCM'
  | 'DECRYPT_AES_GCM'
  | 'WRAP_KEY_RAW'
  | 'UNWRAP_KEY_RAW'
  | 'GENERATE_RANDOM_BYTES'
  | 'GENERATE_MNEMONIC'
  | 'VALIDATE_MNEMONIC'
  | 'MNEMONIC_TO_SEED';

export interface CryptoWorkerRequestPayloads {
  DERIVE_KEY_RAW: {
    passwordBytes: Uint8Array;
    saltBytes: Uint8Array;
    iterations: number;
    keyLengthBits?: number;
  };
  ENCRYPT_AES_GCM: {
    keyBytes: Uint8Array;
    plaintext: string;
    ivBytes: Uint8Array;
    aad: string;
  };
  DECRYPT_AES_GCM: {
    keyBytes: Uint8Array;
    ciphertextBase64: string;
    ivBytes: Uint8Array;
    aad: string;
  };
  WRAP_KEY_RAW: {
    kekBytes: Uint8Array;
    targetKeyBytes: Uint8Array;
    ivBytes: Uint8Array;
    aad: string;
  };
  UNWRAP_KEY_RAW: {
    kekBytes: Uint8Array;
    wrappedKeyBase64: string;
    ivBytes: Uint8Array;
    aad: string;
  };
  GENERATE_RANDOM_BYTES: {
    length: number;
  };
  GENERATE_MNEMONIC: {
    entropyLengthBytes?: number;
  };
  VALIDATE_MNEMONIC: {
    mnemonic: string;
  };
  MNEMONIC_TO_SEED: {
    mnemonic: string;
    saltBytes?: Uint8Array;
    iterations?: number;
  };
}

export interface CryptoWorkerResponsePayloads {
  DERIVE_KEY_RAW: Uint8Array;
  ENCRYPT_AES_GCM: { ciphertextBase64: string; ivBase64: string };
  DECRYPT_AES_GCM: string;
  WRAP_KEY_RAW: { wrappedKeyBase64: string; ivBase64: string };
  UNWRAP_KEY_RAW: Uint8Array;
  GENERATE_RANDOM_BYTES: Uint8Array;
  GENERATE_MNEMONIC: string;
  VALIDATE_MNEMONIC: { isValid: boolean; error?: string; invalidWords?: string[] };
  MNEMONIC_TO_SEED: Uint8Array;
}

export interface CryptoWorkerRequest<A extends CryptoWorkerAction = CryptoWorkerAction> {
  readonly id: string;
  readonly action: A;
  readonly payload: CryptoWorkerRequestPayloads[A];
}

export interface CryptoWorkerResponseSuccess<T = unknown> {
  readonly id: string;
  readonly success: true;
  readonly result: T;
}

export interface CryptoWorkerResponseFailure {
  readonly id: string;
  readonly success: false;
  readonly error: {
    readonly name: string;
    readonly message: string;
    readonly code?: string;
    readonly stack?: string;
  };
}

export type CryptoWorkerResponse<T = unknown> =
  | CryptoWorkerResponseSuccess<T>
  | CryptoWorkerResponseFailure;
