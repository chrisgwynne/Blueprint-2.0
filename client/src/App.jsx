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
import Settings from './pages/Settings.jsx'
import LoginPage from './pages/LoginPage.jsx'
import Onboarding from './pages/Onboarding.jsx'
import useStore from './lib/store.js'
import { getMe, getBusinesses } from './lib/api.js'

// ============================================
// Protected Route Wrapper
// ============================================
function ProtectedRoute({ children }) {
  const user = useStore((s) => s.user)
  const [checking, setChecking] = useState(true)
  const setUser = useStore((s) => s.setUser)
  const setBusinesses = useStore((s) => s.setBusinesses)
  const setCurrentBusiness = useStore((s) => s.setCurrentBusiness)
  const currentBusiness = useStore((s) => s.currentBusiness)

  useEffect(() => {
    if (user) {
      setChecking(false)
      return
    }
    getMe()
      .then(async (me) => {
        setUser(me)
        try {
          const businesses = await getBusinesses()
          setBusinesses(businesses || [])
          if (businesses && businesses.length > 0 && !currentBusiness) {
            setCurrentBusiness(businesses[0])
          }
        } catch {
          // ignore
        }
        setChecking(false)
      })
      .catch(() => {
        setChecking(false)
      })
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

  // Show onboarding if no businesses exist
  const businesses = useStore((s) => s.businesses)
  const [onboardingDone, setOnboardingDone] = useState(false)
  if (!onboardingDone && Array.isArray(businesses) && businesses.length === 0) {
    return (
      <Onboarding onComplete={() => {
        setOnboardingDone(true)
        // Refresh businesses list
        getBusinesses().then((bs) => {
          useStore.getState().setBusinesses(bs ?? [])
          if (bs?.length > 0) useStore.getState().setCurrentBusiness(bs[0])
        }).catch(() => {})
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
        <Route path="settings" element={<Settings />} />
      </Route>

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}

export default App
