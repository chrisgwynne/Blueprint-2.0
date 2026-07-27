# Intelligence Layer (Phase 3)

Blueprint's "Brain" (`server/brain/*`) already existed before Phase 3 —
goal-reasoner, conflict-engine, calibration, goal-suggester, scenario-engine,
retrospective-engine, restraint, investigation-engine, causal, seasonality,
temporal-summary, intent-extractor, action-windows. Phase 3's research phase
(read every subsystem before writing a line of code, per the governing
spec) found that most of what the spec asked for already had a real,
LLM-backed engine behind it — the work was extending and durably persisting
those engines' output, not building 14 systems from scratch. This document
covers what each engine does after Phase 3, grouped by the spec's numbered
objectives; `GOAL_ENGINE.md` and `DECISION_ENGINE.md` cover the two pieces
substantial enough to warrant their own document.

---

## 1. What already existed vs. what's genuinely new

| Extended (existing engine, new capability) | Genuinely new (Phase 3) |
|---|---|
| `goal-reasoner.ts` — durable multi-strategy persistence | `decision-memory.ts` |
| `conflict-engine.ts` — 3 new detector types, `category` dimension | `knowledge-graph.ts` |
| `calibration.ts` — full rewrite of the scoring algorithm | `recommendation-engine.ts` |
| `goal-suggester.ts` — 4 new opportunity fields, decision recording | `constraint-engine.ts` |
| `retrospective-engine.ts` — calibration now deterministic, cross-business trigger | `cross-business-patterns.ts` |
| | `historical-learning.ts` |

## 2. Strategic Planning & Multi-Strategy Planning

Covered in full in `GOAL_ENGINE.md` (sections 3–4). Summary: every goal
creation/re-plan triggers `goal-reasoner.ts`, which now persists a durable
`goal_assessments` row and one `goal_strategies` row per candidate path
(instead of a JSON blob that got overwritten), each strategy carrying a
deterministically-computed historical success rate from
`historical-learning.ts` (section 6 below) — not an LLM's claim about the
past.

## 3. Conflict Detection — direct/resource/timing/dependency

`conflict-engine.ts` already detected `goal_vs_goal` and `task_vs_window`
conflicts (LLM-backed) and `task_vs_goal` conflicts. Phase 3 adds:

- **`checkTaskTaskConflicts`** — two proposed/approved tasks that would
  step on each other (same page, same campaign, contradictory copy
  changes). LLM-assessed per pair (`assessTaskPair`), run as part of
  `runTaskConflictCheck` alongside the existing detectors whenever a task
  is created.
- **`checkSignalGoalConflicts`** — a new signal that contradicts a goal's
  direction (e.g. a ranking-drop signal on a page a goal is trying to grow
  traffic to). LLM-assessed (`assessSignalGoal`), fired on signal creation.
- **`checkGoalDependencyConflicts`** — the one **deterministic** detector
  (pure graph logic, no LLM call): dependency cycles and "active but
  blocked" goals. See `GOAL_ENGINE.md` section 6.

Every conflict now carries a `category` — `direct | resource | timing |
dependency` — as a dimension **independent of** `conflict_type` (which
entities collided). `conflict_type` answers "what collided"; `category`
answers "what kind of problem is this." A `DEFAULT_CATEGORY_BY_TYPE` map
supplies a sensible default so existing conflict types didn't need to
change call sites, but each new detector sets its own category explicitly
where a default wouldn't fit (e.g. a dependency cycle is always
`category: 'dependency'` regardless of what `conflict_type` labels it).

`resolveConflict()`/`dismissConflict()` now record a decision (see
`DECISION_ENGINE.md`) with the resolving actor's identity, not just flip a
status column.

**Testing note:** `checkGoalDependencyConflicts` is unit-tested directly
(pure logic, no LLM). The LLM-backed detectors follow this codebase's
established convention — no test anywhere in this repo mocks `runLLM` — and
are validated by live smoke testing instead (a real server, a real LLM
call, real inserted conflicts inspected via SQLite). The live pass for this
phase additionally surfaced an emergent, unplanned integration: a
pre-existing deterministic conflict fired on task creation, was correctly
categorized `timing` by the new logic, appeared correctly in the new
general conflicts endpoint, and correctly penalized that task's score in
the new recommendation ranking (section 4) — end-to-end evidence the system
is coherently wired, not just individually correct.

## 4. Recommendation Ranking

New module, `server/brain/recommendation-engine.ts`. Gathers every
currently-actionable candidate — proposed tasks awaiting approval, pending
opportunities (`goal_suggestions`), and candidate strategies for active
goals (`goal_strategies` where `status = 'candidate'`, only the most recent
assessment's strategies) — into one comparable ranked list.

Score is a weighted sum, not a single opaque number without justification:

```
score = 0.25·confidence + 0.20·goal_priority_weight + 0.15·urgency
      + 0.15·historical_success_rate + 0.15·effort_weight + 0.10·(1 - has_open_conflict)
```

Every candidate also gets a human-readable `rationale: string[]` (e.g.
`"Confidence 82%"`, `"Serves goal \"Grow organic traffic\" (p1)"`,
`"Historically 71% successful for \"seo_meta_rewrite\" (n=12)"`, `"⚠ Has an
open, unresolved conflict — review before acting"`). A candidate that fails
`constraint-engine.ts`'s check (section 7) is **never ranked** — it's
returned separately as `excluded`, with the violated constraint's note, so
a caller can see *why* something wasn't recommended instead of it silently
vanishing. This directly satisfies the spec's "what should we deliberately
not do" requirement.

## 5. Knowledge Graph

New module, `server/brain/knowledge-graph.ts`, plus `kg_entities`/`kg_edges`
tables (these two **do** keep real foreign keys — contrast with
`decisions`' soft references in `DECISION_ENGINE.md` section 1; nothing
deletes a graph node today, so enforcement here is free and catches real
bugs rather than blocking legitimate deletes).

- **Automatically derived** for entities with a backing table (goal,
  signal, task, outcome, decision): `deriveEdgesForBusiness()` walks
  existing relational columns — `tasks.signal_id`/`goal_id`,
  `task_outcomes.verdict`, `conflicts`, `decisions.related_*_id`,
  `goal_dependencies` — and upserts the corresponding typed edge
  (`caused`, `supports`, `improves`/`regresses`, `contradicts`/`blocks`,
  `relates_to`, `depends_on`). Idempotent — safe to re-run
  (`POST .../graph/rebuild`) as data changes.
- **Manually registered** for entities with no backing table at all
  (competitor, product, customer, campaign, person) via
  `createStandaloneEntity()` — there is **no automatic extraction
  pipeline** for these (see section 11, "what this doesn't do"). A human or
  BAP caller registers one and links edges to it explicitly.
- **Traversal**, not keyword search: `traverseGraph()` does a bounded BFS
  (`depth` 1–5, capped at 200 nodes) from a starting entity, in both edge
  directions (a `depends_on` edge is equally relevant approached from
  either end), optionally filtered to specific edge types.

## 6. Historical Learning & Opportunity Engine

`server/tasks/historical-learning.ts` — `actionTypeTrackRecord()` (have we
tried this action type before, what fraction succeeded) and
`haveWeSeenThisBefore()` (has this exact action/target combination been
attempted). This was previously duplicated inline in `bap-outcomes.ts`;
Phase 3 extracted it to one shared module now also consumed by
`goal-reasoner.ts` (strategy scoring), `recommendation-engine.ts` (ranking),
and `cross-business-patterns.ts` (section 8) — one source of truth for "did
this historically work," not three independently-drifting copies.

The Opportunity Engine is `goal-suggester.ts` (pre-existing) extended with
the fields the spec's "opportunity" concept required but the table didn't
yet have: `required_effort`, `related_goal_ids` (computed deterministically
by matching the opportunity's metric against active goals, not
LLM-guessed), `related_risks`, `why_it_matters`.

## 7. Constraint Engine

New module, `server/brain/constraint-engine.ts`, backed by a new
`constraints` table (operator-authored: `constraint_type` ∈
`freeze | manual | hours | budget | resource | seasonality`, a JSON
`scope` for narrowing which actions it applies to, `limit_value`/
`limit_unit`/`period`, an active window). `checkConstraints()` is called by
`recommendation-engine.ts` before ranking any candidate and returns
violations split into `blocking` (never recommend) vs. `advisory` (surface,
don't hard-stop) — `seasonality` constraints are always advisory (a metric
move within normal seasonal variation is a caution, not a hard block).

**Honestly scoped, not silently incomplete:** the `budget`/`resource`
constraint type compares a single proposed action's own declared cost
against the limit — it is **not** a period-cumulative spend tracker.
Blueprint has no ledger of actual spend per action to sum against, so many
small actions that together exceed a monthly budget are not caught, only a
single action that alone exceeds it. Documented here and in the module's
own docstring, not glossed over.

## 8. Cross-Business Learning

New module, `server/brain/cross-business-patterns.ts`, backed by
`cross_business_patterns` — a table with structurally **no**
`business_id`, business name, URL, or any other tenant-identifying column
(enforced by omission from the schema, not by a redaction pass that a
future careless call site could bypass). `updateCrossBusinessPatterns()`
aggregates `task_outcomes` across every business on the instance, grouped
by `action_type`, into an abstract pattern: a success rate, a sample size,
and the distinct *business types* (e.g. `"ecommerce"`, never a name or ID)
that contributed data. `listCrossBusinessPatterns(businessType?)` lets a
caller see only patterns relevant to their own business type.

This runs automatically at the end of every retrospective (section 9) and
is exposed read-only via `GET .../patterns`. A dedicated test asserts
`Object.keys(row)` never contains `business_id` and the serialized response
never contains either of two test businesses' literal ID strings — this is
a structural guarantee, not a policy one.

## 9. Agent Calibration — proper calibration, not averaging

`server/brain/calibration.ts` was fully rewritten (same exported function
signatures, entirely different internals) to satisfy the spec's explicit
"NOT simple averaging" and "more conservative when repeatedly wrong"
requirements with concrete mechanisms, not just a stated intent:

1. **Recency-weighted** — each outcome's contribution decays exponentially
   (45-day half-life) rather than being included or excluded by a hard
   window cutoff. A bad run last week matters more than one from three
   months ago, without abruptly discarding older data at a cliff.
2. **Binned reliability curve** — confidences are bucketed into quintiles
   (0–20%, 20–40%, …, 80–100%). A single global average hides an agent that
   is well-calibrated at high confidence but badly overconfident in the
   middle — the bins expose that.
3. **Bayesian-shrunk per bin** — a bin with 2 samples isn't trustworthy on
   its own; each bin's observed rate is pulled toward the agent's overall
   rate in proportion to how little data that bin has (a 5-pseudo-observation
   Beta-Binomial-style prior), so small noisy bins don't produce wild
   offsets.
4. **Conservatism factor** — if an agent was overconfident (positive
   calibration error) in ≥2 of its last 3 calibration periods (including
   the current one), its `calibration_offset` is scaled 1.5× rather than
   reset fresh each period. This is the literal mechanism behind "agents
   should become more conservative when repeatedly wrong," not a
   description of an intent with nothing enforcing it.

Additional tracked dimensions the spec asked for: false positives/negatives
(stated confidence ≥70% that didn't pan out, or <50% that did),
recommendation acceptance/rejection (from `tasks.status` directly, so it
reflects *every* proposal, not just ones with a measurable outcome),
execution success rate (did the approved task's execution succeed,
independent of whether the target metric moved), and long-term success
rate (the outcome-based rate, kept as its own named field distinct from
execution success).

`retrospective-engine.ts`'s `applyCalibration()` now **defers to this
deterministic recalculation** for every number it stores, only attaching
the LLM's qualitative note on top — Phase 0/1/2's precedent of never
trusting an LLM's self-reported statistics applies here too.

## 10. Explainability

Not a separate engine — computed at the BAP/dashboard response layer.
`bap-review.ts`'s `explainRecommendation()` enriches
`recommendation-engine.ts`'s already-computed, pure/sync ranking with:
`evidence` (the historical-success sentence), `reasoning` (the rationale
array), `alternatives_considered` (up to 3 other candidates serving the
same goal, with their own scores), `risk` (open-conflict status), the
already-present `expected_impact`/`confidence`/`historical_evidence`, and —
for the top 5 recommendations only — a knowledge-base search for related
context (`linked_kb`). The top-5 cutoff is a real performance tradeoff (a
KB search is an async call per item) and is documented **in the response
itself** via an `explanation_depth` field, not left silently inconsistent
between item 5 and item 6.

## 11. Strategy Reviews (Retrospectives)

`retrospective-engine.ts` pre-existed; Phase 3's changes: `applyCalibration()`
now defers to the deterministic calibration rewrite (section 9) instead of
trusting the LLM's self-reported confidence numbers, and `runRetrospective()`
now also calls `updateCrossBusinessPatterns()` (section 8) after filing its
report — a monthly retrospective is the natural trigger point for both
"how well-calibrated were we" and "what patterns can other businesses learn
from this month," and both now happen automatically as part of it rather
than needing a separate scheduled job.

## 12. What Phase 3's intelligence layer does not do

- **Standalone knowledge-graph entities have no extraction pipeline** — a
  competitor, product, customer, or campaign only becomes a graph node if
  something explicitly calls `createStandaloneEntity()`. There is nothing
  today that reads KB text and says "this page mentions competitor X" —
  building that would need an LLM entity-extraction pass this phase didn't
  build.
- **Constraint budgets are single-action, not cumulative** (section 7).
- **No structured "was this recommendation actually followed" feedback
  loop back into calibration per-recommendation** — calibration reads
  `task_outcomes`/`tasks.status` in aggregate, not "recommendation #123 led
  to task #456 which succeeded," so a recommendation's own individual track
  record isn't separately tracked from its underlying action type's.
- **Cross-business patterns are outcome-derived only** — they don't yet
  capture patterns from decisions, conflicts, or strategic assessments,
  only from `task_outcomes`.
