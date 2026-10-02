/**
 * Central Vault Manager & Lifecycle Gateway
 *
 * Coordinates cryptographic key hierarchy, memory isolation, and vault session management.
 * Remediates: LUGX-005, LUGX-016, LUGX-042, LUGX-084.
 */

import { sessionKeyStore } from '../sync/session-key-store';
import { AAD } from '../crypto/aad';
import { adaptiveUnwrapRecoverySeed, AdaptiveRecoveryResult } from './recovery';
import { deriveDocumentKey, deriveSearchIndexKey, deriveProofOfPossession, normalizePassword } from '../crypto/key-derivation';

export {
  sessionKeyStore,
  AAD,
  adaptiveUnwrapRecoverySeed,
  deriveDocumentKey,
  deriveSearchIndexKey,
  deriveProofOfPossession,
  normalizePassword,
};
export type { AdaptiveRecoveryResult };

export class VaultManager {
  /**
   * Returns true if the vault master key is currently loaded in memory.
   */
  public static isUnlocked(): boolean {
    return sessionKeyStore.isUnlocked();
  }

  /**
   * Returns the current lock epoch.
   */
  public static getLockEpoch(): number {
    return sessionKeyStore.getLockEpoch();
  }

  /**
   * Executes a scoped operation with master key protection and lockEpoch verification.
   * If the vault locks during the operation, execution is safely aborted (LUGX-016).
   */
  public static async withMasterKey<T>(
    operation: (key: CryptoKey | Uint8Array, epoch: number) => Promise<T> | T
  ): Promise<T> {
    return sessionKeyStore.withMasterKey(operation);
  }

  /**
   * Explicitly updates the inactivity timer upon user interface interaction (LUGX-042).
   */
  public static touchActivity(): void {
    sessionKeyStore.touch();
  }

  /**
   * Locks the vault and increments the lock epoch.
   */
  public static lock(broadcast = true): void {
    sessionKeyStore.lock(broadcast);
  }
}
