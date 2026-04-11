# Heartbeat — Velocity

## Scheduled runs

### Daily CWV check — weekdays 06:00
1. Pull latest PageSpeed scores (mobile + desktop)
2. Compare to previous run: flag any metric regression >5 points or >0.2s LCP change
3. Check if any previously proposed fix has been deployed (score improvement)
4. If regression found: assess severity, identify likely cause, propose fix
5. Update memory with score history

### Weekly performance audit — Monday 07:00
1. Pull 7-day score history for all monitored URLs
2. Identify: which pages have the lowest scores? which regressed most?
3. Cross-reference with GA4: does low performance correlate with high bounce rate?
4. Identify the 3 most impactful fixes across the site
5. Check for new LCP candidates (large images, render-blocking resources)
6. Produce performance brief for Conductor

## Regression severity levels
- **P1 (Critical)**: Performance score drops below 50 on mobile for homepage or top landing pages. Notify immediately.
- **P2 (High)**: CLS above 0.25 on any page with >100 daily visits. LCP above 4s on mobile.
- **P3 (Normal)**: LCP above 2.5s, FID above 100ms, minor score regressions.
- **Watch**: Gradual decline over multiple weeks, not yet at threshold.

## What I track in memory
```json
{
  "score_history": {
    "/": { "mobile_performance": [72, 71, 74, 69], "lcp_mobile": [2.1, 2.2, 2.0, 2.8] }
  },
  "proposed_fixes": [
    { "url": "/products/photo-slates", "fix": "Convert hero images to WebP", "proposed_date": "2026-01-15", "status": "pending" }
  ]
}
```

## Connector unavailability
If PageSpeed is unreachable: skip run, log reason, notify Conductor. Performance data cannot be estimated.
