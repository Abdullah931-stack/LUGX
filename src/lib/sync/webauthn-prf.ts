/**
 * WebAuthn PRF (Pseudo-Random Function) Hardware Key Derivation
 *
 * Implements hardware-bound key wrapping for Zero-Knowledge Vault
 * using the W3C Web Authentication Level 3 PRF extension (FIDO 2.1).
 * Ties the Master Key to platform authenticators (Windows Hello TPM 2.0,
 * Apple Touch ID / Face ID Secure Enclave, Android Titan M2 / StrongBox)
 * to provide complete physical immunity against offline IndexedDB extraction.
 */

import { DeviceTrustEnvelope } from './types/vault';
import { arrayBufferToBase64, base64ToUint8Array, wipeBuffer } from './crypto-utils';
import { cryptoWorkerBridge } from './crypto-worker-bridge';

/**
 * Derives a 256-bit AES-GCM Key Encryption Key (KEK) from raw PRF output and salt via HKDF-SHA-256
 */
export async function derivePrfKek(prfOutput: Uint8Array, salt: Uint8Array): Promise<Uint8Array> {
  const subtle = typeof window !== 'undefined' && window.crypto?.subtle
    ? window.crypto.subtle
    : (globalThis as any).crypto?.subtle;

  if (!subtle) {
    throw new Error('WebCrypto SubtleCrypto is not available in the current environment');
  }

  const hkdfKey = await subtle.importKey(
    'raw',
    prfOutput,
    'HKDF',
    false,
    ['deriveBits']
  );

  const derivedKekBuffer = await subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: salt as unknown as BufferSource,
      info: new TextEncoder().encode('lugx-vault-webauthn-prf-v1'),
    },
    hkdfKey,
    256
  );

  return new Uint8Array(derivedKekBuffer);
}

export interface WebAuthnSupportStatus {
  supported: boolean;
  reason?: 'not_secure_context' | 'no_webauthn_api' | 'platform_not_available' | 'prf_unsupported' | 'unknown_error';
  message?: string;
}

/**
 * Performs a comprehensive diagnostic check on WebAuthn PRF capabilities
 */
export async function checkWebAuthnSupportStatus(): Promise<WebAuthnSupportStatus> {
  const root = typeof window !== 'undefined' ? window : (globalThis as any);

  // 1. Check secure context requirement (WebAuthn requires HTTPS or localhost)
  if (typeof window !== 'undefined' && !window.isSecureContext) {
    return {
      supported: false,
      reason: 'not_secure_context',
      message: 'WebAuthn يتطلب العمل عبر localhost أو اتصال آمن HTTPS.',
    };
  }

  // 2. Check PublicKeyCredential API presence
  if (!root || !root.PublicKeyCredential) {
    return {
      supported: false,
      reason: 'no_webauthn_api',
      message: 'المتصفح الحالي لا يدعم واجهة برمجة WebAuthn.',
    };
  }

  if (typeof root.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable !== 'function') {
    return {
      supported: false,
      reason: 'platform_not_available',
      message: 'المتصفح لا يدعم المصادقة عبر منصة التشغيل (Platform Authenticator).',
    };
  }

  try {
    // 3. Check if Windows Hello / Touch ID is configured and available in OS
    const isPlatformAvailable = await root.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
    if (!isPlatformAvailable) {
      return {
        supported: false,
        reason: 'platform_not_available',
        message: 'Windows Hello غير مفعل في إعدادات النظام (يرجى إعداد PIN أو بصمة في Windows Settings).',
      };
    }

    // 4. Check client capabilities for PRF extension (W3C Level 3 standard uses "extension:prf")
    if (typeof root.PublicKeyCredential.getClientCapabilities === 'function') {
      try {
        const capabilities = await root.PublicKeyCredential.getClientCapabilities();
        const prfSupported = capabilities?.['extension:prf'] ?? capabilities?.['prf'];
        if (prfSupported === false) {
          return {
            supported: false,
            reason: 'prf_unsupported',
            message: 'المتصفح أو النظام يدعم Windows Hello لكنه يفتقر لامتداد التشفير العتادي PRF.',
          };
        }
      } catch {
        // Fall back to platform authenticator availability if capabilities query throws
      }
    }

    return { supported: true };
  } catch (err: any) {
    return {
      supported: false,
      reason: 'unknown_error',
      message: err?.message || 'حدث خطأ أثناء استعلام عتاد المصادقة.',
    };
  }
}

/**
 * Checks if the browser and host platform support WebAuthn PRF with a platform authenticator
 */
export async function isWebAuthnPrfSupported(): Promise<boolean> {
  const status = await checkWebAuthnSupportStatus();
  return status.supported;
}

/**
 * Registers a platform authenticator with the PRF extension and wraps the Master Key
 */
export async function createWebAuthnPrfEnvelope(
  masterKeyBytes: Uint8Array,
  userId: string,
  userEmail: string,
  deviceTrustEpoch = 1
): Promise<DeviceTrustEnvelope> {
  const root = typeof window !== 'undefined' ? window : (globalThis as any);
  const credentials = root?.navigator?.credentials;
  const cryptoObj = root?.crypto || (globalThis as any).crypto;

  if (!credentials || !cryptoObj) {
    throw new Error('WebAuthn is not supported in this environment');
  }

  // 1. Generate challenge and 32-byte CSPRNG PRF salt
  const challenge = cryptoObj.getRandomValues(new Uint8Array(32));
  const prfSalt = cryptoObj.getRandomValues(new Uint8Array(32));

  const rpId = root?.location?.hostname || undefined;
  const userHandle = new TextEncoder().encode(userId);

  // 2. Request credential creation with PRF extension
  const credential = (await credentials.create({
    publicKey: {
      challenge,
      rp: {
        name: 'LUGX Secure Workspace',
        id: rpId,
      },
      user: {
        id: userHandle,
        name: userEmail || userId,
        displayName: userEmail ? userEmail.split('@')[0] : 'LUGX User',
      },
      pubKeyCredParams: [
        { alg: -7, type: 'public-key' },   // ES256
        { alg: -257, type: 'public-key' }, // RS256
      ],
      authenticatorSelection: {
        authenticatorAttachment: 'platform',
        userVerification: 'required',
        residentKey: 'preferred',
      },
      timeout: 60000,
      extensions: {
        prf: {
          eval: {
            first: prfSalt.buffer,
          },
        },
      } as any,
    },
  })) as PublicKeyCredential | null;

  if (!credential) {
    throw new Error('WebAuthn credential creation was cancelled or failed');
  }

  const credentialId = arrayBufferToBase64(new Uint8Array(credential.rawId));
  const clientExtResults: any = credential.getClientExtensionResults?.() || {};

  let derivedRawBytes: Uint8Array | null = null;

  // Check if PRF was evaluated during creation
  if (clientExtResults.prf?.results?.first) {
    derivedRawBytes = new Uint8Array(clientExtResults.prf.results.first);
  } else {
    // If not evaluated directly in create, evaluate via get()
    const assertion = (await credentials.get({
      publicKey: {
        challenge: cryptoObj.getRandomValues(new Uint8Array(32)),
        allowCredentials: [
          {
            id: credential.rawId,
            type: 'public-key',
          },
        ],
        userVerification: 'required',
        timeout: 60000,
        extensions: {
          prf: {
            eval: {
              first: prfSalt.buffer,
            },
          },
        } as any,
      },
    })) as PublicKeyCredential | null;

    if (!assertion) {
      throw new Error('Failed to evaluate PRF on created authenticator');
    }

    const assertExtResults: any = assertion.getClientExtensionResults?.() || {};
    if (!assertExtResults.prf?.results?.first) {
      throw new Error('Platform authenticator did not return PRF evaluated key material');
    }
    derivedRawBytes = new Uint8Array(assertExtResults.prf.results.first);
  }

  // 3. Derive wrapping key via HKDF
  const kek = await derivePrfKek(derivedRawBytes, prfSalt);

  // 4. Wrap Master Key with AES-GCM-256
  const iv = await cryptoWorkerBridge.generateRandomBytes(12);
  const aad = `trusted_device:${userId}:${deviceTrustEpoch}`;

  try {
    const wrapped = await cryptoWorkerBridge.wrapKeyRaw(kek, masterKeyBytes, iv, aad);
    const now = Date.now();

    return {
      version: 1,
      algorithm: 'AES-GCM-256',
      trustType: 'webauthn_prf',
      encryptedMasterKey: wrapped.wrappedKeyBase64,
      salt: arrayBufferToBase64(prfSalt),
      iv: wrapped.ivBase64,
      credentialId,
      deviceTrustEpoch,
      trustedAt: now,
      expiresAt: now + 30 * 24 * 60 * 60 * 1000, // 30 days validity
      failedAttempts: 0,
    };
  } finally {
    wipeBuffer(derivedRawBytes);
    wipeBuffer(kek);
    wipeBuffer(iv);
  }
}

/**
 * Unwraps the Master Key using hardware PRF evaluation via navigator.credentials.get
 */
export async function unwrapMasterKeyWithWebAuthnPrf(
  envelope: DeviceTrustEnvelope,
  userId: string
): Promise<Uint8Array> {
  if (Date.now() > envelope.expiresAt) {
    throw new Error('Trusted device hardware envelope has expired after 30 days');
  }

  if (!envelope.credentialId) {
    throw new Error('Missing credentialId in hardware trust envelope');
  }

  const root = typeof window !== 'undefined' ? window : (globalThis as any);
  const credentials = root?.navigator?.credentials;
  const cryptoObj = root?.crypto || (globalThis as any).crypto;

  if (!credentials || !cryptoObj) {
    throw new Error('WebAuthn is not supported in this environment');
  }

  const prfSalt = base64ToUint8Array(envelope.salt);
  const credIdBytes = base64ToUint8Array(envelope.credentialId);

  try {
    const assertion = (await credentials.get({
      publicKey: {
        challenge: cryptoObj.getRandomValues(new Uint8Array(32)),
        allowCredentials: [
          {
            id: credIdBytes.buffer as ArrayBuffer,
            type: 'public-key',
          },
        ],
        userVerification: 'required',
        timeout: 60000,
        extensions: {
          prf: {
            eval: {
              first: prfSalt.buffer as ArrayBuffer,
            },
          },
        } as any,
      },
    })) as PublicKeyCredential | null;

    if (!assertion) {
      throw new Error('Biometric / Hardware authentication cancelled');
    }

    const extResults: any = assertion.getClientExtensionResults?.() || {};
    if (!extResults.prf?.results?.first) {
      throw new Error('Platform authenticator did not return PRF evaluation result');
    }

    const prfOutput = new Uint8Array(extResults.prf.results.first);

    // Derive KEK via HKDF
    const kek = await derivePrfKek(prfOutput, prfSalt);
    const iv = base64ToUint8Array(envelope.iv);
    const aad = `trusted_device:${userId}:${envelope.deviceTrustEpoch || 1}`;

    try {
      return await cryptoWorkerBridge.unwrapKeyRaw(kek, envelope.encryptedMasterKey, iv, aad);
    } finally {
      wipeBuffer(prfOutput);
      wipeBuffer(kek);
      wipeBuffer(iv);
    }
  } finally {
    wipeBuffer(prfSalt);
    wipeBuffer(credIdBytes);
  }
}
