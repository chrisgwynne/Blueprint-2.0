/**
 * Brain — Constraint Engine (Phase 3).
 *
 * Generalizes the "don't recommend impossible actions" rule beyond the
 * one constraint type restraint.ts already enforced (measurement windows,
 * via action_memory). Operator-authored rows in the `constraints` table
 * add: campaign freezes, working-hours windows, and single-action budget
 * ceilings. Seasonality reuses the existing seasonality.ts detector rather
 * than duplicating it.
 *
 * Honesty note: the "budget"/"resource" constraint type compares a single
 * proposed action's own declared cost against the constraint's
 * limit_value — it is NOT a period-cumulative spend tracker (Blueprint has
 * no ledger of actual ad/resource spend to sum against). A goal or
 * strategy proposing to spend more than the limit in one shot is caught;
 * many smaller actions that together exceed a monthly budget are not,
 * because nothing currently records actual spend per action. See
 * PHASE3.md's "remaining limitations."
 */
import db from '../db/db.js';
import { isWithinSeasonalVariation } from './seasonality.js';

export interface ConstraintCheckInput {
  action_type?: string | null;
  connector?: string | null;
  category?: string | null;
  estimated_cost?: number | null;
  metric_name?: string | null;
  metric_change_pct?: number | null;
  at?: Date; // for testability; defaults to now
}

export interface ConstraintViolation {
  constraint_id: string;
  constraint_type: string;
  note: string | null;
  severity: 'blocking' | 'advisory';
}

interface ConstraintRow {
  id: string;
  constraint_type: string;
  scope: string | null;
  limit_value: number | null;
  limit_unit: string | null;
  period: string | null;
  starts_at: string | null;
  ends_at: string | null;
  note: string | null;
}

function scopeMatches(scope: Record<string, unknown>, input: ConstraintCheckInput): boolean {
  if (scope.action_type && scope.action_type !== input.action_type) return false;
  if (scope.connector && scope.connector !== input.connector) return false;
  if (scope.category && scope.category !== input.category) return false;
  return true;
}

function isTimeActive(row: ConstraintRow, at: Date): boolean {
  if (row.starts_at && new Date(row.starts_at) > at) return false;
  if (row.ends_at && new Date(row.ends_at) < at) return false;
  return true;
}

/**
 * Checks a proposed action against every active constraint for the
 * business. Returns violations (blocking = should not be recommended at
 * all; advisory = surface it, but not a hard stop) — never throws, so
 * callers (recommendation-engine.ts, opportunity generation) can always
 * call this and act on the result rather than handling an exception.
 */
export function checkConstraints(businessId: string, input: ConstraintCheckInput): { allowed: boolean; violations: ConstraintViolation[] } {
  const at = input.at ?? new Date();
  const rows = db.prepare(
    'SELECT * FROM constraints WHERE business_id = ? AND active = 1'
  ).all(businessId) as ConstraintRow[];

  const violations: ConstraintViolation[] = [];
  for (const row of rows) {
    if (!isTimeActive(row, at)) continue;
    let scope: Record<string, unknown> = {};
    try { scope = row.scope ? JSON.parse(row.scope) : {}; } catch {}
    if (Object.keys(scope).length > 0 && !scopeMatches(scope, input)) continue;

    switch (row.constraint_type) {
      case 'freeze':
      case 'manual':
        violations.push({ constraint_id: row.id, constraint_type: row.constraint_type, note: row.note, severity: 'blocking' });
        break;
      case 'hours': {
        const startHour = (scope.start_hour as number | undefined) ?? 0;
        const endHour = (scope.end_hour as number | undefined) ?? 24;
        const hour = at.getUTCHours();
        if (hour < startHour || hour >= endHour) {
          violations.push({ constraint_id: row.id, constraint_type: 'hours', note: row.note ?? `Only allowed between ${startHour}:00 and ${endHour}:00 UTC.`, severity: 'blocking' });
        }
        break;
      }
      case 'budget':
      case 'resource':
        if (row.limit_value != null && input.estimated_cost != null && input.estimated_cost > row.limit_value) {
          violations.push({
            constraint_id: row.id, constraint_type: row.constraint_type,
            note: row.note ?? `Estimated cost ${input.estimated_cost} exceeds the ${row.limit_value} ${row.limit_unit ?? ''} limit for this scope.`,
            severity: 'blocking',
          });
        }
        break;
      case 'seasonality':
        if (input.metric_name && input.metric_change_pct != null && isWithinSeasonalVariation(input.metric_name, input.metric_change_pct, businessId)) {
          violations.push({
            constraint_id: row.id, constraint_type: 'seasonality',
            note: row.note ?? `The change in ${input.metric_name} is within normal seasonal variation — likely not worth acting on.`,
            severity: 'advisory',
          });
        }
        break;
      default:
        // Unknown constraint_type — surface as advisory rather than
        // silently ignoring an operator-authored constraint we don't
        // understand yet.
        violations.push({ constraint_id: row.id, constraint_type: row.constraint_type, note: row.note, severity: 'advisory' });
    }
  }

  return { allowed: !violations.some((v) => v.severity === 'blocking'), violations };
}

export function listConstraints(businessId: string, activeOnly = true): Record<string, unknown>[] {
  const where = activeOnly ? 'business_id = ? AND active = 1' : 'business_id = ?';
  return (db.prepare(`SELECT * FROM constraints WHERE ${where} ORDER BY created_at DESC`).all(businessId) as Array<Record<string, unknown>>)
    .map((r) => ({ ...r, scope: (() => { try { return JSON.parse((r.scope as string) || '{}'); } catch { return {}; } })() }));
}
