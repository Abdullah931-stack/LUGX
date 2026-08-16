/**
 * Upgrade Button Component
 * 
 * Client component for handling subscription upgrades via Stripe.
 */

'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { useToast } from '@/hooks/use-toast';
import { ExternalLink, Loader2 } from 'lucide-react';

interface UpgradeButtonProps {
    tier: 'pro' | 'ultra';
    currentTier: string;
    disabled?: boolean;
}

export function UpgradeButton({ tier, currentTier, disabled = false }: UpgradeButtonProps) {
    const [loading, setLoading] = useState(false);
    const { toast } = useToast();

    const handleUpgrade = async () => {
        try {
            setLoading(true);

            // Call API to create checkout session
            const response = await fetch('/api/stripe/create-checkout', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ tier }),
            });

            const data = await response.json();

            if (!response.ok) {
                // Handle error response
                throw new Error(data.error || 'Failed to create checkout session');
            }

            if (data.url) {
                // Redirect to Stripe Checkout
                window.location.href = data.url;
            } else {
                throw new Error('No checkout URL received');
            }

        } catch (error) {
            console.error('Upgrade error:', error);

            // Show error toast
            toast({
                title: 'Upgrade Failed',
                description: error instanceof Error
                    ? error.message
                    : 'An unexpected error occurred. Please try again.',
                variant: 'destructive',
            });
        } finally {
            setLoading(false);
        }
    };

    // Determine if button should be disabled
    // Allow upgrades: Free→Pro, Free→Ultra, Pro→Ultra
    // Disable if: already on this tier, on higher tier, or loading
    const tierHierarchy: Record<string, number> = { free: 0, pro: 1, ultra: 2 };
    const currentTierLevel = tierHierarchy[currentTier] || 0;
    const targetTierLevel = tierHierarchy[tier] || 0;

    // Disable if already on this tier or on a higher tier
    const isDisabled = disabled || loading || currentTierLevel >= targetTierLevel;

    return (
        <Button
            variant="primary"
            size="sm"
            onClick={handleUpgrade}
            disabled={isDisabled}
            className="gap-2"
        >
            {loading ? (
                <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Processing...
                </>
            ) : (
                <>
                    Upgrade to {tier.charAt(0).toUpperCase() + tier.slice(1)}
                    <ExternalLink className="w-4 h-4" />
                </>
            )}
        </Button>
    );
}
