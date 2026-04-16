/**
 * Workflow engine (Prompt 1).
 *
 * Executes a named multi-step pipeline. Each step runs an agent with a
 * task template plus the previous step's output as additional context.
 * Steps with `approval_gate: true` pause the run until a human approves.
 *
 * Called from /server/routes/workflows.js, signal-engine, or scheduler.
 */
import crypto from 'crypto';
import db from '../db/db.js';
import { pushDashboardEvent } from '../lib/sse-bus.js';

const STEP_LIMIT_MS = 30 * 60 * 1000; // 30 min safety ceiling

interface WorkflowStep {
  index: number;
  name: string;
  agent_id: string;
  task_template: string;
  approval_gate: boolean;
  approval_message: string;
  timeout_minutes: number;
}

interface WorkflowRow {
  id: string;
  business_id: string;
  name: string;
  steps: string;
  status: string;
  tags: string;
}

interface WorkflowRunRow {
  id: string;
  workflow_id: string;
  business_id: string;
  status: string;
  current_step: number;
  context: string;
}

interface StepRunRow {
  id: string;
  run_id: string;
  step_index: number;
  step_name: string;
  agent_id: string;
  status: string;
  output: string | null;
  approved_by: string | null;
}

// ─── Start a workflow run ────────────────────────────────────────────────────

export async function startWorkflow(workflowId: string, businessId: string, triggeredBy: string, reason: string | null = null): Promise<string> {
  const workflow = db.prepare('SELECT * FROM workflows WHERE id = ?').get(workflowId) as WorkflowRow | null;
  if (!workflow) throw new Error(`Workflow ${workflowId} not found`);
  if (workflow.status === 'archived') throw new Error(`Workflow ${workflow.name} is archived`);

  const steps: WorkflowStep[] = JSON.parse(workflow.steps || '[]');
  if (steps.length === 0) throw new Error('Workflow has no steps');

  const runId = crypto.randomUUID();
  db.prepare(`
    INSERT INTO workflow_runs
    (id, workflow_id, business_id, status, triggered_by,
     trigger_reason, current_step, steps_total, context)
    VALUES (?, ?, ?, 'running', ?, ?, 0, ?, '{}')
  `).run(runId, workflowId, businessId, triggeredBy, reason ?? null, steps.length);

  db.prepare(`
    UPDATE workflows SET run_count = run_count + 1,
      last_run_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(workflowId);

  for (const step of steps) {
    db.prepare(`
      INSERT INTO workflow_step_runs
      (id, run_id, workflow_id, business_id, step_index,
       step_name, agent_id, status, approval_required)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)
    `).run(
      crypto.randomUUID(), runId, workflowId, businessId,
      step.index, step.name, step.agent_id,
      step.approval_gate ? 1 : 0
    );
  }

  pushDashboardEvent(businessId, 'workflow_started', { runId, workflowId, name: workflow.name });

  // Fire and forget — don't block the caller
  executeNextStep(runId, businessId).catch((err: Error) => {
    console.error('[workflow] Execution error:', err);
    try {
      db.prepare("UPDATE workflow_runs SET status='failed', error=?, completed_at=CURRENT_TIMESTAMP WHERE id=?")
        .run(err.message, runId);
    } catch {}
  });

  return runId;
}

// ─── Execute next step ───────────────────────────────────────────────────────

async function executeNextStep(runId: string, businessId: string): Promise<void> {
  const run = db.prepare('SELECT * FROM workflow_runs WHERE id = ?').get(runId) as WorkflowRunRow | null;
  if (!run || run.status !== 'running') return;

  const workflow = db.prepare('SELECT * FROM workflows WHERE id = ?').get(run.workflow_id) as WorkflowRow;
  const steps: WorkflowStep[] = JSON.parse(workflow.steps);
  const currentStep = steps[run.current_step];

  if (!currentStep) {
    db.prepare("UPDATE workflow_runs SET status='complete', completed_at=CURRENT_TIMESTAMP WHERE id=?")
      .run(runId);
    pushDashboardEvent(businessId, 'workflow_complete', { runId, workflowId: workflow.id });
    await fileWorkflowToKB(runId, workflow, businessId).catch(() => {});
    return;
  }

  const stepRun = db.prepare(`
    SELECT * FROM workflow_step_runs WHERE run_id=? AND step_index=?
  `).get(runId, run.current_step) as StepRunRow;

  if (stepRun.status === 'awaiting_approval') return;

  db.prepare("UPDATE workflow_step_runs SET status='running', started_at=CURRENT_TIMESTAMP WHERE id=?")
    .run(stepRun.id);

  pushDashboardEvent(businessId, 'workflow_step_started', {
    runId, stepIndex: run.current_step, stepName: currentStep.name, agentId: currentStep.agent_id,
  });

  try {
    const context = JSON.parse(run.context || '{}');
    const previousOutput: string = context.last_step_output || '';

    const taskInput = previousOutput
      ? `${currentStep.task_template}\n\n## Previous step output\n\n${previousOutput}`
      : currentStep.task_template;

    db.prepare('UPDATE workflow_step_runs SET input=? WHERE id=?').run(taskInput, stepRun.id);

    const result = await runAgentForStep(
      currentStep.agent_id, taskInput, businessId, run.workflow_id, runId, stepRun.id
    );

    const newStatus = currentStep.approval_gate ? 'awaiting_approval' : 'complete';
    db.prepare(`
      UPDATE workflow_step_runs
      SET status=?, output=?, completed_at=CURRENT_TIMESTAMP, tasks_created=?
      WHERE id=?
    `).run(newStatus, result.output, JSON.stringify(result.taskIds || []), stepRun.id);

    const updatedContext = {
      ...context,
      last_step_output: result.output,
      [`step_${run.current_step}_output`]: result.output,
      [`step_${run.current_step}_task_ids`]: result.taskIds || [],
    };
    db.prepare('UPDATE workflow_runs SET context=? WHERE id=?').run(JSON.stringify(updatedContext), runId);

    if (currentStep.approval_gate) {
      db.prepare("UPDATE workflow_runs SET status='paused' WHERE id=?").run(runId);
      pushDashboardEvent(businessId, 'workflow_approval_needed', {
        runId, stepIndex: run.current_step, stepName: currentStep.name,
        message: currentStep.approval_message || `Review ${currentStep.name} before proceeding`,
      });
      await sendApprovalNotification(runId, currentStep, workflow).catch(() => {});
      return;
    }

    db.prepare(`
      UPDATE workflow_runs
      SET current_step = current_step + 1, steps_completed = steps_completed + 1
      WHERE id = ?
    `).run(runId);

    pushDashboardEvent(businessId, 'workflow_step_complete', {
      runId, stepIndex: run.current_step, stepName: currentStep.name,
    });

    await new Promise((r) => setTimeout(r, 500));
    await executeNextStep(runId, businessId);
  } catch (err: any) {
    db.prepare(`
      UPDATE workflow_step_runs SET status='failed', error=?, completed_at=CURRENT_TIMESTAMP
      WHERE id=?
    `).run(err.message, stepRun.id);

    db.prepare(`
      UPDATE workflow_runs SET status='failed', error=?, completed_at=CURRENT_TIMESTAMP WHERE id=?
    `).run(`Step ${run.current_step} (${currentStep.name}) failed: ${err.message}`, runId);

    pushDashboardEvent(businessId, 'workflow_failed', {
      runId, stepIndex: run.current_step, error: err.message,
    });
  }
}

// ─── Run agent for a workflow step ───────────────────────────────────────────

async function runAgentForStep(agentId: string, taskInput: string, businessId: string, workflowId: string, runId: string, stepRunId: string): Promise<{ output: string; taskIds: string[] }> {
  // Use runAgent with trigger='workflow'. It will read the workflow context
  // from the shared run record we pass via triggerId.
  const { runAgent } = await import('../agents/agent-runner.js') as unknown as { runAgent: (...args: any[]) => Promise<{ runId: string }> };

  // We need the agent's JSON output (reasoning + tasks). runAgent returns the
  // runId + tasksProposed but not the content. Simplest: call runAgent and
  // then read the agent_run record for its `reasoning` field (which holds the
  // parsed reasoning text).
  const result = await runAgent(agentId, businessId, 'workflow', stepRunId, {
    extra_user_message: taskInput,
    workflow_run_id: runId,
    workflow_id: workflowId,
  });

  const runRow = db.prepare('SELECT reasoning FROM agent_runs WHERE id=?').get(result.runId) as { reasoning: string | null } | null;
  const output = runRow?.reasoning || '(no output)';

  // Task ids created by this run — tasks with created_at within the run window
  const taskIds = (db.prepare(`
    SELECT id FROM tasks
    WHERE business_id = ? AND proposed_by = ?
      AND created_at >= (SELECT started_at FROM agent_runs WHERE id = ?)
  `).all(businessId, agentId, result.runId) as Array<{ id: string }>).map((r) => r.id);

  return { output, taskIds };
}

// ─── Approval / Rejection ───────────────────────────────────────────────────

export async function approveWorkflowStep(runId: string, stepIndex: number, approvedBy: string): Promise<void> {
  const run = db.prepare('SELECT * FROM workflow_runs WHERE id=?').get(runId) as WorkflowRunRow | null;
  if (!run) throw new Error('Run not found');

  const stepRun = db.prepare(
    'SELECT * FROM workflow_step_runs WHERE run_id=? AND step_index=?'
  ).get(runId, stepIndex) as StepRunRow | null;
  if (!stepRun || stepRun.status !== 'awaiting_approval') {
    throw new Error('Step is not awaiting approval');
  }

  db.prepare(`
    UPDATE workflow_step_runs
    SET status='complete', approved_by=?, approved_at=CURRENT_TIMESTAMP
    WHERE id=?
  `).run(approvedBy, stepRun.id);

  db.prepare(`
    UPDATE workflow_runs
    SET status='running',
        current_step = current_step + 1,
        steps_completed = steps_completed + 1
    WHERE id=?
  `).run(runId);

  pushDashboardEvent(run.business_id, 'workflow_step_approved', { runId, stepIndex });

  await executeNextStep(runId, run.business_id);
}

export async function rejectWorkflowStep(runId: string, stepIndex: number, reason: string, rejectedBy = 'human'): Promise<void> {
  const run = db.prepare('SELECT * FROM workflow_runs WHERE id=?').get(runId) as WorkflowRunRow | null;
  if (!run) throw new Error('Run not found');

  db.prepare(`
    UPDATE workflow_step_runs
    SET status='failed', rejection_reason=?, approved_by=?, completed_at=CURRENT_TIMESTAMP
    WHERE run_id=? AND step_index=?
  `).run(reason, rejectedBy, runId, stepIndex);

  db.prepare(`
    UPDATE workflow_runs
    SET status='cancelled', error=?, completed_at=CURRENT_TIMESTAMP
    WHERE id=?
  `).run(`Step ${stepIndex} rejected: ${reason}`, runId);

  pushDashboardEvent(run.business_id, 'workflow_cancelled', { runId, reason });
}

export async function cancelWorkflow(runId: string): Promise<void> {
  const run = db.prepare('SELECT * FROM workflow_runs WHERE id=?').get(runId) as WorkflowRunRow | null;
  if (!run) throw new Error('Run not found');
  db.prepare(`
    UPDATE workflow_runs SET status='cancelled', error='Cancelled by user', completed_at=CURRENT_TIMESTAMP
    WHERE id=? AND status IN ('running', 'paused')
  `).run(runId);
  pushDashboardEvent(run.business_id, 'workflow_cancelled', { runId, reason: 'cancelled' });
}

// ─── KB integration ──────────────────────────────────────────────────────────

async function fileWorkflowToKB(runId: string, workflow: WorkflowRow, businessId: string): Promise<void> {
  try {
    const { getKBForBusiness } = await import('../kb/kb-config.js') as unknown as { getKBForBusiness: (id: string) => Promise<{ engine: any } | null> };
    const result = await getKBForBusiness(businessId);
    if (!result?.engine) return;

    const steps: WorkflowStep[] = JSON.parse(workflow.steps);
    const stepRuns = db.prepare(
      'SELECT * FROM workflow_step_runs WHERE run_id=? ORDER BY step_index ASC'
    ).all(runId) as StepRunRow[];

    const today = new Date().toISOString().split('T')[0];
    const slug = `workflow-run-${runId.slice(0, 8)}-${today}`;

    const body = `# Workflow Run: ${workflow.name}

**Completed:** ${new Date().toISOString()}
**Steps:** ${steps.map((s) => s.name).join(' → ')}

${stepRuns.map((sr, i) => `## Step ${i + 1}: ${sr.step_name}

**Agent:** ${sr.agent_id}
**Status:** ${sr.status}
${sr.approved_by ? `**Approved by:** ${sr.approved_by}\n` : ''}

${(sr.output || '_(no output)_').slice(0, 4000)}
`).join('\n')}
`;

    await result.engine.writeFile(
      `decisions/${slug}.md`,
      body,
      {
        title: `Workflow: ${workflow.name}`,
        tags: ['workflow', ...JSON.parse(workflow.tags || '[]')],
        created: today, updated: today,
        written_by: 'system', review_status: 'auto_approved',
        workflow_id: workflow.id, run_id: runId,
      },
      `workflow: ${workflow.name}`
    );
  } catch (err: any) {
    console.warn('[workflow] KB file failed (non-fatal):', err.message);
  }
}

// ─── Approval notification ──────────────────────────────────────────────────

async function sendApprovalNotification(runId: string, step: WorkflowStep, workflow: WorkflowRow): Promise<void> {
  try {
    const { dispatchNotification } = await import('../notifications/dispatcher.js') as unknown as { dispatchNotification: (opts: any) => Promise<void> };
    await dispatchNotification({
      businessId: workflow.business_id,
      severity: 'info',
      title: `Workflow paused: approval needed`,
      body: `${workflow.name} — step "${step.name}" awaits review.`,
      channels: ['telegram', 'dashboard'],
      entityType: 'workflow_run',
      entityId: runId,
    });
  } catch {
    // Non-fatal — notification dispatcher may not be configured.
  }
}
