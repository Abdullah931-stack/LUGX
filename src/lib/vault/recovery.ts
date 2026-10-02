/**
 * Vault Adaptive Dual-Try Recovery Migration Service
 *
 * Resolves LUGX-005 (BIP-39 recovery phrase AAD mismatch).
 * Attempts unwrap using the canonical context (lugx:v1:recovery:<userId>) first.
 * Upon MAC/authentication failure, gracefully falls back to the legacy creation context
 * (vault:seed:<userId>). If the legacy unwrap succeeds, it automatically re-wraps the master
 * key under the canonical schema and returns the new envelope for cloud and local persistence.
 */

import { AAD } from '../crypto/aad';
import { cryptoWorkerBridge, wipeBuffer, base64ToUint8Array } from '../sync/crypto-worker-bridge';
import { InvalidCiphertextOrKeyError } from '../sync/types/vault';

export interface AdaptiveRecoveryResult {
  /**
   * The recovered 32-byte raw master key
   */
  masterKey: Uint8Array;
  /**
   * True if the vault was unwrapped via legacy context and needs migration persistence
   */
  wasMigrated: boolean;
  /**
   * The newly re-wrapped envelope under canonical AAD, populated if wasMigrated is true
   */
  reWrappedEnvelope?: {
    ciphertext: string;
    iv: string;
  };
}

export interface AdaptiveRecoveryOptions {
  seedMnemonic: string;
  recoveryEncryptedMasterKey: string;
  recoverySaltBytes: Uint8Array;
  userId: string;
  kdfIterations?: number;
}

/**
 * Executes the Adaptive Dual-Try Recovery algorithm with zero-knowledge key isolation.
 */
export async function adaptiveUnwrapRecoverySeed(
  options: AdaptiveRecoveryOptions
): Promise<AdaptiveRecoveryResult> {
  const {
    seedMnemonic,
    recoveryEncryptedMasterKey,
    recoverySaltBytes,
    userId,
    kdfIterations = 600000
  } = options;

  const cleanSeed = seedMnemonic?.trim();
  const cleanUserId = userId?.trim();

  if (!cleanSeed) {
    throw new InvalidCiphertextOrKeyError('Recovery seed phrase cannot be empty');
  }
  if (!cleanUserId) {
    throw new InvalidCiphertextOrKeyError('User ID is required for recovery AAD');
  }

  let kekSeed: Uint8Array | null = null;
  let ivBytes: Uint8Array | null = null;

  try {
    // 1. Derive KEK-Seed from 12-word recovery mnemonic
    const seedBytes = await cryptoWorkerBridge.mnemonicToSeed(
      cleanSeed,
      recoverySaltBytes,
      kdfIterations
    );
    kekSeed = seedBytes.slice(0, 32);
    wipeBuffer(seedBytes);

    // 2. Parse wrapped recovery envelope
    let wrappedObj: { ciphertext: string; iv: string };
    try {
      wrappedObj = JSON.parse(recoveryEncryptedMasterKey);
      if (!wrappedObj.ciphertext || !wrappedObj.iv) {
        throw new Error('Missing ciphertext or iv in recovery envelope payload');
      }
    } catch {
      throw new InvalidCiphertextOrKeyError('Malformed recovery encrypted envelope payload');
    }

    ivBytes = base64ToUint8Array(wrappedObj.iv);

    // 3. Try 1: Attempt unwrap using canonical AAD (lugx:v1:recovery:<userId>)
    const canonicalAAD = AAD.recoveryWrap(cleanUserId);
    try {
      const masterKey = await cryptoWorkerBridge.unwrapKeyRaw(
        kekSeed,
        wrappedObj.ciphertext,
        ivBytes,
        canonicalAAD
      );

      return {
        masterKey,
        wasMigrated: false
      };
    } catch (_canonicalErr: unknown) {
      // Canonical unwrap failed; attempt legacy fallback for vaults created pre-remediation (LUGX-005)
    }

    // 4. Try 2: Attempt unwrap using legacy creation AAD (vault:seed:<userId>)
    const legacyAAD = AAD.legacy.seedWrap(cleanUserId);
    let legacyMasterKey: Uint8Array;
    try {
      legacyMasterKey = await cryptoWorkerBridge.unwrapKeyRaw(
        kekSeed,
        wrappedObj.ciphertext,
        ivBytes,
        legacyAAD
      );
    } catch (_legacyErr: unknown) {
      // Both standard and legacy contexts rejected the seed / ciphertext
      throw new InvalidCiphertextOrKeyError(
        'Recovery seed phrase is incorrect, invalid, or does not match this vault.'
      );
    }

    // 5. Legacy unwrap succeeded: immediately re-wrap under the canonical AAD
    const newIv = await cryptoWorkerBridge.generateRandomBytes(12);
    let reWrapped: { wrappedKeyBase64: string; ivBase64: string };
    try {
      reWrapped = await cryptoWorkerBridge.wrapKeyRaw(
        kekSeed,
        legacyMasterKey,
        newIv,
        canonicalAAD
      );
    } finally {
      wipeBuffer(newIv);
    }

    return {
      masterKey: legacyMasterKey,
      wasMigrated: true,
      reWrappedEnvelope: {
        ciphertext: reWrapped.wrappedKeyBase64,
        iv: reWrapped.ivBase64
      }
    };
  } finally {
    if (kekSeed) wipeBuffer(kekSeed);
    if (ivBytes) wipeBuffer(ivBytes);
  }
}
