/**
 * Client-Side Dual-Tier Hybrid Encryption & Envelope Management
 *
 * Implements AES-GCM-256 zero-knowledge encryption envelopes with mandatory
 * AAD binding, PBKDF2 (600,000 iterations), BIP-39 recovery seed derivation,
 * and memory sanitization via CryptoWorkerBridge and SessionKeyStore.
 */

import {
  EncryptedEnvelope,
  AADIntegrityError,
  InvalidCiphertextOrKeyError
} from './types/vault';
import {
  cryptoWorkerBridge,
  wipeBuffer,
  arrayBufferToBase64,
  base64ToUint8Array
} from './crypto-worker-bridge';
import { sessionKeyStore } from './session-key-store';
import { validateMnemonic } from './mnemonic';

export interface EncryptionConfig {
  algorithm: 'AES-GCM';
  keyLength: 256;
  ivLength: 12;
  iterations?: number;
}

export interface EncryptedData {
  ciphertext: string;
  iv: string;
  algorithm: string;
  version: 1;
}

const DEFAULT_CONFIG: EncryptionConfig = {
  algorithm: 'AES-GCM',
  keyLength: 256,
  ivLength: 12,
  iterations: 600000
};

/**
 * Generates a 256-bit (32 bytes) CSPRNG Master Key
 */
export async function generateMasterKeyRaw(): Promise<Uint8Array> {
  return cryptoWorkerBridge.generateRandomBytes(32);
}

/**
 * Generates random 16-byte salt
 */
export async function generateSalt(length = 16): Promise<Uint8Array> {
  return cryptoWorkerBridge.generateRandomBytes(length);
}

/**
 * Generates random 12-byte IV for AES-GCM
 */
export async function generateIV(length = 12): Promise<Uint8Array> {
  return cryptoWorkerBridge.generateRandomBytes(length);
}

/**
 * Derives a 256-bit KEK (Key Encryption Key) from a password using PBKDF2-HMAC-SHA256 (600K iterations)
 */
export async function deriveKEKFromPassword(
  password: string,
  saltBytes: Uint8Array,
  iterations = 600000
): Promise<Uint8Array> {
  const normalized = password.normalize('NFKC');
  const passwordBytes = new TextEncoder().encode(normalized);
  try {
    return await cryptoWorkerBridge.deriveKeyRaw(
      passwordBytes,
      saltBytes,
      iterations,
      256
    );
  } finally {
    wipeBuffer(passwordBytes);
  }
}

/**
 * Derives a 256-bit KEK from a 12-word BIP-39 recovery mnemonic
 */
export async function deriveKEKFromRecoverySeed(
  mnemonic: string,
  saltBytes: Uint8Array,
  iterations = 600000
): Promise<Uint8Array> {
  const validation = await validateMnemonic(mnemonic);
  if (!validation.isValid) {
    throw new Error(validation.error || 'Invalid recovery mnemonic phrase');
  }

  return cryptoWorkerBridge.mnemonicToSeed(mnemonic, saltBytes, iterations);
}

/**
 * Wraps (encrypts) the Master Key with a password-derived KEK
 */
export async function wrapMasterKeyWithPassword(
  masterKeyBytes: Uint8Array,
  password: string,
  saltBytes: Uint8Array,
  userId: string,
  iterations = 600000
): Promise<{ wrappedKeyBase64: string; ivBase64: string }> {
  const kek = await deriveKEKFromPassword(password, saltBytes, iterations);
  const iv = await generateIV(12);
  const aad = `master_key:${userId}`;

  try {
    return await cryptoWorkerBridge.wrapKeyRaw(kek, masterKeyBytes, iv, aad);
  } finally {
    wipeBuffer(kek);
    wipeBuffer(iv);
  }
}

/**
 * Unwraps (decrypts) the Master Key using the user's password
 */
export async function unwrapMasterKeyWithPassword(
  wrappedKeyBase64: string,
  ivBase64: string,
  password: string,
  saltBytes: Uint8Array,
  userId: string,
  iterations = 600000
): Promise<Uint8Array> {
  const kek = await deriveKEKFromPassword(password, saltBytes, iterations);
  const iv = base64ToUint8Array(ivBase64);
  const aad = `master_key:${userId}`;

  try {
    return await cryptoWorkerBridge.unwrapKeyRaw(kek, wrappedKeyBase64, iv, aad);
  } finally {
    wipeBuffer(kek);
    wipeBuffer(iv);
  }
}

/**
 * Wraps (encrypts) the Master Key with a 12-word recovery seed
 */
export async function wrapMasterKeyWithRecoverySeed(
  masterKeyBytes: Uint8Array,
  mnemonic: string,
  recoverySaltBytes: Uint8Array,
  userId: string,
  iterations = 600000
): Promise<{ wrappedKeyBase64: string; ivBase64: string }> {
  const kek = await deriveKEKFromRecoverySeed(mnemonic, recoverySaltBytes, iterations);
  const iv = await generateIV(12);
  const aad = `recovery_master_key:${userId}`;

  try {
    return await cryptoWorkerBridge.wrapKeyRaw(kek, masterKeyBytes, iv, aad);
  } finally {
    wipeBuffer(kek);
    wipeBuffer(iv);
  }
}

/**
 * Unwraps (decrypts) the Master Key using the 12-word recovery seed
 */
export async function unwrapMasterKeyWithRecoverySeed(
  wrappedKeyBase64: string,
  ivBase64: string,
  mnemonic: string,
  recoverySaltBytes: Uint8Array,
  userId: string,
  iterations = 600000
): Promise<Uint8Array> {
  const kek = await deriveKEKFromRecoverySeed(mnemonic, recoverySaltBytes, iterations);
  const iv = base64ToUint8Array(ivBase64);
  const aad = `recovery_master_key:${userId}`;

  try {
    return await cryptoWorkerBridge.unwrapKeyRaw(kek, wrappedKeyBase64, iv, aad);
  } finally {
    wipeBuffer(kek);
    wipeBuffer(iv);
  }
}

/**
 * Encrypts a plaintext document into a zero-knowledge EncryptedEnvelope with mandatory AAD
 */
export async function encryptEnvelope(
  plaintext: string,
  keyBytes: Uint8Array,
  keyId: string,
  saltBase64: string,
  aad: string,
  kdfIterations = 600000
): Promise<EncryptedEnvelope> {
  if (!aad) {
    throw new AADIntegrityError('AAD (Additional Authenticated Data) is required for envelope encryption');
  }

  const ivBytes = await generateIV(12);

  try {
    const { ciphertextBase64, ivBase64 } = await cryptoWorkerBridge.encryptAESGCM(
      keyBytes,
      plaintext,
      ivBytes,
      aad
    );

    return {
      version: 1,
      algorithm: 'AES-GCM-256',
      keyId,
      iv: ivBase64,
      salt: saltBase64,
      ciphertext: ciphertextBase64,
      kdfIterations
    };
  } finally {
    wipeBuffer(ivBytes);
  }
}

/**
 * Decrypts an EncryptedEnvelope document with mandatory AAD integrity validation
 */
export async function decryptEnvelope(
  envelope: EncryptedEnvelope,
  keyBytes: Uint8Array,
  aad: string
): Promise<string> {
  if (!envelope || envelope.version !== 1 || envelope.algorithm !== 'AES-GCM-256') {
    throw new InvalidCiphertextOrKeyError('Unsupported envelope version or algorithm');
  }

  if (!aad) {
    throw new AADIntegrityError('AAD (Additional Authenticated Data) is required for envelope decryption');
  }

  const ivBytes = base64ToUint8Array(envelope.iv);

  try {
    return await cryptoWorkerBridge.decryptAESGCM(
      keyBytes,
      envelope.ciphertext,
      ivBytes,
      aad
    );
  } finally {
    wipeBuffer(ivBytes);
  }
}

/**
 * Unified Encryption Manager (Supporting backwards-compatible APIs & LocalDeviceKey management)
 */
export class EncryptionManager {
  private config: EncryptionConfig;
  private key: CryptoKey | null = null;
  private rawKey: Uint8Array | null = null;
  private keyDerivationSalt: Uint8Array | null = null;

  constructor(config: Partial<EncryptionConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  async deriveKeyFromPassword(
    password: string,
    salt?: Uint8Array
  ): Promise<{ key: CryptoKey; salt: Uint8Array }> {
    const derivedSalt = salt ?? (await generateSalt(16));
    const normalized = password.normalize('NFKC');
    const passwordBytes = new TextEncoder().encode(normalized);

    try {
      const rawDerived = await cryptoWorkerBridge.deriveKeyRaw(
        passwordBytes,
        derivedSalt,
        this.config.iterations || 600000,
        this.config.keyLength
      );

      if (this.rawKey) wipeBuffer(this.rawKey);
      this.rawKey = new Uint8Array(rawDerived);
      const key = await crypto.subtle.importKey(
        'raw',
        this.rawKey as unknown as BufferSource,
        { name: this.config.algorithm, length: this.config.keyLength },
        false,
        ['encrypt', 'decrypt']
      );

      if (this.keyDerivationSalt) wipeBuffer(this.keyDerivationSalt);
      this.key = key;
      this.keyDerivationSalt = derivedSalt;
      return { key, salt: derivedSalt };
    } finally {
      wipeBuffer(passwordBytes);
    }
  }

  async generateKey(): Promise<CryptoKey> {
    const raw = await cryptoWorkerBridge.generateRandomBytes(32);
    this.rawKey = new Uint8Array(raw);
    const key = await crypto.subtle.importKey(
      'raw',
      this.rawKey as unknown as BufferSource,
      { name: this.config.algorithm, length: this.config.keyLength },
      false,
      ['encrypt', 'decrypt']
    );
    this.key = key;
    return key;
  }

  setKey(key: CryptoKey): void {
    this.key = key;
  }

  setRawKey(rawKey: Uint8Array): void {
    if (this.rawKey) wipeBuffer(this.rawKey);
    this.rawKey = new Uint8Array(rawKey);
  }

  getRawKey(): Uint8Array | null {
    return this.rawKey;
  }

  isInitialized(): boolean {
    return this.key !== null || this.rawKey !== null;
  }

  async encrypt(plaintext: string, aad = 'default'): Promise<EncryptedData> {
    if (!this.rawKey && !this.key) {
      throw new Error('Encryption key not initialized');
    }

    const ivBytes = await generateIV(this.config.ivLength);

    try {
      let ciphertextBase64: string;
      let ivBase64: string;

      if (this.rawKey) {
        const res = await cryptoWorkerBridge.encryptAESGCM(this.rawKey, plaintext, ivBytes, aad);
        ciphertextBase64 = res.ciphertextBase64;
        ivBase64 = res.ivBase64;
      } else {
        const plaintextBytes = new TextEncoder().encode(plaintext);
        const aadBytes = new TextEncoder().encode(aad);
        const ciphertextBuffer = await crypto.subtle.encrypt(
          { name: this.config.algorithm, iv: ivBytes as unknown as BufferSource, additionalData: aadBytes as unknown as BufferSource },
          this.key!,
          plaintextBytes as unknown as BufferSource
        );
        ciphertextBase64 = arrayBufferToBase64(ciphertextBuffer);
        ivBase64 = arrayBufferToBase64(ivBytes);
        wipeBuffer(plaintextBytes);
      }

      return {
        ciphertext: ciphertextBase64,
        iv: ivBase64,
        algorithm: this.config.algorithm,
        version: 1
      };
    } finally {
      wipeBuffer(ivBytes);
    }
  }

  async decrypt(encryptedData: EncryptedData, aad = 'default'): Promise<string> {
    if (!this.rawKey && !this.key) {
      throw new Error('Encryption key not initialized');
    }

    const ivBytes = base64ToUint8Array(encryptedData.iv);

    try {
      if (this.rawKey) {
        return await cryptoWorkerBridge.decryptAESGCM(
          this.rawKey,
          encryptedData.ciphertext,
          ivBytes,
          aad
        );
      }

      const ciphertextBytes = base64ToUint8Array(encryptedData.ciphertext);
      const aadBytes = new TextEncoder().encode(aad);
      try {
        const plaintextBuffer = await crypto.subtle.decrypt(
          { name: encryptedData.algorithm, iv: ivBytes as unknown as BufferSource, additionalData: aadBytes as unknown as BufferSource },
          this.key!,
          ciphertextBytes as unknown as BufferSource
        );
        return new TextDecoder().decode(plaintextBuffer);
      } finally {
        wipeBuffer(ciphertextBytes);
      }
    } finally {
      wipeBuffer(ivBytes);
    }
  }

  async encryptForStorage(content: string, aad = 'default'): Promise<string> {
    return JSON.stringify(await this.encrypt(content, aad));
  }

  async decryptFromStorage(encryptedJson: string, aad = 'default'): Promise<string> {
    return this.decrypt(JSON.parse(encryptedJson), aad);
  }

  exportSalt(): string | null {
    return this.keyDerivationSalt ? arrayBufferToBase64(this.keyDerivationSalt) : null;
  }

  importSalt(saltBase64: string): Uint8Array {
    return base64ToUint8Array(saltBase64);
  }

  clear(): void {
    if (this.rawKey) {
      wipeBuffer(this.rawKey);
      this.rawKey = null;
    }
    this.key = null;
    if (this.keyDerivationSalt) {
      wipeBuffer(this.keyDerivationSalt);
      this.keyDerivationSalt = null;
    }
  }
}

export const encryptionManager = new EncryptionManager();

export function isEncryptionSupported(): boolean {
  return typeof crypto !== 'undefined' && typeof crypto.subtle !== 'undefined';
}
