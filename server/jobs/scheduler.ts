import cron from 'node-cron';
import db from '../db/db.js';
import { processTimedApproval } from '../tasks/approval.js';
import { runConductorAllBusinesses } from '../agents/conductor.js';
import crypto from 'crypto';
import type { Connector } from '../types/db.js';
import type { ConnectorInterface } from '../connectors/connector.interface.js';
import { withLeaderLock, tryAcquireOrRenewLeaderLock } from './scheduler-lock.js';
import { runExecutionWorkerTick, recoverStuckJobs } from '../tasks/execution-worker.js';
import { pruneExpiredIdempotencyKeys } from '../lib/idempotency.js';
import { refreshConnectorConfidence } from '../connectors/confidence.js';
import { writeWorldModelSnapshot, getPreviousConnectorData } from '../world-model/world-model.js';
import { recoverStaleAgentRuns } from '../agents/agent-runner.js';

let schedulerStarted = false;

/**
 * Every cron registration in this file goes through this wrapper instead
 * of calling node-cron's `cron.schedule` directly — it's the same
 * function, plus a leader-lock guard (scheduler-lock.ts) so that if two
 * Blueprint processes are ever running against the same database, only
 * the one currently holding the lease actually does the work on a given
 * tick. The other simply no-ops that tick rather than duplicating a
 * connector sync, an agent run, an outcome check, or (most importantly)
 * an execution-job claim.
 */
function scheduleWithLock(pattern: string, fn: () => void | Promise<void>, options?: Parameters<typeof cron.schedule>[2]): void {
  cron.schedule(pattern, withLeaderLock(fn), options);
}

/**
 * Sync a single connector by loading its implementation and running fetch.
 */
export async function syncConnector(connector: Connector): Promise<{ ok: boolean; newSignals?: unknown[]; error?: string }> {
  const syncId = crypto.randomUUID();
  const syncStart = Date.now();
  try {
    db.prepare(`INSERT INTO connector_syncs (id, connector_id, status, created_at) VALUES (?, ?, 'running', CURRENT_TIMESTAMP)`).run(syncId, connector.id);
  } catch {}

  try {
    const { default: connectorImpl } = await import(`../connectors/${connector.type}/index.js`) as { default: ConnectorInterface & { extractMetrics?: (data: unknown, now: string) => Array<{ name: string; value: number | string | null; data?: unknown }> } };

    let credentials: Record<string, unknown> = {};
    if (connector.credentials) {
      const { decrypt } = await import('../crypto.js');
      try {
        credentials = JSON.parse(decrypt(connector.credentials as unknown as string));
      } catch {
        credentials = {};
      }
    }

    const config: Record<string, unknown> = connector.config ? JSON.parse(connector.config as unknown as string) : {};

    // Determine what to fetch based on connector type
    let businessUrl: string | null = null;
    if (connector.type === 'pagespeed' && !config.url) {
      try {
        const biz = db.prepare('SELECT settings FROM businesses WHERE id = ?').get(connector.business_id) as { settings: string } | undefined;
        if (biz?.settings) {
          const settings = JSON.parse(biz.settings);
          businessUrl = settings?.website || settings?.url || null;
        }
      } catch {}
    }

    const fetchParams = {
      ...config,
      businessId: connector.business_id,
      ...(config.siteUrl ? { siteUrl: config.siteUrl } : {}),
      ...(config.propertyId ? { propertyId: config.propertyId } : {}),
      ...(config.url ? { url: config.url } : businessUrl ? { url: businessUrl } : {}),
    };

    const dataType = (config.defaultDataType as string | undefined) || getDefaultDataType(connector.type);
    const data = await connectorImpl.fetch(dataType, credentials, fetchParams);
    const now = new Date().toISOString();

    // Write individual named metric rows if connector supports extractMetrics()
    if (typeof connectorImpl.extractMetrics === 'function') {
      const metrics = connectorImpl.extractMetrics(data, now);
      for (const m of metrics) {
        db.prepare(`
          INSERT INTO metrics (id, business_id, connector_id, metric_name, metric_value, metric_data, period_start, period_end, recorded_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        `).run(
          crypto.randomUUID(),
          connector.business_id,
          connector.id,
          m.name,
          m.value ?? null,
          m.data ? JSON.stringify(m.data) : null,
          now,
          now,
        );
      }
    }

    // Always write a blob summary row for history + signal engine
    db.prepare(`
      INSERT INTO metrics (id, business_id, connector_id, metric_name, metric_data, period_start, period_end, recorded_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    `).run(
      crypto.randomUUID(),
      connector.business_id,
      connector.id,
      `${connector.type}_sync`,
      JSON.stringify(data),
      now,
      now,
    );

    // Run signal engine against the new data
    const { runSignalEngine } = await import('../signals/signal-engine.js') as unknown as { runSignalEngine: (...args: any[]) => Promise<any[]> };

    // "Connectors update the World Model, signals are generated from the
    // World Model" — previousData now comes from the World Model's own
    // record of this connector's last-known data (the prior snapshot,
    // written after the LAST sync), not an ad-hoc second query against
    // the metrics table. The 40 signal rules below are unaffected — they
    // still just receive (current, previous) in the same shape.
    const previousData = getPreviousConnectorData(connector.business_id, connector.id);

    // For pagespeed, pass mobile data directly to match signal rule field paths
    const signalData = (connector.type === 'pagespeed' && (data as Record<string, unknown>).mobile) ? (data as Record<string, unknown>).mobile : data;
    const prevData = previousData as Record<string, unknown> | null;
    const prevSignalData = (connector.type === 'pagespeed' && prevData?.mobile) ? prevData.mobile : prevData;

    const newSignals = await runSignalEngine(
      connector.business_id,
      connector.id,
      signalData,
      prevSignalData,
      connector.type
    );

    // Update connector last_sync
    db.prepare(`
      UPDATE connectors SET status = 'connected', last_sync = CURRENT_TIMESTAMP, last_error = NULL WHERE id = ?
    `).run(connector.id);

    console.log(`[scheduler] Synced connector '${connector.name}' (${connector.type}). New signals: ${newSignals.length}`);

    // World Model: connectors feed the World Model, not agents directly.
    // Fire-and-forget — never let confidence/snapshot bookkeeping block sync.
    try { refreshConnectorConfidence({ ...connector, status: 'connected', last_sync: new Date().toISOString(), last_error: null }); } catch {}
    writeWorldModelSnapshot(connector.business_id, 'connector_sync');

    // BAP webhook: connector.sync.complete
    try {
      const { dispatchWebhookEvent } = await import('../bap/webhook-dispatcher.js') as unknown as { dispatchWebhookEvent: (event: string, data: any) => void };
      dispatchWebhookEvent('connector.sync.complete', {
        connector_id: connector.id, connector_type: connector.type,
        business_id: connector.business_id, signals_created: newSignals.length,
      });
    } catch {}

    // Update connector_syncs on success
    try {
      db.prepare(`UPDATE connector_syncs SET status = 'complete', duration_ms = ? WHERE id = ?`)
        .run(Date.now() - syncStart, syncId);
    } catch {}

    // Post-sync orchestration
    try {
      const { onConnectorSyncSuccess } = await import('../connectors/post-sync.js') as unknown as { onConnectorSyncSuccess: (type: string, businessId: string) => any };
      onConnectorSyncSuccess(connector.type, connector.business_id);
    } catch (err: any) {
      console.warn(`[scheduler] post-sync hook failed for '${connector.name}':`, err.message);
    }

    return { ok: true, newSignals };
  } catch (err: any) {
    // Update connector_syncs on failure
    try {
      db.prepare(`UPDATE connector_syncs SET status = 'failed', error = ?, duration_ms = ? WHERE id = ?`)
        .run(err.message.substring(0, 500), Date.now() - syncStart, syncId);
    } catch {}

    db.prepare(`
      UPDATE connectors SET status = 'error', last_error = ? WHERE id = ?
    `).run(err.message.substring(0, 500), connector.id);
    console.error(`[scheduler] Sync failed for connector '${connector.name}':`, err.message);

    // Self-healing: diagnose connector sync failures
    import('../agents/self-healer.js')
      .then((m) => m.healConnectorError(err as Error, connector.type, connector.business_id))
      .catch((healErr: Error) => console.warn('[self-heal] Connector healing failed (non-fatal):', healErr.message));

    // BAP webhook: connector.error
    try {
      const { dispatchWebhookEvent } = await import('../bap/webhook-dispatcher.js') as unknown as { dispatchWebhookEvent: (event: string, data: any) => void };
      dispatchWebhookEvent('connector.error', {
        connector_id: connector.id, connector_type: connector.type,
        business_id: connector.business_id, error: err.message,
      });
    } catch {}

    return { ok: false, error: err.message };
  }
}

function getDefaultDataType(connectorType: string): string {
  const defaults: Record<string, string> = {
    pagespeed: 'performance',
    gsc: 'search_analytics',
    ga4: 'report',
    shopify: 'orders',
    uptimerobot: 'monitors',
    todoist: 'tasks',
    brevo: 'campaigns',
    stannp: 'campaigns',
    wordpress: 'content',
    kirby: 'pages',
    'google-ads': 'campaigns',
  };
  return defaults[connectorType] ?? 'default';
}

function isDue(connector: Connector, intervalMinutes: number): boolean {
  if (!connector.last_sync) return true;
  const lastSync = new Date(connector.last_sync).getTime();
  const intervalMs = intervalMinutes * 60 * 1000;
  return Date.now() - lastSync >= intervalMs;
}

/**
 * Start all scheduled jobs.
 */
export function startScheduler(): void {
  if (schedulerStarted) {
    console.warn('[scheduler] Already started. Skipping.');
    return;
  }
  schedulerStarted = true;

  console.log('[scheduler] Starting Blueprint scheduler...');

  // Every 15 minutes: check connector polling intervals, sync due connectors
  scheduleWithLock('*/15 * * * *', async () => {
    console.log('[scheduler] Running connector poll check...');
    try {
      const connectors = db.prepare(`SELECT * FROM connectors WHERE status != 'disconnected'`).all() as Connector[];

      for (const connector of connectors) {
        const pollingDefaults: Record<string, number> = {
          pagespeed: 1440,
          gsc: 720,
          ga4: 360,
          shopify: 360,
          uptimerobot: 15,
          todoist: 60,
          brevo: 360,
          stannp: 720,
          wordpress: 360,
          kirby: 720,
          'google-ads': 360,
        };
        let configuredInterval: number | null = null;
        try {
          const cfg = typeof connector.config === 'string' ? JSON.parse(connector.config) : (connector.config ?? {});
          if (cfg.pollingIntervalMinutes) configuredInterval = Number(cfg.pollingIntervalMinutes);
        } catch {}
        const interval = configuredInterval || pollingDefaults[connector.type] || 360;

        if (isDue(connector, interval)) {
          syncConnector(connector).catch((err: Error) => {
            console.error(`[scheduler] Connector sync error for ${connector.name}:`, err.message);
          });
        }
      }
    } catch (err) {
      console.error('[scheduler] Connector poll check failed:', err);
    }
  });

  // Every hour: check for stale connectors
  scheduleWithLock('30 * * * *', async () => {
    try {
      const thresholds: Record<string, number> = { pagespeed: 48, gsc: 24, ga4: 12, shopify: 12, uptimerobot: 2 };
      const connectors = db.prepare(`
        SELECT c.id, c.type, c.status, c.last_sync, c.business_id, b.name as business_name
        FROM connectors c JOIN businesses b ON c.business_id = b.id
        WHERE c.status = 'connected' AND c.last_sync IS NOT NULL
      `).all() as Array<Connector & { business_name: string }>;
      for (const c of connectors) {
        const hours = (Date.now() - new Date(c.last_sync!).getTime()) / 3600000;
        const threshold = thresholds[c.type] ?? 24;
        if (hours > threshold) {
          db.prepare("UPDATE connectors SET status = 'stale' WHERE id = ? AND status = 'connected'").run(c.id);
          const exists = db.prepare("SELECT id FROM signals WHERE connector_id = ? AND rule_id = 'connector_stale' AND status = 'open'").get(c.id);
          if (!exists) {
            const { generateId: gid } = await import('../db/db.js') as unknown as { generateId: () => string };
            db.prepare(`
              INSERT INTO signals (id, business_id, connector_id, rule_id, type, severity, title, description, data, status, confidence, created_at)
              VALUES (?, ?, ?, 'connector_stale', 'risk', ?, ?, ?, '{}', 'open', 1.0, CURRENT_TIMESTAMP)
            `).run(
              gid(), c.business_id, c.id,
              hours > threshold * 2 ? 'alert' : 'warning',
              `${c.type.toUpperCase()} connector is stale`,
              `No sync in ${Math.round(hours)} hours for ${c.business_name}. Last synced: ${c.last_sync}`
            );
          }
        }
      }
    } catch (err: any) {
      console.error('[scheduler] Stale connector check failed:', err.message);
    }
  });

  // Conductor safety-net — every 15 minutes, work-gated.
  scheduleWithLock('*/15 * * * *', async () => {
    try {
      const { hasWorkToDo } = await import('../agents/work-checker.js') as any;
      const businesses = db.prepare('SELECT id, slug FROM businesses').all() as any[];
      let ran = 0, skipped = 0;
      for (const biz of businesses) {
        try {
          const work = hasWorkToDo('conductor', biz.id);
          if (!work.hasWork) { skipped += 1; continue; }
          (async () => {
            try {
              const { runAgent } = await import('../agents/agent-runner.js') as any;
              await runAgent('conductor', biz.id, 'safety_net_poll');
            } catch (err: any) {
              console.warn(`[scheduler] Conductor safety-net run failed for ${biz.slug}:`, err.message);
            }
          })();
          ran += 1;
        } catch (err: any) {
          console.warn(`[scheduler] Conductor safety-net check failed for ${biz.slug}:`, err.message);
        }
      }
      if (ran > 0 || skipped > 0) {
        console.log(`[scheduler] Conductor safety-net: ${ran} queued, ${skipped} skipped (no work).`);
      }
    } catch (err) {
      console.error('[scheduler] Conductor safety-net poll failed:', err);
    }
  });

  // Per-agent safety-net — every 5 minutes
  scheduleWithLock('*/5 * * * *', async () => {
    try {
      const { hasWorkToDo, _internal } = await import('../agents/work-checker.js') as any;
      const { getPollInterval } = await import('../agents/poll-intervals.js') as any;

      const businesses = db.prepare('SELECT id, slug FROM businesses').all() as any[];
      const activeAgents = db.prepare(
        "SELECT id FROM agents WHERE status = 'active' AND id != 'conductor'"
      ).all() as any[];

      let queued = 0;
      for (const biz of businesses) {
        for (const agent of activeAgents) {
          const intervalMin = getPollInterval(agent.id);
          const lastRun = _internal.getLastSuccessfulRunAt(agent.id, biz.id);

          if (lastRun) {
            const msSince = Date.now() - new Date(lastRun + (lastRun.endsWith('Z') ? '' : 'Z')).getTime();
            if (Number.isFinite(msSince) && msSince < intervalMin * 60 * 1000) continue;
          }

          const work = hasWorkToDo(agent.id, biz.id);
          if (!work.hasWork) continue;

          (async () => {
            try {
              const { runAgent } = await import('../agents/agent-runner.js') as any;
              await runAgent(agent.id, biz.id, 'safety_net_poll');
            } catch (err: any) {
              console.warn(`[scheduler] ${agent.id} safety-net run failed for ${biz.slug}:`, err.message);
            }
          })();
          queued += 1;
        }
      }
      if (queued > 0) {
        console.log(`[scheduler] Agents safety-net: ${queued} queued.`);
      }
    } catch (err) {
      console.error('[scheduler] Per-agent safety-net poll failed:', err);
    }
  });

  // Every day at 06:00: full connector sync
  scheduleWithLock('0 6 * * *', async () => {
    console.log('[scheduler] Running daily full connector sync...');
    try {
      const connectors = db.prepare(`SELECT * FROM connectors`).all() as Connector[];
      for (const connector of connectors) {
        await syncConnector(connector).catch((err: Error) => {
          console.error(`[scheduler] Daily sync error for ${connector.name}:`, err.message);
        });
      }
      console.log('[scheduler] Daily sync complete. Running post-sync conductor pass...');
      await runConductorAllBusinesses();
    } catch (err) {
      console.error('[scheduler] Daily sync failed:', err);
    }
  });

  // Every day at 04:30: prune old metric snapshots. The metrics table is an
  // append-only time series (every sync writes named metrics + a full raw
  // blob) and grows without bound otherwise. Named metrics are kept longer
  // than the heavy `*_sync` raw blobs. Retention is configurable via the
  // settings keys metrics_retention_days / sync_blob_retention_days.
  scheduleWithLock('30 4 * * *', () => {
    try {
      const getSetting = (key: string, fallback: number): number => {
        try {
          const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
          const n = row ? Number(JSON.parse(row.value)) : NaN;
          return Number.isFinite(n) && n > 0 ? n : fallback;
        } catch { return fallback; }
      };
      const metricDays = getSetting('metrics_retention_days', 365);
      const blobDays = getSetting('sync_blob_retention_days', 60);

      const blobs = db.prepare(`
        DELETE FROM metrics
        WHERE metric_name LIKE '%\\_sync' ESCAPE '\\'
          AND recorded_at < datetime('now', '-' || ? || ' days')
      `).run(blobDays);
      const named = db.prepare(`
        DELETE FROM metrics
        WHERE metric_name NOT LIKE '%\\_sync' ESCAPE '\\'
          AND recorded_at < datetime('now', '-' || ? || ' days')
      `).run(metricDays);

      if ((blobs.changes ?? 0) > 0 || (named.changes ?? 0) > 0) {
        console.log(`[scheduler] Metrics retention: pruned ${blobs.changes} sync blobs (>${blobDays}d) and ${named.changes} named metrics (>${metricDays}d).`);
      }
    } catch (err) {
      console.error('[scheduler] Metrics retention pruning failed:', err);
    }
  });

  // Every 5 minutes: process timed approvals
  scheduleWithLock('*/5 * * * *', async () => {
    try {
      const results = await processTimedApproval();
      if (results.length > 0) {
        console.log(`[scheduler] Processed ${results.length} timed approvals.`);
      }
    } catch (err) {
      console.error('[scheduler] Timed approval processing failed:', err);
    }
  });

  // Weekly outcome attribution checks — Monday 9am
  scheduleWithLock('0 9 * * 1', async () => {
    try {
      const { runOutcomeChecks } = await import('../tasks/outcomes.js') as any;
      const checked = runOutcomeChecks();
      if (checked > 0) console.log(`[scheduler] Outcome checks: ${checked} tasks evaluated.`);
    } catch (err: any) {
      console.error('[scheduler] Outcome checks failed:', err.message);
    }
  });

  // Weekly goal progress check — Monday 8am
  scheduleWithLock('0 8 * * 1', async () => {
    try {
      const { checkAllGoals } = await import('../goals/goal-engine.js') as any;
      const businesses = db.prepare('SELECT id FROM businesses').all() as any[];
      let total = 0;
      for (const b of businesses) {
        total += await checkAllGoals(b.id);
      }
      if (total > 0) console.log(`[scheduler] Goal checks: ${total} goals evaluated.`);
    } catch (err: any) {
      console.error('[scheduler] Goal checks failed:', err.message);
    }
  });

  // Weekly goal suggestions scan — Wednesday 9am
  scheduleWithLock('0 9 * * 3', async () => {
    try {
      const { scanForGoalSuggestions } = await import('../brain/goal-suggester.js') as any;
      const businesses = db.prepare('SELECT id FROM businesses').all() as any[];
      let total = 0;
      for (const b of businesses) {
        try {
          const s = await scanForGoalSuggestions(b.id);
          total += s.length;
        } catch (err: any) {
          console.warn(`[scheduler] Goal suggestions failed for ${b.id}:`, err.message);
        }
      }
      if (total > 0) console.log(`[scheduler] Goal suggestions: ${total} new.`);
    } catch (err: any) {
      console.error('[scheduler] Goal suggestions scan failed:', err.message);
    }
  });

  // Monthly retrospective — 1st of every month at 06:00
  scheduleWithLock('0 6 1 * *', async () => {
    try {
      const { runRetrospective } = await import('../brain/retrospective-engine.js') as any;
      const businesses = db.prepare('SELECT id FROM businesses').all() as any[];
      for (const b of businesses) {
        try {
          const r = await runRetrospective(b.id, { triggered_by: 'scheduler' });
          if (r) console.log(`[scheduler] Retrospective filed for ${b.id.slice(0, 8)}.`);
        } catch (err: any) {
          console.warn(`[scheduler] Retrospective failed for ${b.id}:`, err.message);
        }
      }
    } catch (err: any) {
      console.error('[scheduler] Retrospective run failed:', err.message);
    }
  });

  // Weekly goal conflict audit — Monday 7am
  scheduleWithLock('0 7 * * 1', async () => {
    try {
      const { auditAllGoalConflicts, autoResolveStale } = await import('../brain/conflict-engine.js') as any;
      autoResolveStale();
      const businesses = db.prepare('SELECT id FROM businesses').all() as any[];
      let total = 0;
      for (const b of businesses) {
        total += await auditAllGoalConflicts(b.id).catch(() => 0);
      }
      if (total > 0) console.log(`[scheduler] Conflict audit: ${total} conflicts identified.`);
    } catch (err: any) {
      console.error('[scheduler] Conflict audit failed:', err.message);
    }
  });

  // Weekly strategic goal-reasoning refresh — Monday 6am
  scheduleWithLock('0 6 * * 1', async () => {
    try {
      const { runGoalReasoning } = await import('../brain/goal-reasoner.js') as any;
      const goals = db.prepare(
        "SELECT id, business_id FROM goals WHERE status = 'active'"
      ).all() as any[];
      let refreshed = 0;
      for (const g of goals) {
        try {
          const r = await runGoalReasoning(g.id, g.business_id);
          if (r?.reasoning) refreshed++;
        } catch (err: any) {
          console.warn(`[scheduler] goal reasoning failed for ${g.id}:`, err.message);
        }
      }
      if (refreshed > 0) console.log(`[scheduler] Goal reasoning: refreshed ${refreshed} goals.`);
    } catch (err: any) {
      console.error('[scheduler] Goal reasoning refresh failed:', err.message);
    }
  });

  // Brain — every morning at 07:00
  scheduleWithLock('0 7 * * *', async () => {
    try {
      const { processDeferredTasks } = await import('../brain/restraint.js') as any;
      const { markMeasurementReady } = await import('../brain/action-windows.js') as any;
      await processDeferredTasks();
      const ready = markMeasurementReady();
      if (ready > 0) console.log(`[brain] ${ready} action(s) are now ready to measure.`);
    } catch (err: any) {
      console.error('[scheduler] brain daily pass failed:', err.message);
    }
  });

  // Brain — weekly seasonal pattern detection (Sunday 04:00)
  scheduleWithLock('0 4 * * 0', async () => {
    try {
      const { detectSeasonalPatterns } = await import('../brain/seasonality.js') as any;
      const businesses = db.prepare('SELECT id FROM businesses').all() as any[];
      for (const b of businesses) {
        await detectSeasonalPatterns(b.id);
      }
    } catch (err: any) {
      console.error('[scheduler] seasonal detection failed:', err.message);
    }
  });

  // Nightly KB lint + auto-fix — runs at 2am every night
  scheduleWithLock('0 2 * * *', async () => {
    console.log('[scheduler] Running nightly KB lint + auto-fix...');
    try {
      const { getKBForBusiness } = await import('../kb/kb-config.js') as any;
      const { KBAgent } = await import('../kb/kb-agent.js') as any;
      const { createTask } = await import('../tasks/task-queue.js') as any;

      const businesses = db.prepare('SELECT id, slug FROM businesses').all() as any[];
      for (const business of businesses) {
        try {
          const result = await getKBForBusiness(business.id);
          if (!result) continue;

          const agent = new KBAgent(result.engine);

          const lintResult = await agent.runLint();
          const fixResult = await agent.autoFix(
            lintResult.issues,
            createTask,
            business.id
          );

          const totalIssues =
            lintResult.issues.dead_links.length +
            lintResult.issues.orphans.length +
            lintResult.issues.missing_frontmatter.length;

          console.log(
            `[scheduler] KB auto-fix ${business.slug}: ` +
            `${totalIssues} issues found, ` +
            `${fixResult.applied.length} fixed, ` +
            `${fixResult.escalated.length} escalated, ` +
            `${fixResult.errors.length} errors`
          );

          if (fixResult.errors.length > 0) {
            console.warn(
              `[scheduler] KB auto-fix errors for ${business.slug}:`,
              fixResult.errors.join('; ')
            );
          }
        } catch (bizErr: any) {
          console.warn(
            `[scheduler] KB auto-fix failed for ${business.slug}:`,
            bizErr.message
          );
        }
      }
    } catch (err) {
      console.error('[scheduler] Nightly KB auto-fix failed:', err);
    }
  });

  // Every 5 minutes: retry failed BAP webhook deliveries
  scheduleWithLock('*/5 * * * *', async () => {
    try {
      const { retryPendingDeliveries } = await import('../bap/webhook-dispatcher.js') as any;
      const retried = await retryPendingDeliveries();
      if (retried > 0) {
        console.log(`[scheduler] Retried ${retried} BAP webhook deliveries.`);
      }
    } catch (err: any) {
      console.error('[scheduler] BAP webhook retry failed:', err.message);
    }
  });

  // Weekly full-KB analysis — Sunday at 4am
  scheduleWithLock('0 4 * * 0', async () => {
    console.log('[scheduler] Running weekly KB analysis pass...');
    try {
      const { analyseKBForSignals } = await import('../kb/kb-analyser.js') as any;
      const businesses = db.prepare('SELECT id, slug FROM businesses').all() as any[];
      for (const business of businesses) {
        try {
          const r = await analyseKBForSignals(business.id, { hours: 168, force: true });
          if (r && !r.skipped) {
            console.log(
              `[scheduler] KB analysis ${business.slug}: ` +
              `${r.signals} signals, ${r.tasks} tasks, ${r.gaps} gaps, ` +
              `${r.insights} insights, ${r.contradictions} contradictions`
            );
          }
        } catch (bizErr: any) {
          console.warn(`[scheduler] KB analysis failed for ${business.slug}:`, bizErr.message);
        }
      }
    } catch (err) {
      console.error('[scheduler] Weekly KB analysis failed:', err);
    }
  });

  // Weekly git maintenance — Sunday 3am
  scheduleWithLock('0 3 * * 0', async () => {
    try {
      const { existsSync, statSync } = await import('fs');
      const { resolve, join } = await import('path');
      const { exec } = await import('child_process');
      const { promisify } = await import('util');
      const execAsync = promisify(exec);

      const KB_ROOT = process.env.KB_PATH || resolve(process.cwd(), '../kb');
      const businesses = db.prepare('SELECT slug FROM businesses').all() as any[];
      for (const biz of businesses) {
        const kbPath = join(KB_ROOT, biz.slug);
        if (!existsSync(join(kbPath, '.git'))) continue;
        try {
          await execAsync('git gc --auto --quiet', { cwd: kbPath, timeout: 30_000 });
          const size = statSync(join(kbPath, '.git')).size / 1048576;
          console.log(`[scheduler] KB git gc: ${biz.slug} (.git = ${size.toFixed(1)}MB)`);
        } catch {}
      }
    } catch (err: any) {
      console.error('[scheduler] Git maintenance failed:', err.message);
    }
  });

  // ─── Autonomous execution reliability ─────────────────────────────────────

  // Execution-job worker: claims and runs queued jobs (approveTask() also
  // wakes this immediately via runExecutionWorkerTickNow — this interval
  // is the durability fallback, so a claim is never missed for longer
  // than a minute even if the immediate wake-up is itself lost to a
  // crash right after approval).
  scheduleWithLock('* * * * *', async () => {
    try {
      const { claimed } = await runExecutionWorkerTick();
      if (claimed > 0) console.log(`[scheduler] Execution worker: ran ${claimed} job(s).`);
    } catch (err: any) {
      console.error('[scheduler] Execution worker tick failed:', err.message);
    }
  });

  // Crash recovery: jobs whose lease expired mid-execution. Runs less
  // often than the worker tick — lease expiry (2 min default, see
  // execution-jobs.ts's DEFAULT_LEASE_MS) is the signal something died,
  // so this only needs to run roughly that often.
  scheduleWithLock('*/2 * * * *', async () => {
    try {
      const stats = await recoverStuckJobs();
      if (stats.recovered + stats.requeued + stats.manualReview > 0) {
        console.log(`[scheduler] Crash recovery: ${stats.recovered} recovered, ${stats.requeued} requeued, ${stats.manualReview} sent to manual review.`);
      }
    } catch (err: any) {
      console.error('[scheduler] Crash recovery sweep failed:', err.message);
    }
  });

  // Stale agent-run recovery (issue #25): agent_runs left in status='running'
  // with no completed_at/error because the process crashed or an LLM/tool
  // call hung mid-run. Runs every 10 minutes — a coarser cadence than the
  // execution-job crash recovery above since agent runs have no lease to
  // expire, only a maximum-duration timeout (default 30 min, see
  // recoverStaleAgentRuns()).
  scheduleWithLock('*/10 * * * *', () => {
    try {
      const { markedStale } = recoverStaleAgentRuns();
      if (markedStale > 0) console.log(`[scheduler] Marked ${markedStale} stale agent run(s) as failed.`);
    } catch (err: any) {
      console.error('[scheduler] Stale agent-run recovery failed:', err.message);
    }
  });

  // Idempotency-key housekeeping — daily.
  scheduleWithLock('0 5 * * *', () => {
    try {
      const pruned = pruneExpiredIdempotencyKeys();
      if (pruned > 0) console.log(`[scheduler] Pruned ${pruned} expired idempotency key(s).`);
    } catch (err: any) {
      console.error('[scheduler] Idempotency key pruning failed:', err.message);
    }
  });

  console.log('[scheduler] All jobs scheduled. Ready.');
}

/**
 * Wake the execution worker immediately rather than waiting for the next
 * scheduled tick — called by task-queue.ts:approveTask right after it
 * enqueues a job, for low latency in the common (no-crash) case. Not
 * relied on for correctness: if this call is itself lost (e.g. the
 * process crashes right after approveTask returns), the scheduled tick
 * above picks the job up within a minute regardless. Still respects the
 * leader lock — a non-leader instance does not run jobs just because a
 * local approveTask() call happened to fire on it.
 */
export function runExecutionWorkerTickNow(): void {
  if (!tryAcquireOrRenewLeaderLock()) return;
  runExecutionWorkerTick().catch((err: Error) => {
    console.error('[scheduler] Immediate execution worker wake-up failed:', err.message);
  });
}
