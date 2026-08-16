# Stripe Setup Guide

This guide will help you complete the Stripe integration setup for LUGX.

## ⚠️ IMPORTANT: You MUST complete these steps before the payment system will work!

### Step 1: Create Products in Stripe Dashboard

1. **Go to Stripe Dashboard (Test Mode)**:
   - Visit: https://dashboard.stripe.com/test/products
   - Make sure you're in **Test Mode** (toggle at top right)

2. **Create Pro Plan Product**:
   - Click "+ Add product"
   - Name: `LUGX Pro`
   - Description: `Pro subscription plan for LUGX - 20,000 words/day, 5 summaries/day, 10 prompts/day`
   - Pricing model: `Recurring`
   - Price: `$12.00`
   - Billing period: `Monthly`
   - Click "Save product"
   - **COPY THE PRICE ID** (format: `price_XXXXXXXXXXXXX`)

3. **Create Ultra Plan Product**:
   - Click "+ Add product"
   - Name: `LUGX Ultra`
   - Description: `Ultra subscription plan for LUGX - 250,000 words/day, 50 summaries/day, 500 prompts/day`
   - Pricing model: `Recurring`
   - Price: `$120.00`
   - Billing period: `Monthly`
   - Click "Save product"
   - **COPY THE PRICE ID** (format: `price_XXXXXXXXXXXXX`)

### Step 2: Update Environment Variables

Open your `.env` file and replace the PLACEHOLDER values:

```bash
# Replace these placeholders with the actual Price IDs from Step 1
STRIPE_PRO_PRICE_ID=price_ACTUAL_PRO_PRICE_ID_HERE
STRIPE_ULTRA_PRICE_ID=price_ACTUAL_ULTRA_PRICE_ID_HERE
```

### Step 3: Set Up Webhook (Optional for Testing)

For local testing, you can use Stripe CLI:

1. **Install Stripe CLI**: https://stripe.com/docs/stripe-cli

2. **Login to Stripe**:
```bash
stripe login
```

3. **Forward webhooks to your local server**:
```bash
stripe listen --forward-to localhost:3000/api/stripe/webhook
```

4. The CLI will show you a **webhook signing secret** (starts with `whsec_`). Update it in `.env`:
```bash
STRIPE_WEBHOOK_SECRET=whsec_YOUR_LOCAL_SECRET_HERE
```

### Step 4: Testing the Integration

1. **Start your development server**:
```bash
npm run dev
```

2. **Test the upgrade flow**:
   - Login to your app
   - Go to `/account`
   - Click "Upgrade" button next to Pro plan
   - You should be redirected to Stripe Checkout page

3. **Use Stripe test card**:
   - Card number: `4242 4242 4242 4242`
   - Expiry: Any future date (e.g., `12/25`)
   - CVC: Any 3 digits (e.g., `123`)
   - ZIP: Any 5 digits (e.g., `12345`)

4. **Complete payment and verify**:
   - After successful payment, you'll be redirected to `/dashboard`
   - Go to `/account` again
   - Your plan should now show "Pro" instead of "Free"
   - Your quota limits should be updated accordingly

### Step 5: Production Deployment

When ready to go live:

1. **Switch to Live Mode in Stripe Dashboard**
2. **Create the same products in Live Mode**
3. **Get Live API Keys**:
   - Go to https://dashboard.stripe.com/apikeys
   - Copy Publishable key and Secret key
4. **Update production environment variables**:
```bash
STRIPE_SECRET_KEY=sk_live_XXXXXXXX
NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=pk_live_XXXXXXXX
STRIPE_PRO_PRICE_ID=price_live_XXXXXXXX
STRIPE_ULTRA_PRICE_ID=price_live_XXXXXXXX
```
5. **Set up production webhook**:
   - Go to https://dashboard.stripe.com/webhooks
   - Add endpoint: `https://yourdomain.com/api/stripe/webhook`
   - Select events: `checkout.session.completed`, `customer.subscription.updated`, `customer.subscription.deleted`
   - Copy webhook signing secret and update `STRIPE_WEBHOOK_SECRET`

## Troubleshooting

### "Failed to create checkout session" Error
- **Check**: Make sure you've replaced the PLACEHOLDER Price IDs in `.env`
- **Check**: Verify Price IDs are correct (start with `price_`)
- **Check**: Ensure you're using Test Mode keys with Test Mode Price IDs

### Webhook not receiving events
- **Local**: Make sure Stripe CLI is running with `stripe listen`
- **Production**: Verify webhook URL is accessible and starts with `https://`
- **Check**: Webhook secret matches the one in Stripe Dashboard

### Payment succeeds but tier doesn't update
- **Check**: Look at server console logs for webhook errors
- **Check**: Verify database connection is working
- **Check**: Ensure metadata (userId, tier) is properly set in checkout session

## Security Checklist

✅ Never commit `.env` file to Git (should be in `.gitignore`)  
✅ Use Test Mode for development  
✅ Webhook signature verification is enabled  
✅ User authentication is required before creating checkout sessions  
✅ Tier validation prevents unauthorized upgrades  

## Support

If you encounter issues:
1. Check server console logs
2. Check Stripe Dashboard → Logs for API errors
3. Verify all environment variables are set correctly
4. Test with Stripe test cards first
