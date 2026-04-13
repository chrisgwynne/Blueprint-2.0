import React, { useEffect, useState } from 'react'
import { Routes, Route, Navigate, useNavigate } from 'react-router-dom'
import Layout from './components/Layout.jsx'
import Dashboard from './pages/Dashboard.jsx'
import Signals from './pages/Signals.jsx'
import Tasks from './pages/Tasks.jsx'
import Agents from './pages/Agents.jsx'
import AgentDetail from './pages/AgentDetail.jsx'
import Connectors from './pages/Connectors.jsx'
import ConnectorDataPage from './pages/ConnectorDataPage.jsx'
import KB from './pages/KB.jsx'
import SystemHealth from './pages/SystemHealth.jsx'
import Chat from './pages/Chat.jsx'
import Outcomes from './pages/Outcomes.jsx'
import Workflows from './pages/Workflows.jsx'
import Goals from './pages/Goals.jsx'
import Scenarios from './pages/Scenarios.jsx'
import Conflicts from './pages/Conflicts.jsx'
import Retrospectives from './pages/Retrospectives.jsx'
import Projects from './pages/Projects.jsx'
import Timeline from './pages/Timeline.jsx'
import Settings from './pages/Settings.jsx'
import LoginPage from './pages/LoginPage.jsx'
import Onboarding from './pages/Onboarding.jsx'
import useStore from './lib/store.js'
import { getMe, getBusinesses } from './lib/api.js'

// ============================================
// Protected Route Wrapper
// ============================================
function ProtectedRoute({ children }) {
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
          setCurrentBusiness(bs[0])
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
        getBusinesses().then((bs) => {
          useStore.getState().setBusinesses(bs ?? [])
          if (bs?.length > 0) useStore.getState().setCurrentBusiness(bs[0])
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
        <Route path="workflows" element={<Workflows />} />
        <Route path="goals" element={<Goals />} />
        <Route path="scenarios" element={<Scenarios />} />
        <Route path="conflicts" element={<Conflicts />} />
        <Route path="retrospectives" element={<Retrospectives />} />
        <Route path="retrospectives/:id" element={<Retrospectives />} />
        <Route path="projects" element={<Projects />} />
        <Route path="projects/:projectId" element={<Projects />} />
        <Route path="timeline" element={<Timeline />} />
        <Route path="settings" element={<Settings />} />
      </Route>

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}

export default App
