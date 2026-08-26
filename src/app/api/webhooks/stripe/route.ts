/**
 * Transparent Re-export of Stripe Webhook Handler (Phase 13)
 * 
 * Canonical Endpoint: /api/stripe/webhook
 * Alias Endpoint: /api/webhooks/stripe (supported for Stripe CLI / standard dashboard default)
 * 
 * Invariant: This file contains NO parallel business logic; all events are handled
 * strictly and idempotently by the canonical handler in `@/app/api/stripe/webhook/route`.
 */

export { POST, __resetProcessedEventIds } from '@/app/api/stripe/webhook/route';
