import React from 'react'

/**
 * Catches unhandled render/lifecycle errors anywhere in the React tree and
 * shows a diagnostic screen instead of a silent white page. Without this,
 * a single bad render (e.g. a malformed date, a missing field, a Hooks
 * ordering bug) blanks the entire app AND persists across reloads because
 * the error happens on every mount.
 */
class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props)
    this.state = { error: null, info: null }
  }

  static getDerivedStateFromError(error) {
    return { error }
  }

  componentDidCatch(error, info) {
    // eslint-disable-next-line no-console
    console.error('[Blueprint] Unhandled render error:', error, info)
    this.setState({ info })
  }

  reset = () => {
    this.setState({ error: null, info: null })
  }

  hardReset = () => {
    try {
      localStorage.clear()
      sessionStorage.clear()
    } catch {}
    window.location.href = '/'
  }

  render() {
    if (!this.state.error) return this.props.children

    const msg = this.state.error?.message || String(this.state.error)
    const stack = this.state.error?.stack || ''
    const componentStack = this.state.info?.componentStack || ''

    return (
      <div style={{
        minHeight: '100vh',
        background: 'var(--bp-bg, #0a0e14)',
        color: 'var(--bp-text, #cdd6f4)',
        fontFamily: 'var(--bp-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)',
        padding: 32,
      }}>
        <div style={{ maxWidth: 820, margin: '0 auto' }}>
          <h1 style={{
            fontFamily: 'Syne, sans-serif',
            fontSize: 22,
            marginBottom: 8,
            color: 'var(--bp-red, #ff5252)',
          }}>
            Something broke while rendering.
          </h1>
          <p style={{ fontSize: 13, color: 'var(--bp-text-2, #a0a8b5)', marginBottom: 24 }}>
            Blueprint caught an unhandled error. The details below are also
            printed to the browser console.
          </p>

          <div style={{
            background: 'rgba(255,82,82,0.08)',
            border: '1px solid rgba(255,82,82,0.25)',
            borderRadius: 6,
            padding: 14,
            marginBottom: 16,
            fontSize: 12,
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
          }}>
            {msg}
          </div>

          {stack && (
            <details style={{ marginBottom: 16 }}>
              <summary style={{ fontSize: 12, cursor: 'pointer', color: 'var(--bp-text-3, #6b7280)' }}>
                Stack trace
              </summary>
              <pre style={{
                fontSize: 11,
                marginTop: 8,
                padding: 12,
                background: 'rgba(255,255,255,0.03)',
                border: '1px solid rgba(255,255,255,0.06)',
                borderRadius: 4,
                overflow: 'auto',
                maxHeight: 300,
              }}>{stack}</pre>
            </details>
          )}

          {componentStack && (
            <details style={{ marginBottom: 24 }}>
              <summary style={{ fontSize: 12, cursor: 'pointer', color: 'var(--bp-text-3, #6b7280)' }}>
                Component tree
              </summary>
              <pre style={{
                fontSize: 11,
                marginTop: 8,
                padding: 12,
                background: 'rgba(255,255,255,0.03)',
                border: '1px solid rgba(255,255,255,0.06)',
                borderRadius: 4,
                overflow: 'auto',
                maxHeight: 220,
              }}>{componentStack}</pre>
            </details>
          )}

          <div style={{ display: 'flex', gap: 8 }}>
            <button
              onClick={this.reset}
              style={{
                padding: '8px 16px', fontSize: 12,
                background: 'var(--bp-blue, #4da6ff)', color: '#000',
                border: 'none', borderRadius: 4, cursor: 'pointer',
                fontFamily: 'inherit', fontWeight: 600,
              }}
            >Try again</button>
            <button
              onClick={this.hardReset}
              style={{
                padding: '8px 16px', fontSize: 12,
                background: 'transparent',
                color: 'var(--bp-text-2, #a0a8b5)',
                border: '1px solid var(--bp-border, rgba(255,255,255,0.12))',
                borderRadius: 4, cursor: 'pointer',
                fontFamily: 'inherit',
              }}
            >Clear local state & reload</button>
          </div>
        </div>
      </div>
    )
  }
}

export default ErrorBoundary
