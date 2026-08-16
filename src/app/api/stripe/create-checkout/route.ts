/**
 * API Route: Create Stripe Checkout Session
 * 
 * POST /api/stripe/create-checkout
 * 
 * Creates a Stripe Checkout Session for subscription upgrade.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getUser } from '@/lib/supabase/server';
import { getUserProfile } from '@/server/actions/auth-actions';
import { updateUserStripeCustomerId } from '@/server/actions/subscription-actions';
import { getOrCreateStripeCustomer, createCheckoutSession } from '@/lib/stripe';
import { getStripePriceId, isValidStripeTier } from '@/lib/stripe/config';

export async function POST(request: NextRequest) {
    try {
        // 1. Authenticate user
        const user = await getUser();

        if (!user) {
            return NextResponse.json(
                { error: 'Unauthorized. Please log in.' },
                { status: 401 }
            );
        }

        // 2. Parse request body
        const body = await request.json();
        const { tier } = body;

        // 3. Validate tier
        if (!tier || !isValidStripeTier(tier)) {
            return NextResponse.json(
                { error: 'Invalid tier. Must be "pro" or "ultra".' },
                { status: 400 }
            );
        }

        // 4. Get user profile
        const profileResult = await getUserProfile();

        if (!profileResult.success || !profileResult.data) {
            return NextResponse.json(
                { error: 'Failed to retrieve user profile.' },
                { status: 500 }
            );
        }

        const profile = profileResult.data;

        // 5. Prevent downgrade (optional check)
        if (profile.tier === 'ultra' && tier === 'pro') {
            return NextResponse.json(
                { error: 'Cannot downgrade from Ultra to Pro. Please contact support.' },
                { status: 400 }
            );
        }

        // 6. Check if already on requested tier
        if (profile.tier === tier) {
            return NextResponse.json(
                { error: `You are already subscribed to the ${tier} plan.` },
                { status: 400 }
            );
        }

        // 7. Get or create Stripe customer
        const stripeCustomerId = await getOrCreateStripeCustomer(
            user.id,
            profile.email,
            profile.displayName || undefined
        );

        // 8. Update Stripe customer ID in database if needed
        if (profile.stripeCustomerId !== stripeCustomerId) {
            await updateUserStripeCustomerId(user.id, stripeCustomerId);
        }

        // 9. Get Price ID for the tier
        const priceId = getStripePriceId(tier);

        // 10. Create Checkout Session
        const session = await createCheckoutSession(
            stripeCustomerId,
            priceId,
            user.id,
            tier
        );

        // 11. Return session URL
        return NextResponse.json({
            success: true,
            url: session.url,
            sessionId: session.id,
        });

    } catch (error) {
        console.error('Error in create-checkout API:', error);

        // Return user-friendly error message
        const errorMessage = error instanceof Error
            ? error.message
            : 'An unexpected error occurred';

        return NextResponse.json(
            {
                error: 'Failed to create checkout session',
                details: errorMessage
            },
            { status: 500 }
        );
    }
}
