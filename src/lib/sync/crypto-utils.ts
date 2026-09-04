/**
 * Cryptographic Utility Functions & Buffer Sanitization
 *
 * Provides shared, zero-dependency helpers for defensive memory wiping,
 * base64 encoding/decoding, and direct CSPRNG random byte generation.
 * Decouples utility logic from Worker and Bridge instances to prevent circular dependencies.
 */

import { InvalidCiphertextOrKeyError } from './types/vault';

/**
 * Defensive buffer wiping helper (.fill(0))
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
 * Maximum byte length allowed per single crypto.getRandomValues call according to W3C Web Cryptography API.
 * Any request exceeding this limit triggers QuotaExceededError unless chunked.
 */
export const MAX_RANDOM_BYTES_CHUNK = 65536;

/**
 * Direct Synchronous CSPRNG Byte Generator
 * Uses hardware/OS cryptographically secure random values across all JS environments
 * (Window, WebWorker, Node.js globalThis) without thread context switching or IPC timeouts.
 * Automatically chunks requests > 65,536 bytes to strictly adhere to W3C quota limitations.
 */
export function generateDirectRandomBytes(length: number): Uint8Array {
  if (length < 0) {
    throw new RangeError('Random byte length must be non-negative');
  }
  if (length === 0) {
    return new Uint8Array(0);
  }

  const bytes = new Uint8Array(length);
  const cryptoObj =
    typeof globalThis !== 'undefined' && globalThis.crypto
      ? globalThis.crypto
      : typeof window !== 'undefined'
      ? window.crypto
      : null;

  if (!cryptoObj || typeof cryptoObj.getRandomValues !== 'function') {
    throw new Error('Cryptographically secure PRNG (crypto.getRandomValues) is unavailable in current runtime');
  }

  // W3C Chunked Generation (length <= 65536 per slice)
  for (let offset = 0; offset < length; offset += MAX_RANDOM_BYTES_CHUNK) {
    const chunkLength = Math.min(MAX_RANDOM_BYTES_CHUNK, length - offset);
    const chunk = bytes.subarray(offset, offset + chunkLength);
    cryptoObj.getRandomValues(chunk);
  }

  return bytes;
}

/**
 * Checks if Web Crypto Subtle API is available in the current execution context.
 * Returns false in non-secure contexts (e.g. HTTP over LAN IP like 192.168.x.x) or stripped environments.
 */
export function isCryptoSubtleAvailable(): boolean {
  const cryptoObj =
    typeof globalThis !== 'undefined' && globalThis.crypto
      ? globalThis.crypto
      : typeof window !== 'undefined'
      ? window.crypto
      : null;

  return !!(cryptoObj && cryptoObj.subtle && typeof cryptoObj.subtle.encrypt === 'function');
}

/**
 * Validates runtime environment and throws informative error if Web Crypto Subtle is missing
 * due to non-secure context (HTTP access across LAN IP).
 */
export function assertSecureCryptoContext(): void {
  if (!isCryptoSubtleAvailable()) {
    const isBrowser = typeof window !== 'undefined';
    const isNonLocalHttp =
      isBrowser &&
      window.location &&
      window.location.protocol === 'http:' &&
      window.location.hostname !== 'localhost' &&
      window.location.hostname !== '127.0.0.1';

    if (isNonLocalHttp) {
      throw new Error(
        `Web Crypto Subtle is disabled because this page is loaded in an Insecure Context (${window.location.origin}). ` +
          'WebCrypto AES-GCM and key derivation require HTTPS or http://localhost.'
      );
    }

    throw new Error('Web Crypto Subtle API is not supported or unavailable in the current runtime environment.');
  }
}
