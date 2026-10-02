/**
 * Verification Test Suite for Phase 9: Cryptographic Hierarchy, Standard AAD & Adaptive Migration
 *
 * Exercises real WebCrypto cryptographic operations without mocks.
 * Remediates and verifies:
 * - LUGX-005 (BIP-39 seed recovery AAD mismatch & adaptive dual-try migration)
 * - LUGX-016 (lockEpoch & memory hygiene preventing zero-key encryption)
 * - LUGX-042 (decoupling getMasterKey from inactivity auto-lock touch)
 * - LUGX-043 (strict standard 2048-word BIP-39 wordlist audit)
 * - LUGX-133 (NFKC Unicode password normalization)
 * - HKDF-SHA-256 subkey derivation
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { AAD } from '@/lib/crypto/aad';
import {
  BIP39_STANDARD_WORDLIST,
  BIP39_STANDARD_WORD_MAP
} from '@/lib/crypto/bip39-wordlist';
import { BIP39_WORDLIST, generateMnemonic, validateMnemonic } from '@/lib/sync/mnemonic';
import {
  normalizePassword,
  deriveDocumentKey,
  deriveSearchIndexKey,
  deriveProofOfPossession
} from '@/lib/crypto/key-derivation';
import { adaptiveUnwrapRecoverySeed } from '@/lib/vault/recovery';
import { VaultManager, sessionKeyStore } from '@/lib/vault/vault-manager';
import {
  cryptoWorkerBridge,
  generateDirectRandomBytes,
  wipeBuffer,
  base64ToUint8Array
} from '@/lib/sync/crypto-worker-bridge';

const TEST_USER = 'user-adaptive-migration-phase9';
const TEST_ITERATIONS = 5000; // Deterministic reduced iteration count for fast tests

describe('Phase 9: Cryptographic Hierarchy, Standard AAD & Adaptive Dual-Try Migration', () => {
  beforeEach(() => {
    sessionKeyStore.purgeKeys(false);
  });

  afterEach(() => {
    sessionKeyStore.purgeKeys(false);
  });

  describe('1. BIP-39 Standard Wordlist Audit (LUGX-043)', () => {
    it('contains exactly 2048 standard English words', () => {
      expect(BIP39_STANDARD_WORDLIST).toHaveLength(2048);
      expect(BIP39_WORDLIST).toHaveLength(2048);
      expect(BIP39_STANDARD_WORD_MAP.size).toBe(2048);
    });

    it('does not contain non-standard or corrupted words like "paci", "coal", "squad", "squash"', () => {
      expect(BIP39_STANDARD_WORDLIST.includes('paci')).toBe(false);
      expect(BIP39_STANDARD_WORDLIST.includes('coal')).toBe(false);
      expect(BIP39_STANDARD_WORDLIST.includes('squad')).toBe(false);
      expect(BIP39_STANDARD_WORDLIST.includes('squash')).toBe(false);
    });

    it('contains standard restored words like "pact", "paddle", "squeeze", "tragic"', () => {
      expect(BIP39_STANDARD_WORDLIST.includes('pact')).toBe(true);
      expect(BIP39_STANDARD_WORDLIST.includes('paddle')).toBe(true);
      expect(BIP39_STANDARD_WORDLIST.includes('squeeze')).toBe(true);
      expect(BIP39_STANDARD_WORDLIST.includes('tragic')).toBe(true);
    });

    it('is strictly sorted in alphabetical order', () => {
      for (let i = 1; i < BIP39_STANDARD_WORDLIST.length; i++) {
        expect(BIP39_STANDARD_WORDLIST[i] > BIP39_STANDARD_WORDLIST[i - 1]).toBe(true);
      }
    });

    it('successfully generates and validates 12-word mnemonics with standard wordlist', async () => {
      const mnemonic = await generateMnemonic(16);
      const words = mnemonic.trim().split(/\s+/);
      expect(words).toHaveLength(12);

      for (const word of words) {
        expect(BIP39_STANDARD_WORD_MAP.has(word)).toBe(true);
      }

      const validation = await validateMnemonic(mnemonic);
      expect(validation.isValid).toBe(true);
    });
  });

  describe('2. Standardized AAD Contexts (LUGX-005)', () => {
    it('generates canonical v1 AAD formats', () => {
      expect(AAD.passwordWrap(TEST_USER)).toBe(`lugx:v1:pass:${TEST_USER}`);
      expect(AAD.recoveryWrap(TEST_USER)).toBe(`lugx:v1:recovery:${TEST_USER}`);
      expect(AAD.deviceWrap(TEST_USER, 3)).toBe(`lugx:v1:device:${TEST_USER}:3`);
      expect(AAD.file(TEST_USER, 'doc-123')).toBe(`lugx:v1:file:${TEST_USER}:doc-123`);
    });

    it('provides legacy fallback formats', () => {
      expect(AAD.legacy.seedWrap(TEST_USER)).toBe(`vault:seed:${TEST_USER}`);
      expect(AAD.legacy.passWrap(TEST_USER)).toBe(`vault:pass:${TEST_USER}`);
      expect(AAD.legacy.recoveryWrap(TEST_USER)).toBe(`vault:recovery:${TEST_USER}`);
      expect(AAD.legacy.file(TEST_USER, 'doc-123')).toBe(`vault:file:${TEST_USER}:doc-123`);
    });

    it('rejects empty identifiers with AADValidationError', () => {
      expect(() => AAD.passwordWrap('')).toThrow();
      expect(() => AAD.recoveryWrap('')).toThrow();
      expect(() => AAD.file('', 'doc-1')).toThrow();
      expect(() => AAD.file('user-1', '')).toThrow();
    });
  });

  describe('3. Adaptive Dual-Try Recovery Migration (LUGX-005 Resolution)', () => {
    it('successfully recovers a legacy vault created with vault:seed: and re-wraps with lugx:v1:recovery:', async () => {
      const masterKey = await generateDirectRandomBytes(32);
      const mnemonic = await generateMnemonic(16);
      const recoverySalt = await generateDirectRandomBytes(16);

      // Simulate legacy vault creation: KEK derived from mnemonic, wrapped with AAD vault:seed:<userId>
      const seedBytes = await cryptoWorkerBridge.mnemonicToSeed(mnemonic, recoverySalt, TEST_ITERATIONS);
      const kekSeed = seedBytes.slice(0, 32);
      wipeBuffer(seedBytes);

      const legacyIv = await generateDirectRandomBytes(12);
      const legacyAAD = AAD.legacy.seedWrap(TEST_USER); // 'vault:seed:userId'
      const legacyWrapResult = await cryptoWorkerBridge.wrapKeyRaw(
        kekSeed,
        masterKey,
        legacyIv,
        legacyAAD
      );
      wipeBuffer(kekSeed);

      const legacyEnvelopePayload = JSON.stringify({
        ciphertext: legacyWrapResult.wrappedKeyBase64,
        iv: legacyWrapResult.ivBase64
      });

      // Execute Adaptive Dual-Try Recovery
      const recoveryResult = await adaptiveUnwrapRecoverySeed({
        seedMnemonic: mnemonic,
        recoveryEncryptedMasterKey: legacyEnvelopePayload,
        recoverySaltBytes: recoverySalt,
        userId: TEST_USER,
        kdfIterations: TEST_ITERATIONS
      });

      // Assertions
      expect(recoveryResult.wasMigrated).toBe(true);
      expect(Array.from(recoveryResult.masterKey)).toEqual(Array.from(masterKey));
      expect(recoveryResult.reWrappedEnvelope).toBeDefined();

      // Verify that the re-wrapped envelope now successfully unwraps under canonical AAD without legacy fallback
      const reWrapped = recoveryResult.reWrappedEnvelope!;
      const newSeedBytes = await cryptoWorkerBridge.mnemonicToSeed(mnemonic, recoverySalt, TEST_ITERATIONS);
      const newKekSeed = newSeedBytes.slice(0, 32);
      wipeBuffer(newSeedBytes);

      const canonicalAAD = AAD.recoveryWrap(TEST_USER); // 'lugx:v1:recovery:userId'
      const unwrappedUnderCanonical = await cryptoWorkerBridge.unwrapKeyRaw(
        newKekSeed,
        reWrapped.ciphertext,
        base64ToUint8Array(reWrapped.iv),
        canonicalAAD
      );

      expect(Array.from(unwrappedUnderCanonical)).toEqual(Array.from(masterKey));
      wipeBuffer(newKekSeed);
      wipeBuffer(unwrappedUnderCanonical);
      wipeBuffer(masterKey);
      wipeBuffer(recoveryResult.masterKey);
    });

    it('unwraps canonical modern vaults directly on Try 1 without migration (wasMigrated: false)', async () => {
      const masterKey = await generateDirectRandomBytes(32);
      const mnemonic = await generateMnemonic(16);
      const recoverySalt = await generateDirectRandomBytes(16);

      const seedBytes = await cryptoWorkerBridge.mnemonicToSeed(mnemonic, recoverySalt, TEST_ITERATIONS);
      const kekSeed = seedBytes.slice(0, 32);
      wipeBuffer(seedBytes);

      const canonicalIv = await generateDirectRandomBytes(12);
      const canonicalAAD = AAD.recoveryWrap(TEST_USER);
      const canonicalWrapResult = await cryptoWorkerBridge.wrapKeyRaw(
        kekSeed,
        masterKey,
        canonicalIv,
        canonicalAAD
      );
      wipeBuffer(kekSeed);

      const canonicalEnvelopePayload = JSON.stringify({
        ciphertext: canonicalWrapResult.wrappedKeyBase64,
        iv: canonicalWrapResult.ivBase64
      });

      const recoveryResult = await adaptiveUnwrapRecoverySeed({
        seedMnemonic: mnemonic,
        recoveryEncryptedMasterKey: canonicalEnvelopePayload,
        recoverySaltBytes: recoverySalt,
        userId: TEST_USER,
        kdfIterations: TEST_ITERATIONS
      });

      expect(recoveryResult.wasMigrated).toBe(false);
      expect(Array.from(recoveryResult.masterKey)).toEqual(Array.from(masterKey));
      expect(recoveryResult.reWrappedEnvelope).toBeUndefined();

      wipeBuffer(masterKey);
      wipeBuffer(recoveryResult.masterKey);
    });

    it('rejects invalid or tampered mnemonic phrases across all contexts', async () => {
      const masterKey = await generateDirectRandomBytes(32);
      const mnemonic = await generateMnemonic(16);
      const wrongMnemonic = await generateMnemonic(16);
      const recoverySalt = await generateDirectRandomBytes(16);

      const seedBytes = await cryptoWorkerBridge.mnemonicToSeed(mnemonic, recoverySalt, TEST_ITERATIONS);
      const kekSeed = seedBytes.slice(0, 32);
      wipeBuffer(seedBytes);

      const canonicalIv = await generateDirectRandomBytes(12);
      const wrapResult = await cryptoWorkerBridge.wrapKeyRaw(
        kekSeed,
        masterKey,
        canonicalIv,
        AAD.recoveryWrap(TEST_USER)
      );
      wipeBuffer(kekSeed);

      const envelopePayload = JSON.stringify({
        ciphertext: wrapResult.wrappedKeyBase64,
        iv: wrapResult.ivBase64
      });

      // Attempt unwrap with wrong mnemonic
      await expect(
        adaptiveUnwrapRecoverySeed({
          seedMnemonic: wrongMnemonic,
          recoveryEncryptedMasterKey: envelopePayload,
          recoverySaltBytes: recoverySalt,
          userId: TEST_USER,
          kdfIterations: TEST_ITERATIONS
        })
      ).rejects.toThrow();

      // Attempt unwrap with wrong user ID (AAD mismatch)
      await expect(
        adaptiveUnwrapRecoverySeed({
          seedMnemonic: mnemonic,
          recoveryEncryptedMasterKey: envelopePayload,
          recoverySaltBytes: recoverySalt,
          userId: 'attacker-user-id',
          kdfIterations: TEST_ITERATIONS
        })
      ).rejects.toThrow();

      wipeBuffer(masterKey);
    });
  });

  describe('4. Memory Hygiene & Concurrency Isolation (LUGX-016 & lockEpoch)', () => {
    it('getMasterKeyRaw returns a detached clone and does not mutate internal key if zeroed', async () => {
      const originalKey = await generateDirectRandomBytes(32);
      sessionKeyStore.setMasterKey(originalKey);

      const cloned = sessionKeyStore.getMasterKeyRaw();
      expect(cloned).not.toBeNull();
      expect(Array.from(cloned!)).toEqual(Array.from(originalKey));

      // Wipe caller clone
      wipeBuffer(cloned!);

      // Internal key must remain intact
      const freshRead = sessionKeyStore.getMasterKeyRaw();
      expect(freshRead).not.toBeNull();
      expect(Array.from(freshRead!)).toEqual(Array.from(originalKey));

      wipeBuffer(originalKey);
      if (freshRead) wipeBuffer(freshRead);
    });

    it('increments lockEpoch on every lock and purge operation', async () => {
      const initialEpoch = sessionKeyStore.getLockEpoch();
      expect(initialEpoch).toBeGreaterThanOrEqual(1);

      sessionKeyStore.lock(false);
      expect(sessionKeyStore.getLockEpoch()).toBe(initialEpoch + 1);

      sessionKeyStore.purgeKeys(false);
      expect(sessionKeyStore.getLockEpoch()).toBe(initialEpoch + 2);
    });

    it('withMasterKey safely aborts execution if vault locks concurrently (remediates LUGX-016 zero-key encryption)', async () => {
      const masterKey = await generateDirectRandomBytes(32);
      sessionKeyStore.setMasterKey(masterKey);

      await expect(
        VaultManager.withMasterKey(async () => {
          // Simulate concurrent lock during async work (e.g. timeout or logout)
          sessionKeyStore.lock(false);
          return 'stolen-data';
        })
      ).rejects.toThrow(/locked/i);

      wipeBuffer(masterKey);
    });

    it('withMasterKey succeeds when vault remains open throughout the operation', async () => {
      const masterKey = await generateDirectRandomBytes(32);
      sessionKeyStore.setMasterKey(masterKey);

      const result = await VaultManager.withMasterKey(async (key, epoch) => {
        expect(epoch).toBe(sessionKeyStore.getLockEpoch());
        expect(key).toBeDefined();
        return 'success';
      });

      expect(result).toBe('success');
      wipeBuffer(masterKey);
    });
  });

  describe('5. Inactivity Auto-Lock Decoupling (LUGX-042)', () => {
    it('getMasterKey does not reset the auto-lock inactivity timer', async () => {
      const masterKey = await generateDirectRandomBytes(32);
      // Set short 60ms timeout for test
      sessionKeyStore.setInactivityTimeout(60);
      sessionKeyStore.setMasterKey(masterKey);

      expect(sessionKeyStore.isUnlocked()).toBe(true);

      // Access key repeatedly over 40ms without touching user activity
      await new Promise(resolve => setTimeout(resolve, 30));
      expect(sessionKeyStore.getMasterKey()).not.toBeNull();

      // Wait for total elapsed time to exceed 60ms (30ms + 40ms = 70ms)
      await new Promise(resolve => setTimeout(resolve, 40));

      // Vault must have locked automatically because programmatic getMasterKey did not call touch()
      expect(sessionKeyStore.isUnlocked()).toBe(false);
      expect(sessionKeyStore.getMasterKey()).toBeNull();

      wipeBuffer(masterKey);
    });
  });

  describe('6. Unicode NFKC Password Normalization (LUGX-133)', () => {
    it('produces identical byte representations for composed and decomposed Unicode sequences', () => {
      const composed = 'Caf\u00e9'; // É as single codepoint
      const decomposed = 'Cafe\u0301'; // E + combining acute accent

      expect(composed).not.toBe(decomposed);
      expect(normalizePassword(composed)).toBe(normalizePassword(decomposed));
    });

    it('derives identical cryptographic keys from different Unicode input forms', async () => {
      const composed = 'VaultPass#2026-\u00e9';
      const decomposed = 'VaultPass#2026-e\u0301';
      const salt = await generateDirectRandomBytes(16);

      const encoder = new TextEncoder();
      const bytes1 = encoder.encode(normalizePassword(composed));
      const bytes2 = encoder.encode(normalizePassword(decomposed));

      const key1 = await cryptoWorkerBridge.deriveKeyRaw(bytes1, salt, 2000, 256);
      const key2 = await cryptoWorkerBridge.deriveKeyRaw(bytes2, salt, 2000, 256);

      expect(Array.from(key1)).toEqual(Array.from(key2));

      wipeBuffer(bytes1);
      wipeBuffer(bytes2);
      wipeBuffer(key1);
      wipeBuffer(key2);
      wipeBuffer(salt);
    });
  });

  describe('7. HKDF-SHA-256 Subkey Derivation', () => {
    it('derives distinct 256-bit subkeys for different document files', async () => {
      const masterKey = await generateDirectRandomBytes(32);

      const docKey1 = await deriveDocumentKey(masterKey, 'file-doc-001');
      const docKey2 = await deriveDocumentKey(masterKey, 'file-doc-002');

      expect(docKey1).toHaveLength(32);
      expect(docKey2).toHaveLength(32);
      expect(Array.from(docKey1)).not.toEqual(Array.from(docKey2));

      wipeBuffer(masterKey);
      wipeBuffer(docKey1);
      wipeBuffer(docKey2);
    });

    it('derives deterministic search index key for a given user', async () => {
      const masterKey = await generateDirectRandomBytes(32);

      const searchKeyA = await deriveSearchIndexKey(masterKey, TEST_USER);
      const searchKeyB = await deriveSearchIndexKey(masterKey, TEST_USER);

      expect(Array.from(searchKeyA)).toEqual(Array.from(searchKeyB));

      wipeBuffer(masterKey);
      wipeBuffer(searchKeyA);
      wipeBuffer(searchKeyB);
    });

    it('computes cryptographic proof of possession', async () => {
      const masterKey = await generateDirectRandomBytes(32);
      const nonce = 'server-challenge-nonce-999';

      const proof1 = await deriveProofOfPossession(masterKey, nonce);
      const proof2 = await deriveProofOfPossession(masterKey, nonce);
      const proof3 = await deriveProofOfPossession(masterKey, 'different-nonce');

      expect(proof1).toHaveLength(64); // 32 bytes hex encoded = 64 chars
      expect(proof1).toBe(proof2);
      expect(proof1).not.toBe(proof3);

      wipeBuffer(masterKey);
    });
  });
});
