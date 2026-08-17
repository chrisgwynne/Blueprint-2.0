import React, { useState, useEffect } from 'react'
import { Outlet, useLocation, useNavigate } from 'react-router-dom'
import {
  AlertCircle,
  CheckSquare,
  RefreshCw,
  Bell,
  X,
  Menu,
  HelpCircle,
} from 'lucide-react'
import Sidebar from './Sidebar'
import AgentSidebar from './agents/AgentSidebar'
import useStore from '../lib/store.js'
import { formatDistanceToNow } from 'date-fns'
import clsx from 'clsx'

function useLocalStorage<T>(key: string, fallback: T): [T, React.Dispatch<React.SetStateAction<T>>] {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = window.localStorage.getItem(key)
      return raw != null ? JSON.parse(raw) : fallback
    } catch { return fallback }
  })
  useEffect(() => {
    try { window.localStorage.setItem(key, JSON.stringify(value)) } catch {}
  }, [key, value])
  return [value, setValue]
}

// Contextual docs links per route
const DOCS_LINKS: Record<string, string> = {
  '/':            '/docs/getting-started/installation',
  '/signals':     '/docs/signals/overview',
  '/tasks':       '/docs/tasks/overview',
  '/chat':        '/docs/integrations/api-reference',
  '/agents':      '/docs/agents/overview',
  '/connectors':  '/docs/connectors/overview',
  '/outcomes':    '/docs/brain/causal-attribution',
  '/workflows':   '/docs/tasks/overview',
  '/goals':       '/docs/goals/overview',
  '/kb':          '/docs/brain/overview',
  '/health':      '/docs/troubleshooting/common-issues',
  '/settings':    '/docs/deployment/environment-variables',
}

// Page title map
const PAGE_TITLES: Record<string, string> = {
  '/':           'Dashboard',
  '/signals':    'Signals',
  '/tasks':      'Tasks',
  '/decision-centre': 'Decision Centre',
  '/chat':       'Chat',
  '/agents':     'Agents',
  '/connectors': 'Connectors',
  '/outcomes':   'Outcomes',
  '/roi':        'ROI',
  '/workflows':  'Workflows',
  '/goals':      'Goals',
  '/projects':   'Projects',
  '/timeline':   'Timeline',
  '/kb':         'Knowledge Base',
  '/health':     'System Health',
  '/settings':   'Settings',
}

// ============================================
// Health Score (centre of top bar)
// ============================================
function HealthScore({ score }: { score: number | null }) {
  if (score == null) return null

  const color =
    score >= 80 ? 'var(--bp-green)' :
    score >= 60 ? 'var(--bp-amber)' :
    'var(--bp-red)'

  return (
    <div style={{ textAlign: 'center', lineHeight: 1 }}>
      <div style={{
        fontFamily: 'var(--bp-font-display)',
        fontWeight: 800,
        fontSize: 26,
        color,
        lineHeight: 1,
        filter: `drop-shadow(0 0 6px ${color}50)`,
      }}>
        {score}
      </div>
      <div style={{
        fontFamily: 'var(--bp-font-mono)',
        fontSize: 8,
        letterSpacing: '0.15em',
        color: 'var(--bp-text-3)',
        marginTop: 3,
        textTransform: 'uppercase',
      }}>
        Health Score
      </div>
    </div>
  )
}

// ============================================
// Notification Area (toasts)
// ============================================
function NotificationArea() {
  const notifications = useStore((s) => s.notifications)
  const clearNotification = useStore((s) => s.clearNotification)

  if (notifications.length === 0) return null

  return (
    <div className="fixed bottom-4 right-4 z-[100] flex flex-col gap-2 max-w-sm">
      {notifications.map((n) => (
        <div
          key={n.id}
          className={clsx(
            'bp-card flex items-start gap-3 shadow-xl animate-fade-in',
            n.type === 'error'   && 'border-l-critical',
            n.type === 'success' && 'border-l-success',
            n.type === 'warning' && 'border-l-warning',
            (!n.type || n.type === 'info') && 'border-l-info',
          )}
          style={{ padding: '12px 16px' }}
        >
          <div className="flex-1 min-w-0">
            {n.title && (
              <p style={{ fontFamily: 'var(--bp-font-display)', fontWeight: 600, fontSize: 13, color: 'var(--bp-text)', marginBottom: 2 }}>
                {n.title}
              </p>
            )}
            <p style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 11, color: 'var(--bp-text-2)' }}>
              {n.message}
            </p>
          </div>
          <button
            onClick={() => clearNotification(n.id)}
            style={{ color: 'var(--bp-text-3)', flexShrink: 0, background: 'none', border: 'none', cursor: 'pointer', marginTop: 1 }}
          >
            <X size={14} />
          </button>
        </div>
      ))}
    </div>
  )
}

// ============================================
// Top Bar
// ============================================
function TopBar({ onHamburger }: { onHamburger: () => void }) {
  const location = useLocation()
  const dashboard = useStore((s) => s.dashboard)
  const openSignalCount = useStore((s) => s.openSignalCount)
  const pendingTaskCount = useStore((s) => s.pendingTaskCount)
  const navigate = useNavigate()
  const [syncing, setSyncing] = useState(false)
  const [lastSync] = useState(new Date())

  const pageTitle = PAGE_TITLES[location.pathname] || 'Blueprint'
  const healthScore: number | null = dashboard?.health_score ?? null

  async function handleSyncAll() {
    setSyncing(true)
    try {
      await fetch('/api/connectors/sync-all', { method: 'POST', credentials: 'include' })
    } catch { /* non-fatal */ }
    finally { setSyncing(false) }
  }

  return (
    <div
      style={{
        height: 52,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '0 20px',
        borderBottom: '1px solid var(--bp-border)',
        background: 'rgba(8,11,18,0.85)',
        backdropFilter: 'blur(12px)',
        flexShrink: 0,
        position: 'sticky',
        top: 0,
        zIndex: 20,
      }}
    >
      {/* Left: hamburger (mobile) + page title */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 140 }}>
        <button className="mobile-hamburger" onClick={onHamburger}>
          <Menu size={20} />
        </button>
        <span style={{
          fontFamily: 'var(--bp-font-display)',
          fontWeight: 600,
          fontSize: 15,
          color: 'var(--bp-text)',
        }}>
          {pageTitle}
        </span>
      </div>

      {/* Centre: health score */}
      <HealthScore score={healthScore} />

      {/* Right: badges + actions */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 140, justifyContent: 'flex-end' }}>
        {/* Signal count */}
        {openSignalCount > 0 ? (
          <button
            onClick={() => navigate('/signals')}
            className="bp-pill bp-pill-red"
            style={{ cursor: 'pointer', background: 'none', border: '1px solid rgba(239,68,68,0.3)' }}
          >
            <AlertCircle size={10} />
            {openSignalCount} signals
          </button>
        ) : (
          <span className="bp-pill bp-pill-green" style={{ fontSize: 10 }}>
            ● clear
          </span>
        )}

        {/* Task count */}
        {pendingTaskCount > 0 && (
          <button
            onClick={() => navigate('/tasks')}
            className="bp-pill bp-pill-amber"
            style={{ cursor: 'pointer', background: 'none', border: '1px solid rgba(245,158,11,0.3)' }}
          >
            <CheckSquare size={10} />
            {pendingTaskCount}
          </button>
        )}

        {/* Last sync */}
        <span style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 10, color: 'var(--bp-text-3)' }}>
          {formatDistanceToNow(lastSync, { addSuffix: true })}
        </span>

        {/* Sync all */}
        <button
          onClick={handleSyncAll}
          disabled={syncing}
          style={{
            width: 28, height: 28,
            borderRadius: '50%',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            background: 'transparent',
            border: '1px solid var(--bp-border)',
            color: 'var(--bp-text-2)',
            cursor: 'pointer',
            transition: 'all 150ms ease',
          }}
          title="Sync all connectors"
        >
          <RefreshCw size={12} style={{ animation: syncing ? 'bp-spin-slow 1s linear infinite' : 'none' }} />
        </button>

        {/* Contextual help */}
        <a
          href={DOCS_LINKS[location.pathname] || '/docs'}
          target="_blank"
          rel="noreferrer"
          style={{
            width: 28, height: 28,
            borderRadius: '50%',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            background: 'transparent',
            border: '1px solid var(--bp-border)',
            color: 'var(--bp-text-3)',
            textDecoration: 'none',
            transition: 'color 150ms ease, border-color 150ms ease',
            flexShrink: 0,
          }}
          title="Documentation"
          onMouseEnter={e => { e.currentTarget.style.color = 'var(--bp-text)'; e.currentTarget.style.borderColor = 'var(--bp-text-3)' }}
          onMouseLeave={e => { e.currentTarget.style.color = 'var(--bp-text-3)'; e.currentTarget.style.borderColor = 'var(--bp-border)' }}
        >
          <HelpCircle size={12} />
        </a>

        {/* Bell */}
        <button
          style={{
            width: 28, height: 28,
            borderRadius: '50%',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            background: 'transparent',
            border: '1px solid var(--bp-border)',
            color: openSignalCount > 0 ? 'var(--bp-text)' : 'var(--bp-text-2)',
            cursor: 'pointer',
            position: 'relative',
          }}
          title="Notifications"
        >
          <Bell size={12} />
          {openSignalCount > 0 && (
            <span style={{
              position: 'absolute',
              top: 5, right: 5,
              width: 5, height: 5,
              borderRadius: '50%',
              background: 'var(--bp-red)',
            }} />
          )}
        </button>
      </div>
    </div>
  )
}

// ============================================
// Main Layout
// ============================================
function Layout() {
  const sidebarCollapsed = useStore((s) => s.sidebarCollapsed)
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false)
  const [agentPanelOpen, setAgentPanelOpen] = useLocalStorage<boolean>('agent-panel-open', true)
  const location = useLocation()

  // Close mobile sidebar on navigation
  useEffect(() => { setMobileSidebarOpen(false) }, [location.pathname])

  return (
    <div style={{ display: 'flex', height: '100vh', background: 'var(--bp-base)', overflow: 'hidden' }}>
      {/* Mobile sidebar overlay */}
      <div
        className={`mobile-sidebar-overlay ${mobileSidebarOpen ? 'active' : ''}`}
        onClick={() => setMobileSidebarOpen(false)}
      />
      <div className={`sidebar-root ${mobileSidebarOpen ? 'mobile-open' : ''}`}>
        <Sidebar />
      </div>
      <div
        className="main-content-area"
        style={{
          display: 'flex',
          flexDirection: 'column',
          flex: 1,
          overflow: 'hidden',
          transition: 'margin-left 200ms ease',
          marginLeft: sidebarCollapsed ? 56 : 220,
        }}
      >
        <TopBar onHamburger={() => setMobileSidebarOpen(true)} />
        <main
          className="dot-grid"
          style={{ flex: 1, overflowY: 'auto', overflowX: 'hidden' }}
        >
          <Outlet />
        </main>
      </div>
      <AgentSidebar open={agentPanelOpen} onToggle={() => setAgentPanelOpen(!agentPanelOpen)} />
      <NotificationArea />
    </div>
  )
}

export default Layout
