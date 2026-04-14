---
title: "Causal Attribution"
description: "How Blueprint works out what caused a metric change"
section: "The Brain"
order: 4
---

# Causal Attribution

A metric moved. What caused it?

This is the question that Blueprint's causal attribution system tries to answer — not "what happened?" but "why did it happen, and what should we do about it?"

---

## Why It Matters

Organic sessions dropped 18% this week. You have three plausible explanations:

1. The copy rewrite you did 3 weeks ago hurt the page's relevance signals.
2. Google pushed an algorithm update that affected your category of content.
3. It's a seasonal lull — this always happens in mid-April.

Each explanation implies a completely different response. If it's the copy rewrite, you should review the rewrite and consider reverting or refining it. If it's an algorithm update, you should wait and watch — panic-rewriting your pages now would contaminate the data and leave you worse off. If it's seasonal, you should do nothing and expect recovery in a few weeks.

Without causal attribution, you make a guess. With Blueprint, the system checks its records against known patterns before recommending a course of action.

---

## How Blueprint Decides

When an agent detects a significant metric change, it runs through four checks in order:

**1. Recent actions in the same metric category.**
Blueprint queries `action_memory` for entries that affect the same URL, entity, or metric type as the one that changed. If you rewrote a product page's copy 21 days ago and the page's conversion rate just changed, that action is flagged as a candidate cause.

**2. Timing match against expected windows.**
For each candidate action, Blueprint checks whether the elapsed time falls within the expected measurement window for that action type. A product description rewrite has a 7–28 day window with 14 days expected. If 21 days have passed, that's firmly within the window — strong timing match. If 45 days have passed, it's outside the max window — weak or no timing match.

**3. Multi-metric correlation check.**
If multiple unrelated metrics moved simultaneously — organic traffic and paid traffic and email opens all dropped in the same week — that pattern suggests an external cause rather than an internal one. A copy change on a single product page cannot cause email open rates to drop. When Blueprint sees correlated drops across independent channels, it assigns higher probability to an external cause.

**4. Confidence score.**
Blueprint combines the results of the three checks into a confidence score between 0 and 1 for each candidate explanation. The highest-confidence explanation becomes the primary attribution. The score is always shown alongside the recommendation — you can see how certain the system is.

---

## Two Attribution Examples

### Example 1: Internal Cause

> "Organic traffic dropped 18% this week. We rewrote the product page copy 21 days ago. This falls within the 14–28 day measurement window for product description changes. Attribution confidence: 72%. Recommendation: review the rewrite — it may have introduced copy that weakened the page's relevance signals for the target keyword. Compare the rewritten version against the original using GSC position data for the primary keyword."

Blueprint identified a recent action in the same metric category, verified the timing is within the expected window, and confirmed that no other channels moved simultaneously (traffic is down, but conversion rate and email metrics are flat — an algorithm update would have hit the traffic metric across more pages, not just the one product page). The 72% confidence reflects: strong timing match, same-page action, isolated to one metric.

The recommendation is specific: review the rewrite, compare against the original, check GSC position data for the keyword. Not "wait and see," not "revert everything" — a targeted diagnostic step.

### Example 2: External Cause

> "Organic traffic dropped 18% this week. No changes were made to content in the past 60 days. Multiple GSC properties are showing simultaneous drops. Attribution: external (likely algorithm update). Confidence: 84%. Recommendation: do not act on content or meta descriptions this week. Wait 14 days and re-measure. Panic-rewriting now would contaminate the data — if traffic recovers naturally, you'd never know whether your rewrites helped or hurt."

Blueprint found no internal actions in `action_memory` for the past 60 days. It then checked whether multiple independent properties were affected — they were, which is a strong signal for an external cause. The recommendation is explicitly not to act, with the reason stated: acting now adds noise to data that is already in flux.

The confidence is higher (84%) because the pattern — multiple properties, no recent actions, simultaneous drop — is a clear signature of an external event.

---

## "Do Not Act" Recommendations

When Blueprint recommends "do not act," it is not being overly cautious. It is making a specific claim: any action you take right now will lower the quality of the attribution data you'll have in two weeks.

If organic traffic drops 18% and Blueprint says "wait 14 days before acting," it is saying: the expected recovery window for this type of external event is 7–14 days. If you rewrite your pages now and traffic recovers, you will attribute the recovery to your rewrites. But the recovery was probably going to happen anyway. You've now introduced a confounding variable into your data and wasted effort.

The cost of waiting 14 days when it's an algorithm update is zero — traffic recovers regardless. The cost of acting when it's an algorithm update is two weeks of data contamination and misattributed work. The expected value of waiting is almost always higher.

Blueprint surfaces "do not act" recommendations because they are often the most commercially valuable recommendation it can make. They are not passivity — they are deliberate restraint in service of better future decisions.

---

## Attribution and the Learning Cycle

When Blueprint makes an attribution and turns out to be correct — the copy rewrite was the cause, and the metric improved after a targeted fix — that outcome is recorded. The learnings feed back into the agent's `memory.json` and increase confidence in future attributions of the same type.

When Blueprint turns out to be wrong — it attributed a traffic drop to an algorithm update, but a follow-up analysis showed it was a technical issue — that can be corrected manually through the task feedback mechanism. The correction updates the attribution record and adjusts the weighting in future analyses.

Over time, the attribution system calibrates to the patterns of your specific site, your industry's seasonality, and your typical change cadence. The longer Blueprint runs on your data, the more accurate its attributions become.
