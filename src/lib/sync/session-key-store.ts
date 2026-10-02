/**
 * In-Memory Key Store & Defensive RAM Sanitization Manager (SessionKeyStore)
 *
 * Safely holds LocalDeviceKey and VaultMasterKey in volatile RAM.
 * Manages inactivity auto-lock timers, subscriptions, and provides instant .fill(0)
 * defensive wiping via purgeKeys() on lock, logout, or session expiry.
 *
 * Hardened with Deterministic Time-Based Invalidation against background-tab throttling.
 */

import { wipeBuffer } from './crypto-worker-bridge';
import { SessionKeyStoreError } from './types/vault';
import { sanitizeLogValue } from './log-sanitizer';
import { broadcastCrossTabEvent, subscribeCrossTabSync } from './cross-tab-sync';

export type KeyStoreListener = (isUnlocked: boolean) => void;

const SESSION_STORAGE_VAULT_KEY = 'lugx_vault_session_v1';

export interface SessionKeyStoreConfig {
  /**
   * Inactivity timeout in milliseconds before vault automatically locks.
   * Default: 1 hour (3,600,000 ms). 0 disables auto-lock.
   */
  inactivityTimeoutMs?: number;
}

export class SessionKeyStore {
  private masterKey: CryptoKey | null = null;
  private masterKeyRaw: Uint8Array | null = null;
  private localDeviceKey: CryptoKey | null = null;
  private localDeviceKeyRaw: Uint8Array | null = null;
  private keyVersion = 1;
  private lockEpoch = 1;

  private inactivityTimer: ReturnType<typeof setTimeout> | null = null;
  private inactivityTimeoutMs = 60 * 60 * 1000; // 1 hour default (3,600,000 ms)
  private lastActivityTimestamp = 0;
  private listeners = new Set<KeyStoreListener>();
  private _unsubCrossTab?: () => void;

  constructor(config: SessionKeyStoreConfig = {}) {
    if (config.inactivityTimeoutMs !== undefined) {
      this.inactivityTimeoutMs = config.inactivityTimeoutMs;
    }

    // Cross-tab vault lock synchronization
    if (typeof window !== 'undefined') {
      this._unsubCrossTab = subscribeCrossTabSync((event) => {
        if (event.type === 'vault_locked') {
          this.lock(false); // Purge locally without re-broadcasting
        }
      });
    }
  }

  /**
   * Cleans up cross-tab synchronization subscriptions and clears listeners
   */
  public destroy(): void {
    if (this._unsubCrossTab) {
      this._unsubCrossTab();
      this._unsubCrossTab = undefined;
    }
    this.purgeKeys(false);
    this.listeners.clear();
  }

  /**
   * Configures or updates the inactivity auto-lock timeout
   */
  public setInactivityTimeout(ms: number): void {
    this.inactivityTimeoutMs = ms;
    this.touch();
  }

  /**
   * Returns current inactivity auto-lock timeout in milliseconds
   */
  public getInactivityTimeout(): number {
    return this.inactivityTimeoutMs;
  }

  /**
   * Resets the inactivity timer and activity timestamp upon user activity
   */
  public touch(): void {
    this.lastActivityTimestamp = Date.now();

    if (this.inactivityTimer) {
      clearTimeout(this.inactivityTimer);
      this.inactivityTimer = null;
    }

    if (this.inactivityTimeoutMs > 0 && (this.masterKey !== null || this.masterKeyRaw !== null)) {
      this.inactivityTimer = setTimeout(() => {
        this.lock();
      }, this.inactivityTimeoutMs);
    }
  }

  /**
   * Sets the Vault Master Key in volatile memory and activates auto-lock timer
   */
  public setMasterKey(key: CryptoKey | Uint8Array, keyVersion = 1): void {
    if (!key) {
      throw new SessionKeyStoreError('Invalid key provided to setMasterKey');
    }

    // Wipe previous keys if present
    this.purgeMasterKey();

    if (key instanceof Uint8Array) {
      this.masterKeyRaw = new Uint8Array(key);
      this.masterKey = null;

      // Asynchronously isolate as non-extractable CryptoKey if WebCrypto is available (LUGX-084)
      if (typeof crypto !== 'undefined' && crypto.subtle) {
        void crypto.subtle.importKey(
          'raw',
          new Uint8Array(this.masterKeyRaw),
          { name: 'AES-GCM', length: 256 },
          false,
          ['encrypt', 'decrypt']
        ).then((imported) => {
          if (this.masterKeyRaw) {
            this.masterKey = imported;
          }
        }).catch(() => {
          // Graceful fallback to raw bytes in environments lacking full subtle support
        });
      }
    } else {
      this.masterKey = key;
      this.masterKeyRaw = null;
    }

    this.keyVersion = keyVersion;
    this.touch();
    this.notifyListeners(true);
  }

  /**
   * Retrieves the current Vault Master Key without triggering an activity touch (LUGX-042).
   * Background decryption and synchronization do not postpone inactivity lock.
   */
  public getMasterKey(): CryptoKey | Uint8Array | null {
    if (!this.isUnlocked()) {
      return null;
    }
    return this.masterKey || (this.masterKeyRaw ? new Uint8Array(this.masterKeyRaw) : null);
  }

  /**
   * Retrieves a detached clone of raw master key bytes if stored as Uint8Array (LUGX-016).
   * Prevents callers from holding mutable pointers that get zeroed in place on purge.
   * Does not trigger an activity touch (LUGX-042).
   */
  public getMasterKeyRaw(): Uint8Array | null {
    if (!this.isUnlocked()) {
      return null;
    }
    return this.masterKeyRaw ? new Uint8Array(this.masterKeyRaw) : null;
  }

  /**
   * Returns the current monotonic lock epoch counter
   */
  public getLockEpoch(): number {
    return this.lockEpoch;
  }

  /**
   * Scoped execution wrapper that operates over master key material with lockEpoch validation.
   * Guarantees that if the vault locks during an async operation, execution is safely aborted
   * rather than producing ciphertext encrypted with an all-zero buffer (LUGX-016).
   */
  public async withMasterKey<T>(
    operation: (key: CryptoKey | Uint8Array, epoch: number) => Promise<T> | T
  ): Promise<T> {
    if (!this.isUnlocked()) {
      throw new SessionKeyStoreError('Vault is locked; operation rejected');
    }
    const startEpoch = this.lockEpoch;
    const keyRef = this.masterKey || (this.masterKeyRaw ? new Uint8Array(this.masterKeyRaw) : null);
    if (!keyRef) {
      throw new SessionKeyStoreError('Vault key is unavailable');
    }

    try {
      const result = await operation(keyRef, startEpoch);
      if (this.lockEpoch !== startEpoch || !this.isUnlocked()) {
        throw new SessionKeyStoreError(
          'Vault was locked concurrently during operation; execution aborted to prevent zero-key encryption'
        );
      }
      return result;
    } finally {
      if (keyRef instanceof Uint8Array) {
        wipeBuffer(keyRef);
      }
    }
  }

  /**
   * Sets the Local Device Key for Always-On IndexedDB local encryption
   */
  public setLocalDeviceKey(key: CryptoKey | Uint8Array): void {
    if (!key) {
      throw new SessionKeyStoreError('Invalid key provided to setLocalDeviceKey');
    }

    this.purgeLocalDeviceKey();

    if (key instanceof Uint8Array) {
      this.localDeviceKeyRaw = new Uint8Array(key);
      this.localDeviceKey = null;
    } else {
      this.localDeviceKey = key;
      this.localDeviceKeyRaw = null;
    }
  }

  /**
   * Retrieves the Local Device Key
   */
  public getLocalDeviceKey(): CryptoKey | Uint8Array | null {
    return this.localDeviceKey || this.localDeviceKeyRaw;
  }

  /**
   * Returns true if Vault Master Key is present, active, and not expired by inactivity
   */
  public isUnlocked(): boolean {
    if (this.inactivityTimeoutMs > 0 && this.lastActivityTimestamp > 0) {
      if (Date.now() - this.lastActivityTimestamp > this.inactivityTimeoutMs) {
        this.lock();
        return false;
      }
    }
    return this.masterKey !== null || this.masterKeyRaw !== null;
  }

  /**
   * Alias for isUnlocked()
   */
  public hasMasterKey(): boolean {
    return this.isUnlocked();
  }

  /**
   * Alias for isUnlocked() explicitly checking Vault unlock state
   */
  public isVaultUnlocked(): boolean {
    return this.isUnlocked();
  }

  /**
   * Stores raw Master Key bytes in volatile memory
   */
  public storeMasterKeyRaw(key: Uint8Array, _timeoutSeconds?: number): void {
    this.setMasterKey(key);
  }

  /**
   * Returns true if Local Device Key is initialized
   */
  public hasLocalDeviceKey(): boolean {
    return this.localDeviceKey !== null || this.localDeviceKeyRaw !== null;
  }

  /**
   * Returns current master key version
   */
  public getKeyVersion(): number {
    return this.keyVersion;
  }

  /**
   * Purges master key only and transitions vault state to locked.
   * Broadcasts vault_locked event across tabs unless broadcast is set to false.
   */
  public lock(broadcast = true): void {
    const wasUnlocked = this.masterKey !== null || this.masterKeyRaw !== null;
    this.purgeMasterKey();
    if (wasUnlocked) {
      this.notifyListeners(false);
      if (broadcast && typeof window !== 'undefined') {
        broadcastCrossTabEvent({ type: 'vault_locked' });
      }
    }
  }

  /**
   * Purges all keys (Master Key & Local Device Key) and zeroes volatile RAM.
   * Broadcasts vault_locked event across tabs unless broadcast is set to false.
   */
  public purgeKeys(broadcast = true): void {
    const wasUnlocked = this.masterKey !== null || this.masterKeyRaw !== null;
    this.purgeMasterKey();
    this.purgeLocalDeviceKey();
    if (wasUnlocked) {
      this.notifyListeners(false);
      if (broadcast && typeof window !== 'undefined') {
        broadcastCrossTabEvent({ type: 'vault_locked' });
      }
    }
  }

  private purgeMasterKey(): void {
    this.lockEpoch++;

    if (this.inactivityTimer) {
      clearTimeout(this.inactivityTimer);
      this.inactivityTimer = null;
    }

    if (this.masterKeyRaw) {
      wipeBuffer(this.masterKeyRaw);
      this.masterKeyRaw = null;
    }

    this.masterKey = null;
    this.lastActivityTimestamp = 0;

    if (typeof window !== 'undefined' && window.sessionStorage) {
      try {
        window.sessionStorage.removeItem(SESSION_STORAGE_VAULT_KEY);
      } catch {
        // ignore
      }
    }
  }

  private purgeLocalDeviceKey(): void {
    if (this.localDeviceKeyRaw) {
      wipeBuffer(this.localDeviceKeyRaw);
      this.localDeviceKeyRaw = null;
    }

    this.localDeviceKey = null;
  }

  /**
   * Subscribes to vault lock/unlock status changes
   */
  public subscribe(listener: KeyStoreListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notifyListeners(isUnlocked: boolean): void {
    for (const listener of this.listeners) {
      try {
        listener(isUnlocked);
      } catch (err) {
        console.error('SessionKeyStore listener error:', sanitizeLogValue(err));
      }
    }
  }
}

export const sessionKeyStore = new SessionKeyStore();
