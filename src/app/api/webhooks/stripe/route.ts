/**
 * Re-export Stripe Webhook Handler to support both URL paths:
 * 1. /api/stripe/webhook (standard)
 * 2. /api/webhooks/stripe (Stripe CLI / common dashboard default)
 */

export { POST, __resetProcessedEventIds } from '@/app/api/stripe/webhook/route';
