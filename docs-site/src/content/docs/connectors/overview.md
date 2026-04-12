---
title: Connectors Overview
description: How Blueprint connects to your business tools
---

Connectors pull data from external services on a polling schedule, write metrics to the database, and feed the signal engine.

## Available connectors

| Category | Connector | Auth | Signals |
|----------|-----------|------|---------|
| **Search & SEO** | Google Analytics 4 | OAuth | 5 |
| | Google Search Console | OAuth | 5 |
| | PageSpeed Insights | API key (optional) | 6 |
| | Google Business Profile | OAuth | 8 |
| | Google Ads | OAuth | 5 |
| **Commerce** | Shopify | API key | 4 |
| | Stripe | API key | 4 |
| **Email** | Brevo | API key | 3 |
| **Productivity** | Todoist | OAuth | 3 |
| **Infrastructure** | UptimeRobot | API key | 4 |
| **Code** | GitHub | PAT | 4 |
| **CMS** | WordPress | App password | 4 |
| | Kirby | Basic auth | 3 |
| **Marketing** | Stannp | API key | 3 |

## How connectors work

1. Connector syncs on its polling schedule (or manually via Sync Now)
2. `extractMetrics()` writes individual metric rows to the database
3. Signal engine evaluates all rules for that connector type
4. New signals are created and dispatched to webhooks/notifications

## Polling intervals

| Connector | Default |
|-----------|---------|
| UptimeRobot | 15 min |
| Todoist | 1 hour |
| Shopify, Stripe, GA4, Google Ads | 6 hours |
| GSC | 12 hours |
| PageSpeed | 24 hours |
| WordPress, Kirby, Stannp | 12 hours |

## Building a connector

See [Building a Connector](/connectors/building-a-connector/) for a step-by-step guide. A basic connector takes about 2 hours.
