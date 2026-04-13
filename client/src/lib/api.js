const BASE = '/api'

// ============================================
// Core fetch helpers
// ============================================

async function request(method, path, body, params) {
  let url = BASE + path

  if (params && Object.keys(params).length > 0) {
    const qs = new URLSearchParams(
      Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '')
    ).toString()
    if (qs) url += '?' + qs
  }

  const options = {
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

const get = (path, params) => request('GET', path, undefined, params)
const post = (path, body) => request('POST', path, body)
const patch = (path, body) => request('PATCH', path, body)
const del = (path) => request('DELETE', path)

// ============================================
// Auth
// ============================================

export const login = (username, password) => post('/auth/login', { username, password })
export const logout = () => post('/auth/logout')
export const getMe = () => get('/auth/me')

// ============================================
// Businesses
// ============================================

export const getBusinesses = () => get('/businesses')
export const createBusiness = (data) => post('/businesses', data)
export const updateBusiness = (id, data) => patch(`/businesses/${id}`, data)

// ============================================
// Dashboard
// ============================================

export const getDashboard = (businessId) => get(`/dashboard/${businessId}`)

// ============================================
// Signals
// ============================================

export const getSignals = (businessId, params) => get(`/signals/${businessId}`, params)
export const updateSignal = (id, data) => patch(`/signals/${id}`, data)

// ============================================
// Tasks
// ============================================

export const getTasks = (businessId, params) => get(`/tasks/${businessId}`, params)
export const createTask = (data) => post('/tasks', data)
export const approveTask = (id, data) => patch(`/tasks/${id}/approve`, data)
export const rejectTask = (id, data) => patch(`/tasks/${id}/reject`, data)
export const updateTask = (id, data) => patch(`/tasks/${id}`, data)

// ============================================
// Agents
// ============================================

export const getAgents = () => get('/agents')
export const runAgent = (id, body = {}) => post(`/agents/${id}/run`, body)
export const getAgentRuns = (id, params) => get(`/agents/${id}/runs`, params)
export const getAgentRun = (id, runId) => get(`/agents/${id}/runs/${runId}`)
export const updateAgent = (id, data) => patch(`/agents/${id}`, data)
export const getAgentProfile = (id) => get(`/agents/${id}/profile`)
export const updateAgentFile = (id, filename, content) => request('PUT', `/agents/${id}/files/${encodeURIComponent(filename)}`, { content })
export const patchAgentProfile = (id, data) => patch(`/agents/${id}/profile`, data)
export const getAgentMemory = (id) => get(`/agents/${id}/memory`)
export const clearAgentMemory = (id) => del(`/agents/${id}/memory`)
export const getAgentTemplates = () => get('/agents/templates')
export const installAgent = (agentId) => post('/agents/install', { agent_id: agentId })

// ============================================
// LLM Providers
// ============================================

export const getLLMProviders = () => get('/llm/providers')
export const getLLMModels = (providerId) => get(`/llm/providers/${providerId}/models`)
export const saveLLMCredentials = (providerId, creds) => request('PUT', `/llm/providers/${providerId}/credentials`, creds)
export const testLLMCredentials = (providerId, creds) => post(`/llm/providers/${providerId}/test`, creds)
export const getLLMDefault = () => get('/llm/default')
export const setLLMDefault = (provider) => request('PUT', '/llm/default', { provider })

// ============================================
// Connectors
// ============================================

export const getConnectors = (businessId) => get(`/connectors/${businessId}`)
export const addConnector = (data) => post('/connectors', data)
export const syncConnector = (id) => post(`/connectors/${id}/sync`)
export const healthCheckConnector = (id) => get(`/connectors/${id}/health`)
export const updateConnector = (id, data) => patch(`/connectors/${id}`, data)
export const deleteConnector = (id) => del(`/connectors/${id}`)
export const testPageSpeed = (url, apiKey) => post('/connectors/pagespeed/test', { url, apiKey: apiKey || undefined })

// Google OAuth — full-page redirect (not a fetch). Returns the URL to redirect to.
export function getGoogleAuthUrl(businessId, types = 'gsc,ga4') {
  return `/api/oauth/google?businessId=${encodeURIComponent(businessId)}&types=${encodeURIComponent(types)}`
}
export const revokeGoogleAuth = (businessId) => del(`/oauth/google/${businessId}`)

// ============================================
// Knowledge Base (business-scoped, Karpathy wiki pattern)
// ============================================

// Settings + init
export const getKbSettings = (businessId) => get(`/kb/${businessId}/settings`)
export const saveKbSettings = (businessId, data) => post(`/kb/${businessId}/settings`, data)
export const initKb = (businessId) => post(`/kb/${businessId}/init`)

// Read
export const getKbTree = (businessId) => get(`/kb/${businessId}/tree`)
export const getKbLog = (businessId, params) => get(`/kb/${businessId}/log`, params)
export const searchKb = (businessId, q) => get(`/kb/${businessId}/search`, { q })
export const getKbFile = (businessId, path) => get(`/kb/${businessId}/file/${path}`)
export const getKbBacklinks = (businessId, path) => get(`/kb/${businessId}/backlinks/${path}`)
export const getKbHistory = (businessId, path) => get(`/kb/${businessId}/history/${path}`)
export const getKbDiff = (businessId, hash, path) => get(`/kb/${businessId}/diff/${hash}/${path}`)

// Write
export const saveKbFile = (businessId, path, data) => post(`/kb/${businessId}/file/${path}`, data)
export const archiveKbFile = (businessId, path) => del(`/kb/${businessId}/file/${path}`)
export const restoreKbVersion = (businessId, data) => post(`/kb/${businessId}/restore`, data)
export const uploadKbRaw = (businessId, data) => post(`/kb/${businessId}/upload-raw`, data)

// Agent operations
export const ingestKb = (businessId, data) => post(`/kb/${businessId}/ingest`, data)
export const queryKb = (businessId, data) => post(`/kb/${businessId}/query`, data)
export const lintKb = (businessId) => post(`/kb/${businessId}/lint`)

// ============================================
// BAP — External Agents management (admin UI)
// ============================================

export const getBapAgents = () => get('/bap/v1/agents-admin')   // custom admin route (below)
export const revokeBapAgent = (agentId) => post(`/bap/v1/agents-admin/${agentId}/revoke`)
export const getBapAudit = (agentId, params) => get(`/bap/v1/agents-admin/${agentId}/audit`, params)
export const getBapDeliveries = (agentId, params) => get(`/bap/v1/agents-admin/${agentId}/deliveries`, params)

// LEGACY (kept for backwards-compat with anything still importing these — will be removed)
export const getKbDocs = (params) => get('/kb', params)
export const getKbDoc = (path) => get(`/kb/${path}`)
export const saveKbDoc = (path, data) => post(`/kb/${path}`, data)

// ============================================
// Audit
// ============================================

export const getAuditLog = (businessId, params) => get(`/audit/${businessId}`, params)

// ============================================
// Connector Data Pages
// ============================================

export const getConnectorData = (connectorId, params) => get(`/connector-data/${connectorId}`, params)

// ============================================
// Signals — AI Analysis
// ============================================

export const triggerAnalysis = (businessId) => post(`/signals/analyse/${businessId}`)
export const getAnalysisStatus = (businessId, runId) => get(`/signals/analyse/${businessId}/status/${runId}`)
export const getAIInsights = (businessId) => get(`/signals/insights/${businessId}`)
export const getSignalSummary = (businessId) => get(`/signals/${businessId}/summary`)
export const createTaskFromSignal = (signalId, data) => post(`/signals/${signalId}/create-task`, data)

// ============================================
// Tasks — Detail & History
// ============================================

export const getTaskDetail = (taskId) => get(`/tasks/${taskId}/detail`)
export const getTaskHistory = (taskId) => get(`/tasks/${taskId}/history`)
export const addTaskComment = (taskId, content) => post(`/tasks/${taskId}/comment`, { content })

// ============================================
// Metrics
// ============================================

export const getMetrics = (businessId, params) => get(`/metrics/${businessId}`, params)

// ============================================
// System Health (Feature 1)
// ============================================

export const getSystemHealth = () => get('/system/health/full')

// ============================================
// Signal Clusters (Feature 2)
// ============================================

export const getSignalClusters = (businessId, params) => get(`/signals/${businessId}/clusters`, params)
export const updateSignalCluster = (id, data) => patch(`/signals/clusters/${id}`, data)
export const runClusteringNow = (businessId) => post(`/signals/${businessId}/cluster`)

// ============================================
// Chat (Feature 3)
// ============================================

export const getConversations = (businessId) => get(`/chat/${businessId}/conversations`)
export const getConversation = (businessId, id) => get(`/chat/${businessId}/conversations/${id}`)
export const createConversation = (businessId, data) => post(`/chat/${businessId}/conversations`, data)
export const archiveConversation = (businessId, id) => del(`/chat/${businessId}/conversations/${id}`)
export const sendChatMessage = (businessId, conversationId, content) =>
  post(`/chat/${businessId}/conversations/${conversationId}/messages`, { content })
export const getChatMessages = (businessId, conversationId) =>
  get(`/chat/${businessId}/conversations/${conversationId}/messages`)

// ============================================
// Outcomes (Feature 4)
// ============================================

export const getOutcomes = (businessId, params) => get(`/outcomes/${businessId}`, params)
export const getAgentOutcomePerformance = (businessId) => get(`/outcomes/${businessId}/agents`)
export const getOutcomeTimeline = (businessId, params) => get(`/outcomes/${businessId}/timeline`, params)

// ============================================
// Email (Feature 5)
// ============================================

export const getEmailSettings = () => get('/notifications/email/settings')
export const saveEmailSettings = (data) => post('/notifications/email/settings', data)
export const sendTestEmail = (data) => post('/notifications/email/test', data)

// ============================================
// Workflows (Prompt 1)
// ============================================
export const getWorkflows = (businessId) => get(`/workflows/${businessId}`)
export const getWorkflow = (businessId, id) => get(`/workflows/${businessId}/${id}`)
export const createWorkflow = (businessId, data) => post(`/workflows/${businessId}`, data)
export const updateWorkflow = (businessId, id, data) => request('PUT', `/workflows/${businessId}/${id}`, data)
export const deleteWorkflow = (businessId, id) => del(`/workflows/${businessId}/${id}`)
export const runWorkflow = (businessId, id, data = {}) => post(`/workflows/${businessId}/${id}/run`, data)
export const getWorkflowRuns = (businessId) => get(`/workflows/${businessId}/runs/all`)
export const getWorkflowRun = (businessId, runId) => get(`/workflows/${businessId}/runs/${runId}`)
export const approveWorkflowStep = (businessId, runId, stepIndex, data = {}) =>
  post(`/workflows/${businessId}/runs/${runId}/steps/${stepIndex}/approve`, data)
export const rejectWorkflowStep = (businessId, runId, stepIndex, data) =>
  post(`/workflows/${businessId}/runs/${runId}/steps/${stepIndex}/reject`, data)
export const cancelWorkflowRun = (businessId, runId) =>
  post(`/workflows/${businessId}/runs/${runId}/cancel`)
export const proposeWorkflow = (businessId, trigger) =>
  post(`/workflows/${businessId}/propose`, { trigger })

// ============================================
// Goals (Prompt 2)
// ============================================
export const getGoals = (businessId) => get(`/goals/${businessId}`)
export const getGoal = (businessId, id) => get(`/goals/${businessId}/${id}`)
export const createGoal = (businessId, data) => post(`/goals/${businessId}`, data)
export const updateGoal = (businessId, id, data) => request('PUT', `/goals/${businessId}/${id}`, data)
export const deleteGoal = (businessId, id) => del(`/goals/${businessId}/${id}`)
export const checkGoal = (businessId, id) => post(`/goals/${businessId}/${id}/check`)
export const proposeGoal = (businessId, context) => post(`/goals/${businessId}/propose`, { context })
export const reasonGoal = (businessId, id) => post(`/goals/${businessId}/${id}/reason`)

// ============================================
// Agent calibration (Feature 5)
// ============================================
export const getAgentCalibration = (agentId, businessId) =>
  get(`/agents/${agentId}/calibration${businessId ? `?business_id=${businessId}` : ''}`)
export const recalculateAgentCalibration = (agentId, businessId) =>
  post(`/agents/${agentId}/calibration/recalculate`, { business_id: businessId })

// ============================================
// Scenarios (Feature 1)
// ============================================
export const getScenarios = (businessId) => get(`/scenarios/${businessId}`)
export const getScenario = (businessId, id) => get(`/scenarios/${businessId}/${id}`)
export const modelScenario = (businessId, question, context) =>
  post(`/scenarios/${businessId}/model`, { question, context })
export const deleteScenario = (businessId, id) => del(`/scenarios/${businessId}/${id}`)

// ============================================
// Conflicts (Feature 2)
// ============================================
export const getConflicts = (businessId, params = '') =>
  get(`/conflicts/${businessId}${params ? `?${params}` : ''}`)
export const resolveConflict = (businessId, id, note) =>
  post(`/conflicts/${businessId}/${id}/resolve`, { note })
export const dismissConflict = (businessId, id, reason) =>
  post(`/conflicts/${businessId}/${id}/dismiss`, { reason })
export const auditConflicts = (businessId) => post(`/conflicts/${businessId}/audit`)

// ============================================
// Retrospectives (Feature 3)
// ============================================
export const getRetrospectives = (businessId) => get(`/retrospectives/${businessId}`)
export const getRetrospective = (businessId, id) => get(`/retrospectives/${businessId}/${id}`)
export const runRetrospective = (businessId) => post(`/retrospectives/${businessId}/run`)

// ============================================
// Goal suggestions (Feature 6)
// ============================================
export const getGoalSuggestions = (businessId) => get(`/goal-suggestions/${businessId}`)
export const runGoalSuggestionScan = (businessId) => post(`/goal-suggestions/${businessId}/scan`)
export const acceptGoalSuggestion = (businessId, id) =>
  post(`/goal-suggestions/${businessId}/${id}/accept`)
export const dismissGoalSuggestion = (businessId, id, reason) =>
  post(`/goal-suggestions/${businessId}/${id}/dismiss`, { reason })
export const snoozeGoalSuggestion = (businessId, id, days) =>
  post(`/goal-suggestions/${businessId}/${id}/snooze`, { days })

// ============================================
// Investigations (Feature 9)
// ============================================
export const getInvestigations = (businessId) => get(`/investigations/${businessId}`)
export const getInvestigation = (businessId, id) => get(`/investigations/${businessId}/${id}`)
export const runInvestigation = (businessId, payload) =>
  post(`/investigations/${businessId}/run`, payload)

// ============================================
// Projects (Prompt 3)
// ============================================
export const getProjects = (businessId) => get(`/projects/${businessId}`)
export const getProject = (businessId, id) => get(`/projects/${businessId}/${id}`)
export const createProject = (businessId, data) => post(`/projects/${businessId}`, data)
export const updateProject = (businessId, id, data) => request('PUT', `/projects/${businessId}/${id}`, data)
export const deleteProject = (businessId, id) => del(`/projects/${businessId}/${id}`)
export const linkToProject = (businessId, id, data) => post(`/projects/${businessId}/${id}/link`, data)
export const proposeProject = (businessId, context) => post(`/projects/${businessId}/propose`, { context })

// ============================================
// Timeline (Prompt 5)
// ============================================
export const getTimeline = (businessId, params) => get(`/timeline/${businessId}`, params)

// ============================================
// Agent Status (Prompt 4)
// ============================================
export const getAgentStatuses = () => get('/agents-status')

// ============================================
// Brain
// ============================================
export const getBrainStatus = (businessId) => get(`/brain/${businessId}`)
export const getActionWindows = (businessId) => get(`/brain/${businessId}/action-windows`)
export const getInFlightActions = (businessId) => get(`/brain/${businessId}/in-flight`)
export const overrideDeferredTask = (businessId, taskId) => post(`/brain/${businessId}/tasks/${taskId}/override`)

// ─── Google OAuth app configuration ────────────────────────────────────────
export const getGoogleOAuthConfig = () => get('/oauth/google/config')
export const saveGoogleOAuthConfig = (body) => request('PUT', '/oauth/google/config', body)
