import React, { useState, useEffect } from 'react'
import { NavLink, useNavigate } from 'react-router-dom'
import {
  LayoutDashboard,
  Radio,
  CheckSquare,
  Bot,
  Plug,
  BookOpen,
  Settings,
  ChevronLeft,
  ChevronRight,
  LogOut,
  ExternalLink,
  ChevronsUpDown,
  Building2,
  Plus,
  Search,
  BarChart2,
  Zap,
  ShoppingBag,
  MapPin,
  Database,
  Activity,
  Mail,
  Send,
  Globe,
  FileText,
  TrendingUp,
  CreditCard,
  GitBranch,
  Store,
  type LucideIcon,
} from 'lucide-react'
import { MessageSquare, Target, Workflow, FolderOpen, Clock, Sparkles, BookMarked, AlertTriangle, PiggyBank, Lightbulb, History, ListChecks, Gauge, Share2 } from 'lucide-react'
import clsx from 'clsx'
import useStore from '../lib/store.js'
import { logout, createBusiness, getBusinesses, getConnectors, getSystemHealth, getProjects } from '../lib/api.js'

const CONNECTOR_ICONS: Record<string, LucideIcon> & { default: LucideIcon } = {
  gsc:           Search,
  ga4:           BarChart2,
  pagespeed:     Zap,
  shopify:       ShoppingBag,
  gbp:           MapPin,
  stripe:        CreditCard,
  github:        GitBranch,
  uptimerobot:   Activity,
  todoist:       CheckSquare,
  brevo:         Mail,
  stannp:        Send,
  wordpress:     Globe,
  kirby:         FileText,
  'google-ads':  TrendingUp,
  'google-merchant': Store,
  'meta-ads':    Target,
  default:       Database,
}

const CONNECTOR_LABELS: Record<string, string> = {
  gsc:           'Search',
  ga4:           'Analytics',
  pagespeed:     'PageSpeed',
  shopify:       'Shopify',
  gbp:           'Business Profile',
  stripe:        'Stripe',
  github:        'GitHub',
  uptimerobot:   'Uptime',
  todoist:       'Todoist',
  brevo:         'Brevo',
  stannp:        'Stannp',
  wordpress:     'WordPress',
  kirby:         'Kirby',
  'google-ads':  'Google Ads',
  'google-merchant': 'Merchant Center',
  'meta-ads':    'Meta Ads',
  default:       'Data',
}

interface NavItemConfig {
  label: string
  to: string
  icon: LucideIcon
  end?: boolean
  badge?: string
  healthDot?: boolean
}

const NAV_ITEMS: NavItemConfig[] = [
  { label: 'Dashboard',     to: '/',           icon: LayoutDashboard, end: true },
  { label: 'Signals',       to: '/signals',    icon: Radio,           badge: 'openSignalCount' },
  { label: 'Tasks',         to: '/tasks',      icon: CheckSquare,     badge: 'pendingTaskCount' },
  { label: 'Chat',          to: '/chat',       icon: MessageSquare },
  { label: 'Workflows',     to: '/workflows',  icon: Workflow },
  { label: 'Goals',         to: '/goals',      icon: Target },
  { label: 'Opportunities', to: '/opportunities', icon: Lightbulb },
  { label: 'Recommendations', to: '/recommendations', icon: ListChecks },
  { label: 'Scenarios',     to: '/scenarios',  icon: Sparkles },
  { label: 'Conflicts',     to: '/conflicts',  icon: AlertTriangle },
  { label: 'Decisions',     to: '/decisions',  icon: History },
  { label: 'Retrospectives',to: '/retrospectives', icon: BookMarked },
  { label: 'Calibration',   to: '/calibration', icon: Gauge },
  { label: 'Relationship Graph', to: '/graph',  icon: Share2 },
  { label: 'Timeline',      to: '/timeline',   icon: Clock },
  { label: 'Agents',        to: '/agents',     icon: Bot },
  { label: 'Connectors',    to: '/connectors', icon: Plug },
  { label: 'Outcomes',      to: '/outcomes',   icon: Target },
  { label: 'ROI',           to: '/roi',        icon: PiggyBank },
  { label: 'Knowledge Base',to: '/kb',         icon: BookOpen },
  { label: 'System Health', to: '/health',     icon: Activity,        healthDot: true },
  { label: 'Settings',      to: '/settings',   icon: Settings },
]

function NavItem({ item, collapsed, healthStatus }: {
  item: NavItemConfig
  collapsed: boolean
  healthStatus: string | null
}) {
  const openSignalCount  = useStore((s) => s.openSignalCount)
  const pendingTaskCount = useStore((s) => s.pendingTaskCount)

  const badgeCount =
    item.badge === 'openSignalCount'  ? openSignalCount  :
    item.badge === 'pendingTaskCount' ? pendingTaskCount :
    0

  const showHealthDot = item.healthDot && healthStatus
  const healthColor =
    healthStatus === 'healthy'  ? 'var(--bp-green)' :
    healthStatus === 'degraded' ? 'var(--bp-amber)' :
    healthStatus === 'critical' ? 'var(--bp-red)'   :
    null

  return (
    <NavLink
      to={item.to}
      end={item.end}
      style={({ isActive }) => ({
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: collapsed ? '9px 0' : '8px 10px',
        borderRadius: 5,
        borderLeft: isActive ? '2px solid var(--bp-blue)' : '2px solid transparent',
        paddingLeft: collapsed ? 0 : isActive ? 8 : 10,
        background: isActive ? 'linear-gradient(90deg, rgba(59,130,246,0.08), transparent)' : 'transparent',
        color: isActive ? 'var(--bp-blue)' : 'var(--bp-text-3)',
        fontFamily: 'var(--bp-font-mono)',
        fontSize: 12,
        fontWeight: 500,
        letterSpacing: '0.04em',
        textDecoration: 'none',
        transition: 'all 150ms ease',
        position: 'relative',
        justifyContent: collapsed ? 'center' : 'flex-start',
      })}
      className="group"
    >
      {({ isActive }) => (
        <>
          <item.icon
            size={15}
            style={{
              flexShrink: 0,
              color: isActive ? 'var(--bp-blue)' : 'var(--bp-text-3)',
            }}
          />
          {!collapsed && (
            <span style={{ flex: 1, color: isActive ? 'var(--bp-blue)' : 'var(--bp-text-2)' }}>
              {item.label}
            </span>
          )}
          {!collapsed && badgeCount > 0 && (
            <span
              className="bp-pill bp-pill-blue"
              style={{ padding: '1px 6px', fontSize: 9 }}
            >
              {badgeCount > 99 ? '99+' : badgeCount}
            </span>
          )}
          {!collapsed && showHealthDot && healthColor && (
            <span style={{
              width: 6, height: 6, borderRadius: '50%',
              background: healthColor,
              display: 'inline-block',
              animation: healthStatus !== 'healthy' ? `bp-pulse ${healthStatus === 'critical' ? '1s' : '2s'} infinite` : 'none',
              boxShadow: `0 0 6px ${healthColor}80`,
            }} />
          )}
          {collapsed && badgeCount > 0 && (
            <span style={{
              position: 'absolute',
              top: 6, right: 6,
              width: 5, height: 5,
              borderRadius: '50%',
              background: 'var(--bp-blue)',
            }} />
          )}
          {collapsed && showHealthDot && healthColor && (
            <span style={{
              position: 'absolute',
              bottom: 5, right: 5,
              width: 5, height: 5,
              borderRadius: '50%',
              background: healthColor,
              animation: healthStatus !== 'healthy' ? `bp-pulse ${healthStatus === 'critical' ? '1s' : '2s'} infinite` : 'none',
            }} />
          )}
          {/* Tooltip when collapsed */}
          {collapsed && (
            <div
              className="bp-tooltip opacity-0 group-hover:opacity-100 transition-opacity"
              style={{ left: 'calc(100% + 12px)', top: '50%', transform: 'translateY(-50%)' }}
            >
              {item.label}
              {badgeCount > 0 && (
                <span style={{ marginLeft: 6, color: 'var(--bp-blue)' }}>{badgeCount}</span>
              )}
            </div>
          )}
        </>
      )}
    </NavLink>
  )
}

// ============================================
// Business Switcher
// ============================================
function BusinessSwitcher({ collapsed }: { collapsed: boolean }) {
  const currentBusiness  = useStore((s) => s.currentBusiness)
  const businesses       = useStore((s) => s.businesses)
  const setCurrentBusiness = useStore((s) => s.setCurrentBusiness)
  const setBusinesses    = useStore((s) => s.setBusinesses)
  const [open, setOpen]  = useState(false)
  const [addingNew, setAddingNew] = useState(false)
  const [newName, setNewName]     = useState('')
  const [creating, setCreating]   = useState(false)

  if (!currentBusiness) return null

  const logo = (currentBusiness.settings as Record<string, unknown>)?.logo as string | undefined

  async function handleCreate() {
    if (!newName.trim()) return
    setCreating(true)
    try {
      const created = await createBusiness({ name: newName.trim() })
      const updated = await getBusinesses()
      setBusinesses(updated)
      setCurrentBusiness(created)
      setOpen(false)
      setAddingNew(false)
      setNewName('')
    } catch { /* ignore */ }
    finally { setCreating(false) }
  }

  if (collapsed) {
    return (
      <div style={{ padding: '8px 0', borderBottom: '1px solid var(--bp-border)', display: 'flex', justifyContent: 'center' }}>
        {logo ? (
          <img src={logo} alt="" style={{ width: 28, height: 28, borderRadius: 4, objectFit: 'cover' }} />
        ) : (
          <div style={{
            width: 28, height: 28, borderRadius: 4,
            background: 'rgba(59,130,246,0.15)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            <Building2 size={13} style={{ color: 'var(--bp-blue)' }} />
          </div>
        )}
      </div>
    )
  }

  return (
    <div style={{ padding: '8px', borderBottom: '1px solid var(--bp-border)', position: 'relative' }}>
      <button
        onClick={() => setOpen(!open)}
        style={{
          width: '100%',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '6px 8px',
          borderRadius: 5,
          background: 'transparent',
          border: 'none',
          cursor: 'pointer',
          transition: 'background 150ms ease',
        }}
        onMouseEnter={e => e.currentTarget.style.background = 'var(--bp-surface-3)'}
        onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
      >
        {logo ? (
          <img src={logo} alt="" style={{ width: 22, height: 22, borderRadius: 3, objectFit: 'cover', flexShrink: 0 }} />
        ) : (
          <div style={{
            width: 22, height: 22, borderRadius: 3, flexShrink: 0,
            background: 'rgba(59,130,246,0.15)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            <Building2 size={11} style={{ color: 'var(--bp-blue)' }} />
          </div>
        )}
        <span style={{
          flex: 1, textAlign: 'left',
          fontFamily: 'var(--bp-font-mono)',
          fontSize: 11, fontWeight: 500,
          color: 'var(--bp-text)',
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>
          {currentBusiness.name}
        </span>
        <ChevronsUpDown size={11} style={{ color: 'var(--bp-text-3)', flexShrink: 0 }} />
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => { setOpen(false); setAddingNew(false); setNewName('') }} />
          <div style={{
            position: 'absolute',
            left: 8, right: 8,
            top: '100%',
            marginTop: 4,
            background: 'var(--bp-surface-2)',
            border: '1px solid var(--bp-border-2)',
            borderRadius: 6,
            zIndex: 50,
            padding: '4px 0',
            boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
          }}>
            {businesses.map((biz) => (
              <button
                key={biz.id}
                onClick={() => { setCurrentBusiness(biz); setOpen(false) }}
                style={{
                  width: '100%',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '7px 12px',
                  background: 'transparent',
                  border: 'none',
                  cursor: 'pointer',
                  fontFamily: 'var(--bp-font-mono)',
                  fontSize: 11,
                  color: biz.id === currentBusiness.id ? 'var(--bp-blue)' : 'var(--bp-text-2)',
                  textAlign: 'left',
                }}
              >
                {(biz.settings as Record<string, unknown>)?.logo ? (
                  <img src={(biz.settings as Record<string, unknown>).logo as string} alt="" style={{ width: 18, height: 18, borderRadius: 3, objectFit: 'cover' }} />
                ) : (
                  <div style={{ width: 18, height: 18, borderRadius: 3, background: 'rgba(255,255,255,0.06)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    <Building2 size={9} style={{ color: 'var(--bp-text-3)' }} />
                  </div>
                )}
                <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{biz.name}</span>
                {biz.id === currentBusiness.id && <span style={{ fontSize: 9, color: 'var(--bp-blue)' }}>●</span>}
              </button>
            ))}

            <div style={{ borderTop: '1px solid var(--bp-border)', marginTop: 4, paddingTop: 4 }}>
              {!addingNew ? (
                <button
                  onClick={() => setAddingNew(true)}
                  style={{
                    width: '100%',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    padding: '7px 12px',
                    background: 'transparent',
                    border: 'none',
                    cursor: 'pointer',
                    fontFamily: 'var(--bp-font-mono)',
                    fontSize: 11,
                    color: 'var(--bp-text-3)',
                  }}
                >
                  <Plus size={11} />
                  Add new business
                </button>
              ) : (
                <div style={{ padding: '8px 12px' }} onClick={e => e.stopPropagation()}>
                  <input
                    value={newName}
                    onChange={e => setNewName(e.target.value)}
                    onKeyDown={e => e.key === 'Enter' && handleCreate()}
                    className="bp-input"
                    style={{ fontSize: 11, padding: '5px 8px', marginBottom: 6 }}
                    placeholder="Business name..."
                    autoFocus
                  />
                  <div style={{ display: 'flex', gap: 4 }}>
                    <button
                      onClick={handleCreate}
                      disabled={creating || !newName.trim()}
                      className="bp-btn bp-btn-primary"
                      style={{ flex: 1, justifyContent: 'center', fontSize: 10, padding: '4px 8px' }}
                    >
                      {creating ? '…' : 'Create'}
                    </button>
                    <button
                      onClick={() => { setAddingNew(false); setNewName('') }}
                      className="bp-btn bp-btn-ghost"
                      style={{ fontSize: 10, padding: '4px 8px' }}
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  )
}

// ============================================
// Projects Section (sidebar)
// ============================================
interface Project {
  id: string
  name: string
  status: string
  color: string
  icon: string
  task_count: number
  [key: string]: unknown
}

function ProjectsSection({ collapsed }: { collapsed: boolean }) {
  const currentBusiness = useStore((s) => s.currentBusiness)
  const [projects, setProjects] = useState<Project[]>([])

  useEffect(() => {
    if (!currentBusiness) return
    getProjects(currentBusiness.id)
      .then((list: Project[]) => setProjects((list ?? []).filter((p: Project) => p.status === 'active').slice(0, 5)))
      .catch(() => {})
  }, [currentBusiness])

  if (projects.length === 0 || collapsed) return null

  return (
    <div style={{ borderTop: '1px solid var(--bp-border)', flexShrink: 0 }}>
      <div style={{
        padding: '8px 16px 4px',
        fontFamily: 'var(--bp-font-mono)', fontSize: 9,
        color: 'var(--bp-text-3)', letterSpacing: '0.1em', textTransform: 'uppercase',
      }}>Projects</div>
      <div style={{ padding: '4px 8px', display: 'flex', flexDirection: 'column', gap: 1 }}>
        {projects.map((p) => (
          <NavLink
            key={p.id}
            to={`/projects/${p.id}`}
            style={({ isActive }) => ({
              display: 'flex', alignItems: 'center', gap: 8,
              padding: '6px 8px',
              borderRadius: 4,
              borderLeft: isActive ? `2px solid ${p.color}` : '2px solid transparent',
              paddingLeft: isActive ? 6 : 8,
              background: isActive ? `${p.color}10` : 'transparent',
              color: isActive ? p.color : 'var(--bp-text-3)',
              textDecoration: 'none',
              fontFamily: 'var(--bp-font-mono)', fontSize: 11,
            })}>
            <span style={{ fontSize: 12 }}>{p.icon}</span>
            <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {p.name}
            </span>
            {p.task_count > 0 && (
              <span style={{ fontSize: 9, color: 'var(--bp-text-3)' }}>{p.task_count}</span>
            )}
          </NavLink>
        ))}
        <NavLink to="/projects" style={{
          padding: '4px 8px', fontFamily: 'var(--bp-font-mono)', fontSize: 10,
          color: 'var(--bp-blue)', textDecoration: 'none',
        }}>All projects →</NavLink>
      </div>
    </div>
  )
}

// ============================================
// Connected Data Section
// ============================================
interface ConnectorItem {
  id: string
  type: string
  name: string
  status: string
  [key: string]: unknown
}

function ConnectedDataSection({ collapsed }: { collapsed: boolean }) {
  const currentBusiness = useStore((s) => s.currentBusiness)
  const [connectors, setConnectors] = useState<ConnectorItem[]>([])

  useEffect(() => {
    if (!currentBusiness) return
    getConnectors(currentBusiness.id)
      .then((data: any) => {
        const list = Array.isArray(data) ? data : []
        setConnectors(list.filter((c: ConnectorItem) => c.status === 'connected' || c.status === 'syncing'))
      })
      .catch(() => {})
  }, [currentBusiness])

  if (connectors.length === 0) return null

  const dotClass = (c: ConnectorItem) => {
    if (c.status === 'connected') return 'pulse-dot-green'
    if (c.status === 'error') return 'pulse-dot-red'
    if (c.status === 'syncing') return 'pulse-dot-blue'
    return 'pulse-dot-amber'
  }

  return (
    <div style={{ borderTop: '1px solid var(--bp-border)', flexShrink: 0 }}>
      {!collapsed && (
        <div style={{
          padding: '8px 16px 4px',
          fontFamily: 'var(--bp-font-mono)', fontSize: 9,
          color: 'var(--bp-text-3)', letterSpacing: '0.1em', textTransform: 'uppercase',
        }}>
          Connected Data
        </div>
      )}
      <div style={{
        padding: collapsed ? '4px' : '4px 8px',
        display: 'flex', flexDirection: 'column', gap: 1,
        maxHeight: 200, overflowY: 'auto',
      }}>
        {connectors.map((c) => {
          const Icon = CONNECTOR_ICONS[c.type] || CONNECTOR_ICONS.default
          const label = CONNECTOR_LABELS[c.type] || c.name
          return (
            <NavLink
              key={c.id}
              to={`/connectors/${c.id}/data`}
              style={({ isActive }) => ({
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: collapsed ? '7px 0' : '6px 8px',
                borderRadius: 4,
                borderLeft: isActive ? '2px solid var(--bp-blue)' : '2px solid transparent',
                paddingLeft: collapsed ? 0 : isActive ? 6 : 8,
                background: isActive ? 'rgba(59,130,246,0.06)' : 'transparent',
                color: isActive ? 'var(--bp-blue)' : 'var(--bp-text-3)',
                textDecoration: 'none',
                justifyContent: collapsed ? 'center' : 'flex-start',
                transition: 'all 120ms ease',
              })}
            >
              {({ isActive }) => (
                <>
                  <Icon size={13} style={{ flexShrink: 0, color: isActive ? 'var(--bp-blue)' : 'var(--bp-text-3)' }} />
                  {!collapsed && (
                    <>
                      <span style={{ flex: 1, fontFamily: 'var(--bp-font-mono)', fontSize: 11, color: isActive ? 'var(--bp-blue)' : 'var(--bp-text-2)' }}>
                        {label}
                      </span>
                      <span className={`pulse-dot ${dotClass(c)}`} style={{ width: 5, height: 5 }} />
                    </>
                  )}
                </>
              )}
            </NavLink>
          )
        })}
      </div>
    </div>
  )
}

// ============================================
// Sidebar
// ============================================
function Sidebar() {
  const collapsed      = useStore((s) => s.sidebarCollapsed)
  const toggleSidebar  = useStore((s) => s.toggleSidebar)
  const user           = useStore((s) => s.user)
  const setUser        = useStore((s) => s.setUser)
  const navigate       = useNavigate()

  const [healthStatus, setHealthStatus] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    async function poll() {
      try {
        const result = await getSystemHealth()
        if (!cancelled && result?.overall) setHealthStatus(result.overall)
      } catch {}
    }
    poll()
    const interval = setInterval(poll, 60000)
    return () => { cancelled = true; clearInterval(interval) }
  }, [])

  async function handleLogout() {
    try { await logout() } catch { /* ignore */ }
    setUser(null)
    navigate('/login')
  }

  const width = collapsed ? 56 : 220

  return (
    <div
      style={{
        position: 'fixed',
        top: 0, left: 0,
        height: '100vh',
        width,
        display: 'flex',
        flexDirection: 'column',
        background: 'var(--bp-surface)',
        borderRight: '1px solid var(--bp-border)',
        transition: 'width 200ms ease',
        zIndex: 30,
        overflow: 'hidden',
      }}
    >
      {/* ── Logo / Wordmark ─────────────────────────── */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: collapsed ? 'center' : 'space-between',
        padding: collapsed ? '12px 0' : '12px 12px',
        borderBottom: '1px solid var(--bp-border)',
        flexShrink: 0,
      }}>
        {!collapsed && (
          <div>
            <div style={{
              fontFamily: 'var(--bp-font-display)',
              fontWeight: 700,
              fontSize: 17,
              color: 'var(--bp-text)',
              letterSpacing: '0.02em',
              lineHeight: 1,
            }}>
              Blueprint
            </div>
            <div style={{
              fontFamily: 'var(--bp-font-mono)',
              fontSize: 9,
              letterSpacing: '0.1em',
              color: 'var(--bp-text-3)',
              marginTop: 2,
            }}>
              [PERSONAL OS]
            </div>
          </div>
        )}
        {collapsed && (
          <div style={{
            width: 28, height: 28,
            background: 'rgba(59,130,246,0.15)',
            borderRadius: 4,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            border: '1px solid rgba(59,130,246,0.25)',
          }}>
            <span style={{ fontFamily: 'var(--bp-font-display)', fontWeight: 700, fontSize: 10, color: 'var(--bp-blue)' }}>BP</span>
          </div>
        )}

        {/* Blue separator line */}
        {!collapsed && (
          <button
            onClick={toggleSidebar}
            style={{
              background: 'none', border: 'none', cursor: 'pointer',
              color: 'var(--bp-text-3)', padding: 2,
            }}
          >
            <ChevronLeft size={15} />
          </button>
        )}
      </div>

      {!collapsed && (
        <div style={{ height: 1, background: 'rgba(59,130,246,0.25)', flexShrink: 0 }} />
      )}

      {/* ── Business Switcher ───────────────────────── */}
      <BusinessSwitcher collapsed={collapsed} />

      {/* ── Expand when collapsed ───────────────────── */}
      {collapsed && (
        <button
          onClick={toggleSidebar}
          style={{
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            padding: '8px 0',
            background: 'none', border: 'none', cursor: 'pointer',
            color: 'var(--bp-text-3)',
          }}
        >
          <ChevronRight size={14} />
        </button>
      )}

      {/* ── Nav Items ──────────────────────────────── */}
      <nav style={{
        flex: 1,
        padding: collapsed ? '8px 4px' : '8px 8px',
        display: 'flex',
        flexDirection: 'column',
        gap: 2,
        overflowY: 'auto',
      }}>
        {NAV_ITEMS.map((item) => (
          <NavItem key={item.to} item={item} collapsed={collapsed} healthStatus={healthStatus} />
        ))}
      </nav>

      {/* ── Projects ──────────────────────────── */}
      <ProjectsSection collapsed={collapsed} />

      {/* ── Connected Data ──────────────────────────── */}
      <ConnectedDataSection collapsed={collapsed} />

      {/* ── Bottom: User + Logout ─────────────────── */}
      <div style={{
        borderTop: '1px solid var(--bp-border)',
        padding: collapsed ? '8px 4px' : '8px 8px',
        flexShrink: 0,
      }}>
        {user && !collapsed && (
          <div style={{
            display: 'flex', alignItems: 'center', gap: 8,
            padding: '6px 8px', marginBottom: 4,
          }}>
            <div style={{
              width: 24, height: 24,
              borderRadius: '50%',
              background: 'rgba(59,130,246,0.15)',
              border: '1px solid rgba(59,130,246,0.25)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              flexShrink: 0,
            }}>
              <span style={{ fontFamily: 'var(--bp-font-display)', fontWeight: 700, fontSize: 10, color: 'var(--bp-blue)' }}>
                {((user as any).username || (user as any).name || 'U')[0].toUpperCase()}
              </span>
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 11, fontWeight: 500, color: 'var(--bp-text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {(user as any).username || (user as any).name}
              </div>
              <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 9, color: 'var(--bp-text-3)' }}>
                {(user as any).role || 'admin'}
              </div>
            </div>
          </div>
        )}

        {/* Docs link */}
        <a
          href="/docs"
          target="_blank"
          rel="noreferrer"
          className="group"
          style={{
            width: '100%',
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            padding: '7px 10px',
            borderRadius: 5,
            textDecoration: 'none',
            fontFamily: 'var(--bp-font-mono)',
            fontSize: 12,
            color: 'var(--bp-text-3)',
            justifyContent: collapsed ? 'center' : 'flex-start',
            transition: 'all 150ms ease',
            marginBottom: 2,
          }}
          onMouseEnter={e => { e.currentTarget.style.color = 'var(--bp-text)'; e.currentTarget.style.background = 'rgba(255,255,255,0.04)' }}
          onMouseLeave={e => { e.currentTarget.style.color = 'var(--bp-text-3)'; e.currentTarget.style.background = 'transparent' }}
          title="Documentation"
        >
          <BookOpen size={14} style={{ flexShrink: 0 }} />
          {!collapsed && (
            <>
              <span style={{ flex: 1 }}>Docs</span>
              <ExternalLink size={10} style={{ opacity: 0.5 }} />
            </>
          )}
        </a>

        <button
          onClick={handleLogout}
          className="group"
          style={{
            width: '100%',
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            padding: '7px 10px',
            borderRadius: 5,
            background: 'transparent',
            border: 'none',
            cursor: 'pointer',
            fontFamily: 'var(--bp-font-mono)',
            fontSize: 12,
            color: 'var(--bp-text-3)',
            justifyContent: collapsed ? 'center' : 'flex-start',
            transition: 'all 150ms ease',
          }}
          onMouseEnter={e => { e.currentTarget.style.color = 'var(--bp-red)'; e.currentTarget.style.background = 'rgba(239,68,68,0.08)' }}
          onMouseLeave={e => { e.currentTarget.style.color = 'var(--bp-text-3)'; e.currentTarget.style.background = 'transparent' }}
        >
          <LogOut size={14} style={{ flexShrink: 0 }} />
          {!collapsed && <span>Logout</span>}
        </button>

        {!collapsed && (
          <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 9, color: 'var(--bp-text-3)', padding: '4px 8px' }}>
            v0.1.0
          </div>
        )}
      </div>
    </div>
  )
}

export default Sidebar
