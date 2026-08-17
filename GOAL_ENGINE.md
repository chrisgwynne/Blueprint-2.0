# Goal Engine (Phase 3)

The goal model before Phase 3: a `goals` row with a metric, a deadline, a
free-form `milestones` JSON array, and — critically — no real relationship
to the tasks, signals, or outcomes working toward it. Linkage was inferred
through an optional `project_id` both goals and tasks happened to share —
a known gap: "Goal↔task/signal linkage is a proxy, not a real
relationship."

Phase 3 makes goals a first-class relational entity: real foreign keys,
owner/confidence/priority, milestones and dependencies as queryable tables,
and a durable strategic-planning history. This document covers the data
model; `INTELLIGENCE.md` covers how the reasoning engines that populate it
work, and `DECISION_ENGINE.md` covers how the decisions this engine makes
(which strategy to recommend, which task serves which goal) are recorded
permanently.

---

## 1. Real foreign keys, not a proxy

```sql
ALTER TABLE tasks ADD COLUMN goal_id TEXT REFERENCES goals(id);
ALTER TABLE signals ADD COLUMN goal_id TEXT REFERENCES goals(id);
ALTER TABLE task_outcomes ADD COLUMN goal_id TEXT REFERENCES goals(id);
ALTER TABLE agent_runs ADD COLUMN goal_id TEXT REFERENCES goals(id);
```

`project_id` is left in place — nothing after this reads it exclusively —
and a one-time backfill (safe to re-run every startup; a no-op once a row
has a `goal_id`) fills `goal_id` from `project_id` for every pre-existing
row that had one:

```sql
UPDATE tasks SET goal_id = (
  SELECT g.id FROM goals g WHERE g.project_id = tasks.project_id AND g.business_id = tasks.business_id LIMIT 1
) WHERE goal_id IS NULL AND project_id IS NOT NULL;
```

Every read path that used to join through `project_id` now reads `goal_id`
directly, with the `project_id` join kept only as a fallback **union**, so a
goal or task created before this migration doesn't silently lose its
linkage:

- `bap-goals.ts`'s `GET /goals/:id` — `linked_tasks`/`linked_signals` are
  `WHERE (goal_id = ? OR (project_id = ? AND project_id IS NOT NULL))`.
- `bap.ts`'s `GET .../tasks?goal_id=...` filter is now a direct
  `WHERE goal_id = ?` (previously resolved through `project_id`).
- `POST .../signals` and `POST .../tasks` both accept and validate a
  `goal_id` directly now.

## 2. Goal model additions

```sql
ALTER TABLE goals ADD COLUMN owner TEXT;
ALTER TABLE goals ADD COLUMN confidence REAL;
ALTER TABLE goals ADD COLUMN priority TEXT DEFAULT 'p2';   -- p1 | p2 | p3
```

`milestones`/`notes`/`tags` stay as JSON columns (small, free-form,
non-relational lists) — `owner`/`confidence`/`priority` are scalars that
belong on the row itself. Milestones and dependencies, by contrast, are
genuinely relational (a growing, independently-queried collection, and a
goal-to-goal edge respectively), so they get real tables:

```sql
CREATE TABLE goal_milestones (
  id TEXT PRIMARY KEY, goal_id TEXT NOT NULL REFERENCES goals(id),
  business_id TEXT NOT NULL REFERENCES businesses(id),
  title TEXT NOT NULL, target_pct REAL, notes TEXT,
  status TEXT NOT NULL DEFAULT 'pending', achieved_at DATETIME,
  source TEXT DEFAULT 'human', created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE goal_dependencies (
  id TEXT PRIMARY KEY, goal_id TEXT NOT NULL REFERENCES goals(id),
  depends_on_goal_id TEXT NOT NULL REFERENCES goals(id),
  business_id TEXT NOT NULL REFERENCES businesses(id),
  note TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
-- UNIQUE(goal_id, depends_on_goal_id)
```

`goal_dependencies` is deliberately goal-to-goal only — "Goal B can't start
until Goal A hits 50%." Cross-entity dependency conflicts (a *task*
depending on something) are the conflict engine's job, not this table's;
see section 4 below and `checkGoalDependencyConflicts` in
`server/brain/conflict-engine.ts`.

Every goal created before this migration has no rows in either table — its
detail response falls back to the legacy `goals.milestones` JSON column,
merged by title with the real rows (`loadMilestones()` in
`bap-goals.ts`/`goals.ts`) so nothing silently disappears; dependencies have
no legacy equivalent and simply start empty.

## 3. Strategic Planning Engine — durable, versioned assessments

`server/brain/goal-reasoner.ts` already ran an LLM-backed feasibility pass
on goal creation (Phase 0/1). Phase 3's change is not the reasoning itself
but **what happens to its output**: previously it produced a JSON blob
attached to a `goals.notes` entry and a rendered KB markdown page — useful
for a human reading the dashboard, unqueryable by BAP, and overwritten
conceptually every time reasoning re-ran (the notes array grew, but nothing
distinguished "the current plan" from "an old one" except position).

Now every reasoning pass appends a permanent `goal_assessments` row:

```sql
CREATE TABLE goal_assessments (
  id TEXT PRIMARY KEY, goal_id TEXT NOT NULL REFERENCES goals(id),
  business_id TEXT NOT NULL REFERENCES businesses(id),
  feasibility_verdict TEXT, feasibility_confidence REAL, feasibility_reasoning TEXT,
  key_constraint TEXT, expected_impact TEXT, gap_analysis JSON,
  assumptions JSON DEFAULT '[]', risks JSON DEFAULT '[]', dependencies JSON DEFAULT '[]',
  measurement_plan JSON, success_criteria JSON DEFAULT '[]',
  recommended_strategy_id TEXT, created_by TEXT DEFAULT 'goal-reasoner',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

"Updated over time" (the spec's words) means **append**, not overwrite —
`GET /goals/:id/assessment` returns the latest, `GET /goals/:id/assessments`
returns the full history, and the assessment history is itself part of the
goal's timeline (section 5). The LLM's structured output was extended with
`assumptions`, per-path `estimated_cost_gbp`/`action_type_hint`, and a
top-level `success_criteria` field the spec explicitly asks for.

## 4. Multi-Strategy Planning — comparable candidate strategies

`goal-reasoner.ts` already asked the LLM for multiple "paths" toward a
goal. Phase 3 turns each path into a durable, individually comparable row
instead of a nested array inside the assessment JSON:

```sql
CREATE TABLE goal_strategies (
  id TEXT PRIMARY KEY, goal_id TEXT NOT NULL REFERENCES goals(id),
  business_id TEXT NOT NULL REFERENCES businesses(id),
  assessment_id TEXT REFERENCES goal_assessments(id),
  name TEXT NOT NULL, summary TEXT, expected_impact_summary TEXT,
  confidence REAL, estimated_effort TEXT, estimated_cost REAL, estimated_cost_unit TEXT DEFAULT 'gbp',
  time_to_impact_days INTEGER, historical_success_rate REAL, historical_sample_size INTEGER DEFAULT 0,
  evidence JSON DEFAULT '[]', depends_on JSON DEFAULT '[]',
  is_recommended INTEGER DEFAULT 0, status TEXT NOT NULL DEFAULT 'candidate',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

`historical_success_rate`/`historical_sample_size` are computed
deterministically per strategy from `server/tasks/historical-learning.ts`'s
`actionTypeTrackRecord()` at persistence time — the LLM proposes the path,
the historical-learning module (not the LLM) supplies its track record,
matching the spec's "structured evidence, not LLM-hallucinated" requirement
for historical claims. `GET /goals/:id/strategies` returns every candidate,
sorted recommended-first then by confidence — this is also the exact query
`server/brain/recommendation-engine.ts` uses to feed strategies into the
cross-cutting recommendation ranking (see `INTELLIGENCE.md`).

`persistStrategicPlanning()` in `goal-reasoner.ts` is the single write path
for both tables — it inserts one `goal_assessments` row and one
`goal_strategies` row per LLM-proposed path, marks the recommended one, and
records a `strategy_selection` decision (see `DECISION_ENGINE.md`) — so "why
did the reasoner recommend path B over path A" is answerable from stored
evidence months later, not by re-asking the LLM.

## 5. Goal timeline

`GET /goals/:id/timeline` (and its session-authenticated dashboard mirror,
`GET /api/goals/:businessId/:id/timeline`) merges every dated event a goal
has accumulated into one chronological feed, computed at read time from six
existing sources — nothing new is written to produce it:

| Event type | Source |
|---|---|
| `goal_created` | `goals.created_at` |
| `progress_check` | `goal_checks` |
| `strategic_assessment` | `goal_assessments` |
| `strategy_proposed` | `goal_strategies` |
| `conflict_detected` | `conflicts` (either side referencing this goal) |
| `decision` | `decisions` (`related_goal_id = this goal`) |
| `goal_achieved` | `goals.achieved_at`, if set |

This answers the spec's "historical timeline" requirement without a new
event-sourcing table — every contributing table already existed or was
added for its own reason (assessments/strategies above, decisions in
`DECISION_ENGINE.md`); the timeline is a merge-sort over them.

## 6. Goal conflict detection — dependencies as a first-class conflict type

`server/brain/conflict-engine.ts` gained `checkGoalDependencyConflicts()` —
the one **deterministic** (no LLM) conflict detector in Phase 3, because a
broken dependency chain is a pure graph fact, not a judgment call:

- **Cycles** — A depends on B, B depends on A (or a longer cycle) —
  `goal_dependency` conflict, `category: 'dependency'`.
- **Blocked-but-active** — a goal is `active` while a goal it depends on is
  neither `achieved` nor sufficiently progressed — flagged so a human sees
  "you're working on B, but A isn't done yet" rather than discovering it
  only when B stalls.

This is one of five conflict detectors Phase 3 added or extended (task vs.
task, signal vs. goal, and the pre-existing goal vs. goal and task vs. goal
detectors are LLM-backed); see `INTELLIGENCE.md` section 3 for the full
picture and why `category` (direct/resource/timing/dependency) is tracked
as a dimension independent of `conflict_type` (which entities collided).

## 7. API surface

New/changed endpoints — see [server/bap/AGENT-GUIDE.md](server/bap/AGENT-GUIDE.md)'s
Goals section for the current, code-verified list and
`docs/openapi/bap-v1.yaml` for the formal spec:

- `POST`/`PATCH .../goals` accept `owner`, `confidence`, `priority`,
  `depends_on` (array of goal IDs; silently drops any ID that isn't a real
  goal in the same business rather than erroring — same
  "best-effort, not fatal" philosophy the rest of `bap-goals.ts` uses).
- `GET /goals/:id` now returns `strategic_planning: { latest_assessment,
  strategy_count }` and real `milestones`/`dependencies` (merged with any
  legacy JSON, per section 2).
- `GET /goals/:id/assessment`, `/assessments`, `/strategies`, `/timeline` —
  new, read-only.
- `POST /goals/:id/plan` — re-runs the reasoner on demand, fire-and-forget
  (202), same shape as every other expensive-trigger endpoint in this
  codebase (`goals:propose`/`tasks:approve`'s async execution, Phase 2's
  connector-sync trigger).

Every one of these exists twice — once BAP-key-authenticated
(`server/routes/bap-goals.ts`) and once session-authenticated
(`server/routes/goals.ts`, for the dashboard) — reading the exact same
tables and engine functions, matching the codebase's established
"same engine, different auth gate" pattern (Phase 2's `goals.ts` vs.
`bap-goals.ts` split).

## 8. What this does not do

- **Milestone CRUD has no dedicated endpoint.** `goal_milestones` rows are
  read (merged into `GET /goals/:id`) but only written by direct SQL today
  (there is no `POST /goals/:id/milestones`) — the legacy JSON milestones
  field on `PATCH .../goals` is still the only write path a caller has.
  Adding a real milestone-CRUD surface is a reasonable Phase 4 candidate.
- **`depends_on` validation is silent, not error-returning.** An agent that
  passes a typo'd goal ID gets a 200/201 with that dependency simply
  omitted, not a 400 — consistent with this file's existing tolerance for
  malformed `assigned_agents`/`tags`, but worth knowing if you're debugging
  "why isn't my dependency showing up."
- **Historical success rate on a strategy is action-type-level, not
  strategy-specific.** Two different strategies that both hint at the same
  `action_type` (e.g. both roughly "SEO content work") get the same
  historical-success number — the track record doesn't yet distinguish
  strategies by anything more specific than the action type they'd
  ultimately execute as.
