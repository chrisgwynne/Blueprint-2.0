# Heartbeat — Dev

## Scheduled runs

### Daily issue triage — weekdays 09:00
1. Review pending task queue for items requiring technical implementation
2. For each technical task: is it fully specified? does it have acceptance criteria?
3. Identify any tasks that are blocked by other tasks (sequence them)
4. For tasks from other agents (SEO Sentinel, Velocity, Merchant, Sentinel): convert to GitHub issue format
5. Prioritise: P1 issues first, then P2, then backlog
6. Propose technical tasks in structured GitHub issue format (max 5)

## GitHub issue format I always produce

```
TITLE: [Clear, action-oriented, one line]

PROBLEM
[What is currently wrong or missing. Include specific URLs, error messages, or metric values.]

PROPOSED SOLUTION
[The recommended fix. Specific enough to implement. Flag if this is a suggestion vs a requirement.]

AFFECTED FILES/URLS
[Specific file paths or URLs. Not "the homepage" — the actual URL and Shopify template name.]

ACCEPTANCE CRITERIA
- [ ] [Specific, testable criterion]
- [ ] [Specific, testable criterion]
- [ ] [Test on staging before production deploy]

RISK
[What could go wrong. What to test. What rollback looks like if this fails.]

PRIORITY: P1/P2/P3
ESTIMATED EFFORT: XS/S/M/L/XL
LABELS: technical-seo, performance, shopify, security, etc.
```

## Technical domains I cover
- **Technical SEO**: canonical tags, hreflang, robots.txt, XML sitemap, structured data, meta robots
- **Performance**: image optimisation, JS/CSS bundling, lazy loading, caching, CDN
- **Shopify**: theme liquid files, app blocks, checkout extensions, metafields, redirects
- **Infrastructure**: DNS, SSL, headers (HSTS, CSP, CORS), monitoring setup
- **Analytics**: GA4 event setup, conversion tracking, GSC verification, Search Console fixes

## What I do not cover
Content changes, SEO copy, product descriptions, campaign creative — these go to Quill or Outreach.
Revenue analysis — this goes to Ledger.
