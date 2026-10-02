import { describe, it, expect, vi, beforeEach } from "vitest";
import { BillingService, type DbClient } from "@/server/services/billing-service";
import * as schema from "@/server/db/schema";

describe("BillingService (Phase 12 Domain Logic)", () => {
    let mockSubscriptions: Array<{
        id: string;
        userId: string;
        stripeSubscriptionId: string;
        tier: string;
        status: string;
        currentPeriodStart: Date;
        currentPeriodEnd: Date;
        cancelAtPeriodEnd: boolean;
    }>;
    let mockUsers: Array<{
        id: string;
        stripeCustomerId?: string | null;
        tier: string;
    }>;

    let mockDb: DbClient;

    beforeEach(() => {
        mockSubscriptions = [];
        mockUsers = [
            { id: "user-1", stripeCustomerId: "cus_123", tier: "free" },
            { id: "user-2", stripeCustomerId: "cus_456", tier: "free" },
        ];

        // Create an in-memory mock client that mirrors Drizzle operations used by BillingService
        mockDb = {
            select: vi.fn((_fields?: any) => {
                let selectedTable: any = null;
                let whereClause: any = null;
                let limitCount: number | null = null;

                const queryBuilder: any = {
                    from: vi.fn((table: any) => {
                        selectedTable = table;
                        return queryBuilder;
                    }),
                    where: vi.fn((clause: any) => {
                        whereClause = clause;
                        return queryBuilder;
                    }),
                    orderBy: vi.fn(() => queryBuilder),
                    limit: vi.fn((n: number) => {
                        limitCount = n;
                        return queryBuilder;
                    }),
                    then: (resolve: (val: any) => void) => {
                        let data: any[] = [];
                        if (selectedTable === schema.subscriptions) {
                            data = [...mockSubscriptions];
                            if (whereClause) {
                                if (whereClause.__userId) {
                                    data = data.filter((s) => s.userId === whereClause.__userId);
                                }
                                if (whereClause.__subId) {
                                    data = data.filter(
                                        (s) => s.stripeSubscriptionId === whereClause.__subId
                                    );
                                }
                            }
                        } else if (selectedTable === schema.users) {
                            data = [...mockUsers];
                            if (whereClause?.__customerId) {
                                data = data.filter(
                                    (u) => u.stripeCustomerId === whereClause.__customerId
                                );
                            }
                        }

                        if (limitCount !== null) {
                            data = data.slice(0, limitCount);
                        }
                        return Promise.resolve(resolve(data));
                    },
                };
                return queryBuilder;
            }),

            insert: vi.fn((table: any) => ({
                values: vi.fn(async (values: any) => {
                    if (table === schema.subscriptions) {
                        mockSubscriptions.push({
                            id: `sub_${Date.now()}_${Math.random()}`,
                            ...values,
                        });
                    }
                    return [{ id: "mock_id" }];
                }),
            })),

            update: vi.fn((table: any) => ({
                set: vi.fn((setValues: any) => ({
                    where: vi.fn(async (clause: any) => {
                        if (table === schema.subscriptions) {
                            for (const sub of mockSubscriptions) {
                                if (
                                    (clause?.__id && sub.id === clause.__id) ||
                                    (clause?.__subId && sub.stripeSubscriptionId === clause.__subId) ||
                                    (clause?.__userId && sub.userId === clause.__userId)
                                ) {
                                    Object.assign(sub, setValues);
                                }
                            }
                        } else if (table === schema.users) {
                            for (const user of mockUsers) {
                                if (clause?.__userId && user.id === clause.__userId) {
                                    Object.assign(user, setValues);
                                }
                            }
                        }
                        return [{ affected: 1 }];
                    }),
                })),
            })),

            delete: vi.fn(() => ({
                where: vi.fn(async () => []),
            })),
        } as unknown as DbClient;
    });

    describe("calculateEffectiveTier (MAX(tier) derivation)", () => {
        it("returns 'free' when user has no subscriptions", async () => {
            vi.mocked(mockDb.select).mockReturnValueOnce({
                from: () => ({
                    where: () => Promise.resolve([]),
                }),
            } as any);

            const tier = await BillingService.calculateEffectiveTier("user-1", mockDb);
            expect(tier).toBe("free");
        });

        it("returns 'pro' when user has a single active Pro subscription", async () => {
            vi.mocked(mockDb.select).mockReturnValueOnce({
                from: () => ({
                    where: () =>
                        Promise.resolve([
                            { tier: "pro", status: "active" },
                        ]),
                }),
            } as any);

            const tier = await BillingService.calculateEffectiveTier("user-1", mockDb);
            expect(tier).toBe("pro");
        });

        it("returns 'ultra' when user has BOTH an active Pro AND an active Ultra subscription (1:N MAX)", async () => {
            vi.mocked(mockDb.select).mockReturnValueOnce({
                from: () => ({
                    where: () =>
                        Promise.resolve([
                            { tier: "pro", status: "active" },
                            { tier: "ultra", status: "active" },
                        ]),
                }),
            } as any);

            const tier = await BillingService.calculateEffectiveTier("user-1", mockDb);
            expect(tier).toBe("ultra");
        });

        it("returns 'pro' when Ultra subscription is canceled but Pro subscription remains active", async () => {
            vi.mocked(mockDb.select).mockReturnValueOnce({
                from: () => ({
                    where: () =>
                        Promise.resolve([
                            { tier: "pro", status: "active" },
                            { tier: "ultra", status: "canceled" },
                        ]),
                }),
            } as any);

            const tier = await BillingService.calculateEffectiveTier("user-1", mockDb);
            expect(tier).toBe("pro");
        });

        it("returns 'pro' when Ultra subscription is past_due but Pro subscription is active", async () => {
            vi.mocked(mockDb.select).mockReturnValueOnce({
                from: () => ({
                    where: () =>
                        Promise.resolve([
                            { tier: "pro", status: "active" },
                            { tier: "ultra", status: "past_due" },
                        ]),
                }),
            } as any);

            const tier = await BillingService.calculateEffectiveTier("user-1", mockDb);
            expect(tier).toBe("pro");
        });

        it("accepts 'trialing' subscriptions as active tier entitlement", async () => {
            vi.mocked(mockDb.select).mockReturnValueOnce({
                from: () => ({
                    where: () =>
                        Promise.resolve([
                            { tier: "ultra", status: "trialing" },
                        ]),
                }),
            } as any);

            const tier = await BillingService.calculateEffectiveTier("user-1", mockDb);
            expect(tier).toBe("ultra");
        });

        it("ignores 'paused' subscription status when calculating active tier", async () => {
            vi.mocked(mockDb.select).mockReturnValueOnce({
                from: () => ({
                    where: () =>
                        Promise.resolve([
                            { tier: "ultra", status: "paused" },
                        ]),
                }),
            } as any);

            const tier = await BillingService.calculateEffectiveTier("user-1", mockDb);
            expect(tier).toBe("free");
        });
    });

    describe("resolveUserId (Multi-source resolution)", () => {
        it("prefers metadataUserId over all other sources", async () => {
            const resolved = await BillingService.resolveUserId(
                {
                    metadataUserId: "direct-user-id",
                    subscriptionDetailsUserId: "ignored-id",
                    stripeCustomerId: "cus_123",
                    stripeSubscriptionId: "sub_123",
                },
                mockDb
            );
            expect(resolved).toBe("direct-user-id");
        });

        it("falls back to subscriptionDetailsUserId if metadataUserId is missing", async () => {
            const resolved = await BillingService.resolveUserId(
                {
                    subscriptionDetailsUserId: "sub-details-user-id",
                    stripeCustomerId: "cus_123",
                },
                mockDb
            );
            expect(resolved).toBe("sub-details-user-id");
        });

        it("resolves userId via stripeCustomerId from users table (LUGX-141)", async () => {
            vi.mocked(mockDb.select).mockReturnValueOnce({
                from: () => ({
                    where: () => ({
                        limit: () => Promise.resolve([{ id: "user-via-customer" }]),
                    }),
                }),
            } as any);

            const resolved = await BillingService.resolveUserId(
                {
                    stripeCustomerId: "cus_known",
                },
                mockDb
            );
            expect(resolved).toBe("user-via-customer");
        });

        it("resolves userId via stripeSubscriptionId from subscriptions table", async () => {
            vi.mocked(mockDb.select)
                .mockReturnValueOnce({
                    from: () => ({
                        where: () => ({
                            limit: () => Promise.resolve([]),
                        }),
                    }),
                } as any)
                .mockReturnValueOnce({
                    from: () => ({
                        where: () => ({
                            limit: () => Promise.resolve([{ userId: "user-via-sub" }]),
                        }),
                    }),
                } as any);

            const resolved = await BillingService.resolveUserId(
                {
                    stripeCustomerId: "cus_unknown",
                    stripeSubscriptionId: "sub_known",
                },
                mockDb
            );
            expect(resolved).toBe("user-via-sub");
        });

        it("returns null if no sources match", async () => {
            vi.mocked(mockDb.select).mockReturnValue({
                from: () => ({
                    where: () => ({
                        limit: () => Promise.resolve([]),
                    }),
                }),
            } as any);

            const resolved = await BillingService.resolveUserId({}, mockDb);
            expect(resolved).toBeNull();
        });
    });

    describe("handleCancellation (Preserving 1:N multi-subscriptions)", () => {
        it("retains Pro tier if Ultra subscription is canceled but user still holds active Pro sub", async () => {
            vi.mocked(mockDb.select)
                .mockReturnValueOnce({
                    from: () => ({
                        where: () => ({
                            limit: () =>
                                Promise.resolve([
                                    { id: "sub-ultra-id", userId: "user-1", stripeSubscriptionId: "sub_ultra" },
                                ]),
                        }),
                    }),
                } as any)
                .mockReturnValueOnce({
                    from: () => ({
                        where: () =>
                            Promise.resolve([
                                { tier: "free", status: "canceled" },
                                { tier: "pro", status: "active" },
                            ]),
                    }),
                } as any);

            const result = await BillingService.handleCancellation("sub_ultra", "user-1", mockDb);

            expect(result.success).toBe(true);
            expect(result.effectiveTier).toBe("pro");
        });

        it("downgrades to free if user has no remaining active subscriptions", async () => {
            vi.mocked(mockDb.select)
                .mockReturnValueOnce({
                    from: () => ({
                        where: () => ({
                            limit: () =>
                                Promise.resolve([
                                    { id: "sub-sole-id", userId: "user-1", stripeSubscriptionId: "sub_sole" },
                                ]),
                        }),
                    }),
                } as any)
                .mockReturnValueOnce({
                    from: () => ({
                        where: () =>
                            Promise.resolve([
                                { tier: "free", status: "canceled" },
                            ]),
                    }),
                } as any);

            const result = await BillingService.handleCancellation("sub_sole", "user-1", mockDb);

            expect(result.success).toBe(true);
            expect(result.effectiveTier).toBe("free");
        });

        it("throws error if userId cannot be resolved", async () => {
            vi.mocked(mockDb.select).mockReturnValueOnce({
                from: () => ({
                    where: () => ({
                        limit: () => Promise.resolve([]),
                    }),
                }),
            } as any);

            await expect(
                BillingService.handleCancellation("sub_phantom", null, mockDb)
            ).rejects.toThrow("userId unresolved");
        });
    });

    describe("handleInvoicePaymentFailed (Grace period preservation - LUGX-026)", () => {
        it("marks subscription as past_due and preserves other active subscriptions", async () => {
            vi.mocked(mockDb.select)
                .mockReturnValueOnce({
                    from: () => ({
                        where: () => ({
                            limit: () =>
                                Promise.resolve([
                                    { id: "sub-1-id", userId: "user-1", stripeSubscriptionId: "sub_failed" },
                                ]),
                        }),
                    }),
                } as any)
                .mockReturnValueOnce({
                    from: () => ({
                        where: () =>
                            Promise.resolve([
                                { tier: "pro", status: "past_due" },
                            ]),
                    }),
                } as any);

            const result = await BillingService.handleInvoicePaymentFailed(
                {
                    userId: "user-1",
                    stripeSubscriptionId: "sub_failed",
                },
                mockDb
            );

            expect(result.success).toBe(true);
            expect(result.effectiveTier).toBe("free");
            expect(result.subscriptionId).toBe("sub_failed");
        });
    });
});
