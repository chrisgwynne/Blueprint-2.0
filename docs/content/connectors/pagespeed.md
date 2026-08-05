---
title: "Google PageSpeed Insights"
section: "Connectors"
order: 4
---

# Google PageSpeed Insights

The PageSpeed connector runs mobile and desktop Lighthouse audits against your site via the PageSpeed Insights API. It reports performance scores, Core Web Vitals, and a ranked list of performance opportunities. It syncs every 24 hours.

---

## Authentication

PageSpeed Insights supports two auth modes, resolved in this priority order on each request:

1. **API key** — Enter a key in the connector config, or set the `PAGESPEED_API_KEY` environment variable.
2. **Anonymous** — Works without any auth at a lower rate limit. Sufficient for a single site syncing once per day.

PageSpeed does not use user OAuth. Connecting GA4, GSC, GBP, Ads, or Merchant Center does not grant PageSpeed quota.

### Obtaining a PageSpeed API key (optional)

1. Go to [console.cloud.google.com](https://console.cloud.google.com).
2. Select your project.
3. Navigate to **APIs & Services → Library** and enable the **PageSpeed Insights API**.
4. Navigate to **APIs & Services → Credentials → Create Credentials → API key**.
5. Copy the key and paste it into the Blueprint connector config field labelled **API Key** (or set `PAGESPEED_API_KEY` in your environment).

---

## Setup

### 1. Add the connector

Go to **Connectors → Add → Google PageSpeed Insights**.

### 2. Set the URL to test

Enter the full URL to audit (e.g. `https://example.com`). If left blank, Blueprint falls back to the website URL set on the business profile (Settings → Business).

### 3. API key (optional)

If you do not have GA4 or GSC connected, paste an API key from the step above. Leave blank to use anonymous access.

---

## Data pulled

Both mobile and desktop strategies are fetched in parallel on each sync.

| Category | What is measured |
|---|---|
| Performance score | 0–100 Lighthouse performance score |
| Accessibility score | 0–100 Lighthouse accessibility score |
| Best Practices score | 0–100 |
| SEO score | 0–100 Lighthouse on-page SEO score |
| LCP | Largest Contentful Paint (ms) |
| FID | Max Potential FID (ms) |
| CLS | Cumulative Layout Shift (score) |
| FCP | First Contentful Paint (ms) |
| TTFB | Time to First Byte (ms) |
| Speed Index | Speed Index (ms) |
| TTI | Time to Interactive (ms) |
| TBT | Total Blocking Time (ms) |
| Opportunities | Lighthouse opportunity audits with estimated savings (ms) |
| Diagnostics | Non-passing audits below 0.9 score |

**Update frequency:** every 24 hours.

---

## Metrics written to the database

`extractMetrics()` writes these rows for both `mobile` and `desktop` strategies. Replace `{strategy}` with `mobile` or `desktop`:

| Metric name | Value |
|---|---|
| `pagespeed.{strategy}.performance_score` | Performance score (0–100) |
| `pagespeed.{strategy}.accessibility_score` | Accessibility score |
| `pagespeed.{strategy}.best_practices_score` | Best Practices score |
| `pagespeed.{strategy}.seo_score` | SEO score |
| `pagespeed.{strategy}.lcp_ms` | LCP in milliseconds |
| `pagespeed.{strategy}.fid_ms` | Max Potential FID in milliseconds |
| `pagespeed.{strategy}.cls` | CLS score |
| `pagespeed.{strategy}.fcp_ms` | FCP in milliseconds |
| `pagespeed.{strategy}.ttfb_ms` | TTFB in milliseconds |
| `pagespeed.{strategy}.speed_index_ms` | Speed Index in milliseconds |
| `pagespeed.{strategy}.tti_ms` | TTI in milliseconds |
| `pagespeed.{strategy}.tbt_ms` | TBT in milliseconds |
| `pagespeed.{strategy}.opportunities` | Rich data — opportunity audits with savings |
| `pagespeed.{strategy}.diagnostics` | Rich data — failing diagnostic audits |

---

## Signals produced

Signal rules evaluate the **mobile** result only.

| Signal ID | Severity | Trigger condition |
|---|---|---|
| `pagespeed_regression` | alert | Mobile performance score drops ≥10 points vs previous sync |
| `cwv_lcp_failing` | alert | LCP >2,500ms (needs improvement); confidence increases at >4,000ms (poor) |
| `cwv_cls_failing` | alert | CLS >0.1 (needs improvement); poor at >0.25 |
| `cwv_fid_failing` | warning | FID or TBT >100ms (needs improvement); poor at >300ms |
| `score_drop_mobile` | alert | Mobile performance score <50 (poor); severity increases at <30 (critical) |
| `opportunities_detected` | info | One or more opportunity audits have potential savings |

Google's Core Web Vitals thresholds applied:

| Metric | Good | Needs improvement | Poor |
|---|---|---|---|
| LCP | ≤2,500ms | 2,500–4,000ms | >4,000ms |
| CLS | ≤0.1 | 0.1–0.25 | >0.25 |
| FID/TBT | ≤100ms | 100–300ms | >300ms |

---

## Troubleshooting

**"API key not valid" error**

The most common cause is the PageSpeed Insights API not being enabled on the Cloud project that owns the key. Go to [console.cloud.google.com/apis/library/pagespeedonline.googleapis.com](https://console.cloud.google.com/apis/library/pagespeedonline.googleapis.com) and enable it. Also check that the key has not been restricted to specific APIs or referrers.

**Quota exceeded — anonymous request**

If the error message references project number `583797351490`, the request was treated as anonymous because no PageSpeed API key was applied. Add a PageSpeed API key or wait for anonymous quota to reset.

**Quota exceeded — authenticated request**

Authenticated PageSpeed quota resets at midnight Pacific. For higher limits, add a billing account to your Cloud project. A single URL syncing once per day stays well within free quota.

**"No URL configured" on health check**

The connector has no URL set and the business profile has no website URL. Enter a URL directly in the connector config.
