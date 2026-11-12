# 竹里集 · 竹编生活美学

## Stripe configuration

The site uses Stripe Checkout Sessions for one-time physical-goods payments. Configure these runtime secrets in Sites before enabling live payment:

- `STRIPE_SECRET_KEY`: restricted server-side Stripe key (`rk_test_...` for a sandbox or `rk_live_...` for live).
- `STRIPE_WEBHOOK_SECRET`: signing secret for the webhook endpoint.

Create the webhook endpoint at `/api/stripe/webhook` and subscribe to:

- `checkout.session.completed`
- `checkout.session.async_payment_succeeded`
- `checkout.session.async_payment_failed`

The order is fulfilled from webhook events, not the success page. If `STRIPE_SECRET_KEY` is missing, the storefront falls back to the demo order API and displays a configuration notice.
