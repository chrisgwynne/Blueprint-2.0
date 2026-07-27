# Phase 3 — Strategic Intelligence & Autonomous Business Reasoning

**Goal:** make Blueprint genuinely intelligent, not just execution-capable.
Before this phase, Blueprint could collect data, expose state, and execute
work (Phases 0–2). It could not answer "what should we do next, which
opportunities are worth pursuing, which tasks conflict, what are the
possible strategies, which previous approaches worked, how confident are
we, what should we deliberately not do" — every one of those is now
answerable from stored evidence, not from an LLM guessing in the moment.

This phase began with a full read of every major subsystem (goals, BAP,
agents, signals/tasks, knowledge base, the existing "Brain" intelligence
layer) before writing any code, per the governing spec's explicit
instruction. That research found Blueprint already had ~10 LLM-backed
reasoning engines under `server/brain/` covering much of what the spec
asked for — the work here is predominantly **extending and durably
persisting** those engines, plus building the handful of genuinely new
subsystems (Decision Memory, Knowledge Graph, Recommendation Ranking,
Constraint Engine, Cross-Business Patterns) the spec's 14 objectives
actually required and didn't already exist. See `INTELLIGENCE.md` for the
full engine-by-engine breakdown, `GOAL_ENGINE.md` for the goal data model,
and `DECISION_ENGINE.md` for decision memory's design.

---

## 1. New strategic capabilities

Mapped to the spec's 14 numbered objectives:

| # | Objective | Status |
|---|---|---|
| 1 | Real Goal Engine (FKs, owner/confidence/priority/milestones/dependencies, progress, timeline) | Done — `GOAL_ENGINE.md` §1–2, §5 |
| 2 | Strategic Planning Engine (durable, versioned assessments) | Done — `GOAL_ENGINE.md` §3 |
| 3 | Multi-Strategy Planning (comparable candidate strategies) | Done — `GOAL_ENGINE.md` §4 |
| 4 | Goal Conflict Detection (direct/resource/timing/dependency) | Done — `INTELLIGENCE.md` §3 |
| 5 | Decision Memory | Done — `DECISION_ENGINE.md` |
| 6 | Agent Calibration (proper, not averaging) | Done — `INTELLIGENCE.md` §9 |
| 7 | Recommendation Ranking | Done — `INTELLIGENCE.md` §4 |
| 8 | Knowledge Graph | Done — `INTELLIGENCE.md` §5 |
| 9 | Historical Learning | Done — `INTELLIGENCE.md` §6 |
| 10 | Opportunity Engine | Done — `INTELLIGENCE.md` §6 |
| 11 | Explainability | Done — `INTELLIGENCE.md` §10 |
| 12 | Cross-Business Learning | Done — `INTELLIGENCE.md` §8 |
| 13 | Strategy Reviews (retrospectives) | Done — `INTELLIGENCE.md` §11 |
| 14 | Constraint Engine | Done — `INTELLIGENCE.md` §7 |

Every "Done" carries honest, documented limitations — see section 7 below
and each linked document's own "what this doesn't do" section. Nothing in
this table means "perfect," it means "the capability exists, is wired
end-to-end, and is tested."

---

## 2. New database objects

One migration block appended to `STARTUP_MIGRATIONS` in `server/db/db.ts`
(section markers `3.1`–`3.14` in the file itself). New tables:

| Table | Purpose |
|---|---|
| `goal_milestones` | Real milestone rows (was JSON-only) |
| `goal_dependencies` | Goal-to-goal dependency edges |
| `goal_assessments` | Versioned strategic assessment history |
| `goal_strategies` | Comparable candidate strategies per assessment |
| `decisions` | Durable decision memory (soft references — see `DECISION_ENGINE.md` §1) |
| `kg_entities` / `kg_edges` | Knowledge graph nodes/typed edges (real FKs) |
| `cross_business_patterns` | Abstracted, non-tenant-identifying learned patterns |
| `constraints` | Operator-authored budget/hours/freeze/seasonality rules |

New columns on existing tables:

- `tasks.goal_id`, `signals.goal_id`, `task_outcomes.goal_id`,
  `agent_runs.goal_id` — real FKs replacing the `project_id` proxy
  (backfilled from `project_id` on startup, additive, `project_id` retained).
- `goals.owner`, `goals.confidence`, `goals.priority`.
- `conflicts.category` (`direct | resource | timing | dependency`,
  backfilled from `conflict_type` via a default map).
- `agent_calibration.false_positives`, `false_negatives`,
  `recommendations_accepted`, `recommendations_rejected`,
  `execution_success_rate`, `long_term_success_rate`,
  `calibration_method`, `conservatism_factor`, `bins` (JSON).
- `goal_suggestions.required_effort`, `related_goal_ids`, `related_risks`,
  `why_it_matters`.

Every migration is additive — new tables, new nullable columns, or
backfills that are no-ops on rows already populated. No column was dropped
or renamed; no existing row's meaning changed.

---

## 3. New APIs

**5 new BAP-key-authenticated route files** (mounted as sub-routers inside
`bap.ts`'s existing auth chain, matching Phase 2's established pattern):
`bap-opportunities.ts`, `bap-decisions.ts`, `bap-graph.ts`, `bap-review.ts`
(recommendations/retrospectives/calibration/patterns), plus Phase 3
extensions to the pre-existing `bap-goals.ts` (timeline/assessment/
assessments/strategies/plan) and `bap-conflicts.ts` (general business-wide
conflict list with `category`/`conflict_type` filters — this file itself is
new this phase, extending what was previously only a goal-scoped conflicts
sub-route). Full endpoint list, request/response shapes: `GOAL_ENGINE.md`
§7, `DECISION_ENGINE.md` §4, `INTELLIGENCE.md`, and the formal spec in
`docs/openapi/bap-v1.yaml`.

**4 new session-authenticated dashboard route files**, mirroring the BAP
surface for the browser dashboard (same underlying engine calls,
`isAuthenticated` instead of a BAP key — the established "same engine,
different auth gate" split from Phase 2): `server/routes/decisions.ts`,
`server/routes/graph.ts`, `server/routes/review.ts`. Opportunities has no
separate new file — `server/routes/goal-suggestions.ts` already covered
list/scan/accept/dismiss/snooze and already returns the new Phase 3 fields
via its existing `parseRow()`, so it's reused as-is. `server/routes/goals.ts`
and `server/routes/conflicts.ts` gained the same Phase 3 extensions as
their BAP counterparts.

**10 new BAP permissions** added to `GRANTABLE_BAP_PERMISSIONS`:
`opportunities:read`, `opportunities:trigger`, `conflicts:read`,
`decisions:read`, `graph:read`, `graph:trigger`, `recommendations:read`,
`retrospectives:read`, `retrospectives:trigger`, `calibration:read`.

---

## 4. New intelligence services

Genuinely new modules under `server/brain/` and `server/tasks/` (not
extensions of a pre-existing file):

- `decision-memory.ts` — record/recall/get, the single write path for every
  consequential decision across the codebase.
- `knowledge-graph.ts` — entity/edge derivation + bounded BFS traversal.
- `recommendation-engine.ts` — cross-cutting ranked, explainable, constraint-
  filtered recommendations.
- `constraint-engine.ts` — generalizes the "don't recommend impossible
  actions" rule beyond the one type `restraint.ts` already enforced.
- `cross-business-patterns.ts` — structurally tenant-anonymous learning
  across every business on the instance.
- `historical-learning.ts` — extracted from a Phase 2 duplicate, now the
  one shared "have we tried this before" module.

Rewritten (same public signature, new internals): `calibration.ts` — see
`INTELLIGENCE.md` §9 for the algorithm.

---

## 5. Test results

**465 tests across 46 files, 449 passing.** The 16 failures are the
codebase's pre-existing, documented cross-file DB pollution flakiness
(`server/agents/agentLifecycle.test.ts`, `server/jobs/scheduler-lock.test.ts`,
`server/tasks/execution-jobs.test.ts`'s `claimNextJob`) — these fail only
when the *full* suite runs together in the shared in-memory test DB, pass
100% in isolation, and reproduce identically on an unmodified base branch
(confirmed via `git stash` in earlier phases, pattern-matched again here).
Not a regression; not chased, per that established precedent.

Phase 3-specific coverage: **13 new test files, ~117 new test cases**,
covering every new brain module (`decision-memory`, `constraint-engine`,
`recommendation-engine`, `knowledge-graph`, `cross-business-patterns`,
plus the deterministic slice of `conflict-engine` and the full rewrite of
`calibration`) and all 5 new/extended BAP route files
(`bap-opportunities`, `bap-conflicts`, `bap-decisions`, `bap-graph`,
`bap-review`) — permissions (missing scope → 403), cross-tenant isolation,
pagination, idempotency, filter correctness, 404s for unknown IDs, and
concurrent-read safety, matching the exact conventions Phase 2 established.
`bap-goals.test.ts` was extended with 15 more tests covering the new
owner/confidence/priority/dependency fields and the timeline/assessment/
strategies/plan endpoints.

`typecheck` is clean for both `server` and `client`. `bun run build`
(the Vite production build) succeeds with the 5 new dashboard pages as
separate lazy-loaded chunks.

**Live UI smoke test:** a real dev server (server + Vite), a real login, a
real business/goal, and headless-Chromium walkthroughs of all 8
new/extended dashboard pages (Goals, Conflicts, Retrospectives,
Opportunities, Decisions, Recommendations, Calibration, Relationship
Graph) — no React error boundaries, no blank pages, no console/page
errors, across two full passes. This pass caught two real gaps, both fixed
before this report: (1) the recommendations endpoint's `explanation_depth`
copy read "full for the top 0…" when there were zero recommendations —
fixed with a shared `explanationDepthLabel()` helper used by both the BAP
and session routers; (2) `goals.confidence` had no server-side `0–1` bounds
check despite the dashboard form enforcing it client-side — fixed on both
the BAP (`bap-goals.ts`) and session (`goals.ts`) create/update paths, with
regression tests added.

**Testing methodology, honestly stated:** LLM-backed detectors/reasoners
(the two new conflict detectors, goal-reasoner's strategy generation) are
not unit-tested with a mocked LLM — no test anywhere in this codebase mocks
`runLLM`, and this phase didn't break that convention. They were validated
by live smoke testing: a real Bun server process, a real registered BAP
agent, real curl calls, and direct SQLite inspection of the resulting rows.
That pass found zero new integration bugs and additionally *validated* an
emergent cross-system behavior — see `INTELLIGENCE.md` §3's testing note.

---

## 6. Performance impact

- **Read paths add joins, not N+1 queries.** `GET /goals/:id`'s new
  `strategic_planning` block is two additional single-row/COUNT queries;
  the timeline endpoint is six small indexed queries merged in memory, not
  a recursive walk.
- **Knowledge graph traversal is bounded** — depth capped at 5, node count
  capped at 200 (`MAX_NODES` in `knowledge-graph.ts`), so a densely-connected
  graph can't turn a traversal request into an unbounded scan.
- **Recommendation ranking and explainability are the two genuinely
  heavier reads.** Ranking gathers three candidate sets and runs a
  constraint check + historical lookup per candidate — fine at the data
  volumes this instance operates at, but is an O(candidates) set of small
  queries, not a single aggregate query. Explainability's KB search is
  capped to the top 5 recommendations specifically because it's an async
  external-ish call per item; the cap and its rationale are documented in
  the response itself (`explanation_depth`), not hidden.
- **Every expensive/LLM-backed write is fire-and-forget (202), never
  synchronous** — opportunity scans, retrospective runs, goal re-planning —
  consistent with every prior phase's async-trigger convention. The one
  exception, `POST .../graph/rebuild`, is synchronous 200 because it's fast
  and deterministic (no LLM call), which was a deliberate choice, not an
  oversight.
- **No new N+1 pattern was introduced in the dashboard UI.** The Goals
  page's per-goal "Strategy & timeline" panel fetches lazily (only when a
  user expands it), not on initial page load for every goal.

No load/stress testing was performed — this is a single-tenant-per-business,
locally-run system at the data scale Blueprint currently operates at, and
none of the above concerns are expected to matter until that scale changes
materially.

---

## 7. Remaining limitations (honest, not exhaustive)

- **No automatic knowledge-graph entity extraction** for
  competitor/product/customer/campaign/person nodes — manual registration
  only (`INTELLIGENCE.md` §5, §12).
- **Constraint budgets are single-action, not period-cumulative**
  (`INTELLIGENCE.md` §7).
- **Milestone CRUD has no dedicated endpoint** — read-merged from a real
  table, but only writable via the legacy JSON column today
  (`GOAL_ENGINE.md` §8).
- **`depends_on` validation is silent** — a typo'd goal ID is dropped, not
  rejected with a 400 (`GOAL_ENGINE.md` §8).
- **A strategy's historical success rate is action-type-level, not
  strategy-specific** — two different strategies hinting at the same
  action type get the same historical number (`GOAL_ENGINE.md` §8).
- **No per-recommendation feedback loop into calibration** — calibration
  reads aggregate outcomes, not "recommendation #123 led to task #456 which
  succeeded" (`INTELLIGENCE.md` §12).
- **Cross-business patterns are outcome-derived only**, not yet informed by
  decisions, conflicts, or strategic assessments (`INTELLIGENCE.md` §12).
- **The Relationship Graph dashboard page hand-rolls its own force-directed
  layout** (plain repulsion/spring physics in a `useEffect`, no external
  graph-visualization library is a dependency of this project) — adequate
  for the bounded node count the backend already caps traversal to, but not
  as polished as a dedicated library like `d3-force` or `cytoscape` would
  produce. A deliberate scope decision (per the session's "don't add a new
  dependency speculatively" instruction), not an oversight.
- **"Strategy" has no standalone top-level dashboard page** — per-goal
  strategic assessment/candidate strategies/timeline are shown in an
  expandable panel on the Goals page (since every one of them is scoped to
  a specific goal and would otherwise need its own goal-picker), rather than
  a separate `/strategy` route. Recommendations, Opportunities, Decisions,
  Calibration, and the Relationship Graph each got their own dedicated page
  as the spec's UI list otherwise implies.

## 8. Readiness for Phase 4

The strategic reasoning layer is now durable, evidence-backed, and fully
exposed through both BAP and the dashboard — an external agent (Hermes) can
read every goal's strategic plan, every conflict's category, every
decision's evidence, every recommendation's explanation, and every agent's
calibration history, and can trigger planning/scanning/retrospective runs
without needing dashboard access. The genuinely open items for a Phase 4 to
pick up, in rough priority order:

1. **Cumulative constraint tracking** — a real spend/resource ledger, so
   budget constraints catch "many small actions" not just "one large one."
2. **Knowledge-graph entity extraction** — an LLM pass over KB text to
   auto-populate competitor/product/customer/campaign nodes, closing the
   one gap in an otherwise-automatic graph.
3. **Per-recommendation outcome tracking** — closing the loop from "this
   specific recommendation was accepted" to "and here's what happened,"
   distinct from action-type-level historical learning.
4. **A `/strategy` or graph-visualization upgrade** — either promote the
   per-goal strategy panel into its own page with cross-goal comparison, or
   adopt a real graph-visualization library for the Relationship Graph page
   once node counts or interactivity needs grow past what a hand-rolled
   layout comfortably handles.
5. **Cross-business patterns beyond outcomes** — extending the same
   anonymization approach to decisions and conflicts, not just
   `task_outcomes`.

Security, tenant isolation, durability, idempotency, and auditability from
Phases 0–2 are unchanged and unregressed — every new soft-vs-hard foreign
key decision, every new route's permission gate, and every new fire-and-
forget trigger followed the exact patterns those phases established, and
the full pre-existing test suite (minus the documented, pre-existing
flakiness) still passes.
