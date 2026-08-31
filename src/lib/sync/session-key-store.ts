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

export type KeyStoreListener = (isUnlocked: boolean) => void;

export interface SessionKeyStoreConfig {
  /**
   * Inactivity timeout in milliseconds before vault automatically locks.
   * Default: 15 minutes (900,000 ms). 0 disables auto-lock.
   */
  inactivityTimeoutMs?: number;
}

export class SessionKeyStore {
  private masterKey: CryptoKey | null = null;
  private masterKeyRaw: Uint8Array | null = null;
  private localDeviceKey: CryptoKey | null = null;
  private localDeviceKeyRaw: Uint8Array | null = null;
  private keyVersion = 1;

  private inactivityTimer: ReturnType<typeof setTimeout> | null = null;
  private inactivityTimeoutMs = 15 * 60 * 1000; // 15 minutes default
  private lastActivityTimestamp = 0;
  private listeners = new Set<KeyStoreListener>();

  constructor(config: SessionKeyStoreConfig = {}) {
    if (config.inactivityTimeoutMs !== undefined) {
      this.inactivityTimeoutMs = config.inactivityTimeoutMs;
    }
  }

  /**
   * Configures or updates the inactivity auto-lock timeout
   */
  public setInactivityTimeout(ms: number): void {
    this.inactivityTimeoutMs = ms;
    this.touch();
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
    } else {
      this.masterKey = key;
      this.masterKeyRaw = null;
    }

    this.keyVersion = keyVersion;
    this.touch();
    this.notifyListeners(true);
  }

  /**
   * Retrieves the current Vault Master Key with deterministic time-check gatekeeper
   */
  public getMasterKey(): CryptoKey | Uint8Array | null {
    if (!this.isUnlocked()) {
      return null;
    }
    this.touch();
    return this.masterKey || this.masterKeyRaw;
  }

  /**
   * Retrieves raw master key bytes if stored as Uint8Array with time-check gatekeeper
   */
  public getMasterKeyRaw(): Uint8Array | null {
    if (!this.isUnlocked()) {
      return null;
    }
    this.touch();
    return this.masterKeyRaw;
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
   * Purges master key only and transitions vault state to locked
   */
  public lock(): void {
    const wasUnlocked = this.masterKey !== null || this.masterKeyRaw !== null;
    this.purgeMasterKey();
    if (wasUnlocked) {
      this.notifyListeners(false);
    }
  }

  /**
   * Purges all keys (Master Key & Local Device Key) and zeroes volatile RAM
   */
  public purgeKeys(): void {
    const wasUnlocked = this.masterKey !== null || this.masterKeyRaw !== null;
    this.purgeMasterKey();
    this.purgeLocalDeviceKey();
    if (wasUnlocked) {
      this.notifyListeners(false);
    }
  }

  private purgeMasterKey(): void {
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
        console.error('SessionKeyStore listener error:', err);
      }
    }
  }
}

export const sessionKeyStore = new SessionKeyStore();
