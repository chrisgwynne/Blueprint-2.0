# Phase 2-INT — Autonomous Intelligence Foundation

**Goal:** strengthen Blueprint's core reasoning so it becomes a trustworthy
autonomous business operating system capable of safely managing multiple
businesses with minimal human intervention. This phase is about
correctness, validation, business awareness, and continuous learning — not
new user-facing features.

This phase began with a full read of `businesses`/`connectors`/`tasks`,
the existing agent/permission machinery, and the Brain modules
(`calibration.ts`, `historical-learning.ts`, `recommendation-engine.ts`,
`constraint-engine.ts`, `retrospective-engine.ts`) before writing any
code. That research found two things that shaped every design decision
below: (1) three independently hand-maintained, drifting lists of
"valid action types" already existed (`executor.ts`, `action-payloads.ts`,
`execution-safety.ts`), which the new Typed Action Registry needed to
consolidate rather than add a fourth; (2) much of the Outcome Learning
Engine's feedback loop already existed (`historical-learning.ts`'s
success-rate tracking, `recommendation-engine.ts`'s use of it,
`task-intelligence.ts`'s auto-investigation-on-no-improvement) — the
genuinely new work there is thinner than the spec's wording implies.

---

## 1. The five subsystems

| # | Subsystem | Status |
|---|---|---|
| 1 | Business Truth Layer (Business Profile) | Done — §2 |
| 2 | Typed Action & Executor Registry | Done — §3 |
| 3 | Connector Confidence & Identity Verification | Done — §4 |
| 4 | World Model | Done — §5 |
| 5 | Outcome Learning Engine | Done — §6 (mostly pre-existing, formalized) |

Every "Done" carries honest, documented limitations — see §7. A
follow-up pass (§13) subsequently closed every gap this phase originally
deferred — full-enforcement validation, connector-confidence-aware
recommendations, Business Profile policy consumption, action-windows
consolidation, and World-Model-sourced signals.

---

## 2. Business Truth Layer

`business_profiles` (one row per business, `server/db/db.ts`) is the
single source of truth for what a business *is* and what it may do:

- **Identity:** `business_type` (`service | agency | ecommerce | saas |
  content | other`), `operating_model`, `primary_domain`, `primary_brand`,
  `products_services`, `supported_platforms`.
- **Capability:** `allowed_agent_types`, `allowed_action_types` (empty
  array = no restriction, not "nothing allowed" — a deliberate default so
  a business with no profile yet, or a profile that's never had these
  fields touched, isn't accidentally locked out of everything).
- **Policy:** `approval_policy`, `automation_policy`, `risk_policy`,
  `deployment_policy`, `seo_policy`, `ecommerce_policy`,
  `lead_gen_policy`, `communication_preferences` — free-form JSON,
  present as documented schema shape but not yet consumed by other
  engines (see §7).
- **Provenance:** `inferred_fields` (JSON array of field names whose
  current value was auto-inferred, not human-confirmed) and
  `confirmed_by_human` (flips true the first time an operator/API caller
  explicitly edits the profile).

**Auto-population:** `server/business/business-profile.ts`'s
`getOrCreateBusinessProfile()` creates a profile with `business_type`
inferred from the legacy free-text `businesses.type` column via keyword
matching (`shop|commerce|store|retail|apparel|merch` → ecommerce,
`agency|marketing firm|consultanc` → agency, `saas|software|platform` →
saas, `content|media|publish|blog` → content, empty → other, anything
else → **service**, the narrowest/safest default since a service profile
never unlocks ecommerce-only actions). A one-off migration
(`backfillBusinessProfiles` in `db.ts`) runs the same inference for every
pre-existing business at startup. `updateBusinessProfile()` clears
`inferred_fields` for any field it touches and sets
`confirmed_by_human = true` — a real edit implies the value has been
reviewed.

**Consulted by:** the Typed Action Registry's business-type-compatibility
check (§3) and connector confidence's identity checks (§4).

---

## 3. Typed Action & Executor Registry

`action_registry` (one row per `action_type`, keyed on the string itself)
consolidates the three previously-drifting lists into one queryable
table, seeded at startup with all ~30 action types found in real use
(`executor.ts`'s `EXECUTABLE_ACTION_TYPES`, `agentActivationRules.ts`'s
`ROLE_SPECS[*].task_types`, and `action-windows.ts`'s `ACTION_WINDOWS` —
the latter surfaced two more, `gbp_post` and `meta-ads-change`, missed on
the first pass). Each entry carries: `payload_schema` (hand-rolled
JSON-Schema-lite — see below), `required_connector_types`,
`supported_business_types` (empty = no restriction; `shopify_*` and
`product_suggestion` are restricted to `['ecommerce']`, the one
unambiguous example the spec gives), `required_permissions`,
`supports_rollback`, `side_effect_classification` (mirrors
`execution-safety.ts`'s `internal_idempotent`/`external_verifiable`),
`risk_level`, `requires_approval`, and the Outcome Learning Engine fields
(`measurement_window_days`, `success_metrics`, `expected_impact`,
`acceptable_variance`, `confidence_adjustment_rules`,
`follow_up_schedule` — see §6).

**No new dependency.** `validatePayloadAgainstSchema()` in
`server/tasks/action-registry.ts` is a minimal hand-rolled validator
(type/required/properties/enum/min/max/items/length) — not a
general-purpose replacement for ajv, just enough for real payload
checks, matching this project's established no-new-deps discipline.

**The validation gate** (`validateAction()`) is called from
`approveTask()` in `server/tasks/task-queue.ts`, **not** `createTask()`.
The spec says "before a task can become executable Blueprint must
validate" — read as the propose→approve transition, since gating at
creation would immediately break the dozens of existing tests/fixtures
that create tasks with arbitrary `action_type` values against databases
with no real connectors configured. Two checks hard-block (task stays
`proposed`, approval throws, and a Blueprint System Issue explains why):

1. `action_type` must resolve to an active registry entry (a `null`
   action_type — a manual to-do task — is exempt entirely).
2. The business's `business_type` must be in the action's
   `supported_business_types` (if restricted).

**Full-enforcement follow-up (§13) turned all of the following into
hard blocks** — approval throws and a Blueprint System Issue records why,
same as the two above:

3. Every required connector type must have a `connectors` row.
4. Every required connector must be confidence-scored `healthy` or
   `warning` (`connector_confidence.overall_status`) — a connector that's
   never been scored is treated as untrusted, not trusted-by-default
   (fail closed).
5. The payload must pass `validatePayloadAgainstSchema()` against the
   registry entry's `payload_schema`.
6. For BAP-agent approvals (`approvedBy` starting `bap:`) only: the
   agent's granted permissions must be a superset of the action's
   `required_permissions`. Dashboard/Telegram approvals are fully
   privileged, matching this codebase's existing human-trust model.
7. The action's registered executor must exist (checked statically via
   `action_registry.dispatched_by_executor`, not a runtime import of
   `executor.ts`, to avoid a module cycle).
8. The executor must be healthy: if the last 3 completed
   (`succeeded`/`dead_letter`) `execution_jobs` rows for the action_type
   are *all* `dead_letter`, approval is blocked (a DB-observable
   circuit breaker, not a new live health-check system).
9. If the Business Profile's `risk_policy.max_risk_level` is set, the
   action's `risk_level` must not exceed it.

`validateAction()`'s `warnings` return value is kept (always `[]`) for
API shape stability with existing callers; nothing is a "soft" issue
anymore.

---

## 4. Connector Confidence & Identity Verification

`connector_confidence` (one row per connector, `server/connectors/confidence.ts`)
scores nine independent dimensions (`connectivity`, `authentication`,
`authorisation`, `resource_mapping`, `business_identity`,
`website_verification`, `freshness`, `historical_consistency`,
`data_completeness`) each as `healthy | warning | degraded | broken |
unknown`, rolled into `overall_confidence` (0–1) and `overall_status`.

**Passive, not a second health-check system.** This does not
re-implement each connector's `healthCheck()` (no new live API calls on
every scoring pass) — connectivity/auth/authorisation are inferred from
the connector's stored `status`/`last_error`, and freshness reuses
`freshness.ts`'s existing computation so the two never drift.

**Identity verification** (the spec's GBP/GA4/GSC/PageSpeed/Shopify/
Merchant-Center/GitHub examples): for connector types with a meaningful
"belongs to this website" relationship (`gbp, ga4, gsc, pagespeed,
shopify, wordpress, wix, google-merchant, github`), the connector's
configured domain (best-effort extracted from common config keys) is
compared against the Business Profile's `primary_domain`. No
`primary_domain` recorded yet → `unknown` (can't verify, not a failure).
Merchant Center gets an extra check: `business_identity` is `degraded`
unless the business's `business_type` is `ecommerce`. Connector types
with no natural identity relationship (stripe, todoist, brave-search,
...) are left `unknown`, never penalised.

**`isLowConfidence()`** returns true for `degraded`/`broken` status *and*
for a connector that's never been scored at all (fail closed, not
fail open). **Full-enforcement follow-up (§13):** `lowConfidenceConnectorTypes(businessId)`
(new, in this file) returns the set of connector types where *every*
configured instance is low-confidence (a type never configured at all is
excluded — no data isn't the same as untrusted data). `goal-suggester.ts`
filters detected patterns by it before they ever reach the LLM;
`recommendation-engine.ts` excludes candidates whose required connector
type(s) are all low-confidence, with the exclusion reason recorded —
"low-confidence connectors must not generate autonomous recommendations"
is now enforced end-to-end, not just queryable.

Refreshed on every connector sync (`server/jobs/scheduler.ts`'s cron tick
and `server/routes/connectors.ts`'s manual sync route both call
`refreshConnectorConfidence()` immediately after a successful sync).

---

## 5. World Model

`world_model_snapshots` (`server/world-model/world-model.ts`) is a
timestamped, attributable history table — every row is a full JSON
snapshot plus `trigger_source` and `created_at`. "Current" state for a
business is simply its most recent row; `getWorldModelHistory()` gives
before/after comparison for free without a separate "current state"
table that could drift from the history.

The snapshot assembles from existing subsystems rather than new
statistics: `goals` (progress/status), `signals` (open/critical counts,
bucketed into revenue/traffic/SEO/lead-gen/marketing "trends" by keyword
match against signal type/title), `conflicts` (open risks),
`goal_suggestions` (open opportunities), `investigations` and
`scenarios` (last-30-days counts), `task_outcomes` (recent verdicts),
`agent_calibration` (knowledge/prediction confidence), and this phase's
own `connector_confidence`.

**Trigger points:** `writeWorldModelSnapshot(businessId, 'connector_sync')`
fires fire-and-forget from the same two call sites that already run
`runSignalEngine()` after a connector sync
(`server/jobs/scheduler.ts` and `server/routes/connectors.ts`) — "connectors
update the World Model" per the spec, without adding a third code path.

**Scoping note:** the revenue/traffic/SEO/lead-gen/marketing "trend"
fields remain a coarse keyword-bucketing of recent open signals, not a
metrics regression — that simplification stands.

**Full-enforcement follow-up (§13): signals now source their "previous"
comparison data from the World Model, not a raw second query.** The
snapshot gained a `connector_data` field — each connector's latest synced
data blob, keyed by `connector_id` — and a new `getPreviousConnectorData(businessId,
connectorId)` reads it from the *last* snapshot (the one about to be
superseded). `server/jobs/scheduler.ts` and `server/routes/connectors.ts`
both now call this instead of their own ad-hoc "previous row in the
metrics table" query, so `runSignalEngine()`'s `(current, previous)` input
now flows through the World Model in both places it's invoked. The ~40
signal rule functions in `signals/rules.ts` were untouched — only where
their `previous` argument comes from changed, not their shape.

---

## 6. Outcome Learning Engine

Research found most of this loop already built: `historical-learning.ts`'s
`actionTypeTrackRecord()` live-computes success rate from
`task_outcomes`; `recommendation-engine.ts`'s scoring formula already
weights historical success rate at 0.15, meaning "significant improvement
→ increase confidence for similar recommendations" already falls out
naturally from writing better outcomes; and `task-intelligence.ts`'s
`handleNoChange()` **already** creates a follow-up `investigation` task
when a `no_change` verdict lands at the 4-week check — exactly the
spec's "if no improvement occurs: create an investigation."

What this phase actually added:

1. **Formalized per-action-type measurement config on `action_registry`**
   (`measurement_window_days`, `success_metrics`, `expected_impact`,
   `acceptable_variance`, `confidence_adjustment_rules`,
   `follow_up_schedule`) — tying subsystems 2 and 5 together
   structurally. Backfilled from `outcomes.ts`'s `ACTION_TYPE_METRICS`
   map and (more completely) from `server/brain/action-windows.ts`'s
   pre-existing `ACTION_WINDOWS` (min/expected/max days + `metric_types`
   per action type — itself a fourth previously-undiscovered
   per-action-type config source, surfaced by this research).
2. **A new 1-week outcome check.** `outcomes.ts`'s `runOutcomeChecks()`
   previously only ran 2-week and 4-week checks. It now also runs a
   1-week check for any action type whose registry entry's
   `measurement_window_days` includes 7 (the default seed value, so this
   applies broadly) — matching the spec's own SEO example of measuring
   at 7/14/28 days. `handleNoChange()`'s existing "only propose a
   follow-up once the 4-week check lands" guard means this never causes
   a premature investigation.

**Full-enforcement follow-up (§13): consolidated, without rewriting every
consumer.** `restraint.ts`/`causal.ts`/`agent-runner`/`conductor` still
read the `action_windows` table directly — that was left alone. Instead,
`action_registry` gained `display_name`/`measurement_notes`/`volatility`
columns (making it a complete superset of what `action_windows` stores)
and `upsertActionRegistryEntry()` now write-through syncs every
insert/update into `action_windows` via a new `syncToActionWindows()`.
`action_registry` is now the single edit surface; `action_windows` is a
kept-in-sync read replica for its existing readers. `seedActionWindows()`
seeds from `action_registry` first, falling back to the hardcoded
`ACTION_WINDOWS` array only for an action type the registry doesn't have
a 3-element `measurement_window_days` for.

---

## 7. Blueprint System Issues

`system_issues` (`server/system/system-issues.ts`) is the audit trail for
"why didn't Blueprint act" — created whenever action validation fails
(§3), and designed to also carry connector-confidence and
outcome-learning issues in the future (the `issue_type` column is a free
string, not an enum, so new producers don't need a migration).
`related_task_id`/`related_connector_id` are **soft references** (plain
`TEXT`, no `REFERENCES` clause) — a system issue is a historical record
and must survive deletion of the task/connector it references, the same
lesson Phase 3 learned the hard way on the `decisions` table.

---

## 8. New database objects

One migration block appended to `STARTUP_MIGRATIONS` in `server/db/db.ts`:

| Table | Purpose |
|---|---|
| `business_profiles` | Business Truth Layer (§2) |
| `action_registry` | Typed Action & Executor Registry (§3), seeded with ~30 action types |
| `connector_confidence` | Connector Confidence & Identity Verification (§4) |
| `world_model_snapshots` | World Model history (§5) |
| `system_issues` | Audit trail for blocked/degraded autonomous decisions (§7) |

Plus two one-off data migrations: `backfillBusinessProfiles` (creates a
profile for every pre-existing business with inferred `business_type`)
and the registry's `INSERT OR IGNORE`/guarded-`UPDATE` seed statements
(safe to extend in a later deploy — new action types just get inserted).

---

## 9. APIs

**BAP** (`/api/bap/v1`, new permissions `business_profile:read/:update`,
`action_registry:read/:write`, `connector_confidence:read`,
`world_model:read`, `system_issues:read/:update`):

- `GET/PATCH /businesses/:bid/profile`
- `GET /action-registry`, `GET/PUT /action-registry/:actionType`
- `GET /businesses/:bid/connector-confidence`, `GET /connectors/:id/confidence`
- `GET /businesses/:bid/world-model`, `GET /businesses/:bid/world-model/history`
- `GET /businesses/:bid/system-issues`, `PATCH /system-issues/:id`

**Dashboard** (`/api/intelligence`, session-authenticated mirror of the
above, same underlying engines): `business-profile/:businessId`,
`action-registry[/:actionType]`, `connector-confidence/:businessId`,
`world-model/:businessId[/history]`, `system-issues/:businessId`.

---

## 10. UI

- **Settings → Business Profile** tab extended (not duplicated — it
  already existed with only name/type/description/slug/website/logo) with
  a new "Business Truth Layer" section: business type, operating model,
  primary domain/brand, allowed agent/action types, and a visible warning
  when a field is still auto-inferred and unconfirmed.
- **System Health** page extended with two new sections: "Connector
  Confidence & Identity Verification" (per-connector table of the nine
  dimensions) and "World Model" (business health/trends, open risks/
  opportunities, low-confidence connector count), reusing the page's
  existing 30s-poll pattern.

---

## 11. A pre-existing bug this phase's testing surfaced and fixed

While chasing what looked like flaky, order-dependent test failures
(`execution-jobs.test.ts` claiming the wrong job, cascading `FOREIGN KEY
constraint failed` errors in unrelated files), the actual root cause
turned out to be a real, pre-existing bug in `server/db/db.ts`:
`resolve(process.env.DATABASE_PATH)` was being called even when the env
var is the SQLite in-memory sentinel `':memory:'`. `path.resolve`
doesn't special-case that string — it treats it as a relative filename
and returns an absolute path like `<cwd>/:memory:`, which `bun:sqlite`
then happily opens as a **real file on disk**. `test-setup.ts`'s stated
guarantee ("tests never touch the real database... force ephemeral
in-memory database") was silently defeated: every test run was actually
writing to (and reading stale state back from) a literal file named
`:memory:` that persisted across every single test invocation. This
explained 100% of the "pre-existing" test flakiness (confirmed
reproducible byte-for-byte on unmodified `master` too, before this
phase's own changes). Fixed by passing the sentinel through to
`Database()` verbatim instead of resolving it. The full suite is fully
green (548/548) with this fix; it was not green before.

---

## 12. What was NOT built, as of the original phase (historical)

This section originally listed five deliberately deferred gaps. All five
were closed in a direct follow-up pass — see §13 for what changed and
why each was judged safe to complete rather than leave deferred. Kept
here, struck through in spirit but not in text, so the reasoning trail
that led to deferring them in the first place isn't lost:

- ~~Full enforcement of every check the spec lists before a task becomes
  executable (only 2 of ~8 checks hard-block; the rest are non-blocking
  system issues).~~ Closed — §13.1.
- ~~`signals/rules.ts`'s ~40 evaluation functions still consume raw
  connector data directly, not World Model state.~~ Closed — §13.2.
- ~~`action-windows.ts` and `action_registry` are two systems with
  overlapping data, synced one-directionally, not yet consolidated.~~
  Closed — §13.3.
- ~~Connector confidence scoring exists and is queryable, but
  `goal-suggester.ts`/`recommendation-engine.ts` don't yet filter
  candidates by it.~~ Closed — §13.4.
- ~~Business Profile's policy fields are present as typed, editable JSON
  but not yet consumed by the engines whose behaviour they describe.~~
  Closed — §13.5.

---

## 13. Full-enforcement follow-up

Every gap in §12 was a scoped, load-bearing trade-off, not an oversight
— each is closed here in the same spirit: no check weakened to make a
test pass, no existing behaviour silently regressed.

**13.1 — All ~9 validation checks now hard-block approval,** not just
the original 2. See §3's expanded list. New: connector-presence,
connector-confidence, payload-schema, BAP-agent-permission,
executor-exists, executor-health, and `risk_policy.max_risk_level`
checks. `automation_policy.max_autonomous_tasks_per_day` is enforced
separately in `approveTask()` (not `validateAction()`, since it's a
time-windowed count, not a per-call check) — non-`dashboard:`-prefixed
approvals for a business are capped per calendar day; a human approving
via the dashboard is never capped.

**13.2 — Signals now read their "previous" comparison data from the
World Model.** See §5's rewritten paragraph. `getPreviousConnectorData()`
plus a new `connector_data` snapshot field; both call sites
(`scheduler.ts`, `connectors.ts`) rewired; the 40 signal rule functions
themselves are unchanged.

**13.3 — `action-windows.ts` consolidated into `action_registry`** via
write-through sync rather than rewriting the ~10 files that read
`action_windows` directly. See §6's rewritten paragraph.

**13.4 — Connector-confidence-aware recommendation filtering.** See §4's
rewritten paragraph. `lowConfidenceConnectorTypes()` is consulted by both
`goal-suggester.ts` and `recommendation-engine.ts`.

**13.5 — Business Profile policy fields are now consumed:**
- `approval_policy.always_require_approval` / `allow_auto_approve` /
  `default_mode`: `approval.ts`'s `shouldAutoApprove()` now checks these
  right after the `DANGEROUS_ACTION_TYPES` hard floor and before the
  global Settings→Approval Policies / legacy `trust_tier` fallback —
  precedence is: dangerous-action floor → Business Profile → global
  settings → legacy fallback.
- `risk_policy.max_risk_level`: enforced in `validateAction()` (§13.1).
- `automation_policy.max_autonomous_tasks_per_day`: enforced in
  `approveTask()` (§13.1).

**A pre-existing bug this pass's testing surfaced and fixed:**
`getCurrentWorldModel()`/`getWorldModelHistory()` ordered snapshots by
`created_at DESC` alone. `created_at` is second-precision
(`CURRENT_TIMESTAMP`), so multiple snapshots written within the same
second — routine when several connectors sync back-to-back, or in fast
test runs — had no guaranteed order, meaning `getPreviousConnectorData()`
could read a stale snapshot instead of the truly most recent one. Fixed
by adding `rowid DESC` as a tiebreaker (rowid increases with insertion
order). The same tie existed in `buildWorldModelSnapshot()`'s own
per-connector "latest metrics row" query (`recorded_at DESC` with no
tiebreaker) and was fixed the same way. Both were caught by a new test in
`world-model.test.ts` that writes two snapshots back-to-back and asserts
`getPreviousConnectorData()` returns the *first* sync's data until the
*second* snapshot is written.

All 575 tests pass (up from 548 at the end of the original phase);
`tsc --noEmit` and `vite build` are both clean.
