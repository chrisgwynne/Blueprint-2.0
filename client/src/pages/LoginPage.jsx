import React, { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Eye, EyeOff, LogIn, AlertCircle } from 'lucide-react'
import { login, getBusinesses } from '../lib/api.js'
import useStore from '../lib/store.js'

function LoginPage() {
  const navigate = useNavigate()
  const setUser = useStore((s) => s.setUser)
  const setBusinesses = useStore((s) => s.setBusinesses)
  const setCurrentBusiness = useStore((s) => s.setCurrentBusiness)

  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  async function handleSubmit(e) {
    e.preventDefault()
    if (!username.trim() || !password) return

    setLoading(true)
    setError('')

    try {
      const user = await login(username.trim(), password)
      setUser(user)

      // Load businesses
      try {
        const businesses = await getBusinesses()
        setBusinesses(businesses || [])
        if (businesses && businesses.length > 0) {
          setCurrentBusiness(businesses[0])
        }
      } catch {
        // Non-fatal
      }

      navigate('/', { replace: true })
    } catch (err) {
      setError(err.message === 'Unauthorized' ? 'Invalid username or password' : err.message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-blueprint-bg dot-grid">
      <div className="w-full max-w-sm px-4">
        {/* Logo */}
        <div className="flex flex-col items-center mb-8">
          <div className="w-12 h-12 bg-blueprint-blue rounded-lg flex items-center justify-center mb-4 shadow-lg shadow-blueprint-blue/20">
            <span className="text-white font-bold text-lg mono">BP</span>
          </div>
          <h1 className="text-xl font-bold text-slate-100 tracking-tight">Blueprint</h1>
          <p className="text-sm text-blueprint-muted mt-1">Business Operating System</p>
        </div>

        {/* Card */}
        <div className="bp-card p-6 shadow-2xl border-blueprint-border">
          <h2 className="text-sm font-semibold text-slate-200 mb-5">Sign in to continue</h2>

          <form onSubmit={handleSubmit} className="space-y-4">
            {/* Error message */}
            {error && (
              <div className="flex items-center gap-2 p-3 rounded bg-blueprint-red/10 border border-blueprint-red/30">
                <AlertCircle size={13} className="text-blueprint-red flex-shrink-0" />
                <p className="text-xs text-blueprint-red">{error}</p>
              </div>
            )}

            {/* Username */}
            <div>
              <label className="block text-xs font-medium text-blueprint-muted mb-1.5">
                Username
              </label>
              <input
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                className="bp-input"
                placeholder="admin"
                autoComplete="username"
                autoFocus
                required
              />
            </div>

            {/* Password */}
            <div>
              <label className="block text-xs font-medium text-blueprint-muted mb-1.5">
                Password
              </label>
              <div className="relative">
                <input
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="bp-input pr-10"
                  placeholder="••••••••"
                  autoComplete="current-password"
                  required
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-blueprint-muted hover:text-slate-200 transition-colors"
                  tabIndex={-1}
                >
                  {showPassword ? <EyeOff size={14} /> : <Eye size={14} />}
                </button>
              </div>
            </div>

            {/* Submit */}
            <button
              type="submit"
              disabled={loading || !username || !password}
              className="w-full bp-btn bp-btn-primary justify-center py-2.5 text-sm mt-2 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {loading ? (
                <>
                  <span className="pulse-dot pulse-dot-blue" style={{ width: 8, height: 8 }} />
                  Signing in...
                </>
              ) : (
                <>
                  <LogIn size={15} />
                  Sign In
                </>
              )}
            </button>
          </form>
        </div>

        {/* Footer */}
        <p className="text-center text-xs text-blueprint-muted mt-4 mono">v0.1.0</p>
      </div>
    </div>
  )
}

export default LoginPage
