/**
 * BIP-39 Mnemonic Seed Generator & Validator for LUGX Zero-Knowledge Vault
 *
 * Implements 128-bit entropy -> 12-word mnemonic derivation with 4-bit SHA-256 checksum,
 * full wordlist validation, seed derivation, and multi-layer defensive RAM sanitization (.fill(0)).
 */

import { wipeBuffer } from './crypto-utils';
import {
  BIP39_STANDARD_WORDLIST,
  BIP39_STANDARD_WORD_MAP
} from '../crypto/bip39-wordlist';

/**
 * Standard BIP-39 English Wordlist (2048 words)
 */
export const BIP39_WORDLIST: readonly string[] = BIP39_STANDARD_WORDLIST;

// Fast lookup map for word -> index validation
const WORD_INDEX_MAP = BIP39_STANDARD_WORD_MAP;

/**
 * Generates a standard BIP-39 12-word recovery mnemonic from 128-bit CSPRNG entropy.
 * Defensively cleans up intermediate entropy buffers with .fill(0).
 */
export async function generateMnemonic(entropyLengthBytes = 16): Promise<string> {
  if (entropyLengthBytes !== 16) {
    throw new Error('LUGX recovery seeds strictly require 128-bit (16 bytes) entropy for 12 words');
  }

  const entropy = new Uint8Array(entropyLengthBytes);
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    crypto.getRandomValues(entropy);
  } else {
    throw new Error('CSPRNG crypto environment unavailable for mnemonic generation');
  }

  try {
    return await entropyToMnemonic(entropy);
  } finally {
    wipeBuffer(entropy);
  }
}

/**
 * Converts 16-byte (128-bit) entropy to a 12-word BIP-39 mnemonic string with a 4-bit SHA-256 checksum.
 */
export async function entropyToMnemonic(entropy: Uint8Array): Promise<string> {
  if (entropy.length !== 16) {
    throw new Error('Entropy length must be exactly 16 bytes for a 12-word mnemonic');
  }

  // Calculate SHA-256 checksum of the entropy
  const hashBuffer = await crypto.subtle.digest('SHA-256', entropy as unknown as BufferSource);
  const hashBytes = new Uint8Array(hashBuffer);

  try {
    // 128 bits entropy + 4 bits checksum = 132 bits total (12 words * 11 bits)
    const bits: number[] = [];

    // Convert entropy bytes to bit array
    for (let i = 0; i < entropy.length; i++) {
      for (let j = 7; j >= 0; j--) {
        bits.push((entropy[i] >> j) & 1);
      }
    }

    // Add first 4 bits of the hash as checksum
    for (let j = 7; j >= 4; j--) {
      bits.push((hashBytes[0] >> j) & 1);
    }

    // Slice into 12 chunks of 11 bits
    const words: string[] = [];
    for (let i = 0; i < 12; i++) {
      let wordIndex = 0;
      for (let j = 0; j < 11; j++) {
        wordIndex = (wordIndex << 1) | bits[i * 11 + j];
      }
      words.push(BIP39_WORDLIST[wordIndex]);
    }

    return words.join(' ');
  } finally {
    wipeBuffer(hashBytes);
  }
}

export interface MnemonicValidationResult {
  readonly isValid: boolean;
  readonly error?: string;
  readonly invalidWords?: string[];
}

/**
 * Validates a 12-word BIP-39 mnemonic string:
 * 1. Checks word count (exactly 12 words)
 * 2. Checks word existence in the BIP-39 wordlist
 * 3. Verifies the 4-bit SHA-256 checksum against reconstituted entropy
 */
export async function validateMnemonic(mnemonic: string): Promise<MnemonicValidationResult> {
  if (!mnemonic || typeof mnemonic !== 'string') {
    return { isValid: false, error: 'Mnemonic phrase cannot be empty' };
  }

  const words = mnemonic.trim().toLowerCase().split(/\s+/);
  if (words.length !== 12) {
    return {
      isValid: false,
      error: `Invalid word count: expected 12 words, received ${words.length}`
    };
  }

  const invalidWords: string[] = [];
  for (const word of words) {
    if (!WORD_INDEX_MAP.has(word)) {
      invalidWords.push(word);
    }
  }

  if (invalidWords.length > 0) {
    return {
      isValid: false,
      error: `Invalid words detected not in BIP-39 dictionary: ${invalidWords.join(', ')}`,
      invalidWords
    };
  }

  // Reconstitute bits from word indices
  const bits: number[] = [];
  for (const word of words) {
    const index = WORD_INDEX_MAP.get(word)!;
    for (let j = 10; j >= 0; j--) {
      bits.push((index >> j) & 1);
    }
  }

  // Split into 128-bit entropy and 4-bit checksum
  const entropyBytes = new Uint8Array(16);
  for (let i = 0; i < 16; i++) {
    let byte = 0;
    for (let j = 0; j < 8; j++) {
      byte = (byte << 1) | bits[i * 8 + j];
    }
    entropyBytes[i] = byte;
  }

  const expectedChecksumBits = bits.slice(128, 132);

  try {
    const hashBuffer = await crypto.subtle.digest('SHA-256', entropyBytes as unknown as BufferSource);
    const hashBytes = new Uint8Array(hashBuffer);

    try {
      const calculatedChecksumBits: number[] = [];
      for (let j = 7; j >= 4; j--) {
        calculatedChecksumBits.push((hashBytes[0] >> j) & 1);
      }

      for (let i = 0; i < 4; i++) {
        if (expectedChecksumBits[i] !== calculatedChecksumBits[i]) {
          return {
            isValid: false,
            error: 'Mnemonic checksum verification failed: words may be ordered incorrectly or corrupted'
          };
        }
      }

      return { isValid: true };
    } finally {
      wipeBuffer(hashBytes);
    }
  } finally {
    wipeBuffer(entropyBytes);
  }
}

/**
 * Converts a valid 12-word mnemonic back to its raw 16-byte entropy with checksum validation.
 * Caller MUST wipe the returned entropy buffer when finished.
 */
export async function mnemonicToEntropy(mnemonic: string): Promise<Uint8Array> {
  const validation = await validateMnemonic(mnemonic);
  if (!validation.isValid) {
    throw new Error(validation.error || 'Invalid mnemonic phrase');
  }

  const words = mnemonic.trim().toLowerCase().split(/\s+/);
  const bits: number[] = [];
  for (const word of words) {
    const index = WORD_INDEX_MAP.get(word)!;
    for (let j = 10; j >= 0; j--) {
      bits.push((index >> j) & 1);
    }
  }

  const entropyBytes = new Uint8Array(16);
  for (let i = 0; i < 16; i++) {
    let byte = 0;
    for (let j = 0; j < 8; j++) {
      byte = (byte << 1) | bits[i * 8 + j];
    }
    entropyBytes[i] = byte;
  }

  return entropyBytes;
}

/**
 * Derives a cryptographic seed from a 12-word mnemonic using PBKDF2-HMAC-SHA256 with defensive sanitization.
 */
export async function mnemonicToSeed(
  mnemonic: string,
  saltBytes?: Uint8Array,
  iterations = 600000
): Promise<Uint8Array> {
  const entropy = await mnemonicToEntropy(mnemonic);
  const salt = saltBytes ? new Uint8Array(saltBytes) : new Uint8Array(16);

  try {
    if (!saltBytes && typeof crypto !== 'undefined' && crypto.getRandomValues) {
      crypto.getRandomValues(salt);
    }

    const keyMaterial = await crypto.subtle.importKey(
      'raw',
      entropy as unknown as BufferSource,
      'PBKDF2',
      false,
      ['deriveBits', 'deriveKey']
    );

    const derivedBits = await crypto.subtle.deriveBits(
      {
        name: 'PBKDF2',
        salt: salt as unknown as BufferSource,
        iterations,
        hash: 'SHA-256'
      },
      keyMaterial,
      256
    );

    return new Uint8Array(derivedBits);
  } finally {
    wipeBuffer(entropy);
  }
}
