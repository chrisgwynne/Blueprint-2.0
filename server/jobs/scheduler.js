import cron from 'node-cron';
import db from '../db/db.js';
import { processTimedApproval } from '../tasks/approval.js';
import { runConductorAllBusinesses } from '../agents/conductor.js';

let schedulerStarted = false;

/**
 * Sync a single connector by loading its implementation and running fetch.
 */
async function syncConnector(connector) {
  const syncId = crypto.randomUUID();
  const syncStart = Date.now();
  try {
    db.prepare(`INSERT INTO connector_syncs (id, connector_id, status, created_at) VALUES (?, ?, 'running', CURRENT_TIMESTAMP)`).run(syncId, connector.id);
  } catch {}

  try {
    const { default: connectorImpl } = await import(`../connectors/${connector.type}/index.js`);

    let credentials = {};
    if (connector.credentials) {
      const { decrypt } = await import('../crypto.js');
      try {
        credentials = JSON.parse(decrypt(connector.credentials));
      } catch {
        credentials = {};
      }
    }

    const config = connector.config ? JSON.parse(connector.config) : {};

    // Determine what to fetch based on connector type
    // For pagespeed: fall back to business website URL if not set on connector
    let businessUrl = null;
    if (connector.type === 'pagespeed' && !config.url) {
      try {
        const biz = db.prepare('SELECT settings FROM businesses WHERE id = ?').get(connector.business_id);
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

    const dataType = config.defaultDataType || getDefaultDataType(connector.type);
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
    const { runSignalEngine } = await import('../signals/signal-engine.js');

    // Get the previous blob for comparison
    const prevMetric = db.prepare(`
      SELECT metric_data FROM metrics
      WHERE business_id = ? AND connector_id = ? AND metric_name = ?
      ORDER BY recorded_at DESC LIMIT 1 OFFSET 1
    `).get(connector.business_id, connector.id, `${connector.type}_sync`);

    let previousData = null;
    if (prevMetric?.metric_data) {
      try { previousData = JSON.parse(prevMetric.metric_data); } catch {}
    }

    // For pagespeed, pass mobile data directly to match signal rule field paths
    const signalData = (connector.type === 'pagespeed' && data.mobile) ? data.mobile : data;
    const prevSignalData = (connector.type === 'pagespeed' && previousData?.mobile) ? previousData.mobile : previousData;

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

    // BAP webhook: connector.sync.complete
    try {
      const { dispatchWebhookEvent } = await import('../bap/webhook-dispatcher.js');
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

    // Post-sync orchestration: promote pending agents, hiring analysis,
    // queue data-ready agent runs.
    try {
      const { onConnectorSyncSuccess } = await import('../connectors/post-sync.js');
      onConnectorSyncSuccess(connector.type, connector.business_id);
    } catch (err) {
      console.warn(`[scheduler] post-sync hook failed for '${connector.name}':`, err.message);
    }

    return { ok: true, newSignals };
  } catch (err) {
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
      .then(m => m.healConnectorError(err, connector.type, connector.business_id))
      .catch(healErr => console.warn('[self-heal] Connector healing failed (non-fatal):', healErr.message));

    // BAP webhook: connector.error
    try {
      const { dispatchWebhookEvent } = await import('../bap/webhook-dispatcher.js');
      dispatchWebhookEvent('connector.error', {
        connector_id: connector.id, connector_type: connector.type,
        business_id: connector.business_id, error: err.message,
      });
    } catch {}

    return { ok: false, error: err.message };
  }
}

function getDefaultDataType(connectorType) {
  const defaults = {
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

function isDue(connector, intervalMinutes) {
  if (!connector.last_sync) return true;
  const lastSync = new Date(connector.last_sync).getTime();
  const intervalMs = intervalMinutes * 60 * 1000;
  return Date.now() - lastSync >= intervalMs;
}

/**
 * Start all scheduled jobs.
 */
export function startScheduler() {
  if (schedulerStarted) {
    console.warn('[scheduler] Already started. Skipping.');
    return;
  }
  schedulerStarted = true;

  console.log('[scheduler] Starting Blueprint scheduler...');

  // Every 15 minutes: check connector polling intervals, sync due connectors
  cron.schedule('*/15 * * * *', async () => {
    console.log('[scheduler] Running connector poll check...');
    try {
      const connectors = db.prepare(`SELECT * FROM connectors WHERE status != 'disconnected'`).all();

      for (const connector of connectors) {
        // Determine the polling interval — user-configured value takes priority
        const pollingDefaults = {
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
        let configuredInterval = null;
        try {
          if (connector.config) {
            const cfg = JSON.parse(connector.config);
            if (cfg.pollingIntervalMinutes) configuredInterval = Number(cfg.pollingIntervalMinutes);
          }
        } catch {}
        const interval = configuredInterval || pollingDefaults[connector.type] || 360;

        if (isDue(connector, interval)) {
          // Fire-and-forget per connector
          syncConnector(connector).catch(err => {
            console.error(`[scheduler] Connector sync error for ${connector.name}:`, err.message);
          });
        }
      }
    } catch (err) {
      console.error('[scheduler] Connector poll check failed:', err);
    }
  });

  // Every hour: check for stale connectors
  cron.schedule('30 * * * *', async () => {
    try {
      const thresholds = { pagespeed: 48, gsc: 24, ga4: 12, shopify: 12, uptimerobot: 2 };
      const connectors = db.prepare(`
        SELECT c.id, c.type, c.status, c.last_sync, c.business_id, b.name as business_name
        FROM connectors c JOIN businesses b ON c.business_id = b.id
        WHERE c.status = 'connected' AND c.last_sync IS NOT NULL
      `).all();
      for (const c of connectors) {
        const hours = (Date.now() - new Date(c.last_sync).getTime()) / 3600000;
        const threshold = thresholds[c.type] ?? 24;
        if (hours > threshold) {
          db.prepare("UPDATE connectors SET status = 'stale' WHERE id = ? AND status = 'connected'").run(c.id);
          // Only create signal if none already open for this connector
          const exists = db.prepare("SELECT id FROM signals WHERE connector_id = ? AND rule_id = 'connector_stale' AND status = 'open'").get(c.id);
          if (!exists) {
            const { generateId: gid } = await import('../db/db.js');
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
    } catch (err) {
      console.error('[scheduler] Stale connector check failed:', err.message);
    }
  });

  // Every hour at :05: run conductor for all businesses.
  // Offset by 5 minutes so it doesn't overlap with the daily full sync at 06:00,
  // and connector poll syncs that fire on the :00 boundary have a chance to complete.
  cron.schedule('5 * * * *', async () => {
    console.log('[scheduler] Running hourly conductor pass...');
    try {
      await runConductorAllBusinesses();
    } catch (err) {
      console.error('[scheduler] Conductor run failed:', err);
    }
  });

  // Every day at 06:00: full connector sync for all active connectors.
  // After all syncs complete, run a conductor pass so any signals created by
  // fresh data are acted on immediately rather than waiting until 07:05.
  cron.schedule('0 6 * * *', async () => {
    console.log('[scheduler] Running daily full connector sync...');
    try {
      const connectors = db.prepare(`SELECT * FROM connectors`).all();
      for (const connector of connectors) {
        await syncConnector(connector).catch(err => {
          console.error(`[scheduler] Daily sync error for ${connector.name}:`, err.message);
        });
      }
      console.log('[scheduler] Daily sync complete. Running post-sync conductor pass...');
      await runConductorAllBusinesses();
    } catch (err) {
      console.error('[scheduler] Daily sync failed:', err);
    }
  });

  // Every 5 minutes: process timed approvals
  cron.schedule('*/5 * * * *', async () => {
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
  cron.schedule('0 9 * * 1', async () => {
    try {
      const { runOutcomeChecks } = await import('../tasks/outcomes.js');
      const checked = runOutcomeChecks();
      if (checked > 0) console.log(`[scheduler] Outcome checks: ${checked} tasks evaluated.`);
    } catch (err) {
      console.error('[scheduler] Outcome checks failed:', err.message);
    }
  });

  // Weekly goal progress check — Monday 8am (Prompt 2)
  cron.schedule('0 8 * * 1', async () => {
    try {
      const { checkAllGoals } = await import('../goals/goal-engine.js');
      const businesses = db.prepare('SELECT id FROM businesses').all();
      let total = 0;
      for (const b of businesses) {
        total += await checkAllGoals(b.id);
      }
      if (total > 0) console.log(`[scheduler] Goal checks: ${total} goals evaluated.`);
    } catch (err) {
      console.error('[scheduler] Goal checks failed:', err.message);
    }
  });

  // Weekly goal suggestions scan — Wednesday 9am.
  cron.schedule('0 9 * * 3', async () => {
    try {
      const { scanForGoalSuggestions } = await import('../brain/goal-suggester.js');
      const businesses = db.prepare('SELECT id FROM businesses').all();
      let total = 0;
      for (const b of businesses) {
        try {
          const s = await scanForGoalSuggestions(b.id);
          total += s.length;
        } catch (err) {
          console.warn(`[scheduler] Goal suggestions failed for ${b.id}:`, err.message);
        }
      }
      if (total > 0) console.log(`[scheduler] Goal suggestions: ${total} new.`);
    } catch (err) {
      console.error('[scheduler] Goal suggestions scan failed:', err.message);
    }
  });

  // Monthly retrospective — 1st of every month at 06:00.
  cron.schedule('0 6 1 * *', async () => {
    try {
      const { runRetrospective } = await import('../brain/retrospective-engine.js');
      const businesses = db.prepare('SELECT id FROM businesses').all();
      for (const b of businesses) {
        try {
          const r = await runRetrospective(b.id, { triggered_by: 'scheduler' });
          if (r) console.log(`[scheduler] Retrospective filed for ${b.id.slice(0, 8)}.`);
        } catch (err) {
          console.warn(`[scheduler] Retrospective failed for ${b.id}:`, err.message);
        }
      }
    } catch (err) {
      console.error('[scheduler] Retrospective run failed:', err.message);
    }
  });

  // Weekly goal conflict audit — Monday 7am.
  cron.schedule('0 7 * * 1', async () => {
    try {
      const { auditAllGoalConflicts, autoResolveStale } = await import('../brain/conflict-engine.js');
      autoResolveStale();
      const businesses = db.prepare('SELECT id FROM businesses').all();
      let total = 0;
      for (const b of businesses) {
        total += await auditAllGoalConflicts(b.id).catch(() => 0);
      }
      if (total > 0) console.log(`[scheduler] Conflict audit: ${total} conflicts identified.`);
    } catch (err) {
      console.error('[scheduler] Conflict audit failed:', err.message);
    }
  });

  // Weekly strategic goal-reasoning refresh — Monday 6am.
  // Re-runs the LLM reasoning pass on every active goal so feasibility,
  // strategy, and agent briefings stay in sync with the latest metrics.
  cron.schedule('0 6 * * 1', async () => {
    try {
      const { runGoalReasoning } = await import('../brain/goal-reasoner.js');
      const goals = db.prepare(
        "SELECT id, business_id FROM goals WHERE status = 'active'"
      ).all();
      let refreshed = 0;
      for (const g of goals) {
        try {
          const r = await runGoalReasoning(g.id, g.business_id);
          if (r?.reasoning) refreshed++;
        } catch (err) {
          console.warn(`[scheduler] goal reasoning failed for ${g.id}:`, err.message);
        }
      }
      if (refreshed > 0) console.log(`[scheduler] Goal reasoning: refreshed ${refreshed} goals.`);
    } catch (err) {
      console.error('[scheduler] Goal reasoning refresh failed:', err.message);
    }
  });

  // Brain — every morning at 07:00, resurface deferred tasks whose window
  // has closed and mark measurement-ready actions.
  cron.schedule('0 7 * * *', async () => {
    try {
      const { processDeferredTasks } = await import('../brain/restraint.js');
      const { markMeasurementReady } = await import('../brain/action-windows.js');
      await processDeferredTasks();
      const ready = markMeasurementReady();
      if (ready > 0) console.log(`[brain] ${ready} action(s) are now ready to measure.`);
    } catch (err) {
      console.error('[scheduler] brain daily pass failed:', err.message);
    }
  });

  // Brain — weekly seasonal pattern detection (Sunday 04:00)
  cron.schedule('0 4 * * 0', async () => {
    try {
      const { detectSeasonalPatterns } = await import('../brain/seasonality.js');
      const businesses = db.prepare('SELECT id FROM businesses').all();
      for (const b of businesses) {
        await detectSeasonalPatterns(b.id);
      }
    } catch (err) {
      console.error('[scheduler] seasonal detection failed:', err.message);
    }
  });

  // Nightly KB lint + auto-fix — runs at 2am every night.
  // Fixes what it can automatically (dead links, missing frontmatter, orphans),
  // escalates what it can't (stale pages, contradictions) as tasks.
  cron.schedule('0 2 * * *', async () => {
    console.log('[scheduler] Running nightly KB lint + auto-fix...');
    try {
      const { getKBForBusiness } = await import('../kb/kb-config.js');
      const { KBAgent } = await import('../kb/kb-agent.js');
      const { createTask } = await import('../tasks/task-queue.js');

      const businesses = db.prepare('SELECT id, slug FROM businesses').all();
      for (const business of businesses) {
        try {
          const result = await getKBForBusiness(business.id);
          if (!result) continue;

          const agent = new KBAgent(result.engine);

          // 1. Lint — get current issues
          const lintResult = await agent.runLint();

          // 2. Auto-fix — apply all safe mechanical fixes, escalate the rest
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
        } catch (bizErr) {
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
  cron.schedule('*/5 * * * *', async () => {
    try {
      const { retryPendingDeliveries } = await import('../bap/webhook-dispatcher.js');
      const retried = await retryPendingDeliveries();
      if (retried > 0) {
        console.log(`[scheduler] Retried ${retried} BAP webhook deliveries.`);
      }
    } catch (err) {
      console.error('[scheduler] BAP webhook retry failed:', err.message);
    }
  });

  // Weekly full-KB analysis — Sunday at 4am.
  // The debounced per-write trigger in KBEngine covers the "recent activity"
  // case. This weekly pass looks at the same window (168h = 7d) so that KBs
  // with steady but never-bursty updates still get analysed at least once
  // a week, and so contradictions between older + newer entries get noticed.
  cron.schedule('0 4 * * 0', async () => {
    console.log('[scheduler] Running weekly KB analysis pass...');
    try {
      const { analyseKBForSignals } = await import('../kb/kb-analyser.js');
      const businesses = db.prepare('SELECT id, slug FROM businesses').all();
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
        } catch (bizErr) {
          console.warn(`[scheduler] KB analysis failed for ${business.slug}:`, bizErr.message);
        }
      }
    } catch (err) {
      console.error('[scheduler] Weekly KB analysis failed:', err);
    }
  });

  // Weekly git maintenance — Sunday 3am
  cron.schedule('0 3 * * 0', async () => {
    try {
      const { existsSync, statSync } = await import('fs');
      const { resolve, join } = await import('path');
      const { exec } = await import('child_process');
      const { promisify } = await import('util');
      const execAsync = promisify(exec);

      const KB_ROOT = process.env.KB_PATH || resolve(process.cwd(), '../kb');
      const businesses = db.prepare('SELECT slug FROM businesses').all();
      for (const biz of businesses) {
        const kbPath = join(KB_ROOT, biz.slug);
        if (!existsSync(join(kbPath, '.git'))) continue;
        try {
          await execAsync('git gc --auto --quiet', { cwd: kbPath, timeout: 30_000 });
          const size = statSync(join(kbPath, '.git')).size / 1048576;
          console.log(`[scheduler] KB git gc: ${biz.slug} (.git = ${size.toFixed(1)}MB)`);
        } catch {}
      }
    } catch (err) {
      console.error('[scheduler] Git maintenance failed:', err.message);
    }
  });

  console.log('[scheduler] All jobs scheduled. Ready.');
}

import crypto from 'crypto';
