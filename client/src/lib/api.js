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
