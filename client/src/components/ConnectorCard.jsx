import React, { useState } from 'react'
import { formatDistanceToNow } from 'date-fns'
import { parseTimestamp } from '../lib/time.js'
import { RefreshCw, Settings, AlertTriangle, Database, CheckCircle, XCircle, Wifi } from 'lucide-react'
import clsx from 'clsx'
import { syncConnector, healthCheckConnector } from '../lib/api.js'
import useStore from '../lib/store.js'

const STATUS_CONFIG = {
  connected:    { label: 'LIVE',         dotClass: 'pulse-dot-green',  pill: 'bp-pill-green', borderColor: 'var(--bp-green)' },
  syncing:      { label: 'SYNCING',      dotClass: 'pulse-dot-blue',   pill: 'bp-pill-blue',  borderColor: 'var(--bp-blue)' },
  error:        { label: 'ERROR',        dotClass: 'pulse-dot-red',    pill: 'bp-pill-red',   borderColor: 'var(--bp-red)' },
  disconnected: { label: 'DISCONNECTED', dotClass: 'pulse-dot-gray',   pill: 'bp-pill-grey',  borderColor: 'rgba(255,255,255,0.1)' },
  pending:      { label: 'PENDING',      dotClass: 'pulse-dot-amber',  pill: 'bp-pill-amber', borderColor: 'var(--bp-amber)' },
}

const CONNECTOR_ICONS = {
  gsc:       '🔍',
  ga4:       '📊',
  shopify:   '🛒',
  pagespeed: '⚡',
  default:   '🔌',
}

function ConnectorCard({ connector, onSync, onConfigure }) {
  const addNotification = useStore((s) => s.addNotification)
  const [syncing,        setSyncing]       = useState(false)
  const [healthChecking, setHealthChecking] = useState(false)

  const cfg = STATUS_CONFIG[connector.status] || STATUS_CONFIG.disconnected
  const isConnected    = connector.status === 'connected'
  const isDisconnected = connector.status === 'disconnected'
  const hasError       = connector.status === 'error'

  const isStale = connector.last_sync && isConnected
    ? (Date.now() - new Date(connector.last_sync).getTime()) > 26 * 60 * 60 * 1000
    : false

  const icon = CONNECTOR_ICONS[connector.type] || CONNECTOR_ICONS.default

  async function handleSync() {
    setSyncing(true)
    try {
      await syncConnector(connector.id)
      addNotification({ type: 'success', message: `${connector.name} sync started` })
      onSync?.()
    } catch (err) {
      addNotification({ type: 'error', message: err.message })
    } finally {
      setSyncing(false)
    }
  }

  async function handleHealthCheck() {
    setHealthChecking(true)
    try {
      const result = await healthCheckConnector(connector.id)
      addNotification({
        type: result.ok ? 'success' : 'error',
        message: result.ok ? `${connector.name} is healthy` : `Health check failed: ${result.error}`,
      })
    } catch (err) {
      addNotification({ type: 'error', message: err.message })
    } finally {
      setHealthChecking(false)
    }
  }

  const lastSyncText = connector.last_sync
    ? formatDistanceToNow(parseTimestamp(connector.last_sync) || new Date(), { addSuffix: true })
    : 'Never'

  return (
    <div
      className="bp-card"
      style={{
        padding: 0,
        overflow: 'hidden',
        borderTop: `3px solid ${hasError ? 'var(--bp-red)' : isDisconnected ? 'rgba(255,255,255,0.06)' : isStale ? 'var(--bp-amber)' : 'var(--bp-blue)'}`,
        ...(isDisconnected && { borderStyle: 'dashed' }),
      }}
    >
      {/* Top section */}
      <div style={{ padding: '16px 18px', display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontSize: 26, lineHeight: 1 }}>{icon}</span>
          <div>
            <div style={{ fontFamily: 'var(--bp-font-display)', fontWeight: 600, fontSize: 14, color: isDisconnected ? 'var(--bp-text-3)' : 'var(--bp-text)', marginBottom: 2 }}>
              {connector.name}
            </div>
            <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 9, letterSpacing: '0.06em', color: 'var(--bp-text-3)', textTransform: 'uppercase' }}>
              {connector.type}
            </div>
          </div>
        </div>

        {/* Status */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
          <span className={clsx('pulse-dot', cfg.dotClass)} />
          <span className={clsx('bp-pill', cfg.pill)} style={{ padding: '1px 6px', fontSize: 9 }}>
            {cfg.label}
          </span>
        </div>
      </div>

      {/* Divider */}
      <div style={{ height: 1, background: 'var(--bp-border)', margin: '0 18px' }} />

      {/* Metrics */}
      <div style={{ padding: '12px 18px', display: 'flex', flexDirection: 'column', gap: 6 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
          <span style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 10, color: 'var(--bp-text-3)' }}>Last sync</span>
          <span style={{
            fontFamily: 'var(--bp-font-mono)', fontSize: 10,
            color: isStale ? 'var(--bp-amber)' : hasError ? 'var(--bp-red)' : 'var(--bp-text-2)',
          }}>
            {isStale && '⚠ '}{lastSyncText}
          </span>
        </div>

        {connector.data_points != null && (
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <span style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 10, color: 'var(--bp-text-3)', display: 'flex', alignItems: 'center', gap: 4 }}>
              <Database size={10} />Data points
            </span>
            <span style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 10, color: 'var(--bp-text-2)' }}>
              {(connector.data_points || 0).toLocaleString()}
            </span>
          </div>
        )}

        {connector.signals_enabled != null && (
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <span style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 10, color: 'var(--bp-text-3)' }}>Signals enabled</span>
            <span style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 10, color: 'var(--bp-text-2)' }}>{connector.signals_enabled}</span>
          </div>
        )}

        {/* Quick metrics from last sync */}
        {connector.type === 'ga4' && connector.last_data && (
          <>
            <div style={{ height: 1, background: 'var(--bp-border)', margin: '4px 0' }} />
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 10, color: 'var(--bp-text-3)' }}>Sessions (7d)</span>
              <span style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 10, color: 'var(--bp-text)' }}>
                {(connector.last_data.sessions || 0).toLocaleString()}
              </span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 10, color: 'var(--bp-text-3)' }}>Bounce rate</span>
              <span style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 10, color: 'var(--bp-text)' }}>
                {((connector.last_data.bounceRate || 0) * 100).toFixed(0)}%
              </span>
            </div>
          </>
        )}

        {connector.type === 'gsc' && connector.last_data && (
          <>
            <div style={{ height: 1, background: 'var(--bp-border)', margin: '4px 0' }} />
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 10, color: 'var(--bp-text-3)' }}>Clicks (7d)</span>
              <span style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 10, color: 'var(--bp-text)' }}>
                {(connector.last_data.clicks || 0).toLocaleString()}
              </span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 10, color: 'var(--bp-text-3)' }}>Avg position</span>
              <span style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 10, color: 'var(--bp-text)' }}>
                {(connector.last_data.position || 0).toFixed(1)}
              </span>
            </div>
          </>
        )}

        {/* Error message */}
        {connector.last_error && (
          <div style={{ display: 'flex', gap: 6, padding: 8, background: 'rgba(239,68,68,0.08)', borderRadius: 4, border: '1px solid rgba(239,68,68,0.15)', marginTop: 4 }}>
            <AlertTriangle size={11} style={{ color: 'var(--bp-red)', flexShrink: 0, marginTop: 1 }} />
            <span style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 10, color: 'var(--bp-red)', lineHeight: 1.4 }}>
              {connector.last_error.substring(0, 120)}
            </span>
          </div>
        )}
      </div>

      {/* Actions */}
      <div style={{ padding: '12px 18px', borderTop: '1px solid var(--bp-border)', display: 'flex', gap: 8 }}>
        {isDisconnected ? (
          <button
            onClick={() => onConfigure?.(connector)}
            className="bp-btn bp-btn-primary"
            style={{ flex: 1, justifyContent: 'center', fontSize: 11 }}
          >
            <Wifi size={12} /> Connect
          </button>
        ) : (
          <>
            <button
              onClick={handleSync}
              disabled={syncing || connector.status === 'syncing'}
              className="bp-btn bp-btn-secondary"
              style={{ flex: 1, justifyContent: 'center', fontSize: 11 }}
            >
              <RefreshCw size={12} style={{ animation: syncing ? 'bp-spin-slow 1s linear infinite' : 'none' }} />
              {syncing ? 'Syncing…' : 'Sync'}
            </button>
            <button
              onClick={() => onConfigure?.(connector)}
              className="bp-btn bp-btn-ghost"
              style={{ fontSize: 11 }}
              title="Configure"
            >
              <Settings size={12} />
            </button>
            <button
              onClick={handleHealthCheck}
              disabled={healthChecking}
              className="bp-btn bp-btn-ghost"
              style={{ fontSize: 11 }}
              title="Health check"
            >
              {healthChecking ? <RefreshCw size={12} /> : <CheckCircle size={12} />}
            </button>
          </>
        )}
      </div>
    </div>
  )
}

export default ConnectorCard
