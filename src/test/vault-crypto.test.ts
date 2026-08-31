/**
 * LUGX Phase 1 Verification Suite: Isolated Crypto Worker,
 * Defensive RAM Sanitization & Key Management.
 *
 * Tests PBKDF2 600K key derivation, AES-GCM-256 with AAD binding,
 * BIP-39 12-word recovery seed derivation, Master Key dual-wrapping,
 * SessionKeyStore auto-lock/purging, and defensive memory wiping (.fill(0)).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  cryptoWorkerBridge,
  wipeBuffer,
  generateMasterKeyRaw,
  generateSalt,
  generateIV,
  deriveKEKFromPassword,
  deriveKEKFromRecoverySeed,
  wrapMasterKeyWithPassword,
  unwrapMasterKeyWithPassword,
  wrapMasterKeyWithRecoverySeed,
  unwrapMasterKeyWithRecoverySeed,
  encryptEnvelope,
  decryptEnvelope,
  EncryptionManager,
  sessionKeyStore,
  SessionKeyStore,
  generateMnemonic,
  validateMnemonic,
  mnemonicToEntropy,
  entropyToMnemonic,
  mnemonicToSeed,
  BIP39_WORDLIST,
  AADIntegrityError,
  InvalidCiphertextOrKeyError,
  EncryptedEnvelope
} from '../lib/sync';

describe('Phase 1: Crypto Worker, Defensive RAM Sanitization & Key Management', () => {
  beforeEach(() => {
    sessionKeyStore.purgeKeys();
    vi.useRealTimers();
  });

  afterEach(() => {
    sessionKeyStore.purgeKeys();
    vi.restoreAllMocks();
  });

  describe('1. PBKDF2 Key Derivation & Determinism', () => {
    it('should derive deterministic 256-bit key from password and salt', async () => {
      const password = 'CorrectHorseBatteryStaple#2026';
      const salt = await generateSalt(16);

      // Using fast iterations for quick unit test assertion (e.g. 5000)
      const key1 = await deriveKEKFromPassword(password, salt, 5000);
      const key2 = await deriveKEKFromPassword(password, salt, 5000);

      expect(key1).toHaveLength(32); // 256 bits = 32 bytes
      expect(key2).toHaveLength(32);
      expect(Array.from(key1)).toEqual(Array.from(key2));

      // Different salt must produce different key
      const differentSalt = await generateSalt(16);
      const key3 = await deriveKEKFromPassword(password, differentSalt, 5000);
      expect(Array.from(key1)).not.toEqual(Array.from(key3));

      // Different password must produce different key
      const key4 = await deriveKEKFromPassword('WrongPassword', salt, 5000);
      expect(Array.from(key1)).not.toEqual(Array.from(key4));
    });
  });

  describe('2. AES-GCM-256 with Mandatory AAD Binding', () => {
    it('should encrypt and decrypt markdown text successfully when AAD matches', async () => {
      const masterKey = await generateMasterKeyRaw();
      const salt = await generateSalt(16);
      const saltBase64 = Buffer.from(salt).toString('base64');
      const userId = 'user-uuid-123';
      const fileId = 'file-doc-456';
      const aad = `${userId}:${fileId}`;
      const markdownContent = '# Confidential Strategy\n\n- Zero-Knowledge\n- End-to-End Encrypted';

      const envelope = await encryptEnvelope(
        markdownContent,
        masterKey,
        'key-v1',
        saltBase64,
        aad,
        600000
      );

      expect(envelope.version).toBe(1);
      expect(envelope.algorithm).toBe('AES-GCM-256');
      expect(envelope.keyId).toBe('key-v1');
      expect(envelope.ciphertext).toBeDefined();
      expect(envelope.iv).toBeDefined();

      const decrypted = await decryptEnvelope(envelope, masterKey, aad);
      expect(decrypted).toBe(markdownContent);
    });

    it('should reject decryption and throw InvalidCiphertextOrKeyError when key is wrong', async () => {
      const correctKey = await generateMasterKeyRaw();
      const wrongKey = await generateMasterKeyRaw();
      const salt = await generateSalt(16);
      const saltBase64 = Buffer.from(salt).toString('base64');
      const aad = 'user-1:file-1';

      const envelope = await encryptEnvelope(
        'Secret content',
        correctKey,
        'key-v1',
        saltBase64,
        aad,
        600000
      );

      await expect(decryptEnvelope(envelope, wrongKey, aad)).rejects.toThrow(
        InvalidCiphertextOrKeyError
      );
    });

    it('should throw InvalidCiphertextOrKeyError when ciphertext is tampered with', async () => {
      const key = await generateMasterKeyRaw();
      const salt = await generateSalt(16);
      const saltBase64 = Buffer.from(salt).toString('base64');
      const aad = 'user-1:file-1';

      const envelope = await encryptEnvelope(
        'Original text',
        key,
        'key-v1',
        saltBase64,
        aad,
        600000
      );

      // Corrupt the ciphertext
      const rawCipher = Buffer.from(envelope.ciphertext, 'base64');
      rawCipher[0] = rawCipher[0] ^ 0xff; // flip bits
      const tamperedEnvelope: EncryptedEnvelope = {
        ...envelope,
        ciphertext: rawCipher.toString('base64')
      };

      await expect(decryptEnvelope(tamperedEnvelope, key, aad)).rejects.toThrow(
        InvalidCiphertextOrKeyError
      );
    });

    it('should reject decryption when AAD is swapped or tampered with', async () => {
      const key = await generateMasterKeyRaw();
      const salt = await generateSalt(16);
      const saltBase64 = Buffer.from(salt).toString('base64');
      const legitimateAAD = 'user-123:file-AAA';
      const swappedAAD = 'user-123:file-BBB'; // Attempted document substitution

      const envelope = await encryptEnvelope(
        'Document AAA content',
        key,
        'key-v1',
        saltBase64,
        legitimateAAD,
        600000
      );

      // Attempting to decrypt document AAA ciphertext inside document BBB context must fail
      await expect(decryptEnvelope(envelope, key, swappedAAD)).rejects.toThrow(
        InvalidCiphertextOrKeyError
      );
    });

    it('should throw AADIntegrityError when empty AAD is supplied', async () => {
      const key = await generateMasterKeyRaw();
      const salt = await generateSalt(16);
      const saltBase64 = Buffer.from(salt).toString('base64');

      await expect(
        encryptEnvelope('Content', key, 'key-v1', saltBase64, '')
      ).rejects.toThrow(AADIntegrityError);
    });
  });

  describe('3. Master Key Dual-Wrapping (Password & Recovery Seed)', () => {
    it('should wrap and unwrap master key using password KEK', async () => {
      const masterKey = await generateMasterKeyRaw();
      const password = 'SuperSecretPassword@2026';
      const salt = await generateSalt(16);
      const userId = 'user-uuid-999';

      const wrapped = await wrapMasterKeyWithPassword(
        masterKey,
        password,
        salt,
        userId,
        10000
      );

      expect(wrapped.wrappedKeyBase64).toBeDefined();
      expect(wrapped.ivBase64).toBeDefined();

      const unwrappedKey = await unwrapMasterKeyWithPassword(
        wrapped.wrappedKeyBase64,
        wrapped.ivBase64,
        password,
        salt,
        userId,
        10000
      );

      expect(unwrappedKey).toHaveLength(32);
      expect(Array.from(unwrappedKey)).toEqual(Array.from(masterKey));

      // Wrong password fails
      await expect(
        unwrapMasterKeyWithPassword(
          wrapped.wrappedKeyBase64,
          wrapped.ivBase64,
          'WrongPassword',
          salt,
          userId,
          10000
        )
      ).rejects.toThrow(InvalidCiphertextOrKeyError);
    });

    it('should wrap and unwrap master key using 12-word BIP-39 recovery seed', async () => {
      const masterKey = await generateMasterKeyRaw();
      const mnemonic = await generateMnemonic();
      const recoverySalt = await generateSalt(16);
      const userId = 'user-uuid-999';

      const wrapped = await wrapMasterKeyWithRecoverySeed(
        masterKey,
        mnemonic,
        recoverySalt,
        userId,
        10000
      );

      expect(wrapped.wrappedKeyBase64).toBeDefined();

      const unwrappedKey = await unwrapMasterKeyWithRecoverySeed(
        wrapped.wrappedKeyBase64,
        wrapped.ivBase64,
        mnemonic,
        recoverySalt,
        userId,
        10000
      );

      expect(Array.from(unwrappedKey)).toEqual(Array.from(masterKey));

      // Different mnemonic fails
      const otherMnemonic = await generateMnemonic();
      await expect(
        unwrapMasterKeyWithRecoverySeed(
          wrapped.wrappedKeyBase64,
          wrapped.ivBase64,
          otherMnemonic,
          recoverySalt,
          userId,
          10000
        )
      ).rejects.toThrow(InvalidCiphertextOrKeyError);
    });
  });

  describe('4. BIP-39 12-Word Mnemonic Generation & Checksum Validation', () => {
    it('should generate valid 12-word mnemonic from standard BIP-39 wordlist', async () => {
      const mnemonic = await generateMnemonic();
      const words = mnemonic.split(' ');

      expect(words).toHaveLength(12);
      for (const word of words) {
        expect(BIP39_WORDLIST.includes(word)).toBe(true);
      }

      const validation = await validateMnemonic(mnemonic);
      expect(validation.isValid).toBe(true);
      expect(validation.error).toBeUndefined();
    });

    it('should reject mnemonic with invalid word count', async () => {
      const mnemonic11 = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon';
      const validation = await validateMnemonic(mnemonic11);
      expect(validation.isValid).toBe(false);
      expect(validation.error).toContain('Invalid word count');
    });

    it('should reject mnemonic containing words not in dictionary', async () => {
      const invalidMnemonic = 'abandon ability able about above absent absorb abstract absurd abuse access nonexistingword';
      const validation = await validateMnemonic(invalidMnemonic);
      expect(validation.isValid).toBe(false);
      expect(validation.error).toContain('Invalid words detected');
      expect(validation.invalidWords).toContain('nonexistingword');
    });

    it('should reject mnemonic when words are swapped (checksum failure)', async () => {
      const validMnemonic = await generateMnemonic();
      const words = validMnemonic.split(' ');

      // Swap two words
      const temp = words[0];
      words[0] = words[1];
      words[1] = temp;
      const swappedMnemonic = words.join(' ');

      const validation = await validateMnemonic(swappedMnemonic);
      expect(validation.isValid).toBe(false);
      expect(validation.error).toContain('checksum verification failed');
    });

    it('should roundtrip entropy to mnemonic and back to entropy accurately', async () => {
      const originalEntropy = new Uint8Array(16);
      crypto.getRandomValues(originalEntropy);
      const entropyCopy = new Uint8Array(originalEntropy);

      const mnemonic = await entropyToMnemonic(originalEntropy);
      const recoveredEntropy = await mnemonicToEntropy(mnemonic);

      expect(Array.from(recoveredEntropy)).toEqual(Array.from(entropyCopy));
    });
  });

  describe('5. Defensive RAM Sanitization (.fill(0))', () => {
    it('should wipe Uint8Array memory buffers with zeroed bytes', () => {
      const buffer = new Uint8Array([1, 2, 3, 4, 5, 255, 128]);
      wipeBuffer(buffer);

      for (let i = 0; i < buffer.length; i++) {
        expect(buffer[i]).toBe(0);
      }
    });

    it('should handle null or undefined safely without throwing', () => {
      expect(() => wipeBuffer(null)).not.toThrow();
      expect(() => wipeBuffer(undefined)).not.toThrow();
    });
  });

  describe('6. SessionKeyStore In-Memory Management & Auto-Lock', () => {
    it('should store and retrieve master and local keys in memory', async () => {
      const masterKey = await generateMasterKeyRaw();
      const localDeviceKey = await generateMasterKeyRaw();

      expect(sessionKeyStore.isUnlocked()).toBe(false);
      expect(sessionKeyStore.hasMasterKey()).toBe(false);

      sessionKeyStore.setMasterKey(masterKey, 1);
      sessionKeyStore.setLocalDeviceKey(localDeviceKey);

      expect(sessionKeyStore.isUnlocked()).toBe(true);
      expect(sessionKeyStore.hasMasterKey()).toBe(true);
      expect(sessionKeyStore.hasLocalDeviceKey()).toBe(true);
      expect(sessionKeyStore.getKeyVersion()).toBe(1);

      const retrieved = sessionKeyStore.getMasterKey();
      expect(retrieved).toBeDefined();
    });

    it('should wipe keys from memory when locked or purged', async () => {
      const masterKey = new Uint8Array([10, 20, 30, 40]);
      sessionKeyStore.setMasterKey(masterKey);

      expect(sessionKeyStore.isUnlocked()).toBe(true);

      sessionKeyStore.lock();

      expect(sessionKeyStore.isUnlocked()).toBe(false);
      expect(sessionKeyStore.getMasterKey()).toBeNull();
    });

    it('should notify subscribers on lock and unlock transitions', async () => {
      const states: boolean[] = [];
      const unsubscribe = sessionKeyStore.subscribe((isUnlocked) => {
        states.push(isUnlocked);
      });

      const masterKey = await generateMasterKeyRaw();
      sessionKeyStore.setMasterKey(masterKey);
      sessionKeyStore.lock();

      unsubscribe();
      sessionKeyStore.setMasterKey(masterKey);

      expect(states).toEqual([true, false]);
    });

    it('should auto-lock after inactivity timeout', async () => {
      vi.useFakeTimers();
      const customStore = new SessionKeyStore({ inactivityTimeoutMs: 1000 });
      const masterKey = await generateMasterKeyRaw();

      customStore.setMasterKey(masterKey);
      expect(customStore.isUnlocked()).toBe(true);

      // Advance clock by 500ms -> should still be unlocked
      vi.advanceTimersByTime(500);
      expect(customStore.isUnlocked()).toBe(true);

      // Touch -> resets inactivity timer
      customStore.touch();
      vi.advanceTimersByTime(600);
      expect(customStore.isUnlocked()).toBe(true);

      // Advance remaining 500ms past timeout -> auto-locks
      vi.advanceTimersByTime(500);
      expect(customStore.isUnlocked()).toBe(false);

      customStore.purgeKeys();
    });
  });

  describe('7. Backward-Compatible EncryptionManager Integration', () => {
    it('should derive key, encrypt and decrypt correctly using manager', async () => {
      const manager = new EncryptionManager({ iterations: 5000 });
      await manager.deriveKeyFromPassword('UserPassword123');

      expect(manager.isInitialized()).toBe(true);

      const encrypted = await manager.encrypt('Hello World', 'doc-aad');
      expect(encrypted.ciphertext).toBeDefined();
      expect(encrypted.iv).toBeDefined();

      const decrypted = await manager.decrypt(encrypted, 'doc-aad');
      expect(decrypted).toBe('Hello World');

      manager.clear();
      expect(manager.isInitialized()).toBe(false);
    });

    it('should safely wipe previous rawKey and salt on sequential derivations', async () => {
      const manager = new EncryptionManager({ iterations: 5000 });
      await manager.deriveKeyFromPassword('FirstPassword');
      const firstRaw = manager.getRawKey();
      expect(firstRaw).toBeDefined();

      await manager.deriveKeyFromPassword('SecondPassword');
      const secondRaw = manager.getRawKey();
      expect(secondRaw).toBeDefined();
      expect(firstRaw).not.toBe(secondRaw);
    });
  });

  describe('8. Adversarial Audit Hardened Invariants', () => {
    it('should derive identical keys for NFD and NFC Unicode password variations (NFKC Normalization)', async () => {
      // Decomposed (NFD: 'e' + combining acute accent) vs Precomposed (NFC: 'é')
      const nfdPassword = 'P\u0065\u0301tra#2026';
      const nfcPassword = 'P\u00E9tra#2026';
      const salt = await generateSalt(16);

      const keyNFD = await deriveKEKFromPassword(nfdPassword, salt, 5000);
      const keyNFC = await deriveKEKFromPassword(nfcPassword, salt, 5000);

      expect(Array.from(keyNFD)).toEqual(Array.from(keyNFC));
    });

    it('should handle large payloads (500KB+) via chunked Base64 without errors or stack overflow', async () => {
      const largeSize = 512 * 1024; // 512 KB
      const largeBuffer = new Uint8Array(largeSize);
      for (let i = 0; i < largeSize; i++) {
        largeBuffer[i] = i % 256;
      }

      const base64 = Buffer.from(largeBuffer).toString('base64');
      const { base64ToUint8Array, arrayBufferToBase64 } = await import('../lib/sync');

      const convertedBase64 = arrayBufferToBase64(largeBuffer);
      expect(convertedBase64).toBe(base64);

      const decodedBytes = base64ToUint8Array(base64);
      expect(decodedBytes.length).toBe(largeSize);
      expect(decodedBytes[0]).toBe(0);
      expect(decodedBytes[255]).toBe(255);
    });

    it('should support URL-safe base64 inputs seamlessly in base64ToUint8Array', async () => {
      const { base64ToUint8Array } = await import('../lib/sync');
      const standardBase64 = 'a+//cA==';
      const urlSafeBase64 = 'a-__cA==';
      const unpaddedUrlSafe = 'a-__cA';

      const decodedStandard = base64ToUint8Array(standardBase64);
      const decodedUrlSafe = base64ToUint8Array(urlSafeBase64);
      const decodedUnpadded = base64ToUint8Array(unpaddedUrlSafe);

      expect(Array.from(decodedStandard)).toEqual(Array.from(decodedUrlSafe));
      expect(Array.from(decodedStandard)).toEqual(Array.from(decodedUnpadded));
    });

    it('should throw InvalidCiphertextOrKeyError when corrupted base64 is provided', async () => {
      const { base64ToUint8Array } = await import('../lib/sync');
      expect(() => base64ToUint8Array('!!!NotBase64@@@')).toThrow(InvalidCiphertextOrKeyError);
      expect(() => base64ToUint8Array('')).toThrow(InvalidCiphertextOrKeyError);
    });

    it('should immediately lock via time-based invalidation even if setTimeout is delayed', async () => {
      const customStore = new SessionKeyStore({ inactivityTimeoutMs: 500 });
      const masterKey = await generateMasterKeyRaw();

      customStore.setMasterKey(masterKey);
      expect(customStore.isUnlocked()).toBe(true);

      // Simulate clock advancement of 600ms (as in background tab throttling / OS sleep)
      const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 600);

      // Even without setTimeout triggering, isUnlocked() and getMasterKey() must return false/null
      expect(customStore.isUnlocked()).toBe(false);
      expect(customStore.getMasterKey()).toBeNull();

      nowSpy.mockRestore();
    });
  });
});
