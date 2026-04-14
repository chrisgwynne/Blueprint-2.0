---
title: "Stripe"
description: "Connect Stripe to track MRR, churn, refund rates, and subscription health in Blueprint."
section: "Connectors"
order: 16
---

# Stripe

The Stripe connector pulls subscription metrics, revenue data, customer activity, and payment health from the Stripe API. It syncs every hour and feeds the Merchant and Conductor agents with revenue intelligence.

---

## Setup

### 1. Create a restricted API key

Blueprint only needs read access to your Stripe account. Using a restricted key is strongly recommended over a secret key.

1. Log in to the [Stripe Dashboard](https://dashboard.stripe.com).
2. Go to **Developers → API keys**.
3. Click **Create restricted key**.
4. Give it a name such as "Blueprint (read-only)".
5. Under permissions, enable **Read** access for:
   - **Customers**
   - **Subscriptions**
   - **Charges**
   - **Refunds**
   - **Payment Intents**
   - **Invoices**
6. Click **Create key** and copy the key. It starts with `rk_live_` (or `rk_test_` for test mode).

> [!WARNING]
> Do not use your full secret key (`sk_live_`). A restricted key limits blast radius if Blueprint's credentials are ever exposed. The connector does not need write access.

### 2. Add the connector in Blueprint

Go to **Connectors → Add → Stripe** and paste the restricted API key into the **API Key** field. Click **Connect**. Blueprint verifies the key and confirms your Stripe account name.

---

## Data pulled

Each sync fetches active subscriptions, recent charges, refund data, and failed payment information.

| Data | Description |
|---|---|
| Subscriptions | All active subscriptions with plan details and billing intervals |
| Customers | Total customer count, new customers (7d / 30d), churned customers |
| Charges | Recent charge history including amounts and outcomes |
| Refunds | Refund amounts and reasons from the last 30 days |
| Failed payments | Count and rate of failed payment intent attempts |
| Invoices | Paid and unpaid invoice data for MRR calculation |

**Update frequency:** every 1 hour.

> [!NOTE]
> Blueprint calculates MRR from active subscriptions and their billing intervals, not from invoice totals. Monthly subscriptions contribute their plan amount directly; annual subscriptions are divided by 12. This gives a more accurate forward-looking MRR than summing past invoices.

---

## Metrics written to the database

| Metric name | Value |
|---|---|
| `stripe.mrr` | Monthly recurring revenue (calculated from active subscriptions) |
| `stripe.arr` | Annualised recurring revenue (MRR × 12) |
| `stripe.new_customers_7d` | New customers in the last 7 days |
| `stripe.new_customers_30d` | New customers in the last 30 days |
| `stripe.churned_customers` | Subscriptions cancelled in the last 30 days |
| `stripe.refund_rate` | Refund amount as a percentage of total charge volume (30 days) |
| `stripe.average_order_value` | Average successful charge amount |
| `stripe.failed_payment_rate` | Failed payment attempts as a percentage of total attempts |
| `stripe.subscription_count` | Count of all active subscriptions |
| `stripe.customers_data` | Rich data — recent customer list |

---

## Signals produced

| Signal ID | Severity | Trigger condition |
|---|---|---|
| `stripe_mrr_drop` | alert | MRR drops >10% week-over-week |
| `stripe_refund_spike` | warning | Refund rate exceeds 5% of charge volume |
| `stripe_failed_payments` | warning | Failed payment rate exceeds 3% of attempts |

> [!TIP]
> The `stripe_mrr_drop` signal compares the current calculated MRR against the MRR recorded 7 days prior. A sudden drop usually indicates cancellations or failed renewals. Check the `stripe.churned_customers` metric alongside it for context.

---

## Agents triggered after sync

| Agent | Role |
|---|---|
| Merchant | Primary consumer — analyses revenue trends, churn, and subscription health |
| Conductor | Reviews revenue signals and escalates tasks when thresholds are breached |

---

## Troubleshooting

**`Your API key does not have the required permissions`**

Your restricted key is missing one or more required read scopes. Go to **Developers → API keys** in Stripe, find the key, and check that all six resource types have Read access enabled. Save and re-test the connector.

**MRR looks unexpectedly high or low**

Blueprint's MRR calculation only counts subscriptions with `status: active`. Trialing subscriptions are excluded by default. If your business counts trials as MRR, this will produce a lower figure than your Stripe dashboard's MRR widget, which may include trials. This is intentional — Blueprint reports committed revenue.

**Refund rate signal fires on a promotional period**

If you are running a high-volume refund campaign or promotion, you can temporarily suppress the signal in **Connectors → Stripe → Signal Settings** by disabling `stripe_refund_spike`. Re-enable it after the promotion ends.

**Test mode data**

If your key starts with `rk_test_`, Blueprint connects to your Stripe test environment. All metrics will reflect test data. Switch to a live-mode restricted key for production monitoring.
