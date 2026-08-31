/**
 * Isolated Crypto Web Worker for LUGX Dual-Tier Hybrid Vault
 *
 * Executes heavy cryptographic operations (PBKDF2 600K iterations, AES-GCM-256 with AAD,
 * BIP-39 mnemonic entropy derivation) in an isolated background thread.
 * Enforces non-extractable keys in RAM and defensive multi-layer .fill(0) sanitization.
 */

import {
  CryptoWorkerRequest,
  CryptoWorkerResponse,
  AADIntegrityError,
  InvalidCiphertextOrKeyError,
  CryptoWorkerAction
} from '../sync/types/vault';
import {
  generateMnemonic,
  validateMnemonic,
  mnemonicToSeed
} from '../sync/mnemonic';

/**
 * Defensive buffer wiping helper
 */
export function wipeBuffer(buffer: Uint8Array | null | undefined): void {
  if (buffer && buffer instanceof Uint8Array) {
    try {
      buffer.fill(0);
    } catch {
      // Ignore if buffer is detached or read-only
    }
  }
}

/**
 * Base64 Conversion Helpers (Chunked & URL-Safe Resilient)
 */
export function arrayBufferToBase64(buffer: ArrayBuffer | Uint8Array): string {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(bytes).toString('base64');
  }
  let binary = '';
  const len = bytes.byteLength;
  const CHUNK_SIZE = 8192;
  for (let i = 0; i < len; i += CHUNK_SIZE) {
    const chunk = bytes.subarray(i, Math.min(i + CHUNK_SIZE, len));
    binary += String.fromCharCode.apply(null, chunk as unknown as number[]);
  }
  return btoa(binary);
}

export function base64ToUint8Array(base64: string): Uint8Array {
  if (!base64 || typeof base64 !== 'string') {
    throw new InvalidCiphertextOrKeyError('Empty or invalid base64 string provided');
  }
  try {
    let sanitized = base64.replace(/-/g, '+').replace(/_/g, '/').replace(/\s+/g, '');
    while (sanitized.length % 4 !== 0) {
      sanitized += '=';
    }
    const binary = atob(sanitized);
    const len = binary.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  } catch {
    throw new InvalidCiphertextOrKeyError('Failed to decode malformed base64 envelope data');
  }
}

/**
 * Core Worker Cryptographic Handler Functions
 */

export async function handleDeriveKeyRaw(payload: {
  passwordBytes: Uint8Array;
  saltBytes: Uint8Array;
  iterations: number;
  keyLengthBits?: number;
}): Promise<Uint8Array> {
  const { passwordBytes, saltBytes, iterations, keyLengthBits = 256 } = payload;
  const safePassword = new Uint8Array(passwordBytes);
  const safeSalt = new Uint8Array(saltBytes);

  try {
    const keyMaterial = await crypto.subtle.importKey(
      'raw',
      safePassword as unknown as BufferSource,
      'PBKDF2',
      false,
      ['deriveBits', 'deriveKey']
    );

    const derivedBits = await crypto.subtle.deriveBits(
      {
        name: 'PBKDF2',
        salt: safeSalt as unknown as BufferSource,
        iterations: iterations || 600000,
        hash: 'SHA-256'
      },
      keyMaterial,
      keyLengthBits
    );

    return new Uint8Array(derivedBits);
  } finally {
    wipeBuffer(safePassword);
    wipeBuffer(safeSalt);
  }
}

export async function handleEncryptAESGCM(payload: {
  keyBytes: Uint8Array;
  plaintext: string;
  ivBytes: Uint8Array;
  aad: string;
}): Promise<{ ciphertextBase64: string; ivBase64: string }> {
  const { keyBytes, plaintext, ivBytes, aad } = payload;
  const safeKey = new Uint8Array(keyBytes);
  const safeIv = new Uint8Array(ivBytes);
  const plaintextBytes = new TextEncoder().encode(plaintext);
  const aadBytes = new TextEncoder().encode(aad);

  try {
    const cryptoKey = await crypto.subtle.importKey(
      'raw',
      safeKey as unknown as BufferSource,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt']
    );

    const ciphertextBuffer = await crypto.subtle.encrypt(
      {
        name: 'AES-GCM',
        iv: safeIv as unknown as BufferSource,
        additionalData: aadBytes as unknown as BufferSource,
        tagLength: 128
      },
      cryptoKey,
      plaintextBytes as unknown as BufferSource
    );

    return {
      ciphertextBase64: arrayBufferToBase64(ciphertextBuffer),
      ivBase64: arrayBufferToBase64(safeIv)
    };
  } finally {
    wipeBuffer(safeKey);
    wipeBuffer(safeIv);
    wipeBuffer(plaintextBytes);
    wipeBuffer(aadBytes);
  }
}

export async function handleDecryptAESGCM(payload: {
  keyBytes: Uint8Array;
  ciphertextBase64: string;
  ivBytes: Uint8Array;
  aad: string;
}): Promise<string> {
  const { keyBytes, ciphertextBase64, ivBytes, aad } = payload;
  const safeKey = new Uint8Array(keyBytes);
  const safeIv = new Uint8Array(ivBytes);
  const ciphertextBytes = base64ToUint8Array(ciphertextBase64);
  const aadBytes = new TextEncoder().encode(aad);

  let decryptedBuffer: ArrayBuffer | null = null;
  let decryptedBytes: Uint8Array | null = null;

  try {
    const cryptoKey = await crypto.subtle.importKey(
      'raw',
      safeKey as unknown as BufferSource,
      { name: 'AES-GCM', length: 256 },
      false,
      ['decrypt']
    );

    try {
      decryptedBuffer = await crypto.subtle.decrypt(
        {
          name: 'AES-GCM',
          iv: safeIv as unknown as BufferSource,
          additionalData: aadBytes as unknown as BufferSource,
          tagLength: 128
        },
        cryptoKey,
        ciphertextBytes as unknown as BufferSource
      );
    } catch {
      throw new InvalidCiphertextOrKeyError('AES-GCM decryption failed: authentication tag mismatch or invalid key');
    }

    decryptedBytes = new Uint8Array(decryptedBuffer);
    return new TextDecoder().decode(decryptedBytes);
  } finally {
    wipeBuffer(safeKey);
    wipeBuffer(safeIv);
    wipeBuffer(ciphertextBytes);
    wipeBuffer(aadBytes);
    if (decryptedBytes) {
      wipeBuffer(decryptedBytes);
    }
  }
}

export async function handleWrapKeyRaw(payload: {
  kekBytes: Uint8Array;
  targetKeyBytes: Uint8Array;
  ivBytes: Uint8Array;
  aad: string;
}): Promise<{ wrappedKeyBase64: string; ivBase64: string }> {
  const { kekBytes, targetKeyBytes, ivBytes, aad } = payload;
  const safeKek = new Uint8Array(kekBytes);
  const safeTargetKey = new Uint8Array(targetKeyBytes);
  const safeIv = new Uint8Array(ivBytes);
  const aadBytes = new TextEncoder().encode(aad);

  try {
    const kek = await crypto.subtle.importKey(
      'raw',
      safeKek as unknown as BufferSource,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt']
    );

    const wrappedBuffer = await crypto.subtle.encrypt(
      {
        name: 'AES-GCM',
        iv: safeIv as unknown as BufferSource,
        additionalData: aadBytes as unknown as BufferSource,
        tagLength: 128
      },
      kek,
      safeTargetKey as unknown as BufferSource
    );

    return {
      wrappedKeyBase64: arrayBufferToBase64(wrappedBuffer),
      ivBase64: arrayBufferToBase64(safeIv)
    };
  } finally {
    wipeBuffer(safeKek);
    wipeBuffer(safeTargetKey);
    wipeBuffer(safeIv);
    wipeBuffer(aadBytes);
  }
}

export async function handleUnwrapKeyRaw(payload: {
  kekBytes: Uint8Array;
  wrappedKeyBase64: string;
  ivBytes: Uint8Array;
  aad: string;
}): Promise<Uint8Array> {
  const { kekBytes, wrappedKeyBase64, ivBytes, aad } = payload;
  const safeKek = new Uint8Array(kekBytes);
  const safeIv = new Uint8Array(ivBytes);
  const wrappedBytes = base64ToUint8Array(wrappedKeyBase64);
  const aadBytes = new TextEncoder().encode(aad);

  try {
    const kek = await crypto.subtle.importKey(
      'raw',
      safeKek as unknown as BufferSource,
      { name: 'AES-GCM', length: 256 },
      false,
      ['decrypt']
    );

    let unwrappedBuffer: ArrayBuffer;
    try {
      unwrappedBuffer = await crypto.subtle.decrypt(
        {
          name: 'AES-GCM',
          iv: safeIv as unknown as BufferSource,
          additionalData: aadBytes as unknown as BufferSource,
          tagLength: 128
        },
        kek,
        wrappedBytes as unknown as BufferSource
      );
    } catch (err: unknown) {
      throw new InvalidCiphertextOrKeyError('Master key unwrap failed: authentication tag mismatch or invalid KEK');
    }

    return new Uint8Array(unwrappedBuffer);
  } finally {
    wipeBuffer(safeKek);
    wipeBuffer(safeIv);
    wipeBuffer(wrappedBytes);
    wipeBuffer(aadBytes);
  }
}

/**
 * Dispatcher for all Crypto Worker Actions
 */
export async function executeCryptoWorkerAction(action: CryptoWorkerAction, payload: any): Promise<any> {
  switch (action) {
    case 'DERIVE_KEY_RAW':
      return await handleDeriveKeyRaw(payload);
    case 'ENCRYPT_AES_GCM':
      return await handleEncryptAESGCM(payload);
    case 'DECRYPT_AES_GCM':
      return await handleDecryptAESGCM(payload);
    case 'WRAP_KEY_RAW':
      return await handleWrapKeyRaw(payload);
    case 'UNWRAP_KEY_RAW':
      return await handleUnwrapKeyRaw(payload);
    case 'GENERATE_RANDOM_BYTES': {
      const bytes = new Uint8Array(payload.length);
      crypto.getRandomValues(bytes);
      return bytes;
    }
    case 'GENERATE_MNEMONIC':
      return await generateMnemonic(payload?.entropyLengthBytes || 16);
    case 'VALIDATE_MNEMONIC':
      return await validateMnemonic(payload.mnemonic);
    case 'MNEMONIC_TO_SEED':
      return await mnemonicToSeed(payload.mnemonic, payload.saltBytes, payload.iterations);
    default:
      throw new Error(`Unsupported crypto worker action: ${action}`);
  }
}

/**
 * Web Worker Message Event Listener
 * Active only when running in a Worker Global Scope
 */
if (typeof self !== 'undefined' && typeof (self as any).postMessage === 'function' && typeof window === 'undefined') {
  self.onmessage = async (event: MessageEvent<CryptoWorkerRequest>) => {
    const request = event.data;
    if (!request || !request.id || !request.action) return;

    try {
      const result = await executeCryptoWorkerAction(request.action, request.payload);
      const response: CryptoWorkerResponse = {
        id: request.id,
        success: true,
        result
      };
      (self as any).postMessage(response);
    } catch (error: any) {
      const response: CryptoWorkerResponse = {
        id: request.id,
        success: false,
        error: {
          name: error?.name || 'Error',
          message: error?.message || 'Unknown crypto worker execution failure',
          code: error?.code,
          stack: error?.stack
        }
      };
      (self as any).postMessage(response);
    }
  };
}
