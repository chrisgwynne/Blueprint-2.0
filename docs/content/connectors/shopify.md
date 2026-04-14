---
title: "Shopify"
section: "Connectors"
order: 6
---

# Shopify

The Shopify connector pulls order history, revenue, average order value, product inventory, and customer data via the Shopify Admin API. It syncs every 6 hours and feeds the Merchant and Quill agents.

---

## Setup

### 1. Create a custom app in Shopify

1. In your Shopify admin, go to **Settings → Apps and sales channels → Develop apps**.
2. If prompted, click **Allow custom app development**.
3. Click **Create an app**. Give it a name (e.g. "Blueprint").
4. On the app's configuration page, click **Configure Admin API scopes**.
5. Enable the following scopes:
   - `read_orders`
   - `read_products`
   - `read_customers`
   - `read_inventory` (for stock levels)
6. Click **Save**.
7. Click **Install app**, then confirm.
8. Under **Admin API access token**, click **Reveal token once** and copy it. You cannot view this token again after leaving the page.

### 2. Add the connector in Blueprint

Go to **Connectors → Add → Shopify** and enter:

- **Shop domain** — your Shopify store domain in the format `yourstore.myshopify.com`. Do not include `https://`.
- **Admin API access token** — the token copied in step 1.

Click **Connect**. Blueprint runs a health check against your shop and confirms the connection.

---

## Data pulled

Each sync fetches orders from the last 120 days, all active products, and up to 250 recent customers.

| Data | Description |
|---|---|
| Orders | Full order list from the last 120 days, including cancelled and voided orders (marked with status) |
| Revenue | Total revenue from countable orders (excludes cancelled, voided, and fully refunded orders) |
| Average order value | Revenue divided by order count |
| Top products | Up to 20 products ranked by revenue contribution |
| Daily sales | Revenue and order counts broken down by day |
| Products | Up to 200 active products with variant counts, inventory, and pricing |
| Customers | Up to 100 customers with order count and lifetime spend |
| Inventory | Tracked variants sorted by stock level ascending (lowest stock first) |

Orders are dated by `processed_at` (payment capture date) rather than `created_at`, so the date reflects when revenue was actually recognised.

**Update frequency:** every 6 hours.

---

## Metrics written to the database

`extractMetrics()` writes these rows after each sync:

| Metric name | Value |
|---|---|
| `revenue` | Total revenue (last 120 days) |
| `orders` | Total order count |
| `aov` | Average order value |
| `customers` | Customer count |
| `top_products_data` | Rich data — top 20 products by revenue |
| `daily_revenue` | Rich data — revenue per day |
| `orders_daily` | Rich data — order count per day |
| `recent_orders_data` | Rich data — full recent order list |
| `products_data` | Rich data — product catalogue summary |
| `customers_data` | Rich data — customer list |
| `inventory_data` | Rich data — tracked variants sorted by stock level |

---

## Signals produced

| Signal ID | Severity | Trigger condition |
|---|---|---|
| `shopify_revenue_drop` | alert | Revenue drops ≥20% vs previous period |
| `shopify_aov_drop` | warning | Average order value drops ≥15% vs previous period |
| `shopify_order_spike` | info | Order count grows ≥50% vs previous period |
| `shopify_no_orders` | alert | No revenue recorded on today's date |
| `shopify_refund_spike` | warning | Refund rate exceeds threshold vs previous period |

---

## Agents triggered after sync

| Agent | Role |
|---|---|
| Merchant | Primary consumer — analyses revenue, product performance, and inventory |
| Quill | Uses product and order data to inform content and description work |
| Conductor | Reviews signals and decides whether specialist agents should act |

Merchant minimum 4 hours between runs, Quill minimum 12 hours.

---

## Troubleshooting

**`Shopify API error 401: [API] Invalid API key or access token`**

The access token is wrong or has been revoked. Tokens are shown only once when created. Regenerate a new token: go to Shopify Admin → Settings → Apps → Develop apps → your app → Uninstall app, then reinstall and generate a fresh token. Update the connector config in Blueprint with the new token.

**`Shopify orders error 403`**

The app is missing required scopes. Go to Shopify Admin → Settings → Apps → Develop apps → your app → API credentials → Configure Admin API scopes, and ensure `read_orders`, `read_products`, and `read_customers` are checked. After saving, reinstall the app to apply the new scopes.

**Wrong shop domain format**

The shop domain must be `yourstore.myshopify.com` with no protocol prefix. Entering `https://yourstore.myshopify.com` or just `yourstore` will cause the API call to fail.

**Shopify no_orders signal fires incorrectly**

The `shopify_no_orders` signal checks whether today's date appears in the daily sales data. If Blueprint is running in a timezone that differs significantly from your store's timezone, this check can trigger at the wrong time. The signal clears automatically on the next sync once a same-day order appears.
