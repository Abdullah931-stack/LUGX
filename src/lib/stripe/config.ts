/**
 * Stripe Configuration
 * 
 * Defines Stripe Price IDs for each subscription tier.
 * These Price IDs must be created in Stripe Dashboard first.
 */

export type StripeTier = 'pro' | 'ultra';

/**
 * Stripe Price IDs for each tier
 * 
 * IMPORTANT: These are TEST mode Price IDs. 
 * You MUST create these products in your Stripe Dashboard:
 * 1. Go to https://dashboard.stripe.com/test/products
 * 2. Create products for "Pro" ($12/month) and "Ultra" ($120/month)
 * 3. Copy the Price IDs and update them here
 * 
 * For now, using placeholder IDs - YOU MUST UPDATE THESE!
 */
export const STRIPE_PRICE_IDS: Record<StripeTier, string> = {
    pro: process.env.STRIPE_PRO_PRICE_ID || 'price_PLACEHOLDER_PRO',
    ultra: process.env.STRIPE_ULTRA_PRICE_ID || 'price_PLACEHOLDER_ULTRA',
};

/**
 * Get Stripe Price ID for a tier
 * @param tier - Subscription tier
 * @returns Stripe Price ID
 */
export function getStripePriceId(tier: StripeTier): string {
    const priceId = STRIPE_PRICE_IDS[tier];

    if (priceId.includes('PLACEHOLDER')) {
        console.warn(
            `⚠️  WARNING: Using placeholder Price ID for ${tier}. ` +
            `Please create products in Stripe Dashboard and update STRIPE_PRICE_IDS.`
        );
    }

    return priceId;
}

/**
 * Validate if a tier is valid for Stripe checkout
 * @param tier - Tier to validate
 * @returns boolean
 */
export function isValidStripeTier(tier: string): tier is StripeTier {
    return tier === 'pro' || tier === 'ultra';
}

/**
 * Reverse mapping from Stripe Price ID to subscription tier (LUGX-068).
 * Matches against configured price IDs or price ID naming conventions.
 * Returns null for unrecognized price IDs to fail closed.
 */
export function getTierFromPriceId(priceId?: string | null): StripeTier | null {
    if (!priceId) return null;

    if (
        priceId === STRIPE_PRICE_IDS.ultra ||
        (process.env.STRIPE_ULTRA_PRICE_ID && priceId === process.env.STRIPE_ULTRA_PRICE_ID) ||
        priceId.toLowerCase().includes('ultra')
    ) {
        return 'ultra';
    }

    if (
        priceId === STRIPE_PRICE_IDS.pro ||
        (process.env.STRIPE_PRO_PRICE_ID && priceId === process.env.STRIPE_PRO_PRICE_ID) ||
        priceId.toLowerCase().includes('pro')
    ) {
        return 'pro';
    }

    return null;
}
