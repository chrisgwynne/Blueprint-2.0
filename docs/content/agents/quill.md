---
title: "Quill"
description: "Content and copy strategist"
section: "Agents"
order: 4
---

# Quill

Quill is Blueprint's Content and Copy Strategist. It runs every Wednesday morning and works at the intersection of search data and human language: it takes what SEO Sentinel sees in keyword data and turns it into briefs specific enough that a writer needs no follow-up questions. It is not a content mill — every piece it proposes has a clear search intent to match, a specific keyword cluster to target, and a measurable conversion goal.

## Schedule

| Job | Cron | Description |
|-----|------|-------------|
| Weekly content audit | `0 9 * * 3` | Wednesday: GSC and GA4 review, content gap scan, task proposals |

---

## Required and Optional Connectors

**Required:** None. Quill runs without any connectors, though its proposals are much more targeted when data sources are connected.

**Optional:** Google Search Console (keyword positions, CTR data, impression volumes), GA4 (bounce rate, engagement time, page-level behaviour).

Without GSC, Quill works from the knowledge base and any business context already in the system. With GSC, it has the keyword-level data needed to propose precise meta description rewrites and identify content gaps from real search demand.

---

## Signal Triggers

Quill runs immediately when these signals are raised:

- `content_gap_detected` — produces a structured brief immediately
- `traffic_drop_7day` — assesses whether content decay is a contributing factor
- Manual commission from Conductor: "brief a piece on [topic]"

---

## What Quill Does Each Run

**CTR optimisation (meta descriptions and titles).** Quill pulls GSC data and identifies pages where CTR is below the site average for their ranking position. It compares the current title and meta description against the top-ranking competitors for that query and proposes a targeted rewrite.

**Content gap identification.** Quill looks for queries in GSC with significant impression volume where the site has no dedicated page. It cross-references impression volume, search intent, and the business's existing content to determine which gaps are worth filling.

**Declining page analysis.** Quill identifies existing pages where traffic has fallen over the last 28 days. For each, it diagnoses the likely cause (content staleness, ranking drop, seasonal decline) and proposes either a refresh or a targeted update.

**"Almost there" keyword briefs.** Queries ranked 8–20 with more than 50 weekly impressions are candidates for targeted optimisation. Quill proposes either a content brief for a new page or an expansion of an existing page that partially covers the topic.

---

## What a Quill Brief Looks Like

Every task Quill proposes includes:

- **Title** — the exact title of the proposed piece or rewrite
- **Type** — `new_piece` / `refresh` / `meta_update`
- **Target keyword** — primary keyword with approximate monthly search volume
- **Intent** — `informational` / `commercial` / `transactional`
- **Recommended length** — word count range
- **Key sections** — 3–6 section headings to cover
- **Beat this** — the top 1–2 ranking competitors and what to do better
- **Internal links** — specific existing pages to link to
- **Expected impact** — estimated traffic lift if the target position is achieved

---

## Example Output

```json
{
  "title": "Write new guide: 'Personalised Gifts for Mum' (1,900 monthly searches, position 14)",
  "description": "The query 'personalised gifts for mum' has 1,900 monthly searches. The site currently ranks at position 14 with a general category page that covers all recipients. A dedicated guide targeting this query with informational intent would likely rank position 5–8 based on current competition. The top-ranking result at position 1 covers product types but doesn't mention personalisation turnaround time or budget guidance — both of which convert browsing intent into purchase intent. Recommended format: 1,200-word guide. Structure: (1) What makes a gift feel personal (2) Top 8 product types with personalisation options (3) Choosing by budget (4) Personalisation timelines. Internal links: /products/photo-slates, /products/keepsakes, /products/engraved-jewellery. Beat the #1 result by adding specific turnaround times and a comparison table by budget range.",
  "action_type": "content_brief",
  "trust_tier": "yellow",
  "priority": "p2",
  "confidence": 0.83,
  "estimated_impact": "Ranking position 5–8 for 1,900 monthly searches at average CTR 8% = ~150 additional monthly visits. Commercial intent, above-average conversion likelihood."
}
```

---

## Collaboration Rhythm

After its Wednesday audit, Quill sends a structured summary to Conductor via the inbox briefing system and waits for priority confirmation before proceeding. It does not draft content until a brief is approved — it assumes nothing.

When Conductor or SEO Sentinel identifies a content opportunity in a different domain, they commission Quill by routing a `content_gap_detected` signal or a manual task. Quill provides the editorial judgement; Conductor and SEO Sentinel provide the strategic direction.

---

## Trust Tier

**Yellow.** All proposals require approval. Quill proposes briefs and meta updates — it does not publish or modify live pages directly.
