# Decision Memory (Phase 3)

"Why did we decide this six months ago?" should be answerable by reading a
row, not by an LLM guessing from whatever context happens to still be
lying around. That's the entire job of `server/brain/decision-memory.ts`
and the `decisions` table it owns — a genuinely new subsystem in Phase 3,
not an extension of an existing one.

## 1. Schema

```sql
CREATE TABLE decisions (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id),
  decision_type TEXT NOT NULL,
  title TEXT NOT NULL,
  decision TEXT NOT NULL,
  reasoning TEXT,
  evidence JSON DEFAULT '[]',
  confidence REAL,
  alternatives_rejected JSON DEFAULT '[]',
  author TEXT NOT NULL,
  related_goal_id TEXT,
  related_task_id TEXT,
  related_signal_id TEXT,
  related_outcome_id TEXT,
  related_conflict_id TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

`decision_type` is one of `task_approval | task_rejection |
task_cancellation | strategy_selection | goal_creation |
goal_status_change | conflict_resolution | conflict_dismissal |
opportunity_accepted | opportunity_dismissed | manual`.

### Why `related_*_id` columns have no `REFERENCES` clause

This is the one deliberate, load-bearing design decision in this file, and
it was **not** the first draft. The first draft declared `related_goal_id
TEXT REFERENCES goals(id)` (and the same for task/signal/outcome/conflict)
— it looked more "correct" and matched every other foreign key in this
migration.

It broke production-shaped behavior immediately: this database runs with
`PRAGMA foreign_keys = ON`, and once `approveTask()`/`rejectTask()` started
calling `recordDecision()`, a hard FK on `related_task_id` meant **a task
could never be deleted again** once a decision referenced it — including
by admin cleanup scripts and, concretely, by
`task-queue.approve-cancel.test.ts`'s own `afterEach` cleanup, which is how
this was caught (a full-suite regression run went from ~15 known-flaky
failures to 22; isolating to that one test file confirmed the FK as the
cause).

A decision is a **historical record** — like `audit_log.entity_id`, which
this codebase already treats as a plain, unenforced string for exactly this
reason. Deleting the goal a decision references should never be blocked by
the fact that a decision exists; the decision should simply outlive it,
same as an audit log entry outlives whatever it logged. So every
`related_*_id` column is a soft reference: plain `TEXT`, no `REFERENCES`,
resolved at read time by a normal (unenforced) join, and left `NULL`-able
if the referenced row is later deleted.

Contrast this with `kg_entities`/`kg_edges` (see `INTELLIGENCE.md` section
5), which **do** keep real FKs — nothing today deletes a graph node, so
enforcement there costs nothing and catches real bugs. The rule isn't
"decisions never get FKs," it's "a table's delete semantics decide whether
a reference should be enforced or soft," applied per-table rather than by
blanket convention.

## 2. Write path — one function, many callers

`recordDecision()` is the only way a row is ever inserted. Every engine
that makes a consequential choice calls it directly rather than
maintaining its own log:

| Caller | `decision_type` | What's recorded |
|---|---|---|
| `task-queue.ts`'s `approveTask()` | `task_approval` | Who approved, at what confidence, and (via `evidence`) the task's stated action/target |
| `task-queue.ts`'s `rejectTask()` | `task_rejection` | Rejection reason, author |
| `goal-reasoner.ts`'s `persistStrategicPlanning()` | `strategy_selection` | Which candidate strategy was recommended, the assessment it came from, and — critically — the **other candidates as `alternatives_rejected`**, not just the winner |
| `conflict-engine.ts`'s `resolveConflict()`/`dismissConflict()` | `conflict_resolution` / `conflict_dismissal` | Resolution note or dismiss reason, actor (defaults to `'human'` for dashboard calls, the calling agent's ID for BAP calls) |
| `goal-suggester.ts`'s `acceptSuggestion()`/`dismissSuggestion()` | `opportunity_accepted` / `opportunity_dismissed` | Which opportunity, why, at what confidence |

`resolveConflict`/`dismissConflict`/`dismissSuggestion` all gained an
`actor` parameter in Phase 3 specifically so this attribution is real —
previously these functions had no caller identity to record at all.

## 3. Read path — recall, not lookup

`recallDecisions(businessId, filters)` is a general-purpose search, not a
by-ID lookup — `q` (LIKE across `title`/`decision`/`reasoning`),
`decision_type`, `related_goal_id`, `related_task_id`, `date_from`/
`date_to`, paginated. This is what lets a caller ask "why did we decide
anything about goal X" without knowing a decision ID in advance —
exactly the spec's framing.

`getDecision(id, businessId)` is the single-row detail lookup, always
scoped to a business (see section 4).

## 4. API surface

Read-only, on purpose — decisions are written by the engines above, never
directly through either BAP or the dashboard API:

- `GET /businesses/:id/decisions` — recall/search (BAP:
  `bap-decisions.ts`, requires `decisions:read`; dashboard:
  `server/routes/decisions.ts`, session-authenticated, same underlying
  `recallDecisions()` call).
- `GET /decisions/:id` — detail. This route has no `:businessId` in its
  path (a decision ID is unique on its own), so it uses the same
  cross-tenant-safe pattern as every other no-`:businessId` BAP route in
  this codebase: look the row up first by ID alone, **then** re-check the
  caller's permission against the row's actual `business_id` before
  returning anything. A decision belonging to a business the caller isn't
  authorized for returns 403, not 404 (matching the existing IDOR-safety
  precedent from `bap.ts`'s `GET /tasks/:id`/`GET /signals/:id`) and not a
  silent cross-tenant leak.

## 5. What this does not do

- **No decision is ever updated or deleted through this API.** A decision
  is immutable once recorded — if a later decision supersedes it, that's a
  *new* row, not an edit to the old one (this is deliberate: an immutable
  audit trail is the entire point, and it composes with the knowledge
  graph's `supersedes` edge type for representing "this decision replaced
  that one" without destroying the original).
- **`evidence`/`alternatives_rejected` are free-form JSON, not typed
  schemas.** Each caller decides what shape of evidence is meaningful for
  its decision type (a task approval's evidence looks nothing like a
  strategy selection's) — there's no cross-cutting evidence schema
  enforced at the `decisions` table level, only at each call site's
  discretion.
- **No decision review/annotation workflow.** A human can read a decision
  but there's no "mark this decision as having turned out wrong" loop back
  into calibration — that connection exists structurally (calibration
  reads outcomes, not decisions directly) but isn't wired decision-by-decision.
