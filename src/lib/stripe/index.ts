/**
 * Stripe Integration Library
 * 
 * Provides secure wrapper functions for Stripe API operations.
 * IMPORTANT: This file runs on the server only. Never expose secret keys to the client.
 */

import Stripe from 'stripe';

// Initialize Stripe instance with secret key or build-safe placeholder for static analysis
export const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || 'sk_test_placeholder', {
    apiVersion: '2025-12-15.clover',
    typescript: true,
});

/**
 * Validate that STRIPE_SECRET_KEY is configured at runtime before dispatching operations.
 */
function ensureStripeSecretKey(): void {
    if (!process.env.STRIPE_SECRET_KEY) {
        throw new Error('STRIPE_SECRET_KEY is not defined in environment variables');
    }
}

/**
 * Create or retrieve a Stripe customer
 * @param userId - User UUID from database
 * @param email - User email
 * @returns Stripe Customer ID
 */
export async function getOrCreateStripeCustomer(
    userId: string,
    email: string,
    name?: string
): Promise<string> {
    ensureStripeSecretKey();
    try {
        // Search for existing customer by metadata
        const existingCustomers = await stripe.customers.list({
            email,
            limit: 1,
        });

        if (existingCustomers.data.length > 0) {
            return existingCustomers.data[0].id;
        }

        // Create new customer if not found
        const customer = await stripe.customers.create({
            email,
            name: name || email,
            metadata: {
                userId, // Link to our database
            },
        });

        return customer.id;
    } catch (error) {
        console.error('Error in getOrCreateStripeCustomer:', error);
        throw new Error('Failed to create or retrieve Stripe customer');
    }
}

/**
 * Create a Stripe Checkout Session for subscription
 * @param customerId - Stripe Customer ID
 * @param priceId - Stripe Price ID for the subscription
 * @param userId - User UUID for metadata
 * @param tier - Subscription tier name
 * @returns Checkout Session object
 */
export async function createCheckoutSession(
    customerId: string,
    priceId: string,
    userId: string,
    tier: 'pro' | 'ultra'
): Promise<Stripe.Checkout.Session> {
    ensureStripeSecretKey();
    try {
        let appUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
        if (appUrl.includes('localhost') && appUrl.startsWith('https://')) {
            appUrl = appUrl.replace('https://', 'http://');
        }

        const session = await stripe.checkout.sessions.create({
            customer: customerId,
            mode: 'subscription',
            payment_method_types: ['card'],
            line_items: [
                {
                    price: priceId,
                    quantity: 1,
                },
            ],
            success_url: `${appUrl}/dashboard?session_id={CHECKOUT_SESSION_ID}`,
            cancel_url: `${appUrl}/account`,
            metadata: {
                userId,
                tier,
            },
            subscription_data: {
                metadata: {
                    userId,
                    tier,
                },
            },
        });

        return session;
    } catch (error) {
        console.error('Error in createCheckoutSession:', error);
        throw new Error('Failed to create checkout session');
    }
}

/**
 * Construct and verify a Webhook event from Stripe
 * @param payload - Raw request body
 * @param signature - Stripe signature header
 * @returns Verified Stripe Event
 */
export function constructWebhookEvent(
    payload: string | Buffer,
    signature: string
): Stripe.Event {
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
    if (!webhookSecret) {
        throw new Error('STRIPE_WEBHOOK_SECRET is not defined in environment variables');
    }

    try {
        const event = stripe.webhooks.constructEvent(
            payload,
            signature,
            webhookSecret
        );

        return event;
    } catch (error) {
        console.error('Webhook signature verification failed:', error);
        throw new Error('Invalid webhook signature');
    }
}

/**
 * Get Stripe Customer by ID
 * @param customerId - Stripe Customer ID
 * @returns Customer object or null
 */
export async function getStripeCustomer(
    customerId: string
): Promise<Stripe.Customer | null> {
    ensureStripeSecretKey();
    try {
        const customer = await stripe.customers.retrieve(customerId);
        if (customer.deleted) {
            return null;
        }
        return customer as Stripe.Customer;
    } catch (error) {
        console.error('Error retrieving Stripe customer:', error);
        return null;
    }
}

/**
 * Cancel a Stripe subscription
 * @param subscriptionId - Stripe Subscription ID
 * @returns Canceled subscription object
 */
export async function cancelStripeSubscription(
    subscriptionId: string
): Promise<Stripe.Subscription> {
    ensureStripeSecretKey();
    try {
        const subscription = await stripe.subscriptions.cancel(subscriptionId);
        return subscription;
    } catch (error) {
        console.error('Error canceling subscription:', error);
        throw new Error('Failed to cancel subscription');
    }
}
