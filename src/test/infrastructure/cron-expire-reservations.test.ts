import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { GET as expireReservationsGET, POST as expireReservationsPOST } from '@/app/api/cron/expire-reservations/route';
import * as aiSettlement from '@/server/services/ai-settlement-service';

vi.mock('@/server/services/ai-settlement-service', () => ({
    expireStaleReservations: vi.fn(),
}));

describe('Cron: Expire Stale Reservations (/api/cron/expire-reservations) — TD-02', () => {
    const originalEnv = process.env.CRON_SECRET;
    const TEST_SECRET = 'super-secret-cron-key-123';

    beforeEach(() => {
        process.env.CRON_SECRET = TEST_SECRET;
        vi.clearAllMocks();
    });

    afterEach(() => {
        process.env.CRON_SECRET = originalEnv;
    });

    it('should reject request with 401 Unauthorized when Authorization header is missing', async () => {
        const req = new NextRequest('http://localhost:3000/api/cron/expire-reservations', {
            method: 'GET',
        });

        const res = await expireReservationsGET(req);
        expect(res.status).toBe(401);
        const data = await res.json();
        expect(data.success).toBe(false);
        expect(data.error).toBe('Unauthorized');
        expect(aiSettlement.expireStaleReservations).not.toHaveBeenCalled();
    });

    it('should reject request with 401 Unauthorized when Bearer token is invalid', async () => {
        const req = new NextRequest('http://localhost:3000/api/cron/expire-reservations', {
            method: 'GET',
            headers: {
                Authorization: 'Bearer wrong-secret-token',
            },
        });

        const res = await expireReservationsGET(req);
        expect(res.status).toBe(401);
        const data = await res.json();
        expect(data.success).toBe(false);
        expect(data.error).toBe('Unauthorized');
        expect(aiSettlement.expireStaleReservations).not.toHaveBeenCalled();
    });

    it('should execute expireStaleReservations and return 200 with expiredCount when authorized', async () => {
        vi.mocked(aiSettlement.expireStaleReservations).mockResolvedValueOnce(5);

        const req = new NextRequest('http://localhost:3000/api/cron/expire-reservations', {
            method: 'GET',
            headers: {
                Authorization: `Bearer ${TEST_SECRET}`,
            },
        });

        const res = await expireReservationsGET(req);
        expect(res.status).toBe(200);
        const data = await res.json();
        expect(data.success).toBe(true);
        expect(data.expiredCount).toBe(5);
        expect(data.timestamp).toBeDefined();
        expect(aiSettlement.expireStaleReservations).toHaveBeenCalledTimes(1);
    });

    it('should execute via POST method and return 200 when authorized', async () => {
        vi.mocked(aiSettlement.expireStaleReservations).mockResolvedValueOnce(3);

        const req = new NextRequest('http://localhost:3000/api/cron/expire-reservations', {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${TEST_SECRET}`,
            },
        });

        const res = await expireReservationsPOST(req);
        expect(res.status).toBe(200);
        const data = await res.json();
        expect(data.success).toBe(true);
        expect(data.expiredCount).toBe(3);
        expect(aiSettlement.expireStaleReservations).toHaveBeenCalledTimes(1);
    });

    it('should return 500 when expireStaleReservations throws an internal error', async () => {
        vi.mocked(aiSettlement.expireStaleReservations).mockRejectedValueOnce(new Error('DB Connection Dropped'));

        const req = new NextRequest('http://localhost:3000/api/cron/expire-reservations', {
            method: 'GET',
            headers: {
                Authorization: `Bearer ${TEST_SECRET}`,
            },
        });

        const res = await expireReservationsGET(req);
        expect(res.status).toBe(500);
        const data = await res.json();
        expect(data.success).toBe(false);
        expect(data.error).toBe('Expire reservations failed');
    });
});
