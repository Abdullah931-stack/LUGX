/**
 * Cryptographic Key Derivation & Unicode Normalization Module
 *
 * Provides:
 * 1. NFKC Unicode password normalization (remediates LUGX-133).
 * 2. High-performance, resource-efficient subkey derivation using HKDF-SHA-256
 *    for document keys, search indexing, and cryptographic proof of possession.
 * 3. Heavy PBKDF2 remains restricted to initial vault unlock / master key unwrapping.
 */

import { wipeBuffer } from '../sync/crypto-utils';

/**
 * Normalizes password strings to Unicode Normalization Form KC (NFKC).
 * Eliminates character composition/decomposition divergence across operating systems
 * and input methods (LUGX-133).
 */
export function normalizePassword(password: string): string {
  if (typeof password !== 'string') {
    throw new TypeError('Password must be a string');
  }
  return password.normalize('NFKC');
}

/**
 * Derives a cryptographic subkey from a master key using HKDF-SHA-256 (RFC 5869).
 * Avoids CPU-heavy PBKDF2 for per-document or per-index subkey operations.
 */
export async function deriveSubkeyHKDF(
  masterKeyBytes: Uint8Array,
  info: string,
  salt?: Uint8Array,
  lengthBits = 256
): Promise<Uint8Array> {
  if (!masterKeyBytes || masterKeyBytes.length < 16) {
    throw new Error('Master key must be at least 16 bytes for HKDF subkey derivation');
  }

  const cryptoEngine = typeof crypto !== 'undefined' ? crypto : globalThis.crypto;
  if (!cryptoEngine?.subtle) {
    throw new Error('WebCrypto subtle environment is unavailable');
  }

  const encoder = new TextEncoder();
  const infoBytes = encoder.encode(info);
  // Default to 32 bytes of zeroes as HKDF salt if not provided (per RFC 5869)
  const effectiveSalt = salt ?? new Uint8Array(32);

  // Import master key as raw HKDF key material
  const baseKey = await cryptoEngine.subtle.importKey(
    'raw',
    masterKeyBytes as unknown as BufferSource,
    { name: 'HKDF' },
    false,
    ['deriveBits']
  );

  const derivedBits = await cryptoEngine.subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: effectiveSalt as unknown as BufferSource,
      info: infoBytes as unknown as BufferSource
    },
    baseKey,
    lengthBits
  );

  return new Uint8Array(derivedBits);
}

/**
 * Derives an isolated, per-document 256-bit encryption subkey
 * Context: lugx:v1:doc-key:<fileId>
 */
export async function deriveDocumentKey(
  masterKeyBytes: Uint8Array,
  fileId: string
): Promise<Uint8Array> {
  if (!fileId?.trim()) {
    throw new Error('fileId is required to derive document subkey');
  }
  return deriveSubkeyHKDF(masterKeyBytes, `lugx:v1:doc-key:${fileId.trim()}`);
}

/**
 * Derives an isolated subkey for encrypted client-side search index indexing
 * Context: lugx:v1:search-key:<userId>
 */
export async function deriveSearchIndexKey(
  masterKeyBytes: Uint8Array,
  userId: string
): Promise<Uint8Array> {
  if (!userId?.trim()) {
    throw new Error('userId is required to derive search index subkey');
  }
  return deriveSubkeyHKDF(masterKeyBytes, `lugx:v1:search-key:${userId.trim()}`);
}

/**
 * Computes a cryptographic proof-of-possession tag from the master key and a server nonce
 * using HKDF-SHA-256 (remediates LUGX-063).
 */
export async function deriveProofOfPossession(
  masterKeyBytes: Uint8Array,
  nonce: string
): Promise<string> {
  if (!nonce?.trim()) {
    throw new Error('Nonce is required to derive proof of possession');
  }
  const proofBytes = await deriveSubkeyHKDF(
    masterKeyBytes,
    `lugx:v1:proof-of-possession:${nonce.trim()}`
  );
  try {
    return Array.from(proofBytes)
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
  } finally {
    wipeBuffer(proofBytes);
  }
}
