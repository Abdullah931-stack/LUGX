/**
 * Transparent Re-export of Stripe Webhook Handler (Phase 12)
 * 
 * Canonical Endpoint: /api/stripe/webhook
 * Alias Endpoint: /api/billing/webhook (standard billing webhook route)
 * 
 * Invariant: This file contains NO parallel business logic; all events are handled
 * strictly and idempotently by the canonical handler in `@/app/api/stripe/webhook/route`.
 */

export const dynamic = 'force-dynamic';

export { POST } from '@/app/api/stripe/webhook/route';
