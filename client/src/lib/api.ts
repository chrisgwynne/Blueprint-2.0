const BASE = '/api'

// ============================================
// Core fetch helpers
// ============================================

type Params = Record<string, string | number | boolean | null | undefined>

async function request(method: string, path: string, body?: unknown, params?: Params): Promise<any> {
  let url = BASE + path

  if (params && Object.keys(params).length > 0) {
    const qs = new URLSearchParams(
      Object.entries(params)
        .filter(([, v]) => v !== undefined && v !== null && v !== '')
        .map(([k, v]) => [k, String(v)])
    ).toString()
    if (qs) url += '?' + qs
  }

  const options: RequestInit & { headers: Record<string, string> } = {
    method,
    credentials: 'include',
    headers: {},
  }

  if (body !== undefined) {
    options.headers['Content-Type'] = 'application/json'
    options.body = JSON.stringify(body)
  }

  const res = await fetch(url, options)

  if (res.status === 401) {
    // Redirect to login unless already there
    if (!window.location.pathname.startsWith('/login')) {
      window.location.href = '/login'
    }
    throw new Error('Unauthorized')
  }

  if (!res.ok) {
    let errMsg = `HTTP ${res.status}`
    try {
      const err = await res.json()
      errMsg = err.error || err.message || errMsg
    } catch {
      // ignore parse error
    }
    throw new Error(errMsg)
  }

  // Handle empty responses
  const text = await res.text()
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

const get = (path: string, params?: Params): Promise<any> => request('GET', path, undefined, params)
const post = (path: string, body?: unknown): Promise<any> => request('POST', path, body)
const patch = (path: string, body?: unknown): Promise<any> => request('PATCH', path, body)
const put = (path: string, body?: unknown): Promise<any> => request('PUT', path, body)
const del = (path: string, params?: Params): Promise<any> => request('DELETE', path, undefined, params)

// ============================================
// Auth
// ============================================

export const login = (username: string, password: string) => post('/auth/login', { username, password })
export const logout = () => post('/auth/logout')
export const getMe = () => get('/auth/me')

// ============================================
// Businesses
// ============================================

export const getBusinesses = () => get('/businesses')
export const createBusiness = (data: unknown) => post('/businesses', data)
export const updateBusiness = (id: string, data: unknown) => patch(`/businesses/${id}`, data)
export const deleteBusiness = (id: string) => del(`/businesses/${id}`)

// ============================================
// Dashboard
// ============================================

export const getDashboard = (businessId: string) => get(`/dashboard/${businessId}`)

// ============================================
// Signals
// ============================================

export const getSignals = (businessId: string, params?: Params) => get(`/signals/${businessId}`, params)
export const updateSignal = (id: string, data: unknown) => patch(`/signals/${id}`, data)

// ============================================
// Tasks
// ============================================

export const getTasks = (businessId: string, params?: Params) => get(`/tasks/${businessId}`, params)
export const createTask = (data: unknown) => post('/tasks', data)
export const approveTask = (id: string, data: unknown) => patch(`/tasks/${id}/approve`, data)
export const rejectTask = (id: string, data: unknown) => patch(`/tasks/${id}/reject`, data)
export const updateTask = (id: string, data: unknown) => patch(`/tasks/${id}`, data)
export const getApprovalPolicies = () => get('/tasks/approval-policies')
export const saveApprovalPolicies = (policies: unknown) => request('PUT', '/tasks/approval-policies', { policies })

// ============================================
// Agents
// ============================================

export const getAgents = () => get('/agents')
export const runAgent = (id: string, body: unknown = {}) => post(`/agents/${id}/run`, body)
export const getAgentRuns = (id: string, params?: Params) => get(`/agents/${id}/runs`, params)
export const getAgentRun = (id: string, runId: string) => get(`/agents/${id}/runs/${runId}`)
export const updateAgent = (id: string, data: unknown) => patch(`/agents/${id}`, data)
export const retireAgent = (id: string, body: { business_id?: string; reason?: string } = {}) => post(`/agents/${id}/retire`, body)
export const getAgentProfile = (id: string) => get(`/agents/${id}/profile`)
export const updateAgentFile = (id: string, filename: string, content: string) => request('PUT', `/agents/${id}/files/${encodeURIComponent(filename)}`, { content })
export const patchAgentProfile = (id: string, data: unknown) => patch(`/agents/${id}/profile`, data)
export const getAgentMemory = (id: string) => get(`/agents/${id}/memory`)
export const clearAgentMemory = (id: string) => del(`/agents/${id}/memory`)
export const getAgentTemplates = () => get('/agents/templates')
export const installAgent = (agentId: string) => post('/agents/install', { agent_id: agentId })
export const hireAgent = (templateId: string, businessId: string) =>
  post('/agents/hire', { template_id: templateId, business_id: businessId })
export const getHireRecommendations = (businessId: string) =>
  post('/agents/hire-recommendations', { business_id: businessId })

// ============================================
// LLM Providers
// ============================================

export const getLLMProviders = () => get('/llm/providers')
export const getLLMModels = (providerId: string) => get(`/llm/providers/${providerId}/models`)
export const saveLLMCredentials = (providerId: string, creds: unknown) => request('PUT', `/llm/providers/${providerId}/credentials`, creds)
export const testLLMCredentials = (providerId: string, creds: unknown) => post(`/llm/providers/${providerId}/test`, creds)
export const getLLMDefault = () => get('/llm/default')
export const setLLMDefault = (provider: unknown) => request('PUT', '/llm/default', { provider })

// ============================================
// Connectors
// ============================================

export const getConnectors = (businessId: string) => get(`/connectors/${businessId}`)
export const addConnector = (data: unknown) => post('/connectors', data)
export const syncConnector = (id: string) => post(`/connectors/${id}/sync`)
export const healthCheckConnector = (id: string) => get(`/connectors/${id}/health`)
export const updateConnector = (id: string, data: unknown) => patch(`/connectors/${id}`, data)
export const deleteConnector = (id: string) => del(`/connectors/${id}`)
export const testPageSpeed = (url: string, apiKey?: string) => post('/connectors/pagespeed/test', { url, apiKey: apiKey || undefined })

// Google OAuth — full-page redirect (not a fetch). Returns the URL to redirect to.
export function getGoogleAuthUrl(businessId: string, types = 'gsc,ga4'): string {
  return `/api/oauth/google?businessId=${encodeURIComponent(businessId)}&types=${encodeURIComponent(types)}`
}
export const revokeGoogleAuth = (businessId: string, type = 'google') => del(`/oauth/google/${businessId}?type=${encodeURIComponent(type)}`)

// ============================================
// Knowledge Base (business-scoped, Karpathy wiki pattern)
// ============================================

// Settings + init
export const getKbSettings = (businessId: string) => get(`/kb/${businessId}/settings`)
export const saveKbSettings = (businessId: string, data: unknown) => post(`/kb/${businessId}/settings`, data)
export const initKb = (businessId: string) => post(`/kb/${businessId}/init`)

// Read
export const getKbTree = (businessId: string) => get(`/kb/${businessId}/tree`)
export const getKbLog = (businessId: string, params?: Params) => get(`/kb/${businessId}/log`, params)
export const searchKb = (businessId: string, q: string) => get(`/kb/${businessId}/search`, { q })
export const getKbFile = (businessId: string, path: string) => get(`/kb/${businessId}/file/${path}`)
export const getKbBacklinks = (businessId: string, path: string) => get(`/kb/${businessId}/backlinks/${path}`)
export const getKbHistory = (businessId: string, path: string) => get(`/kb/${businessId}/history/${path}`)
export const getKbDiff = (businessId: string, hash: string, path: string) => get(`/kb/${businessId}/diff/${hash}/${path}`)

// Write
export const saveKbFile = (businessId: string, path: string, data: unknown) => post(`/kb/${businessId}/file/${path}`, data)
export const archiveKbFile = (businessId: string, path: string) => del(`/kb/${businessId}/file/${path}`)
export const restoreKbVersion = (businessId: string, data: unknown) => post(`/kb/${businessId}/restore`, data)
export const uploadKbRaw = (businessId: string, data: unknown) => post(`/kb/${businessId}/upload-raw`, data)

// Agent operations
export const ingestKb = (businessId: string, data: unknown) => post(`/kb/${businessId}/ingest`, data)
export const queryKb = (businessId: string, data: unknown) => post(`/kb/${businessId}/query`, data)
export const lintKb = (businessId: string) => post(`/kb/${businessId}/lint`)

// ============================================
// BAP — External Agents management (admin UI)
// ============================================

export const getBapAgents = () => get('/bap/v1/agents-admin')   // custom admin route (below)
export const revokeBapAgent = (agentId: string) => post(`/bap/v1/agents-admin/${agentId}/revoke`)
export const registerBapAgent = (body: { name: string; description?: string; owner?: string; requested_permissions?: string[]; business_access?: string[]; webhook_url?: string }) => post('/bap/v1/register', body)
export const updateBapAgent = (agentId: string, body: { business_access?: string[]; permissions?: string[]; webhook_url?: string; webhook_events?: string[]; name?: string; description?: string }) => patch(`/bap/v1/agents-admin/${agentId}`, body)
export const getBapAudit = (agentId: string, params?: Params) => get(`/bap/v1/agents-admin/${agentId}/audit`, params)
export const getBapDeliveries = (agentId: string, params?: Params) => get(`/bap/v1/agents-admin/${agentId}/deliveries`, params)

// LEGACY (kept for backwards-compat with anything still importing these — will be removed)
export const getKbDocs = (params?: Params) => get('/kb', params)
export const getKbDoc = (path: string) => get(`/kb/${path}`)
export const saveKbDoc = (path: string, data: unknown) => post(`/kb/${path}`, data)

// ============================================
// Audit
// ============================================

export const getAuditLog = (businessId: string, params?: Params) => get(`/audit/${businessId}`, params)

// ============================================
// Connector Data Pages
// ============================================

export const getConnectorData = (connectorId: string, params?: Params) => get(`/connector-data/${connectorId}`, params)

// ============================================
// Signals — AI Analysis
// ============================================

export const triggerAnalysis = (businessId: string) => post(`/signals/analyse/${businessId}`)
export const getAnalysisStatus = (businessId: string, runId: string) => get(`/signals/analyse/${businessId}/status/${runId}`)
export const getAIInsights = (businessId: string) => get(`/signals/insights/${businessId}`)
export const getSignalSummary = (businessId: string) => get(`/signals/${businessId}/summary`)
export const createTaskFromSignal = (signalId: string, data: unknown) => post(`/signals/${signalId}/create-task`, data)

// ============================================
// Tasks — Detail & History
// ============================================

export const getTaskDetail = (taskId: string) => get(`/tasks/${taskId}/detail`)
export const getTaskHistory = (taskId: string) => get(`/tasks/${taskId}/history`)
export const addTaskComment = (taskId: string, content: string) => post(`/tasks/${taskId}/comment`, { content })

// ============================================
// Metrics
// ============================================

export const getMetrics = (businessId: string, params?: Params) => get(`/metrics/${businessId}`, params)

// ============================================
// System Health (Feature 1)
// ============================================

export const getSystemHealth = () => get('/system/health/full')

// ============================================
// Signal Clusters (Feature 2)
// ============================================

export const getSignalClusters = (businessId: string, params?: Params) => get(`/signals/${businessId}/clusters`, params)
export const updateSignalCluster = (id: string, data: unknown) => patch(`/signals/clusters/${id}`, data)
export const runClusteringNow = (businessId: string) => post(`/signals/${businessId}/cluster`)

// ============================================
// Chat (Feature 3)
// ============================================

export const getConversations = (businessId: string) => get(`/chat/${businessId}/conversations`)
export const getConversation = (businessId: string, id: string) => get(`/chat/${businessId}/conversations/${id}`)
export const createConversation = (businessId: string, data: unknown) => post(`/chat/${businessId}/conversations`, data)
export const archiveConversation = (businessId: string, id: string) => del(`/chat/${businessId}/conversations/${id}`)
export const sendChatMessage = (businessId: string, conversationId: string, content: string) =>
  post(`/chat/${businessId}/conversations/${conversationId}/messages`, { content })
export const getChatMessages = (businessId: string, conversationId: string) =>
  get(`/chat/${businessId}/conversations/${conversationId}/messages`)

// ============================================
// Outcomes (Feature 4)
// ============================================

export const getOutcomes = (businessId: string, params?: Params) => get(`/outcomes/${businessId}`, params)
export const getAgentOutcomePerformance = (businessId: string) => get(`/outcomes/${businessId}/agents`)
export const getOutcomeTimeline = (businessId: string, params?: Params) => get(`/outcomes/${businessId}/timeline`, params)

// ============================================
// Verified action receipts (issue #70)
// ============================================

export const getActionReceipts = (businessId: string, params?: Params) => get(`/receipts/${businessId}`, params)
export const getActionReceipt = (businessId: string, receiptId: string) => get(`/receipts/${businessId}/${receiptId}`)
export const getTaskActionReceipts = (businessId: string, taskId: string) => get(`/receipts/${businessId}/task/${taskId}`)

// ============================================
// "Why did Blueprint do this?" explanations (issue #60)
// ============================================

/** Subjects the explanation panel can render. Mirrors the server's registry. */
export type ExplanationKind = 'task' | 'decision' | 'hiring_analysis' | 'hiring_candidate'

/**
 * One explanation for one decision. Read-only: everything in the payload is
 * a rendering of records other modules authored, already redacted server-side.
 */
export const getExplanation = (businessId: string, kind: ExplanationKind, id: string) =>
  get(`/explanations/${businessId}/${encodeURIComponent(kind)}/${encodeURIComponent(id)}`)

/** The vocabulary (quality/causal-claim/disposition meanings) the panel renders. */
export const getExplanationVocabulary = () => get('/explanations/kinds')

// ============================================
// "What happened while I was away?" digest (issue #62)
// ============================================

/**
 * Omit `since` for the default catch-up (since your last acknowledgement).
 * Passing `since` is the explicit override: it ignores the watermark so a
 * period can be deliberately re-read, and leaves the watermark intact.
 */
export const getAwayDigest = (businessId: string | null, params?: Params) =>
  get(businessId ? `/digest/${businessId}` : '/digest', params)

export const getDigestWatermark = (businessId: string) => get(`/digest/${businessId}/watermark`)

export const acknowledgeDigest = (body: {
  business_id?: string | null
  acknowledged_through?: string | null
  digest_id?: string | null
  items?: Record<string, string>
}) => post('/digest/acknowledge', body)

export const resetDigestWatermark = (businessId: string | null) =>
  post('/digest/reset', { business_id: businessId })

// ============================================
// Email (Feature 5)
// ============================================

export const getEmailSettings = () => get('/notifications/email/settings')
export const saveEmailSettings = (data: unknown) => post('/notifications/email/settings', data)
export const sendTestEmail = (data: unknown) => post('/notifications/email/test', data)

// ============================================
// Workflows (Prompt 1)
// ============================================
export const getWorkflows = (businessId: string) => get(`/workflows/${businessId}`)
export const getWorkflow = (businessId: string, id: string) => get(`/workflows/${businessId}/${id}`)
export const createWorkflow = (businessId: string, data: unknown) => post(`/workflows/${businessId}`, data)
export const updateWorkflow = (businessId: string, id: string, data: unknown) => request('PUT', `/workflows/${businessId}/${id}`, data)
export const deleteWorkflow = (businessId: string, id: string) => del(`/workflows/${businessId}/${id}`)
export const runWorkflow = (businessId: string, id: string, data: unknown = {}) => post(`/workflows/${businessId}/${id}/run`, data)
export const getWorkflowRuns = (businessId: string) => get(`/workflows/${businessId}/runs/all`)
export const getWorkflowRun = (businessId: string, runId: string) => get(`/workflows/${businessId}/runs/${runId}`)
export const approveWorkflowStep = (businessId: string, runId: string, stepIndex: number, data: unknown = {}) =>
  post(`/workflows/${businessId}/runs/${runId}/steps/${stepIndex}/approve`, data)
export const rejectWorkflowStep = (businessId: string, runId: string, stepIndex: number, data: unknown) =>
  post(`/workflows/${businessId}/runs/${runId}/steps/${stepIndex}/reject`, data)
export const cancelWorkflowRun = (businessId: string, runId: string) =>
  post(`/workflows/${businessId}/runs/${runId}/cancel`)
export const proposeWorkflow = (businessId: string, trigger: unknown) =>
  post(`/workflows/${businessId}/propose`, { trigger })

// ============================================
// Playbooks — versioned, bounded workflows (#74)
// ============================================
export const getPlaybookVersions = (businessId: string, workflowId: string) =>
  get(`/workflows/${businessId}/${workflowId}/playbook/versions`)
export const getPlaybookEvents = (businessId: string, workflowId: string) =>
  get(`/workflows/${businessId}/${workflowId}/playbook/events`)
export const createPlaybookDraft = (businessId: string, workflowId: string, data: unknown) =>
  post(`/workflows/${businessId}/${workflowId}/playbook/versions`, data)
export const validatePlaybookVersion = (businessId: string, workflowId: string, version: number) =>
  post(`/workflows/${businessId}/${workflowId}/playbook/versions/${version}/validate`, {})
export const activatePlaybookVersion = (businessId: string, workflowId: string, version: number, data: unknown = {}) =>
  post(`/workflows/${businessId}/${workflowId}/playbook/versions/${version}/activate`, data)
export const rollbackPlaybookVersion = (businessId: string, workflowId: string, data: unknown) =>
  post(`/workflows/${businessId}/${workflowId}/playbook/rollback`, data)
/** Preview only — the server performs no action, creates no task and writes no receipt. */
export const simulatePlaybook = (businessId: string, workflowId: string, data: unknown) =>
  post(`/workflows/${businessId}/${workflowId}/playbook/simulate`, data)
export const startPlaybookRun = (businessId: string, workflowId: string, data: unknown) =>
  post(`/workflows/${businessId}/${workflowId}/playbook/runs`, data)
export const getPlaybookRun = (businessId: string, runId: string) =>
  get(`/workflows/${businessId}/playbook-runs/${runId}`)
export const advancePlaybookRun = (businessId: string, runId: string) =>
  post(`/workflows/${businessId}/playbook-runs/${runId}/advance`, {})
export const approvePlaybookStep = (businessId: string, runId: string, stepIndex: number) =>
  post(`/workflows/${businessId}/playbook-runs/${runId}/steps/${stepIndex}/approve`, {})
export const rejectPlaybookStep = (businessId: string, runId: string, stepIndex: number, data: unknown) =>
  post(`/workflows/${businessId}/playbook-runs/${runId}/steps/${stepIndex}/reject`, data)
export const retryPlaybookStep = (businessId: string, runId: string, stepIndex: number) =>
  post(`/workflows/${businessId}/playbook-runs/${runId}/steps/${stepIndex}/retry`, {})
export const rollbackPlaybookRun = (businessId: string, runId: string, data: unknown = {}) =>
  post(`/workflows/${businessId}/playbook-runs/${runId}/rollback`, data)
export const cancelPlaybookRun = (businessId: string, runId: string, data: unknown = {}) =>
  post(`/workflows/${businessId}/playbook-runs/${runId}/cancel`, data)


// ============================================
// Goals (Prompt 2)
// ============================================
export const getGoals = (businessId: string) => get(`/goals/${businessId}`)
export const getGoal = (businessId: string, id: string) => get(`/goals/${businessId}/${id}`)
export const createGoal = (businessId: string, data: unknown) => post(`/goals/${businessId}`, data)
export const updateGoal = (businessId: string, id: string, data: unknown) => request('PUT', `/goals/${businessId}/${id}`, data)
export const deleteGoal = (businessId: string, id: string) => del(`/goals/${businessId}/${id}`)
export const checkGoal = (businessId: string, id: string) => post(`/goals/${businessId}/${id}/check`)
export const proposeGoal = (businessId: string, context: unknown) => post(`/goals/${businessId}/propose`, { context })
export const reasonGoal = (businessId: string, id: string) => post(`/goals/${businessId}/${id}/reason`)

// Phase 3 — strategic planning
export const getGoalAssessment = (businessId: string, id: string) => get(`/goals/${businessId}/${id}/assessment`)
export const getGoalAssessments = (businessId: string, id: string) => get(`/goals/${businessId}/${id}/assessments`)
export const getGoalStrategies = (businessId: string, id: string) => get(`/goals/${businessId}/${id}/strategies`)
export const getGoalTimeline = (businessId: string, id: string) => get(`/goals/${businessId}/${id}/timeline`)

// ============================================
// Agent calibration (Feature 5)
// ============================================
export const getAgentCalibration = (agentId: string, businessId?: string) =>
  get(`/agents/${agentId}/calibration${businessId ? `?business_id=${businessId}` : ''}`)
export const recalculateAgentCalibration = (agentId: string, businessId: string) =>
  post(`/agents/${agentId}/calibration/recalculate`, { business_id: businessId })

// ============================================
// Scenarios (Feature 1)
// ============================================
export const getScenarios = (businessId: string) => get(`/scenarios/${businessId}`)
export const getScenario = (businessId: string, id: string) => get(`/scenarios/${businessId}/${id}`)
export const modelScenario = (businessId: string, question: string, context: unknown) =>
  post(`/scenarios/${businessId}/model`, { question, context })
export const deleteScenario = (businessId: string, id: string) => del(`/scenarios/${businessId}/${id}`)

// ============================================
// Recommendation comparison (issue #66)
//
// `compareCandidates` is READ ONLY — it approves nothing and executes
// nothing. `recordComparisonDecision` writes one decision-memory row and
// still does NOT approve or execute the selected candidate.
// ============================================
export interface ComparisonCandidateRef { id: string; kind?: 'task' | 'opportunity' | 'strategy' }

export const getComparableCandidates = (businessId: string) =>
  get(`/comparisons/${businessId}/candidates`)
export const compareCandidates = (businessId: string, candidates: ComparisonCandidateRef[]) =>
  post(`/comparisons/${businessId}/compare`, { candidates })
export const recordComparisonDecision = (
  businessId: string,
  payload: {
    candidates: ComparisonCandidateRef[]
    outcome: 'selected' | 'deferred'
    selected_candidate_id?: string | null
    rationale: string
  },
) => post(`/comparisons/${businessId}/decision`, payload)

// ============================================
// Conflicts (Feature 2)
// ============================================
export const getConflicts = (businessId: string, params = '') =>
  get(`/conflicts/${businessId}${params ? `?${params}` : ''}`)
export const resolveConflict = (businessId: string, id: string, note: string) =>
  post(`/conflicts/${businessId}/${id}/resolve`, { note })
export const dismissConflict = (businessId: string, id: string, reason: string) =>
  post(`/conflicts/${businessId}/${id}/dismiss`, { reason })
export const auditConflicts = (businessId: string) => post(`/conflicts/${businessId}/audit`)

// ============================================
// Retrospectives (Feature 3)
// ============================================
export const getRetrospectives = (businessId: string) => get(`/retrospectives/${businessId}`)
export const getRetrospective = (businessId: string, id: string) => get(`/retrospectives/${businessId}/${id}`)
export const runRetrospective = (businessId: string) => post(`/retrospectives/${businessId}/run`)

// ============================================
// Goal suggestions (Feature 6)
// ============================================
export const getGoalSuggestions = (businessId: string, status = 'active') => get(`/goal-suggestions/${businessId}`, { status })
export const runGoalSuggestionScan = (businessId: string) => post(`/goal-suggestions/${businessId}/scan`)
export const acceptGoalSuggestion = (businessId: string, id: string) =>
  post(`/goal-suggestions/${businessId}/${id}/accept`)
export const dismissGoalSuggestion = (businessId: string, id: string, reason: string) =>
  post(`/goal-suggestions/${businessId}/${id}/dismiss`, { reason })
export const snoozeGoalSuggestion = (businessId: string, id: string, days: number) =>
  post(`/goal-suggestions/${businessId}/${id}/snooze`, { days })

// ============================================
// Investigations (Feature 9)
// ============================================
export const getInvestigations = (businessId: string) => get(`/investigations/${businessId}`)
export const getInvestigation = (businessId: string, id: string) => get(`/investigations/${businessId}/${id}`)
export const runInvestigation = (businessId: string, payload: unknown) =>
  post(`/investigations/${businessId}/run`, payload)

// ============================================
// Projects (Prompt 3)
// ============================================
export const getProjects = (businessId: string) => get(`/projects/${businessId}`)
export const getProject = (businessId: string, id: string) => get(`/projects/${businessId}/${id}`)
export const createProject = (businessId: string, data: unknown) => post(`/projects/${businessId}`, data)
export const updateProject = (businessId: string, id: string, data: unknown) => request('PUT', `/projects/${businessId}/${id}`, data)
export const deleteProject = (businessId: string, id: string) => del(`/projects/${businessId}/${id}`)
export const linkToProject = (businessId: string, id: string, data: unknown) => post(`/projects/${businessId}/${id}/link`, data)
export const proposeProject = (businessId: string, context: unknown) => post(`/projects/${businessId}/propose`, { context })

// ============================================
// Timeline (Prompt 5)
// ============================================
export const getTimeline = (businessId: string, params?: Params) => get(`/timeline/${businessId}`, params)

// ============================================
// Agent Status (Prompt 4)
// ============================================
export const getAgentStatuses = () => get('/agents-status')

// ── Agent lifecycle sidebar (structured roster + timeline + proposals) ────────
import type {
  AgentRosterResponse, AgentTimelineResponse, ProposedAgentsResponse,
} from '../types/index.js'

export const getAgentRoster = (businessId: string): Promise<AgentRosterResponse> =>
  get('/agents-status/roster', { business_id: businessId })
export const getAgentTimeline = (agentId: string, limit = 30): Promise<AgentTimelineResponse> =>
  get(`/agents-status/${agentId}/timeline`, { limit })
export const getAgentProposals = (businessId: string): Promise<ProposedAgentsResponse> =>
  get('/agents/proposals', { business_id: businessId })
export const approveAgentProposal = (taskId: string) =>
  post(`/agents/proposals/${taskId}/approve`)
export const rejectAgentProposal = (taskId: string, reason?: string) =>
  post(`/agents/proposals/${taskId}/reject`, { reason })

// ============================================
// Brain
// ============================================
export const getBrainStatus = (businessId: string) => get(`/brain/${businessId}`)
export const getActionWindows = (businessId: string) => get(`/brain/${businessId}/action-windows`)
export const getInFlightActions = (businessId: string) => get(`/brain/${businessId}/in-flight`)
export const overrideDeferredTask = (businessId: string, taskId: string) => post(`/brain/${businessId}/tasks/${taskId}/override`)

// ─── Google OAuth app configuration ────────────────────────────────────────
export const getGoogleOAuthConfig = () => get('/oauth/google/config')
export const saveGoogleOAuthConfig = (body: unknown) => request('PUT', '/oauth/google/config', body)

// ─── Intelligence mesh (Timeline "produced by" drilldown) ─────────────────────
// Each timeline event with a `produces` hint can fetch downstream events
// (signals, tasks, KB entries, agent briefs, connector gaps) that were
// caused by it. See server/routes/timeline.js.
export const getTimelineIntelligence = (businessId: string, params?: Params) =>
  get(`/timeline/${businessId}/intelligence`, params)
export const getProducedByEvent = (businessId: string, sourceType: string, sourceId: string, params?: Params) =>
  get(`/timeline/${businessId}/produced/${sourceType}/${encodeURIComponent(sourceId)}`, params)

// ─── ROI (Tranche 7) ─────────────────────────────────────────────────────
export const getROIReport = (businessId: string) => get(`/roi/${businessId}`)
export const getROIAgents = (businessId: string, params?: Params) => get(`/roi/${businessId}/agents`, params)
export const getROIBaselines = (businessId: string) => get(`/roi/${businessId}/baselines`)
export const getROITrajectory = (businessId: string, params?: Params) => get(`/roi/${businessId}/trajectory`, params)
export const getROIAssessment = (businessId: string) => get(`/roi/${businessId}/assessment`)

// ─── LLM tiers (default / triage / fallback) ───────────────────────────────
export const getLLMTiers = () => get('/llm/tiers')
export const setLLMTier = (tier: string, body: unknown) => request('PUT', `/llm/tiers/${tier}`, body)
export const clearLLMTier = (tier: string) => del(`/llm/tiers/${tier}`)

// ─── Agent settings (per-agent poll intervals, Tranche 6D) ──────────────────
export const getAgentPollIntervals = () => get('/agent-settings/poll-intervals')
export const setAgentPollInterval = (agentId: string, minutes: number) =>
  request('PUT', `/agent-settings/poll-intervals/${agentId}`, { minutes })
export const resetAgentPollInterval = (agentId: string) =>
  del(`/agent-settings/poll-intervals/${agentId}`)

// ─── Token-efficiency stats (System Health) ──────────────────────────────────
export const getAgentEfficiency = (params?: Params) => get('/system/agent-efficiency', params)

// ─── Blueprint system GitHub (self-healing + connector discovery) ─────────────
// Separate from business GitHub connectors — targets chrisgwynne/Blueprint only.
export const getBlueprintGitHubStatus   = ()              => get('/settings/blueprint-github/status')
export const saveBlueprintGitHubSettings = (data: unknown) => post('/settings/blueprint-github', data)
export const testBlueprintGitHubConnection = ()           => post('/settings/blueprint-github/test', {})

// ─── Security (prompt injection defence) ───────────────────────────────────
export const getSecurityStatus = () => get('/security/status')
export const getSecurityAllowlist = () => get('/security/allowlist')
export const addSecurityAllowlist = (hostname: string) => post('/security/allowlist', { hostname })
export const removeSecurityAllowlist = (hostname: string) => del(`/security/allowlist/${encodeURIComponent(hostname)}`)
export const setSecurityEnforcement = (enabled: boolean) => post('/security/enforcement', { enabled })
export const toggleSecurityLayer = (key: string, enabled: boolean) => post('/security/toggle', { key, enabled })
export const getSecurityEvents = (params?: Params) => get('/security/events', params)
export const getSecurityOutboundLog = (params?: Params) => get('/security/outbound-log', params)

// ─── Decision Memory (Phase 3) ─────────────────────────────────────────────
export const getDecisions = (businessId: string, params?: Params) => get(`/decisions/${businessId}`, params)
export const getDecisionDetail = (businessId: string, id: string) => get(`/decisions/${businessId}/${id}`)

// ─── Decision Centre — the pending review queue (#61) ───────────────────────
// The counterpart to the decision history above: what still needs a human,
// classified by the per-business operating policy (#68).
export const getDecisionQueue = (businessId: string, params?: Params) => get(`/decision-queue/${businessId}`, params)
export const getDecisionClasses = (businessId: string) => get(`/decision-queue/${businessId}/classes`)
export const reviewPendingDecision = (
  businessId: string,
  taskId: string,
  body: {
    outcome: 'approve' | 'reject' | 'defer' | 'amend'
    reason?: string | null
    override_reason?: string | null
    amended_payload?: unknown
    approve_after_amend?: boolean
    defer_until?: string | null
  },
) => post(`/decision-queue/${businessId}/${taskId}/review`, body)
/** Previews a standing policy rule; saving stays in the policy editor (#68). */
export const proposePolicyRule = (
  businessId: string,
  taskId: string,
  ruleKind: 'always_require_human' | 'cap_auto_approve_tier',
) => post(`/decision-queue/${businessId}/${taskId}/propose-rule`, { rule_kind: ruleKind })

// ─── Knowledge Graph (Phase 3) ──────────────────────────────────────────────
export const getGraph = (businessId: string, params: Params) => get(`/graph/${businessId}`, params)
export const rebuildGraph = (businessId: string) => post(`/graph/${businessId}/rebuild`)

// ─── Review: recommendations, calibration, cross-business patterns (Phase 3)
export const getRecommendations = (businessId: string, params?: Params) => get(`/review/${businessId}/recommendations`, params)
export const getCalibration = (businessId: string, params?: Params) => get(`/review/${businessId}/calibration`, params)
export const getCrossBusinessPatterns = (businessId: string) => get(`/review/${businessId}/patterns`)

// ─── Autonomous Intelligence Foundation (Phase 2-INT) ──────────────────────
export const getBusinessProfile = (businessId: string) => get(`/intelligence/business-profile/${businessId}`)
export const updateBusinessProfile = (businessId: string, data: unknown) => patch(`/intelligence/business-profile/${businessId}`, data)
export const getActionRegistry = () => get('/intelligence/action-registry')
export const getConnectorConfidence = (businessId: string) => get(`/intelligence/connector-confidence/${businessId}`)
export const getWorldModel = (businessId: string) => get(`/intelligence/world-model/${businessId}`)
export const getWorldModelHistory = (businessId: string, params?: Params) => get(`/intelligence/world-model/${businessId}/history`, params)
export const getSystemIssues = (businessId: string, params?: Params) => get(`/intelligence/system-issues/${businessId}`, params)
export const updateSystemIssue = (issueId: string, status: string) => patch(`/intelligence/system-issues/issue/${issueId}`, { status })

// ============================================
// Phase 4 Trust and Autonomy
// ============================================
export const getTrustCapabilities = (businessId: string) => get(`/trust/capabilities/${businessId}`)
export const saveTrustCapability = (businessId: string, data: unknown) => post(`/trust/capabilities/${businessId}`, data)
export const getTrustCorrections = (businessId: string) => get(`/trust/corrections/${businessId}`)
export const getTrustCorrectionImpacts = (businessId: string, correctionId: string) => get(`/trust/corrections/${businessId}/${correctionId}/impacts`)
export const saveTrustCorrection = (businessId: string, data: unknown) => post(`/trust/corrections/${businessId}`, data)
export const getTrustRevenuePaths = (businessId: string) => get(`/trust/revenue-paths/${businessId}`)
export const saveTrustRevenuePath = (businessId: string, data: unknown) => post(`/trust/revenue-paths/${businessId}`, data)
export const getTrustLifecycle = (businessId: string) => get(`/trust/signals/${businessId}/lifecycle`)
export const getTrustMeasurementPolicies = (businessId: string) => get(`/trust/measurement-policies/${businessId}`)
export const getTrustPreflight = () => get('/trust/provider-preflight')
export const getTrustScorecard = (businessId: string, agentId = 'conductor') => get(`/trust/scorecards/${businessId}`, { agent_id: agentId })

// ============================================
// Social Publishing
// ============================================

const socialBase = (bizId: string) => `/social-publishing/${bizId}`

export const getSocialPreflight = (bizId: string) => get(`${socialBase(bizId)}/preflight`)
export const getSocialCapabilities = (bizId: string) => get(`${socialBase(bizId)}/capabilities`)
export const getSocialAccounts = (bizId: string, connectorId?: string) => get(`${socialBase(bizId)}/accounts`, connectorId ? { connectorId } : {})
export const discoverSocialAccounts = (bizId: string, connectorId: string) => get(`${socialBase(bizId)}/accounts/discover`, { connectorId })
export const bindSocialAccount = (bizId: string, body: object) => post(`${socialBase(bizId)}/accounts/bind`, body)
export const getSocialPolicy = (bizId: string, connectorId: string) => get(`${socialBase(bizId)}/policy`, { connectorId })
export const updateSocialPolicy = (bizId: string, body: object) => put(`${socialBase(bizId)}/policy`, body)
export const getSocialPosts = (bizId: string, params?: Params) => get(`${socialBase(bizId)}/posts`, params)
export const getSocialPost = (bizId: string, postId: string) => get(`${socialBase(bizId)}/posts/${postId}`)
export const createSocialDraft = (bizId: string, body: object) => post(`${socialBase(bizId)}/posts`, body)
export const approveSocialPost = (bizId: string, postId: string) => post(`${socialBase(bizId)}/posts/${postId}/approve`)
export const cancelSocialPost = (bizId: string, postId: string) => post(`${socialBase(bizId)}/posts/${postId}/cancel`)
export const publishSocialPost = (bizId: string, postId: string) => post(`${socialBase(bizId)}/posts/${postId}/publish`)
export const uploadSocialMedia = (bizId: string, body: object) => post(`${socialBase(bizId)}/media/upload`, body)
export const deleteStagedMedia = (bizId: string, token: string, connectorId: string) => del(`${socialBase(bizId)}/media/${token}`, { connectorId })

// ============================================
// Operating Policies (#68)
// ============================================
export const getOperatingPolicy = (businessId: string) => get(`/operating-policies/${businessId}`)
export const getOperatingPolicyVersion = (businessId: string, version: number) => get(`/operating-policies/${businessId}/versions/${version}`)
export const previewOperatingPolicy = (businessId: string, patch: unknown, effectiveAt?: string | null) =>
  post(`/operating-policies/${businessId}/preview`, { patch, effective_at: effectiveAt ?? null })
export const saveOperatingPolicy = (
  businessId: string,
  body: { patch: unknown; effective_at?: string | null; change_reason?: string | null; base_version?: number | null },
) => post(`/operating-policies/${businessId}`, body)
export const rollbackOperatingPolicy = (businessId: string, toVersion: number, changeReason?: string | null) =>
  post(`/operating-policies/${businessId}/rollback`, { to_version: toVersion, change_reason: changeReason ?? null })
export const cancelScheduledOperatingPolicy = (businessId: string, version: number, reason?: string | null) =>
  post(`/operating-policies/${businessId}/versions/${version}/cancel`, { reason: reason ?? null })
export const getPolicyPortfolios = () => get('/operating-policies/portfolios')
export const savePolicyPortfolio = (body: { id?: string; name: string; business_ids: string[] }) =>
  post('/operating-policies/portfolios', body)

// ============================================
// Executive command centre (#59)
// ============================================
// The one deliberately cross-business read in the API. `business_ids` is an
// ad hoc selection; `portfolio_id` names one of #68's saved policy
// portfolios as a shorthand for the same thing. Read-only by design —
// acting on a decision goes through reviewPendingDecision() above, which
// re-derives the item's policy standing at the moment of the decision.
export const getCommandCentre = (params?: Params) => get('/command-centre', params)
export const getCommandCentreScope = () => get('/command-centre/scope')

// ============================================
// Portfolios and portfolio comparison (#71)
// ============================================
// A saved, named grouping of businesses, compared metric-by-metric. Distinct
// from the command centre above (which triages decisions per business) and
// from #68's policy portfolios (which must partition businesses, where these
// may overlap freely). The writes here record membership only — grouping a
// business grants no access to it and takes no action on it.
export const getPortfolios = () => get('/portfolios')
export const getPortfolio = (id: string) => get(`/portfolios/${id}`)
export const createPortfolio = (body: { name: string; description?: string | null; business_ids: string[] }) =>
  post('/portfolios', body)
export const updatePortfolio = (id: string, body: { name?: string; description?: string | null }) =>
  patch(`/portfolios/${id}`, body)
export const deletePortfolio = (id: string) => del(`/portfolios/${id}`)
export const addPortfolioMembers = (id: string, businessIds: string[], reason?: string) =>
  post(`/portfolios/${id}/members`, { business_ids: businessIds, reason: reason ?? null })
// DELETE carries no body through the shared helper, so ids travel as a query
// param — the route accepts both forms.
export const removePortfolioMembers = (id: string, businessIds: string[]) =>
  del(`/portfolios/${id}/members`, { business_ids: businessIds.join(',') })
export const getPortfolioHistory = (id: string, params?: Params) => get(`/portfolios/${id}/history`, params)
export const getPortfolioComparison = (id: string, params?: Params) =>
  get(`/portfolios/${id}/comparison`, params)
export const importPolicyPortfolio = (policyPortfolioId: string, name?: string) =>
  post('/portfolios/import-policy-portfolio', { policy_portfolio_id: policyPortfolioId, name })
