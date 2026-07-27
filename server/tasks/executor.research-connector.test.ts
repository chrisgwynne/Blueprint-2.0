/**
 * Regression coverage for issue #29: research_connector tasks failed at
 * execution — a missing action_payload.description, or an LLM response
 * that couldn't be parsed as JSON — instead of being caught earlier
 * (validation) or handled more gracefully (JSON repair). Two independent
 * fixes are covered:
 *   1. action_registry now has a real payload_schema for research_connector
 *      (server/db/db.ts), so a missing description is rejected at approval
 *      time via validateAction(), not left to fail inside the executor.
 *   2. executeResearchConnector() now reuses extractInvestigationJSON()'s
 *      truncation-repair logic instead of a bare JSON.parse with no
 *      fallback, so a response cut short by a token limit still parses.
 *
 * Deliberately does NOT mock ../lib/llm-providers.js: mock.module() replaces
 * a module process-wide, and that module is imported for its real behaviour
 * by llm-providers.stale-model.test.ts (issue #26's fix) elsewhere in the
 * same bun test run. Instead, the 'custom' (generic OpenAI-compatible) LLM
 * provider is pointed at a real local HTTP server this file starts, so the
 * actual resolveProfileLLM()/runLLM() code path runs unmocked.
 */
import { describe, test, expect, beforeAll, afterAll, afterEach, mock } from 'bun:test';
import nodeCrypto from 'crypto';

process.env.ENCRYPTION_KEY ||= nodeCrypto.randomBytes(32).toString('hex');

const agentSearch = mock(async (..._args: unknown[]) => ({ available: false, results: [] as unknown[] }));
mock.module('../agents/tools/search.js', () => ({ agentSearch }));

const getKBForBusiness = mock(async (..._args: unknown[]) => null as { engine: unknown } | null);
mock.module('../kb/kb-config.js', () => ({ getKBForBusiness }));

const createBlueprintIssue = mock(async (..._args: unknown[]) => null as { number: number; url: string } | null);
mock.module('../lib/blueprint-github.js', () => ({ createBlueprintIssue }));

const { default: db, generateId } = await import('../db/db.js');
const { executeTask } = await import('./executor.js');
const { createTask, approveTask } = await import('./task-queue.js');
const { enqueueExecutionJob, getExecutionJob } = await import('./execution-jobs.js');
const { getActionRegistryEntry } = await import('./action-registry.js');
const { saveProviderCredentials } = await import('../lib/llm-providers.js');

const BIZ = 'biz_research_connector_test';

let llmContent = '';
let server: ReturnType<typeof Bun.serve>;

beforeAll(() => {
  db.prepare(`INSERT INTO businesses (id, name, slug) VALUES (?, 'Research Connector Test', 'research-connector-test') ON CONFLICT(id) DO NOTHING`).run(BIZ);

  // A minimal OpenAI-compatible /chat/completions stand-in — server/lib/providers/custom.ts's
  // real complete() posts here exactly as it would to any self-hosted/BYO endpoint.
  server = Bun.serve({
    port: 0,
    fetch(req) {
      if (new URL(req.url).pathname === '/chat/completions') {
        return Response.json({ choices: [{ message: { content: llmContent } }], usage: { prompt_tokens: 10, completion_tokens: 10 } });
      }
      return new Response('not found', { status: 404 });
    },
  });

  saveProviderCredentials('custom', { baseUrl: `http://127.0.0.1:${server.port}`, apiKey: 'test' });
  db.prepare(`INSERT INTO settings (key, value) VALUES ('llm_default_provider', '"custom"') ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run();
  db.prepare(`INSERT INTO settings (key, value) VALUES ('llm_default_model', '"test-model"') ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run();
});

afterAll(() => {
  server.stop();
  db.prepare(`DELETE FROM settings WHERE key IN ('llm_default_provider', 'llm_default_model', 'provider_credentials_custom')`).run();
});

afterEach(() => {
  agentSearch.mockClear();
  getKBForBusiness.mockClear();
  createBlueprintIssue.mockClear();
  db.prepare(`DELETE FROM execution_jobs WHERE business_id = ?`).run(BIZ);
  db.prepare(`DELETE FROM system_issues WHERE business_id = ?`).run(BIZ);
  db.prepare(`DELETE FROM task_events WHERE task_id IN (SELECT id FROM tasks WHERE business_id = ?)`).run(BIZ);
  db.prepare(`DELETE FROM outcome_measurement_runs WHERE business_id = ?`).run(BIZ);
  db.prepare(`DELETE FROM tasks WHERE business_id = ?`).run(BIZ);
});

describe('research_connector — payload_schema enforcement (issue #29)', () => {
  test('action_registry requires action_payload.description, not just an executor-time check', () => {
    const entry = getActionRegistryEntry('research_connector');
    expect(entry).not.toBeNull();
    expect(entry!.payload_schema).toEqual({
      type: 'object',
      required: ['description'],
      properties: { description: { type: 'string', minLength: 3 } },
    });
  });

  test('a task with no description is blocked at approval, before it ever reaches the executor', () => {
    const task = createTask({
      business_id: BIZ, title: 'Research a connector', proposed_by: 'test',
      action_type: 'research_connector', action_payload: {},
      approval_mode: 'requires_approval',
    })!;
    expect(() => approveTask(task.id, 'dashboard:test')).toThrow(/payload_schema_mismatch|description/i);
    const reloaded = db.prepare('SELECT status FROM tasks WHERE id = ?').get(task.id) as any;
    expect(reloaded.status).toBe('proposed'); // never advanced to approved
  });

  test('a task with a valid description passes payload validation and approves', () => {
    const task = createTask({
      business_id: BIZ, title: 'Research a connector', proposed_by: 'test',
      action_type: 'research_connector', action_payload: { description: 'Etsy order data' },
      approval_mode: 'requires_approval',
    })!;
    expect(() => approveTask(task.id, 'dashboard:test')).not.toThrow();
    const reloaded = db.prepare('SELECT status FROM tasks WHERE id = ?').get(task.id) as any;
    expect(reloaded.status).toBe('approved');
  });
});

function approvedResearchTask(payload: Record<string, unknown>): { taskId: string; jobId: string } {
  const task = createTask({
    business_id: BIZ, title: 'Research a connector', proposed_by: 'test',
    action_type: 'research_connector', action_payload: payload,
    approval_mode: 'requires_approval',
  })!;
  const version = (task.version ?? 1) + 1;
  db.prepare(`UPDATE tasks SET status = 'approved', version = ? WHERE id = ?`).run(version, task.id);
  const job = enqueueExecutionJob({ ...task, status: 'approved', version } as any);
  return { taskId: task.id, jobId: job.id };
}

describe('executeResearchConnector — LLM JSON repair (issue #29)', () => {
  test('a well-formed JSON response executes successfully', async () => {
    llmContent = JSON.stringify({
      connector_name: 'Etsy API', connector_id: 'etsy', recommendation: 'build_later',
      build_complexity: 'medium',
    });
    const { taskId, jobId } = approvedResearchTask({ description: 'Etsy order data' });
    const result = await executeTask(taskId, getExecutionJob(jobId));

    expect(result.ok).toBe(true);
    expect(result.outcome_data?.connector_name).toBe('Etsy API');
  });

  test('a response truncated mid-value (a max_tokens cutoff) is repaired into valid JSON instead of a dead-lettered failure', async () => {
    // No closing quote/brace at all — the exact shape extractInvestigationJSON()'s
    // repair logic exists for (see its own "Truncation repair" comment).
    // The repair strips the incomplete trailing field rather than guessing
    // its value, so this proves the task still completes rather than
    // failing outright — not that every field survives truncation intact.
    llmContent = '{"connector_name": "Etsy';
    const { taskId, jobId } = approvedResearchTask({ description: 'Etsy order data' });
    const result = await executeTask(taskId, getExecutionJob(jobId));

    expect(result.ok).toBe(true);
  });

  test('genuinely unparseable LLM output still fails clearly (repair is best-effort, not a guarantee)', async () => {
    llmContent = 'I cannot help with that request.';
    const { taskId, jobId } = approvedResearchTask({ description: 'Etsy order data' });
    const result = await executeTask(taskId, getExecutionJob(jobId));

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/valid connector spec JSON/i);
  });
});
