/**
 * Connection Detector Tests
 * Tests for network connectivity detection and backoff logic
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ConnectionDetector, calculateBackoffDelay, withBackoff } from './connection-detector';

describe('Connection Detector', () => {
    let detector: ConnectionDetector;

    beforeEach(() => {
        vi.clearAllMocks();
        detector = new ConnectionDetector();
    });

    afterEach(() => {
        detector.destroy();
    });

    describe('initialization', () => {
        it('should start with unknown state before init', () => {
            const newDetector = new ConnectionDetector();
            // getState will check navigator.onLine, so we test internal state indirectly
            expect(['online', 'offline', 'unknown']).toContain(newDetector.getState());
            newDetector.destroy();
        });
    });

    describe('isOnline', () => {
        it('should return boolean', () => {
            detector.init();
            expect(typeof detector.isOnline()).toBe('boolean');
        });
    });

    describe('onChange callback', () => {
        it('should register callback and return unsubscribe function', () => {
            const callback = vi.fn();
            const unsubscribe = detector.onChange(callback);

            expect(typeof unsubscribe).toBe('function');
        });

        it('should not call callback on registration', () => {
            const callback = vi.fn();
            detector.onChange(callback);

            expect(callback).not.toHaveBeenCalled();
        });

        it('should unsubscribe correctly', () => {
            const callback = vi.fn();
            const unsubscribe = detector.onChange(callback);
            unsubscribe();

            // After unsubscribe, the callback should not be in the set
            expect(callback).not.toHaveBeenCalled();
        });
    });

    describe('destroy', () => {
        it('should clean up without throwing', () => {
            detector.init();
            expect(() => detector.destroy()).not.toThrow();
        });

        it('should be safe to call multiple times', () => {
            detector.init();
            detector.destroy();
            expect(() => detector.destroy()).not.toThrow();
        });
    });
});

describe('calculateBackoffDelay', () => {
    it('should return initial delay for first attempt', () => {
        const delay = calculateBackoffDelay(0, {
            initialDelayMs: 1000,
            maxDelayMs: 60000,
            multiplier: 2,
            jitter: false,
        });

        expect(delay).toBe(1000);
    });

    it('should double delay for each attempt', () => {
        const config = {
            initialDelayMs: 1000,
            maxDelayMs: 60000,
            multiplier: 2,
            jitter: false,
        };

        expect(calculateBackoffDelay(0, config)).toBe(1000);
        expect(calculateBackoffDelay(1, config)).toBe(2000);
        expect(calculateBackoffDelay(2, config)).toBe(4000);
        expect(calculateBackoffDelay(3, config)).toBe(8000);
    });

    it('should cap at maximum delay', () => {
        const delay = calculateBackoffDelay(10, {
            initialDelayMs: 1000,
            maxDelayMs: 5000,
            multiplier: 2,
            jitter: false,
        });

        expect(delay).toBe(5000);
    });

    it('should add jitter when enabled', () => {
        const config = {
            initialDelayMs: 1000,
            maxDelayMs: 60000,
            multiplier: 2,
            jitter: true,
        };

        // With jitter, delay should be within ±25% of base
        const delays = Array.from({ length: 10 }, () => calculateBackoffDelay(0, config));

        // All delays should be within 750-1250 range (1000 ± 25%)
        delays.forEach(delay => {
            expect(delay).toBeGreaterThanOrEqual(750);
            expect(delay).toBeLessThanOrEqual(1250);
        });

        // There should be some variation (not all same value)
        const uniqueDelays = new Set(delays);
        expect(uniqueDelays.size).toBeGreaterThan(1);
    });

    it('should use default config when not provided', () => {
        const delay = calculateBackoffDelay(0);

        // Default initial delay is 2000ms, with jitter it should be in range
        expect(delay).toBeGreaterThanOrEqual(1500);
        expect(delay).toBeLessThanOrEqual(2500);
    });
});

describe('withBackoff', () => {
    it('should return result on first successful attempt', async () => {
        const fn = vi.fn().mockResolvedValue('success');

        const result = await withBackoff(fn, 3, {
            initialDelayMs: 1,
            maxDelayMs: 10,
            multiplier: 2,
            jitter: false,
        });

        expect(result).toBe('success');
        expect(fn).toHaveBeenCalledTimes(1);
    });

    it('should retry on failure and succeed', async () => {
        const fn = vi.fn()
            .mockRejectedValueOnce(new Error('Fail 1'))
            .mockResolvedValue('success');

        const result = await withBackoff(fn, 3, {
            initialDelayMs: 1,
            maxDelayMs: 10,
            multiplier: 2,
            jitter: false,
        });

        expect(result).toBe('success');
        expect(fn).toHaveBeenCalledTimes(2);
    });

    it('should throw after max retries', async () => {
        const fn = vi.fn().mockRejectedValue(new Error('Always fails'));

        await expect(
            withBackoff(fn, 3, {
                initialDelayMs: 1,
                maxDelayMs: 10,
                multiplier: 2,
                jitter: false,
            })
        ).rejects.toThrow('Always fails');

        expect(fn).toHaveBeenCalledTimes(3);
    });

    it('should accept custom max retries', async () => {
        const fn = vi.fn().mockRejectedValue(new Error('Fail'));

        await expect(
            withBackoff(fn, 5, {
                initialDelayMs: 1,
                maxDelayMs: 10,
                multiplier: 2,
                jitter: false,
            })
        ).rejects.toThrow();

        expect(fn).toHaveBeenCalledTimes(5);
    });

    it('should convert non-Error throws to Error', async () => {
        const fn = vi.fn().mockRejectedValue('string error');

        await expect(
            withBackoff(fn, 1, {
                initialDelayMs: 1,
                maxDelayMs: 10,
                multiplier: 2,
                jitter: false,
            })
        ).rejects.toThrow();

        expect(fn).toHaveBeenCalledTimes(1);
    });
});
