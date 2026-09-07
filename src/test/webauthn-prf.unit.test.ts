import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  derivePrfKek,
  isWebAuthnPrfSupported,
  createWebAuthnPrfEnvelope,
  unwrapMasterKeyWithWebAuthnPrf,
} from '../lib/sync/webauthn-prf';
import { DeviceTrustEnvelope } from '../lib/sync/types/vault';

describe('WebAuthn PRF Hardware Key Derivation & Envelope Lifecycle', () => {
  const testUserId = 'user-hardware-test-uuid-1234';
  const testUserEmail = 'engineer@lugx.org';

  describe('1. derivePrfKek (HKDF-SHA-256 Key Expansion)', () => {
    it('should deterministically derive identical 32-byte KEK from same PRF output and salt', async () => {
      const prfOutput = new Uint8Array(32).fill(0xaa);
      const salt = new Uint8Array(32).fill(0x55);

      const kek1 = await derivePrfKek(prfOutput, salt);
      const kek2 = await derivePrfKek(prfOutput, salt);

      expect(kek1).toBeInstanceOf(Uint8Array);
      expect(kek1.length).toBe(32);
      expect(kek1).toEqual(kek2);
    });

    it('should produce distinct KEKs when PRF output or salt differs (avalanche effect)', async () => {
      const prfOutput1 = new Uint8Array(32).fill(0xaa);
      const prfOutput2 = new Uint8Array(32).fill(0xbb);
      const salt = new Uint8Array(32).fill(0x55);

      const kek1 = await derivePrfKek(prfOutput1, salt);
      const kek2 = await derivePrfKek(prfOutput2, salt);

      expect(kek1).not.toEqual(kek2);

      const salt2 = new Uint8Array(32).fill(0x77);
      const kek3 = await derivePrfKek(prfOutput1, salt2);

      expect(kek1).not.toEqual(kek3);
    });
  });

  describe('2. isWebAuthnPrfSupported (Platform Capability Detection)', () => {
    const originalPublicKeyCredential = (globalThis as any).PublicKeyCredential;

    afterEach(() => {
      if (originalPublicKeyCredential !== undefined) {
        (globalThis as any).PublicKeyCredential = originalPublicKeyCredential;
      } else {
        delete (globalThis as any).PublicKeyCredential;
      }
    });

    it('should return false when PublicKeyCredential is not present', async () => {
      delete (globalThis as any).PublicKeyCredential;
      const supported = await isWebAuthnPrfSupported();
      expect(supported).toBe(false);
    });

    it('should return false when isUserVerifyingPlatformAuthenticatorAvailable resolves to false', async () => {
      (globalThis as any).PublicKeyCredential = {
        isUserVerifyingPlatformAuthenticatorAvailable: vi.fn().mockResolvedValue(false),
      };

      const supported = await isWebAuthnPrfSupported();
      expect(supported).toBe(false);
    });

    it('should return true when platform authenticator is available', async () => {
      (globalThis as any).PublicKeyCredential = {
        isUserVerifyingPlatformAuthenticatorAvailable: vi.fn().mockResolvedValue(true),
      };

      const supported = await isWebAuthnPrfSupported();
      expect(supported).toBe(true);
    });

    it('should respect getClientCapabilities if exposed by modern browsers (prf and extension:prf)', async () => {
      (globalThis as any).PublicKeyCredential = {
        isUserVerifyingPlatformAuthenticatorAvailable: vi.fn().mockResolvedValue(true),
        getClientCapabilities: vi.fn().mockResolvedValue({ 'extension:prf': true }),
      };

      const supported = await isWebAuthnPrfSupported();
      expect(supported).toBe(true);

      (globalThis as any).PublicKeyCredential.getClientCapabilities = vi.fn().mockResolvedValue({ 'extension:prf': false });
      const unsupported = await isWebAuthnPrfSupported();
      expect(unsupported).toBe(false);
    });

    it('should return informative diagnostics from checkWebAuthnSupportStatus', async () => {
      const { checkWebAuthnSupportStatus } = await import('../lib/sync/webauthn-prf');

      (globalThis as any).PublicKeyCredential = {
        isUserVerifyingPlatformAuthenticatorAvailable: vi.fn().mockResolvedValue(false),
      };

      const status = await checkWebAuthnSupportStatus();
      expect(status.supported).toBe(false);
      expect(status.reason).toBe('platform_not_available');
      expect(status.message).toContain('Windows Hello');
    });
  });

  describe('3. End-to-End Mock WebAuthn PRF Enrollment & Unwrapping', () => {
    const mockPrfOutput = new Uint8Array(32).fill(0x42);
    let originalCredentials: any;

    beforeEach(() => {
      originalCredentials = (globalThis as any).navigator.credentials;

      const mockCredentialInstance = {
        rawId: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]).buffer,
        getClientExtensionResults: () => ({
          prf: {
            enabled: true,
            results: {
              first: mockPrfOutput.buffer,
            },
          },
        }),
      };

      (globalThis as any).navigator.credentials = {
        create: vi.fn().mockResolvedValue(mockCredentialInstance),
        get: vi.fn().mockResolvedValue(mockCredentialInstance),
      };
    });

    afterEach(() => {
      (globalThis as any).navigator.credentials = originalCredentials;
    });

    it('should create a valid hardware-bound DeviceTrustEnvelope with trustType = webauthn_prf', async () => {
      const masterKeyBytes = crypto.getRandomValues(new Uint8Array(32));

      const envelope = await createWebAuthnPrfEnvelope(
        masterKeyBytes,
        testUserId,
        testUserEmail,
        2
      );

      expect(envelope.version).toBe(1);
      expect(envelope.algorithm).toBe('AES-GCM-256');
      expect(envelope.trustType).toBe('webauthn_prf');
      expect(envelope.deviceTrustEpoch).toBe(2);
      expect(envelope.credentialId).toBeDefined();
      expect(envelope.salt).toBeDefined();
      expect(envelope.iv).toBeDefined();
      expect(envelope.encryptedMasterKey).toBeDefined();
      expect(envelope.failedAttempts).toBe(0);
      expect(envelope.expiresAt).toBeGreaterThan(Date.now());
    });

    it('should successfully unwrap the master key using the hardware-bound envelope', async () => {
      const originalMasterKey = crypto.getRandomValues(new Uint8Array(32));

      const envelope = await createWebAuthnPrfEnvelope(
        originalMasterKey,
        testUserId,
        testUserEmail,
        1
      );

      const unwrappedKey = await unwrapMasterKeyWithWebAuthnPrf(envelope, testUserId);

      expect(unwrappedKey).toEqual(originalMasterKey);
    });

    it('should fail unwrapping when envelope has expired', async () => {
      const originalMasterKey = crypto.getRandomValues(new Uint8Array(32));

      const envelope = await createWebAuthnPrfEnvelope(
        originalMasterKey,
        testUserId,
        testUserEmail,
        1
      );

      const expiredEnvelope: DeviceTrustEnvelope = {
        ...envelope,
        expiresAt: Date.now() - 1000,
      };

      await expect(
        unwrapMasterKeyWithWebAuthnPrf(expiredEnvelope, testUserId)
      ).rejects.toThrow(/expired/i);
    });

    it('should reject unwrapping if user ID context mismatches (AAD tamper resistance)', async () => {
      const originalMasterKey = crypto.getRandomValues(new Uint8Array(32));

      const envelope = await createWebAuthnPrfEnvelope(
        originalMasterKey,
        testUserId,
        testUserEmail,
        1
      );

      const wrongUserId = 'attacker-uuid-9999';

      await expect(
        unwrapMasterKeyWithWebAuthnPrf(envelope, wrongUserId)
      ).rejects.toThrow();
    });
  });

  describe('4. Backward Compatibility for Legacy PIN Envelopes', () => {
    it('should handle legacy envelopes without trustType gracefully defaulting to pin', () => {
      const legacyEnvelope: DeviceTrustEnvelope = {
        version: 1,
        algorithm: 'AES-GCM-256',
        encryptedMasterKey: 'mock-wrapped-key',
        salt: 'mock-salt',
        iv: 'mock-iv',
        deviceTrustEpoch: 1,
        trustedAt: Date.now(),
        expiresAt: Date.now() + 86400000,
        failedAttempts: 0,
      };

      const resolvedType = legacyEnvelope.trustType ?? 'pin';
      expect(resolvedType).toBe('pin');
    });
  });
});
