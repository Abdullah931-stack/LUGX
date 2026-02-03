/**
 * Concurrency Manager Tests
 * Tests for file-level locking mechanism
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ConcurrencyManager } from './concurrency-manager';

describe('Concurrency Manager', () => {
    let manager: ConcurrencyManager;

    beforeEach(() => {
        vi.clearAllMocks();
        manager = new ConcurrencyManager();
    });

    describe('withLock', () => {
        it('should execute operation and return result', async () => {
            const operation = vi.fn().mockResolvedValue('success');

            const result = await manager.withLock('file-1', operation);

            expect(result).toBe('success');
            expect(operation).toHaveBeenCalledTimes(1);
        });

        it('should serialize operations on same file', async () => {
            const executionOrder: number[] = [];

            const op1 = vi.fn().mockImplementation(async () => {
                executionOrder.push(1);
                await new Promise(r => setTimeout(r, 10));
                return 'op1';
            });

            const op2 = vi.fn().mockImplementation(async () => {
                executionOrder.push(2);
                return 'op2';
            });

            const promise1 = manager.withLock('file-1', op1);
            const promise2 = manager.withLock('file-1', op2);

            await Promise.all([promise1, promise2]);

            // Operations should be serialized: op1 finishes before op2 starts
            expect(executionOrder).toEqual([1, 2]);
        });

        it('should allow parallel operations on different files', async () => {
            const executionOrder: string[] = [];

            const op1 = vi.fn().mockImplementation(async () => {
                executionOrder.push('file1-start');
                await new Promise(r => setTimeout(r, 20));
                executionOrder.push('file1-end');
                return 'op1';
            });

            const op2 = vi.fn().mockImplementation(async () => {
                executionOrder.push('file2-start');
                await new Promise(r => setTimeout(r, 5));
                executionOrder.push('file2-end');
                return 'op2';
            });

            const promise1 = manager.withLock('file-1', op1);
            const promise2 = manager.withLock('file-2', op2);

            await Promise.all([promise1, promise2]);

            // Both should start before file1 ends (parallel execution)
            // file2 should end before file1 due to shorter wait
            expect(executionOrder.indexOf('file1-start')).toBeLessThan(executionOrder.indexOf('file1-end'));
            expect(executionOrder.indexOf('file2-start')).toBeLessThan(executionOrder.indexOf('file2-end'));
        });

        it('should release lock after operation completes', async () => {
            const op1 = vi.fn().mockResolvedValue('op1');
            const op2 = vi.fn().mockResolvedValue('op2');

            await manager.withLock('file-1', op1);

            // Second operation should work after first completes
            const result = await manager.withLock('file-1', op2);

            expect(op2).toHaveBeenCalled();
            expect(result).toBe('op2');
        });

        it('should release lock even if operation throws', async () => {
            const failingOp = vi.fn().mockRejectedValue(new Error('Operation failed'));
            const successOp = vi.fn().mockResolvedValue('success');

            // First operation fails
            await expect(manager.withLock('file-1', failingOp)).rejects.toThrow('Operation failed');

            // Lock should be released, second operation should work
            const result = await manager.withLock('file-1', successOp);

            expect(result).toBe('success');
        });
    });

    describe('isLocked', () => {
        it('should return false for unlocked file', () => {
            expect(manager.isLocked('file-1')).toBe(false);
        });

        it('should return true during operation', async () => {
            let lockStateInsideOp = false;
            let resolveOp: () => void;
            const opPromise = new Promise<void>(r => { resolveOp = r; });

            const op = vi.fn().mockImplementation(async () => {
                lockStateInsideOp = manager.isLocked('file-1');
                await opPromise;
                return 'done';
            });

            const lockPromise = manager.withLock('file-1', op);

            // Wait a tick for the operation to start
            await new Promise(r => setTimeout(r, 1));

            expect(lockStateInsideOp).toBe(true);

            resolveOp!();
            await lockPromise;
        });

        it('should return false after operation completes', async () => {
            const op = vi.fn().mockResolvedValue('done');

            await manager.withLock('file-1', op);

            expect(manager.isLocked('file-1')).toBe(false);
        });
    });

    describe('queue management', () => {
        it('should queue multiple operations for same file', async () => {
            const results: string[] = [];

            const createOp = (name: string) => vi.fn().mockImplementation(async () => {
                results.push(name);
                await new Promise(r => setTimeout(r, 5));
                return name;
            });

            const promises = [
                manager.withLock('file-1', createOp('op1')),
                manager.withLock('file-1', createOp('op2')),
                manager.withLock('file-1', createOp('op3')),
            ];

            await Promise.all(promises);

            // All operations should complete in order
            expect(results).toEqual(['op1', 'op2', 'op3']);
        });
    });
});
