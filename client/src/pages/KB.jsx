/**
 * Knowledge Base — Karpathy LLM Wiki pattern.
 *
 * Three-panel layout:
 *   LEFT  — file tree, search, agent operations
 *   MAIN  — Tiptap editor with markdown / wikilink support
 *   RIGHT — backlinks, git history, lint results
 */
import React, { useEffect, useState, useCallback, useRef, useMemo } from 'react'
import {
  Search, Plus, FileText, Folder, FolderOpen, Save, Upload, Trash2,
  GitBranch, X, RefreshCw, Sparkles, MessageCircle, AlertTriangle,
  ChevronRight, ChevronDown, History, Link2, BookOpen, Activity,
  Brain, Clock, Check, ExternalLink,
} from 'lucide-react'
import { formatDistanceToNow } from 'date-fns'
import { parseTimestamp } from '../lib/time.js'
import clsx from 'clsx'
import useStore from '../lib/store.js'
import Editor from '../components/Editor.jsx'
import {
  getKbTree, getKbFile, saveKbFile, archiveKbFile, getKbBacklinks,
  getKbHistory, restoreKbVersion, searchKb, uploadKbRaw,
  ingestKb, queryKb, lintKb, getKbLog, getKbSettings,
} from '../lib/api.js'

// ─── Helpers ────────────────────────────────────────────────────────────────

const SPECIAL_FILE_ICONS = {
  'WIKI.md':  { icon: BookOpen, color: 'var(--bp-purple)', label: 'schema' },
  'index.md': { icon: FileText, color: 'var(--bp-blue)',   label: 'index' },
  'log.md':   { icon: Clock,    color: 'var(--bp-text-3)', label: 'log' },
  'hot.md':   { icon: Activity, color: 'var(--bp-amber)',  label: 'hot' },
}

function fmt(dt) {
  if (!dt) return '—'
  try { return formatDistanceToNow(parseTimestamp(dt) || new Date(), { addSuffix: true }) }
  catch { return '—' }
}

function flattenTree(nodes, depth = 0, out = []) {
  for (const n of nodes) {
    out.push({ ...n, depth })
    if (n.type === 'dir' && n.children) flattenTree(n.children, depth + 1, out)
  }
  return out
}

// ─── File Tree ──────────────────────────────────────────────────────────────

function TreeNode({ node, depth, expanded, onToggle, onSelect, selectedPath, contradictionsCount }) {
  const isSpecial = SPECIAL_FILE_ICONS[node.path]
  const isContradictionsDir = node.type === 'dir' && node.name === 'contradictions'

  if (node.type === 'dir') {
    const isOpen = expanded.has(node.name + '-' + depth)
    const Icon = isOpen ? FolderOpen : Folder
    return (
      <>
        <div
          onClick={() => onToggle(node.name + '-' + depth)}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 4,
            padding: `3px 6px 3px ${6 + depth * 12}px`,
            cursor: 'pointer',
            fontSize: 11,
            fontFamily: 'var(--bp-font-mono)',
            color: isContradictionsDir && contradictionsCount > 0
              ? 'var(--bp-red)'
              : 'var(--bp-text-2)',
            userSelect: 'none',
          }}
          className="hover:bg-blueprint-border/30"
        >
          {isOpen ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
          <Icon size={11} />
          <span>{node.name}</span>
          {isContradictionsDir && contradictionsCount > 0 && (
            <span style={{
              marginLeft: 'auto',
              fontSize: 9,
              padding: '0 5px',
              borderRadius: 6,
              background: 'rgba(255,82,82,0.15)',
              color: 'var(--bp-red)',
              border: '1px solid rgba(255,82,82,0.3)',
            }}>
              {contradictionsCount}
            </span>
          )}
        </div>
        {isOpen && (node.children ?? []).map((child) => (
          <TreeNode
            key={child.path ?? child.name}
            node={child}
            depth={depth + 1}
            expanded={expanded}
            onToggle={onToggle}
            onSelect={onSelect}
            selectedPath={selectedPath}
            contradictionsCount={contradictionsCount}
          />
        ))}
      </>
    )
  }

  const FileIcon = isSpecial?.icon ?? FileText
  const iconColor = isSpecial?.color ?? 'var(--bp-text-3)'
  const isSelected = selectedPath === node.path

  return (
    <div
      onClick={() => onSelect(node.path)}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        padding: `3px 6px 3px ${6 + depth * 12}px`,
        cursor: 'pointer',
        fontSize: 11,
        fontFamily: 'var(--bp-font-mono)',
        color: isSelected ? 'var(--bp-text)' : 'var(--bp-text-2)',
        background: isSelected ? 'rgba(77,166,255,0.1)' : 'transparent',
        borderLeft: isSelected ? '2px solid var(--bp-blue)' : '2px solid transparent',
      }}
      className="hover:bg-blueprint-border/30"
    >
      <FileIcon size={11} style={{ color: iconColor, flexShrink: 0 }} />
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {node.name}
      </span>
      {isSpecial && (
        <span style={{ marginLeft: 'auto', fontSize: 8, color: 'var(--bp-text-3)', textTransform: 'uppercase' }}>
          {isSpecial.label}
        </span>
      )}
    </div>
  )
}

// ─── Modals ─────────────────────────────────────────────────────────────────

function IngestModal({ businessId, onClose, onComplete }) {
  const addNotification = useStore((s) => s.addNotification)
  const [rawPath, setRawPath] = useState('')
  const [title, setTitle] = useState('')
  const [type, setType] = useState('article')
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState(null)

  async function handleIngest() {
    if (!rawPath || !title) return
    setRunning(true)
    setResult(null)
    try {
      const r = await ingestKb(businessId, { rawPath, sourceTitle: title, sourceType: type })
      setResult(r)
      addNotification({ type: 'success', message: `Ingested: ${r.pagesCreated} pages created` })
    } catch (err) {
      addNotification({ type: 'error', message: err.message })
    } finally {
      setRunning(false)
    }
  }

  return (
    <>
      <div className="drawer-overlay" onClick={onClose} />
      <div className="fixed inset-0 flex items-center justify-center z-50 pointer-events-none">
        <div className="bp-card w-full max-w-md pointer-events-auto shadow-2xl">
          <div className="flex items-center justify-between px-5 py-4 border-b border-blueprint-border">
            <h2 className="text-base font-semibold text-slate-100 flex items-center gap-2">
              <Sparkles size={14} className="text-blueprint-purple" />
              Ingest Source into Wiki
            </h2>
            <button onClick={onClose} className="text-blueprint-muted hover:text-slate-200">
              <X size={16} />
            </button>
          </div>
          <div className="p-5 space-y-3">
            <p className="text-xs text-blueprint-muted">
              The agent will read this raw source, extract entities and concepts, create new wiki pages, and update existing ones.
            </p>
            <div>
              <label className="block text-xs text-blueprint-muted mb-1">Raw file path</label>
              <input value={rawPath} onChange={(e) => setRawPath(e.target.value)}
                className="bp-input" placeholder="raw/article.md" />
            </div>
            <div>
              <label className="block text-xs text-blueprint-muted mb-1">Source title</label>
              <input value={title} onChange={(e) => setTitle(e.target.value)}
                className="bp-input" placeholder="e.g. 2026 Gift Trends Report" />
            </div>
            <div>
              <label className="block text-xs text-blueprint-muted mb-1">Source type</label>
              <select value={type} onChange={(e) => setType(e.target.value)} className="bp-select w-full">
                <option value="article">Article</option>
                <option value="report">Report</option>
                <option value="research">Research</option>
                <option value="transcript">Transcript</option>
                <option value="data">Data</option>
                <option value="other">Other</option>
              </select>
            </div>

            {result && (
              <div className="bg-blueprint-base/50 border border-blueprint-border rounded p-3 space-y-1 text-xs">
                <div className="text-blueprint-green font-medium">✅ Ingest complete</div>
                <div>{result.pagesCreated} pages created • {result.pagesUpdated} updated • {result.contradictions} contradictions</div>
                {result.summary && <div className="text-blueprint-muted mt-1">{result.summary}</div>}
              </div>
            )}

            <div className="flex gap-2 pt-2">
              <button onClick={onClose} className="bp-btn bp-btn-secondary text-xs flex-1 justify-center">
                {result ? 'Close' : 'Cancel'}
              </button>
              <button
                onClick={result ? () => { onComplete(); onClose() } : handleIngest}
                disabled={running || (!result && (!rawPath || !title))}
                className="bp-btn bp-btn-primary text-xs flex-1 justify-center"
              >
                {running ? <RefreshCw size={11} className="animate-spin" /> : <Sparkles size={11} />}
                {running ? 'Processing…' : result ? 'View wiki' : 'Process into wiki'}
              </button>
            </div>
          </div>
        </div>
      </div>
    </>
  )
}

function QueryModal({ businessId, onClose, onAnswerFiled }) {
  const addNotification = useStore((s) => s.addNotification)
  const [question, setQuestion] = useState('')
  const [fileResult, setFileResult] = useState(false)
  const [running, setRunning] = useState(false)
  const [answer, setAnswer] = useState(null)

  async function handleAsk() {
    if (!question) return
    setRunning(true)
    setAnswer(null)
    try {
      const r = await queryKb(businessId, { question, fileResult })
      setAnswer(r)
      if (r.filed) {
        addNotification({ type: 'success', message: `Answer filed as ${r.filedPath}` })
        onAnswerFiled?.()
      }
    } catch (err) {
      addNotification({ type: 'error', message: err.message })
    } finally {
      setRunning(false)
    }
  }

  return (
    <>
      <div className="drawer-overlay" onClick={onClose} />
      <div className="fixed inset-0 flex items-center justify-center z-50 pointer-events-none">
        <div className="bp-card w-full max-w-2xl pointer-events-auto shadow-2xl max-h-[80vh] flex flex-col">
          <div className="flex items-center justify-between px-5 py-4 border-b border-blueprint-border">
            <h2 className="text-base font-semibold text-slate-100 flex items-center gap-2">
              <Brain size={14} className="text-blueprint-purple" />
              Ask the Wiki
            </h2>
            <button onClick={onClose} className="text-blueprint-muted hover:text-slate-200">
              <X size={16} />
            </button>
          </div>
          <div className="p-5 space-y-3 overflow-y-auto">
            <div>
              <input
                autoFocus
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && !e.shiftKey && handleAsk()}
                className="bp-input"
                placeholder="What is our brand voice?"
              />
            </div>
            <label className="flex items-center gap-2 text-xs text-blueprint-muted">
              <input type="checkbox" checked={fileResult} onChange={(e) => setFileResult(e.target.checked)} />
              File this answer as a wiki page
            </label>

            {answer && (
              <div className="space-y-3">
                <div className="bg-blueprint-base/50 border border-blueprint-border rounded p-3">
                  <div className="text-[10px] text-blueprint-muted uppercase tracking-wider mb-2">
                    Sources read ({answer.sourcesRead?.length ?? 0})
                  </div>
                  <div className="flex flex-wrap gap-1">
                    {(answer.sourcesRead ?? []).map((s) => (
                      <span key={s} className="bp-pill bp-pill-blue text-[10px]">{s}</span>
                    ))}
                  </div>
                </div>
                <div className="bg-blueprint-base/50 border border-blueprint-border rounded p-3 text-xs whitespace-pre-wrap">
                  {answer.answer}
                </div>
                {answer.filed && (
                  <div className="text-xs text-blueprint-green flex items-center gap-1">
                    <Check size={11} /> Filed as {answer.filedPath}
                  </div>
                )}
              </div>
            )}

            <div className="flex gap-2 pt-2">
              <button onClick={onClose} className="bp-btn bp-btn-secondary text-xs flex-1 justify-center">
                Close
              </button>
              <button
                onClick={handleAsk}
                disabled={running || !question}
                className="bp-btn bp-btn-primary text-xs flex-1 justify-center"
              >
                {running ? <RefreshCw size={11} className="animate-spin" /> : <Brain size={11} />}
                {running ? 'Thinking…' : 'Ask'}
              </button>
            </div>
          </div>
        </div>
      </div>
    </>
  )
}

function LintModal({ businessId, onClose }) {
  const [running, setRunning] = useState(true)
  const [result, setResult] = useState(null)

  useEffect(() => {
    lintKb(businessId)
      .then(setResult)
      .catch((err) => setResult({ error: err.message }))
      .finally(() => setRunning(false))
  }, [businessId])

  return (
    <>
      <div className="drawer-overlay" onClick={onClose} />
      <div className="fixed inset-0 flex items-center justify-center z-50 pointer-events-none">
        <div className="bp-card w-full max-w-2xl pointer-events-auto shadow-2xl max-h-[80vh] flex flex-col">
          <div className="flex items-center justify-between px-5 py-4 border-b border-blueprint-border">
            <h2 className="text-base font-semibold text-slate-100 flex items-center gap-2">
              <AlertTriangle size={14} className="text-blueprint-amber" />
              Wiki Lint Results
            </h2>
            <button onClick={onClose} className="text-blueprint-muted hover:text-slate-200">
              <X size={16} />
            </button>
          </div>
          <div className="p-5 overflow-y-auto space-y-4">
            {running && (
              <div className="text-center text-blueprint-muted py-10">
                <RefreshCw className="animate-spin mx-auto mb-2" size={20} />
                Running lint…
              </div>
            )}
            {result?.error && (
              <div className="text-red-400 text-xs">{result.error}</div>
            )}
            {result?.issues && (
              <>
                <div className="grid grid-cols-2 gap-3">
                  <Stat label="Total pages" value={result.issues.total_pages} color="var(--bp-blue)" />
                  <Stat label="Health score" value={result.suggestions?.health_score ?? '—'} color="var(--bp-green)" />
                  <Stat label="Orphans" value={result.issues.orphans.length} color="var(--bp-amber)" />
                  <Stat label="Dead links" value={result.issues.dead_links.length} color="var(--bp-amber)" />
                  <Stat label="Missing frontmatter" value={result.issues.missing_frontmatter.length} color="var(--bp-text-3)" />
                  <Stat label="Contradictions" value={result.issues.contradictions.length} color="var(--bp-red)" />
                </div>

                {result.suggestions?.priority_fixes?.length > 0 && (
                  <Section title="Priority fixes">
                    <ul className="space-y-1 text-xs text-slate-300">
                      {result.suggestions.priority_fixes.map((f, i) => <li key={i}>• {f}</li>)}
                    </ul>
                  </Section>
                )}

                {result.suggestions?.missing_topics?.length > 0 && (
                  <Section title="Missing topics">
                    <ul className="space-y-1 text-xs text-slate-300">
                      {result.suggestions.missing_topics.map((t, i) => <li key={i}>• {t}</li>)}
                    </ul>
                  </Section>
                )}

                {result.suggestions?.research_directions?.length > 0 && (
                  <Section title="Research directions">
                    <ul className="space-y-1 text-xs text-slate-300">
                      {result.suggestions.research_directions.map((d, i) => <li key={i}>• {d}</li>)}
                    </ul>
                  </Section>
                )}

                {result.issues.orphans.length > 0 && (
                  <Section title={`Orphan pages (${result.issues.orphans.length})`}>
                    <div className="space-y-1 text-xs text-blueprint-muted">
                      {result.issues.orphans.slice(0, 10).map((p) => <div key={p}>{p}</div>)}
                    </div>
                  </Section>
                )}

                {result.issues.dead_links.length > 0 && (
                  <Section title={`Dead wikilinks (${result.issues.dead_links.length})`}>
                    <div className="space-y-1 text-xs text-blueprint-muted">
                      {result.issues.dead_links.slice(0, 10).map((d, i) => (
                        <div key={i}>{d.file} → <span className="text-blueprint-amber">[[{d.link}]]</span></div>
                      ))}
                    </div>
                  </Section>
                )}
              </>
            )}
          </div>
        </div>
      </div>
    </>
  )
}

function Stat({ label, value, color }) {
  return (
    <div className="bp-card p-3 text-center">
      <div style={{ fontFamily: 'var(--bp-font-display)', fontWeight: 800, fontSize: 22, color, lineHeight: 1 }}>{value}</div>
      <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 9, color: 'var(--bp-text-3)', marginTop: 4, textTransform: 'uppercase', letterSpacing: '0.08em' }}>{label}</div>
    </div>
  )
}

function Section({ title, children }) {
  return (
    <div>
      <div className="text-[10px] text-blueprint-muted uppercase tracking-wider mb-1">{title}</div>
      {children}
    </div>
  )
}

// ─── Main KB page ───────────────────────────────────────────────────────────

function KB() {
  const currentBusiness = useStore((s) => s.currentBusiness)
  const addNotification = useStore((s) => s.addNotification)

  const businessId = currentBusiness?.id

  const [tree, setTree] = useState([])
  const [stats, setStats] = useState({ total_pages: 0, by_category: {} })
  const [settings, setSettings] = useState(null)
  const [loading, setLoading] = useState(true)
  const [expanded, setExpanded] = useState(() => new Set(['wiki-0', 'entities-0', 'concepts-0', 'sources-0', 'signals-0']))
  const [selectedPath, setSelectedPath] = useState(null)
  const [selectedDoc, setSelectedDoc] = useState(null)
  const [editorContent, setEditorContent] = useState('')
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)

  const [backlinks, setBacklinks] = useState([])
  const [history, setHistory] = useState([])
  const [rightTab, setRightTab] = useState('backlinks')

  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState([])
  const [showSearch, setShowSearch] = useState(false)

  const [showIngest, setShowIngest] = useState(false)
  const [showQuery, setShowQuery] = useState(false)
  const [showLint, setShowLint] = useState(false)

  // ── Load tree ──────────────────────────────────────────────────────────────
  const loadTree = useCallback(async () => {
    if (!businessId) return
    setLoading(true)
    try {
      const [treeData, settingsData] = await Promise.all([
        getKbTree(businessId),
        getKbSettings(businessId).catch(() => null),
      ])
      setTree(treeData.tree ?? [])
      setStats(treeData.stats ?? { total_pages: 0, by_category: {} })
      setSettings(settingsData)
    } catch (err) {
      console.error('Failed to load KB tree:', err)
      addNotification({ type: 'error', message: 'Failed to load KB' })
    } finally {
      setLoading(false)
    }
  }, [businessId, addNotification])

  useEffect(() => { loadTree() }, [loadTree])

  // ── Cmd+K search ───────────────────────────────────────────────────────────
  useEffect(() => {
    function handleKey(e) {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault()
        setShowSearch((s) => !s)
      }
      if (e.key === 'Escape') {
        setShowSearch(false)
      }
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [])

  useEffect(() => {
    if (!searchQuery || !businessId) {
      setSearchResults([])
      return
    }
    const t = setTimeout(() => {
      searchKb(businessId, searchQuery)
        .then((r) => setSearchResults(r.results ?? []))
        .catch(() => setSearchResults([]))
    }, 250)
    return () => clearTimeout(t)
  }, [searchQuery, businessId])

  // ── Select & load file ─────────────────────────────────────────────────────
  async function selectFile(path) {
    if (dirty && selectedPath && selectedPath !== path) {
      // Quick auto-save before switching
      await handleSave()
    }
    setSelectedPath(path)
    try {
      const file = await getKbFile(businessId, path)
      setSelectedDoc(file)
      setEditorContent(file.content || file.raw || '')
      setDirty(false)

      // Load backlinks + history in parallel
      const [bl, hist] = await Promise.all([
        getKbBacklinks(businessId, path).catch(() => ({ backlinks: [] })),
        getKbHistory(businessId, path).catch(() => ({ history: [] })),
      ])
      setBacklinks(bl.backlinks ?? [])
      setHistory(hist.history ?? [])
    } catch (err) {
      addNotification({ type: 'error', message: 'Failed to load file' })
    }
  }

  async function handleSave() {
    if (!selectedPath || !dirty) return
    setSaving(true)
    try {
      await saveKbFile(businessId, selectedPath, {
        content: editorContent,
        frontmatter: selectedDoc?.frontmatter ?? null,
        message: `update: ${selectedPath}`,
      })
      setDirty(false)
      // Refresh history
      const hist = await getKbHistory(businessId, selectedPath).catch(() => ({ history: [] }))
      setHistory(hist.history ?? [])
      addNotification({ type: 'success', message: 'Saved' })
    } catch (err) {
      addNotification({ type: 'error', message: err.message })
    } finally {
      setSaving(false)
    }
  }

  async function handleArchive() {
    if (!selectedPath) return
    if (!confirm(`Archive "${selectedPath}"? It will be moved to _archived/ but kept in git history.`)) return
    try {
      await archiveKbFile(businessId, selectedPath)
      setSelectedPath(null)
      setSelectedDoc(null)
      setEditorContent('')
      addNotification({ type: 'success', message: 'Archived' })
      loadTree()
    } catch (err) {
      addNotification({ type: 'error', message: err.message })
    }
  }

  async function handleRestore(hash) {
    if (!confirm(`Restore "${selectedPath}" to commit ${hash.slice(0, 7)}?`)) return
    try {
      await restoreKbVersion(businessId, { path: selectedPath, hash })
      addNotification({ type: 'success', message: 'Restored' })
      await selectFile(selectedPath)
    } catch (err) {
      addNotification({ type: 'error', message: err.message })
    }
  }

  function toggleDir(key) {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  // Pre-expand top-level directories on first load
  useEffect(() => {
    if (tree.length > 0) {
      const topDirs = tree.filter((n) => n.type === 'dir').map((n) => n.name + '-0')
      setExpanded((prev) => new Set([...prev, ...topDirs]))
    }
  }, [tree])

  if (!businessId) {
    return (
      <div style={{ padding: 40, textAlign: 'center', color: 'var(--bp-text-3)' }}>
        Select a business to view its knowledge base.
      </div>
    )
  }

  return (
    <div className="flex h-screen overflow-hidden">
      {/* ── LEFT PANEL ────────────────────────────────────────────────────── */}
      <div className="w-[280px] border-r border-blueprint-border bg-blueprint-card flex flex-col">
        <div className="px-4 py-3 border-b border-blueprint-border">
          <div className="flex items-center justify-between mb-1">
            <h1 className="text-xs font-bold tracking-widest text-slate-100" style={{ fontFamily: 'var(--bp-font-display)' }}>
              KNOWLEDGE BASE
            </h1>
            {settings?.config?.mode && (
              <span className={clsx(
                'text-[9px] px-1.5 py-0.5 rounded uppercase tracking-wider',
                settings.config.mode === 'obsidian'
                  ? 'bg-purple-500/20 text-purple-400'
                  : 'bg-blue-500/20 text-blue-400'
              )}>
                {settings.config.mode}
              </span>
            )}
          </div>
          <p className="text-[10px] text-blueprint-muted">
            {stats.total_pages} pages • {Object.entries(stats.by_category).filter(([, n]) => n > 0).length} sections
          </p>
        </div>

        {/* Search */}
        <div className="p-3 border-b border-blueprint-border">
          <div className="relative">
            <Search size={11} className="absolute left-2 top-1/2 -translate-y-1/2 text-blueprint-muted" />
            <input
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onFocus={() => setShowSearch(true)}
              className="bp-input pl-7 text-xs w-full"
              placeholder="Search… (⌘K)"
            />
          </div>
          {showSearch && searchResults.length > 0 && (
            <div className="mt-2 bg-blueprint-base border border-blueprint-border rounded max-h-48 overflow-y-auto">
              {searchResults.slice(0, 20).map((r) => (
                <div
                  key={r.path}
                  onClick={() => { selectFile(r.path); setShowSearch(false); setSearchQuery('') }}
                  className="p-2 cursor-pointer hover:bg-blueprint-border/50 text-xs border-b border-blueprint-border/30"
                >
                  <div className="text-slate-200 font-medium">{r.path}</div>
                  {r.matches?.[0] && (
                    <div className="text-[10px] text-blueprint-muted mt-0.5 truncate">
                      L{r.matches[0].line}: {r.matches[0].text}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Tree */}
        <div className="flex-1 overflow-y-auto py-2">
          {loading ? (
            <div className="px-4 py-2 text-xs text-blueprint-muted">Loading…</div>
          ) : tree.length === 0 ? (
            <div className="px-4 py-8 text-xs text-blueprint-muted text-center">
              Empty wiki. Initialize via Settings.
            </div>
          ) : (
            tree.map((node) => (
              <TreeNode
                key={node.path ?? node.name}
                node={node}
                depth={0}
                expanded={expanded}
                onToggle={toggleDir}
                onSelect={selectFile}
                selectedPath={selectedPath}
                contradictionsCount={stats.by_category?.contradictions ?? 0}
              />
            ))
          )}
        </div>

        {/* Agent operations */}
        <div className="p-3 border-t border-blueprint-border space-y-1.5">
          <div className="text-[9px] text-blueprint-muted uppercase tracking-wider mb-1">Agent Operations</div>
          <button onClick={() => setShowIngest(true)} className="bp-btn bp-btn-secondary text-[10px] w-full justify-start">
            <Upload size={10} /> Ingest source
          </button>
          <button onClick={() => setShowQuery(true)} className="bp-btn bp-btn-secondary text-[10px] w-full justify-start">
            <Brain size={10} /> Ask the wiki
          </button>
          <button onClick={() => setShowLint(true)} className="bp-btn bp-btn-secondary text-[10px] w-full justify-start">
            <AlertTriangle size={10} /> Run lint
          </button>
        </div>
      </div>

      {/* ── MAIN PANEL ────────────────────────────────────────────────────── */}
      <div className="flex-1 flex flex-col overflow-hidden bg-blueprint-base">
        {!selectedDoc ? (
          <div className="flex-1 flex items-center justify-center text-center p-10">
            <div>
              <BookOpen size={32} className="mx-auto text-blueprint-muted mb-3" />
              <p className="text-sm text-slate-300 mb-1">Select a document</p>
              <p className="text-xs text-blueprint-muted">Or drop a source file into <code>raw/</code> and use Ingest</p>
            </div>
          </div>
        ) : (
          <>
            {/* Document toolbar */}
            <div className="border-b border-blueprint-border px-4 py-3 flex items-center gap-3">
              <div className="flex-1 min-w-0">
                <div className="text-xs font-mono text-slate-200 truncate">{selectedPath}</div>
                <div className="text-[10px] text-blueprint-muted">
                  {selectedDoc.modified && <>Modified {fmt(selectedDoc.modified)}</>}
                  {dirty && <span className="text-blueprint-amber ml-2">• unsaved</span>}
                </div>
              </div>
              <button onClick={handleSave} disabled={!dirty || saving} className="bp-btn bp-btn-primary text-xs">
                <Save size={11} />
                {saving ? 'Saving…' : 'Save'}
              </button>
              <button onClick={handleArchive} className="bp-btn bp-btn-ghost text-xs" title="Archive">
                <Trash2 size={11} />
              </button>
            </div>

            {/* Editor */}
            <div className="flex-1 overflow-y-auto p-6">
              <Editor
                content={editorContent}
                onChange={(c) => { setEditorContent(c); setDirty(true) }}
                placeholder="Start writing…"
              />
            </div>
          </>
        )}
      </div>

      {/* ── RIGHT PANEL ──────────────────────────────────────────────────── */}
      {selectedDoc && (
        <div className="w-[300px] border-l border-blueprint-border bg-blueprint-card flex flex-col">
          <div className="border-b border-blueprint-border flex">
            {[
              { id: 'backlinks', label: 'Backlinks', icon: Link2, count: backlinks.length },
              { id: 'history',   label: 'History',   icon: History, count: history.length },
            ].map((tab) => (
              <button
                key={tab.id}
                onClick={() => setRightTab(tab.id)}
                className={clsx(
                  'flex-1 px-3 py-3 text-[10px] uppercase tracking-wider flex items-center justify-center gap-1 transition-colors',
                  rightTab === tab.id
                    ? 'text-slate-100 border-b-2 border-blueprint-blue'
                    : 'text-blueprint-muted hover:text-slate-300'
                )}
              >
                <tab.icon size={10} />
                {tab.label}
                {tab.count > 0 && (
                  <span className="text-[9px] bg-blueprint-border/50 px-1 rounded">{tab.count}</span>
                )}
              </button>
            ))}
          </div>

          <div className="flex-1 overflow-y-auto p-4">
            {rightTab === 'backlinks' && (
              <div className="space-y-1">
                {backlinks.length === 0 ? (
                  <div className="text-xs text-blueprint-muted">No pages link here yet.</div>
                ) : (
                  backlinks.map((path) => (
                    <div
                      key={path}
                      onClick={() => selectFile(path)}
                      className="text-xs text-slate-300 cursor-pointer hover:text-blueprint-blue py-1 font-mono"
                    >
                      ← {path}
                    </div>
                  ))
                )}
              </div>
            )}

            {rightTab === 'history' && (
              <div className="space-y-2">
                {history.length === 0 ? (
                  <div className="text-xs text-blueprint-muted">No commit history yet.</div>
                ) : (
                  history.map((commit) => (
                    <div key={commit.oid} className="bg-blueprint-base/50 border border-blueprint-border rounded p-2 text-xs">
                      <div className="font-mono text-blueprint-muted text-[10px]">{commit.oid.slice(0, 7)}</div>
                      <div className="text-slate-200 mt-0.5">{commit.message}</div>
                      <div className="text-[10px] text-blueprint-muted mt-1">{fmt(commit.timestamp)} · {commit.author}</div>
                      <button
                        onClick={() => handleRestore(commit.oid)}
                        className="mt-1 text-[10px] text-blueprint-blue hover:underline"
                      >
                        Restore this version
                      </button>
                    </div>
                  ))
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Modals */}
      {showIngest && (
        <IngestModal businessId={businessId} onClose={() => setShowIngest(false)} onComplete={loadTree} />
      )}
      {showQuery && (
        <QueryModal businessId={businessId} onClose={() => setShowQuery(false)} onAnswerFiled={loadTree} />
      )}
      {showLint && (
        <LintModal businessId={businessId} onClose={() => setShowLint(false)} />
      )}
    </div>
  )
}

export default KB
