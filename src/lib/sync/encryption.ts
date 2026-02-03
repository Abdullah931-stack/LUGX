/**
 * Client-Side Encryption using AES-GCM
 */

export interface EncryptionConfig {
    algorithm: 'AES-GCM';
    keyLength: 256;
    ivLength: 12;
}

export interface EncryptedData {
    ciphertext: string;
    iv: string;
    algorithm: string;
    version: 1;
}

const DEFAULT_CONFIG: EncryptionConfig = { algorithm: 'AES-GCM', keyLength: 256, ivLength: 12 };

export class EncryptionManager {
    private config: EncryptionConfig;
    private key: CryptoKey | null = null;
    private keyDerivationSalt: Uint8Array | null = null;

    constructor(config: Partial<EncryptionConfig> = {}) {
        this.config = { ...DEFAULT_CONFIG, ...config };
    }

    async deriveKeyFromPassword(password: string, salt?: Uint8Array): Promise<{ key: CryptoKey; salt: Uint8Array }> {
        const derivedSalt = salt ?? crypto.getRandomValues(new Uint8Array(16));

        const keyMaterial = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits', 'deriveKey']);
        const key = await crypto.subtle.deriveKey(
            { name: 'PBKDF2', salt: derivedSalt.buffer as ArrayBuffer, iterations: 100000, hash: 'SHA-256' },
            keyMaterial,
            { name: this.config.algorithm, length: this.config.keyLength },
            false,
            ['encrypt', 'decrypt']
        );

        this.key = key;
        this.keyDerivationSalt = derivedSalt;
        return { key, salt: derivedSalt };
    }

    async generateKey(): Promise<CryptoKey> {
        const key = await crypto.subtle.generateKey({ name: this.config.algorithm, length: this.config.keyLength }, false, ['encrypt', 'decrypt']);
        this.key = key;
        return key;
    }

    setKey(key: CryptoKey): void { this.key = key; }
    isInitialized(): boolean { return this.key !== null; }

    async encrypt(plaintext: string): Promise<EncryptedData> {
        if (!this.key) throw new Error('Encryption key not initialized');
        const iv = crypto.getRandomValues(new Uint8Array(this.config.ivLength));
        const ciphertextBuffer = await crypto.subtle.encrypt({ name: this.config.algorithm, iv }, this.key, new TextEncoder().encode(plaintext));
        return { ciphertext: this.arrayBufferToBase64(ciphertextBuffer), iv: this.arrayBufferToBase64(iv), algorithm: this.config.algorithm, version: 1 };
    }

    async decrypt(encryptedData: EncryptedData): Promise<string> {
        if (!this.key) throw new Error('Encryption key not initialized');
        const plaintextBuffer = await crypto.subtle.decrypt({ name: encryptedData.algorithm, iv: this.base64ToArrayBuffer(encryptedData.iv) }, this.key, this.base64ToArrayBuffer(encryptedData.ciphertext));
        return new TextDecoder().decode(plaintextBuffer);
    }

    async encryptForStorage(content: string): Promise<string> { return JSON.stringify(await this.encrypt(content)); }
    async decryptFromStorage(encryptedJson: string): Promise<string> { return this.decrypt(JSON.parse(encryptedJson)); }

    exportSalt(): string | null { return this.keyDerivationSalt ? this.arrayBufferToBase64(this.keyDerivationSalt) : null; }
    importSalt(saltBase64: string): Uint8Array { return new Uint8Array(this.base64ToArrayBuffer(saltBase64)); }
    clear(): void { this.key = null; this.keyDerivationSalt = null; }

    private arrayBufferToBase64(buffer: ArrayBuffer | Uint8Array): string {
        const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
        return btoa(String.fromCharCode(...bytes));
    }

    private base64ToArrayBuffer(base64: string): ArrayBuffer {
        const binary = atob(base64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        return bytes.buffer;
    }
}

export const encryptionManager = new EncryptionManager();
export function isEncryptionSupported(): boolean { return typeof crypto !== 'undefined' && typeof crypto.subtle !== 'undefined'; }
