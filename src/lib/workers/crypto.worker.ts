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
  InvalidCiphertextOrKeyError,
  CryptoWorkerAction,
  CryptoWorkerRequestPayloads,
  CryptoWorkerResponsePayloads
} from '../sync/types/vault';
import {
  generateMnemonic,
  validateMnemonic,
  mnemonicToSeed
} from '../sync/mnemonic';
import {
  wipeBuffer,
  arrayBufferToBase64,
  base64ToUint8Array,
  generateDirectRandomBytes
} from '../sync/crypto-utils';

export { wipeBuffer, arrayBufferToBase64, base64ToUint8Array, generateDirectRandomBytes };

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
    } catch (_err: unknown) {
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
export async function executeCryptoWorkerAction<A extends CryptoWorkerAction>(
  action: A,
  payload: CryptoWorkerRequestPayloads[A]
): Promise<CryptoWorkerResponsePayloads[A]> {
  switch (action) {
    case 'DERIVE_KEY_RAW':
      return (await handleDeriveKeyRaw(payload as CryptoWorkerRequestPayloads['DERIVE_KEY_RAW'])) as CryptoWorkerResponsePayloads[A];
    case 'ENCRYPT_AES_GCM':
      return (await handleEncryptAESGCM(payload as CryptoWorkerRequestPayloads['ENCRYPT_AES_GCM'])) as CryptoWorkerResponsePayloads[A];
    case 'DECRYPT_AES_GCM':
      return (await handleDecryptAESGCM(payload as CryptoWorkerRequestPayloads['DECRYPT_AES_GCM'])) as CryptoWorkerResponsePayloads[A];
    case 'WRAP_KEY_RAW':
      return (await handleWrapKeyRaw(payload as CryptoWorkerRequestPayloads['WRAP_KEY_RAW'])) as CryptoWorkerResponsePayloads[A];
    case 'UNWRAP_KEY_RAW':
      return (await handleUnwrapKeyRaw(payload as CryptoWorkerRequestPayloads['UNWRAP_KEY_RAW'])) as CryptoWorkerResponsePayloads[A];
    case 'GENERATE_RANDOM_BYTES': {
      const p = payload as CryptoWorkerRequestPayloads['GENERATE_RANDOM_BYTES'];
      return generateDirectRandomBytes(p.length) as CryptoWorkerResponsePayloads[A];
    }
    case 'GENERATE_MNEMONIC': {
      const p = payload as CryptoWorkerRequestPayloads['GENERATE_MNEMONIC'];
      return (await generateMnemonic(p?.entropyLengthBytes || 16)) as CryptoWorkerResponsePayloads[A];
    }
    case 'VALIDATE_MNEMONIC': {
      const p = payload as CryptoWorkerRequestPayloads['VALIDATE_MNEMONIC'];
      return (await validateMnemonic(p.mnemonic)) as CryptoWorkerResponsePayloads[A];
    }
    case 'MNEMONIC_TO_SEED': {
      const p = payload as CryptoWorkerRequestPayloads['MNEMONIC_TO_SEED'];
      return (await mnemonicToSeed(p.mnemonic, p.saltBytes, p.iterations)) as CryptoWorkerResponsePayloads[A];
    }
    default:
      throw new Error(`Unsupported crypto worker action: ${action}`);
  }
}

interface WorkerScope {
  postMessage(message: unknown): void;
}

/**
 * Web Worker Message Event Listener
 * Active only when running in a Worker Global Scope
 */
const activeWorkerScope = (typeof self !== 'undefined' && typeof window === 'undefined' && 'postMessage' in self)
  ? (self as unknown as WorkerScope)
  : null;

if (activeWorkerScope && typeof activeWorkerScope.postMessage === 'function') {
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
      activeWorkerScope.postMessage(response);
    } catch (error: unknown) {
      const maybeErr = error as { name?: string; message?: string; code?: string; stack?: string } | null;
      const response: CryptoWorkerResponse = {
        id: request.id,
        success: false,
        error: {
          name: maybeErr?.name || 'Error',
          message: maybeErr?.message || 'Unknown crypto worker execution failure',
          code: maybeErr?.code,
          stack: maybeErr?.stack
        }
      };
      activeWorkerScope.postMessage(response);
    }
  };
}
