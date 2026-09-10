import { describe, it, expect, beforeEach } from 'vitest';
import {
    isSensitiveLogKey,
    sanitizeLogMessage,
    sanitizeLogValue,
    REDACTED,
} from '../lib/sync/log-sanitizer';
import { sessionKeyStore } from '../lib/sync/session-key-store';
import { wipeBuffer } from '../lib/sync/crypto-worker-bridge';

describe('Log Sanitizer & RAM Hygiene (Hardened Suite)', () => {
    describe('isSensitiveLogKey & Word-Boundary Isolation (F4 / F5)', () => {
        it('should redact sensitive keys and token-bounded compound keys', () => {
            expect(isSensitiveLogKey('password')).toBe(true);
            expect(isSensitiveLogKey('masterKey')).toBe(true);
            expect(isSensitiveLogKey('pin')).toBe(true);
            expect(isSensitiveLogKey('device_pin')).toBe(true);
            expect(isSensitiveLogKey('authPin')).toBe(true);
            expect(isSensitiveLogKey('iv')).toBe(true);
            expect(isSensitiveLogKey('file_iv')).toBe(true);
            expect(isSensitiveLogKey('aad')).toBe(true);
            expect(isSensitiveLogKey('kek')).toBe(true);
            expect(isSensitiveLogKey('mnemonic')).toBe(true);
            expect(isSensitiveLogKey('seed')).toBe(true);
        });

        it('should NOT falsely redact benign operational keys containing short fragments (F4/F5)', () => {
            // "activity", "archive", "privacy", "privilege", "universal" all contain "iv"
            expect(isSensitiveLogKey('activity')).toBe(false);
            expect(isSensitiveLogKey('archive')).toBe(false);
            expect(isSensitiveLogKey('privacy')).toBe(false);
            expect(isSensitiveLogKey('privilege')).toBe(false);
            expect(isSensitiveLogKey('universal')).toBe(false);
            // "spinning" contains "pin"
            expect(isSensitiveLogKey('spinning')).toBe(false);
            // Standard benign metadata
            expect(isSensitiveLogKey('fileId')).toBe(false);
            expect(isSensitiveLogKey('userId')).toBe(false);
            expect(isSensitiveLogKey('etag')).toBe(false);
            expect(isSensitiveLogKey('operationId')).toBe(false);
        });
    });

    describe('sanitizeLogMessage & JSON Formatting (F11 & F4/F5)', () => {
        it('should produce valid, parseable JSON without duplicate quotes (F11)', () => {
            const rawJson = '{"content": "super_secret_payload"}';
            const scrubbed = sanitizeLogMessage(rawJson);

            // Must NOT contain double double-quotes like ""content""
            expect(scrubbed).not.toContain('""content""');
            expect(scrubbed).toBe('{"content": "[REDACTED]"}');

            // Must parse cleanly as JSON
            const parsed = JSON.parse(scrubbed);
            expect(parsed.content).toBe(REDACTED);
        });

        it('should correctly handle single-quoted JSON-like strings', () => {
            const singleQuoted = "{'content': 'super_secret_payload'}";
            const scrubbed = sanitizeLogMessage(singleQuoted);
            expect(scrubbed).toBe("{'content': '[REDACTED]'}");
        });

        it('should scrub multi-word secrets such as 12-word recovery mnemonics without leaking words (F4/F5)', () => {
            const mnemonicPhrase = 'apple banana cherry dog elephant fox grape horse igloo jaguar kite lion';
            const logMsg = `Vault setup: mnemonic: ${mnemonicPhrase}, status: complete`;
            const scrubbed = sanitizeLogMessage(logMsg);

            expect(scrubbed).toContain('mnemonic: [REDACTED]');
            expect(scrubbed).not.toContain('banana');
            expect(scrubbed).not.toContain('lion');
            expect(scrubbed).toContain('status: complete');
        });

        it('should NOT scrub benign occurrences of words like activity (F4/F5)', () => {
            const msg = 'User activity: export_markdown initiated';
            const scrubbed = sanitizeLogMessage(msg);
            expect(scrubbed).toBe('User activity: export_markdown initiated');
        });
    });

    describe('sanitizeLogValue & DAG Non-Cyclic Traversal (F10)', () => {
        it('should preserve identical object references across DAG branches without false redaction (F10)', () => {
            const sharedAuthor = { name: 'Alice', role: 'admin' };
            const docTree = {
                creator: sharedAuthor,
                lastModifier: sharedAuthor,
            };

            const sanitized = sanitizeLogValue(docTree) as {
                creator: { name: string; role: string };
                lastModifier: { name: string; role: string };
            };

            expect(sanitized.creator).toEqual({ name: 'Alice', role: 'admin' });
            // lastModifier MUST NOT be replaced with [REDACTED]
            expect(sanitized.lastModifier).toEqual({ name: 'Alice', role: 'admin' });
        });

        it('should detect actual circular references and break the infinite loop (F10)', () => {
            const cyclicObj: Record<string, unknown> = { name: 'cycleRoot' };
            cyclicObj.self = cyclicObj;

            const sanitized = sanitizeLogValue(cyclicObj) as Record<string, unknown>;
            expect(sanitized.name).toBe('cycleRoot');
            expect(sanitized.self).toBe(REDACTED);
        });

        it('should sanitize Error objects while preserving sanitized stack trace (F9)', () => {
            const error = new Error('Failed with password: plainsecret, context: sync');
            error.stack = 'Error: Failed with password: plainsecret, context: sync\n    at trace.ts:10:5';

            const sanitized = sanitizeLogValue(error) as { name: string; message: string; stack?: string };
            expect(sanitized.name).toBe('Error');
            expect(sanitized.message).toBe('Failed with password: [REDACTED], context: sync');
            expect(sanitized.stack).toBeDefined();
            expect(sanitized.stack).not.toContain('plainsecret');
            expect(sanitized.stack).toContain('[REDACTED]');
        });

        it('should replace Uint8Array buffers with length-only placeholders', () => {
            const buffer = new Uint8Array(32);
            const sanitized = sanitizeLogValue(buffer);
            expect(sanitized).toBe(`${REDACTED}:binary(32B)`);
        });
    });

    describe('RAM Hygiene & Key Store Independence (F1)', () => {
        beforeEach(() => {
            sessionKeyStore.purgeKeys();
        });

        it('should maintain independent copy in SessionKeyStore when caller wipes its local buffer (F1)', () => {
            const callerBuffer = new Uint8Array(32);
            for (let i = 0; i < 32; i++) callerBuffer[i] = i + 1;

            sessionKeyStore.setMasterKey(callerBuffer, 1);

            // Caller defensively zeroes its local buffer in finally
            wipeBuffer(callerBuffer);

            // Caller's buffer is all zeros
            expect(callerBuffer.every((b) => b === 0)).toBe(true);

            // KeyStore's internal master key is untouched and intact
            const storeKey = sessionKeyStore.getMasterKeyRaw();
            expect(storeKey).not.toBeNull();
            expect(storeKey![0]).toBe(1);
            expect(storeKey![31]).toBe(32);
        });

        it('should not mutate inactivityTimeoutMs when storeMasterKeyRaw is called (F2)', () => {
            const defaultTimeout = sessionKeyStore.getInactivityTimeout();
            const key = new Uint8Array(32);
            key.fill(7);

            // Calling storeMasterKeyRaw with custom timeout should not overwrite global setting
            sessionKeyStore.storeMasterKeyRaw(key, 120);
            expect(sessionKeyStore.getInactivityTimeout()).toBe(defaultTimeout);
        });
    });
});
