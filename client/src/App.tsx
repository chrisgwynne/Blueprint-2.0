import React, { lazy, Suspense, useEffect, useState } from 'react'
import { Routes, Route, Navigate, useNavigate } from 'react-router-dom'
import Layout from './components/Layout'

// All pages lazy-loaded — each becomes a separate route chunk so the initial
// bundle only ships the shell (Layout, store, API client).
const Dashboard      = lazy(() => import('./pages/Dashboard.tsx'))
const Signals        = lazy(() => import('./pages/Signals.tsx'))
const Tasks          = lazy(() => import('./pages/Tasks.tsx'))
const Agents         = lazy(() => import('./pages/Agents.tsx'))
const AgentDetail    = lazy(() => import('./pages/AgentDetail.tsx'))
const Connectors     = lazy(() => import('./pages/Connectors.tsx'))
const ConnectorDataPage = lazy(() => import('./pages/ConnectorDataPage.tsx'))
const KB             = lazy(() => import('./pages/KB.tsx'))
const SystemHealth   = lazy(() => import('./pages/SystemHealth.tsx'))
const Chat           = lazy(() => import('./pages/Chat.tsx'))
const Outcomes       = lazy(() => import('./pages/Outcomes.tsx'))
const Receipts       = lazy(() => import('./pages/Receipts.tsx'))
const Digest         = lazy(() => import('./pages/Digest.tsx'))
const AuditSearch    = lazy(() => import('./pages/AuditSearch.tsx'))
const ROI            = lazy(() => import('./pages/ROI.tsx'))
const Workflows      = lazy(() => import('./pages/Workflows.tsx'))
const Goals          = lazy(() => import('./pages/Goals.tsx'))
const Scenarios      = lazy(() => import('./pages/Scenarios.tsx'))
const Conflicts      = lazy(() => import('./pages/Conflicts.tsx'))
const Retrospectives = lazy(() => import('./pages/Retrospectives.tsx'))
const Projects       = lazy(() => import('./pages/Projects.tsx'))
const Timeline       = lazy(() => import('./pages/Timeline.tsx'))
const Settings       = lazy(() => import('./pages/Settings.tsx'))
const Opportunities  = lazy(() => import('./pages/Opportunities.tsx'))
const Decisions      = lazy(() => import('./pages/Decisions.tsx'))
const DecisionCentre = lazy(() => import('./pages/DecisionCentre.tsx'))
const ExecutiveCommandCentre = lazy(() => import('./pages/ExecutiveCommandCentre.tsx'))
const PortfolioView  = lazy(() => import('./pages/PortfolioView.tsx'))
const Recommendations = lazy(() => import('./pages/Recommendations.tsx'))
const Comparison     = lazy(() => import('./pages/Comparison.tsx'))
const Calibration    = lazy(() => import('./pages/Calibration.tsx'))
const RelationshipGraph = lazy(() => import('./pages/RelationshipGraph.tsx'))
const LoginPage      = lazy(() => import('./pages/LoginPage.tsx'))
const Onboarding     = lazy(() => import('./pages/Onboarding.tsx'))
const TrustOps       = lazy(() => import('./pages/TrustOps.tsx'))
const PolicyEditor   = lazy(() => import('./pages/PolicyEditor.tsx'))
const SocialPublishing = lazy(() => import('./pages/SocialPublishing.tsx'))

// Minimal fallback shown while a page chunk is loading for the first time.
function PageFallback() {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 1, minHeight: 200 }}>
      <div style={{ display: 'flex', gap: 4 }}>
        <span className="pulse-dot pulse-dot-blue" style={{ animationDelay: '0s' }} />
        <span className="pulse-dot pulse-dot-blue" style={{ animationDelay: '0.2s' }} />
        <span className="pulse-dot pulse-dot-blue" style={{ animationDelay: '0.4s' }} />
      </div>
    </div>
  )
}
import useStore from './lib/store.js'
import { getMe, getBusinesses } from './lib/api.js'

// ============================================
// Protected Route Wrapper
// ============================================
function ProtectedRoute({ children }: { children: React.ReactNode }) {
  // All hooks at the top — never after a conditional return.
  const user = useStore((s) => s.user)
  const [checking, setChecking] = useState(true)
  // showOnboarding is set once when checking completes and is only cleared
  // by onComplete(). It must NOT be re-derived from businesses on every
  // render — doing so kills the wizard the moment step 1 creates a business
  // and updates the store.
  const [showOnboarding, setShowOnboarding] = useState(false)
  const setUser = useStore((s) => s.setUser)
  const setBusinesses = useStore((s) => s.setBusinesses)
  const setCurrentBusiness = useStore((s) => s.setCurrentBusiness)
  const currentBusiness = useStore((s) => s.currentBusiness)

  useEffect(() => {
    async function init() {
      let me = user
      if (!me) {
        try {
          me = await getMe()
          setUser(me)
        } catch {
          setChecking(false)
          return
        }
      }
      try {
        const bs = await getBusinesses()
        setBusinesses(bs || [])
        if (bs && bs.length > 0 && !currentBusiness) {
          const savedId = localStorage.getItem('bp_current_business_id')
          const saved = savedId ? bs.find((b: { id: string }) => b.id === savedId) : null
          setCurrentBusiness(saved || bs[0])
        }
        // Decide once whether onboarding is needed.
        if (!bs || bs.length === 0) {
          setShowOnboarding(true)
        }
      } catch {
        // Can't load businesses — show onboarding so user can create one.
        setShowOnboarding(true)
      }
      setChecking(false)
    }
    init()
  }, [])

  if (checking) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-blueprint-bg">
        <div className="flex flex-col items-center gap-4">
          <div className="flex gap-1">
            <span className="pulse-dot pulse-dot-blue" style={{ animationDelay: '0s' }} />
            <span className="pulse-dot pulse-dot-blue" style={{ animationDelay: '0.3s' }} />
            <span className="pulse-dot pulse-dot-blue" style={{ animationDelay: '0.6s' }} />
          </div>
          <p className="text-blueprint-muted text-sm mono">Initialising Blueprint...</p>
        </div>
      </div>
    )
  }

  if (!user) {
    return <Navigate to="/login" replace />
  }

  if (showOnboarding) {
    return (
      <Onboarding onComplete={() => {
        // Refresh businesses then dismiss the wizard.
        getBusinesses().then((bs: any) => {
          useStore.getState().setBusinesses(bs ?? [])
          if (bs?.length > 0) {
            const savedId = localStorage.getItem('bp_current_business_id')
            const saved = savedId ? bs.find((b: any) => b.id === savedId) : null
            useStore.getState().setCurrentBusiness(saved || bs[0])
          }
        }).catch(() => {}).finally(() => {
          setShowOnboarding(false)
        })
      }} />
    )
  }

  return children
}

// ============================================
// App Root
// ============================================
function App() {
  return (
    <Suspense fallback={<PageFallback />}>
      <Routes>
        <Route path="/login" element={<LoginPage />} />

        <Route
          path="/"
          element={
            <ProtectedRoute>
              <Layout />
            </ProtectedRoute>
          }
        >
          <Route index element={<Dashboard />} />
          <Route path="signals" element={<Signals />} />
          <Route path="tasks" element={<Tasks />} />
          <Route path="agents" element={<Agents />} />
          <Route path="agents/:agentId" element={<AgentDetail />} />
          <Route path="connectors" element={<Connectors />} />
          <Route path="connectors/:connectorId/data" element={<ConnectorDataPage />} />
          <Route path="kb" element={<KB />} />
          <Route path="kb/*" element={<KB />} />
          <Route path="health" element={<SystemHealth />} />
          <Route path="chat" element={<Chat />} />
          <Route path="chat/:conversationId" element={<Chat />} />
          <Route path="outcomes" element={<Outcomes />} />
          <Route path="receipts" element={<Receipts />} />
          <Route path="digest" element={<Digest />} />
          <Route path="audit-search" element={<AuditSearch />} />
          <Route path="roi" element={<ROI />} />
          <Route path="workflows" element={<Workflows />} />
          <Route path="goals" element={<Goals />} />
          <Route path="scenarios" element={<Scenarios />} />
          <Route path="conflicts" element={<Conflicts />} />
          <Route path="retrospectives" element={<Retrospectives />} />
          <Route path="retrospectives/:id" element={<Retrospectives />} />
          <Route path="projects" element={<Projects />} />
          <Route path="projects/:projectId" element={<Projects />} />
          <Route path="timeline" element={<Timeline />} />
          <Route path="opportunities" element={<Opportunities />} />
          <Route path="command-centre" element={<ExecutiveCommandCentre />} />
          <Route path="portfolio" element={<PortfolioView />} />
          <Route path="decision-centre" element={<DecisionCentre />} />
          <Route path="decisions" element={<Decisions />} />
          <Route path="recommendations" element={<Recommendations />} />
          <Route path="comparison" element={<Comparison />} />
          <Route path="calibration" element={<Calibration />} />
          <Route path="graph" element={<RelationshipGraph />} />
          <Route path="trust" element={<TrustOps />} />
          <Route path="policy" element={<PolicyEditor />} />
          <Route path="social-publishing" element={<SocialPublishing />} />
          <Route path="settings" element={<Settings />} />
        </Route>

        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Suspense>
  )
}

export default App
