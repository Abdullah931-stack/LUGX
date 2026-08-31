/**
 * Typed RPC Bridge for Isolated Crypto Worker
 *
 * Provides a Promise-based asynchronous facade to execute heavy cryptography
 * off the main UI thread. Supports dual-mode execution (Web Worker in browser,
 * Direct WebCrypto engine in Node.js/SSR/tests) ensuring real verification without mocks.
 */

import {
  CryptoWorkerRequest,
  CryptoWorkerResponse,
  CryptoWorkerAction,
  CryptoWorkerRequestPayloads,
  AADIntegrityError,
  InvalidCiphertextOrKeyError,
  CryptoWorkerBridgeError
} from './types/vault';
import {
  executeCryptoWorkerAction,
  wipeBuffer,
  arrayBufferToBase64,
  base64ToUint8Array
} from '../workers/crypto.worker';

export { wipeBuffer, arrayBufferToBase64, base64ToUint8Array };

export class CryptoWorkerBridge {
  private worker: Worker | null = null;
  private pendingRequests = new Map<
    string,
    {
      resolve: (value: any) => void;
      reject: (reason?: any) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private requestCounter = 0;
  private isInitialized = false;

  constructor(private readonly timeoutMs = 30000) {}

  /**
   * Initializes Web Worker instance if in browser environment
   */
  public initialize(): void {
    if (this.isInitialized) return;

    if (typeof window !== 'undefined' && typeof Worker !== 'undefined') {
      try {
        // Next.js Web Worker module instantiation
        this.worker = new Worker(
          new URL('../workers/crypto.worker.ts', import.meta.url),
          { type: 'module' }
        );

        this.worker.onmessage = (event: MessageEvent<CryptoWorkerResponse>) => {
          this.handleWorkerMessage(event.data);
        };

        this.worker.onerror = (errorEvent: ErrorEvent) => {
          this.handleWorkerError(errorEvent);
        };
      } catch (err) {
        // Fallback to in-process direct execution if Worker creation fails
        this.worker = null;
      }
    }

    this.isInitialized = true;
  }

  /**
   * Dispatches a typed task to the Crypto Worker (or Direct Engine)
   */
  public async executeTask<A extends CryptoWorkerAction>(
    action: A,
    payload: CryptoWorkerRequestPayloads[A]
  ): Promise<any> {
    this.initialize();

    // If Web Worker is active in browser, dispatch through postMessage
    if (this.worker) {
      return this.dispatchToWorker(action, payload);
    }

    // Direct WebCrypto engine execution (Node.js / Vitest / SSR / Fallback)
    try {
      return await executeCryptoWorkerAction(action, payload);
    } catch (err: any) {
      if (err instanceof AADIntegrityError || err instanceof InvalidCiphertextOrKeyError) {
        throw err;
      }
      if (err?.code === 'INVALID_CIPHERTEXT_OR_KEY' || err?.name === 'InvalidCiphertextOrKeyError') {
        throw new InvalidCiphertextOrKeyError(err.message);
      }
      if (err?.code === 'AAD_INTEGRITY_FAILURE' || err?.name === 'AADIntegrityError') {
        throw new AADIntegrityError(err.message);
      }
      throw new CryptoWorkerBridgeError(err?.message || 'Crypto execution error', err);
    }
  }

  private dispatchToWorker<A extends CryptoWorkerAction>(
    action: A,
    payload: CryptoWorkerRequestPayloads[A]
  ): Promise<any> {
    const id = `crypto-task-${Date.now()}-${++this.requestCounter}`;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id);
          reject(new CryptoWorkerBridgeError(`Crypto worker request timed out after ${this.timeoutMs}ms (task: ${action})`));
        }
      }, this.timeoutMs);

      this.pendingRequests.set(id, { resolve, reject, timer });

      const request: CryptoWorkerRequest<A> = { id, action, payload };
      this.worker!.postMessage(request);
    });
  }

  private handleWorkerMessage(response: CryptoWorkerResponse): void {
    if (!response || !response.id) return;

    const pending = this.pendingRequests.get(response.id);
    if (!pending) return;

    this.pendingRequests.delete(response.id);
    clearTimeout(pending.timer);

    if (response.success) {
      pending.resolve(response.result);
    } else {
      const err = response.error;
      if (err.name === 'AADIntegrityError' || err.code === 'AAD_INTEGRITY_FAILURE') {
        pending.reject(new AADIntegrityError(err.message));
      } else if (err.name === 'InvalidCiphertextOrKeyError' || err.code === 'INVALID_CIPHERTEXT_OR_KEY') {
        pending.reject(new InvalidCiphertextOrKeyError(err.message));
      } else {
        pending.reject(new CryptoWorkerBridgeError(err.message || 'Crypto worker failure'));
      }
    }
  }

  private handleWorkerError(errorEvent: ErrorEvent): void {
    for (const [id, pending] of this.pendingRequests.entries()) {
      clearTimeout(pending.timer);
      pending.reject(new CryptoWorkerBridgeError(`Worker fatal error: ${errorEvent.message || 'Unknown error'}`));
      this.pendingRequests.delete(id);
    }
  }

  /**
   * High-Level Cryptographic Facade Methods
   */

  public async deriveKeyRaw(
    passwordBytes: Uint8Array,
    saltBytes: Uint8Array,
    iterations = 600000,
    keyLengthBits = 256
  ): Promise<Uint8Array> {
    return this.executeTask('DERIVE_KEY_RAW', {
      passwordBytes,
      saltBytes,
      iterations,
      keyLengthBits
    });
  }

  public async encryptAESGCM(
    keyBytes: Uint8Array,
    plaintext: string,
    ivBytes: Uint8Array,
    aad: string
  ): Promise<{ ciphertextBase64: string; ivBase64: string }> {
    return this.executeTask('ENCRYPT_AES_GCM', {
      keyBytes,
      plaintext,
      ivBytes,
      aad
    });
  }

  public async decryptAESGCM(
    keyBytes: Uint8Array,
    ciphertextBase64: string,
    ivBytes: Uint8Array,
    aad: string
  ): Promise<string> {
    return this.executeTask('DECRYPT_AES_GCM', {
      keyBytes,
      ciphertextBase64,
      ivBytes,
      aad
    });
  }

  public async wrapKeyRaw(
    kekBytes: Uint8Array,
    targetKeyBytes: Uint8Array,
    ivBytes: Uint8Array,
    aad: string
  ): Promise<{ wrappedKeyBase64: string; ivBase64: string }> {
    return this.executeTask('WRAP_KEY_RAW', {
      kekBytes,
      targetKeyBytes,
      ivBytes,
      aad
    });
  }

  public async unwrapKeyRaw(
    kekBytes: Uint8Array,
    wrappedKeyBase64: string,
    ivBytes: Uint8Array,
    aad: string
  ): Promise<Uint8Array> {
    return this.executeTask('UNWRAP_KEY_RAW', {
      kekBytes,
      wrappedKeyBase64,
      ivBytes,
      aad
    });
  }

  public async generateRandomBytes(length: number): Promise<Uint8Array> {
    return this.executeTask('GENERATE_RANDOM_BYTES', { length });
  }

  public async generateMnemonic(entropyLengthBytes = 16): Promise<string> {
    return this.executeTask('GENERATE_MNEMONIC', { entropyLengthBytes });
  }

  public async validateMnemonic(mnemonic: string): Promise<{ isValid: boolean; error?: string; invalidWords?: string[] }> {
    return this.executeTask('VALIDATE_MNEMONIC', { mnemonic });
  }

  public async mnemonicToSeed(
    mnemonic: string,
    saltBytes?: Uint8Array,
    iterations = 600000
  ): Promise<Uint8Array> {
    return this.executeTask('MNEMONIC_TO_SEED', {
      mnemonic,
      saltBytes,
      iterations
    });
  }

  /**
   * Terminate worker and clear active timers
   */
  public terminate(): void {
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
    for (const [, pending] of this.pendingRequests.entries()) {
      clearTimeout(pending.timer);
    }
    this.pendingRequests.clear();
    this.isInitialized = false;
  }
}

export const cryptoWorkerBridge = new CryptoWorkerBridge();
