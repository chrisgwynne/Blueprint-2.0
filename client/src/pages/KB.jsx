import React, { useEffect, useState, useCallback, useRef } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import {
  Folder, FolderOpen, FileText, Plus, Search, X,
  ChevronRight, ChevronDown, Clock, Tag, Save, GitBranch,
} from 'lucide-react'
import clsx from 'clsx'
import Editor from '../components/Editor.jsx'
import useStore from '../lib/store.js'
import { getKbDocs, getKbDoc, saveKbDoc } from '../lib/api.js'

// ============================================
// File tree builder from flat path list
// ============================================
function buildTree(docs) {
  const root = { name: 'root', children: {}, files: [] }

  for (const doc of docs) {
    const parts = (doc.path || doc.title || 'untitled').split('/')
    let node = root
    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i]
      if (!node.children[part]) {
        node.children[part] = { name: part, children: {}, files: [] }
      }
      node = node.children[part]
    }
    node.files.push(doc)
  }

  return root
}

// ============================================
// Tag Input
// ============================================
function TagInput({ tags, onChange }) {
  const [input, setInput] = useState('')

  function addTag(tag) {
    const t = tag.trim().toLowerCase()
    if (t && !tags.includes(t)) onChange([...tags, t])
    setInput('')
  }

  function removeTag(tag) {
    onChange(tags.filter((t) => t !== tag))
  }

  return (
    <div className="flex flex-wrap gap-1.5 items-center min-h-[32px] p-1.5 bg-blueprint-bg border border-blueprint-border rounded">
      {tags.map((tag) => (
        <span key={tag} className="flex items-center gap-1 px-2 py-0.5 bg-blueprint-blue/10 text-blueprint-blue rounded text-xs">
          {tag}
          <button onClick={() => removeTag(tag)} className="hover:text-white">
            <X size={10} />
          </button>
        </span>
      ))}
      <input
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ',') {
            e.preventDefault()
            addTag(input)
          }
          if (e.key === 'Backspace' && !input && tags.length > 0) {
            removeTag(tags[tags.length - 1])
          }
        }}
        placeholder={tags.length === 0 ? 'Add tags...' : ''}
        className="bg-transparent text-xs text-slate-300 outline-none flex-1 min-w-[80px]"
      />
    </div>
  )
}

// ============================================
// Tree Node
// ============================================
function TreeNode({ name, node, activePath, onSelect, depth = 0 }) {
  const hasChildren = Object.keys(node.children || {}).length > 0
  const [expanded, setExpanded] = useState(true)

  const isActive = node.files.some((f) => f.path === activePath)

  return (
    <div>
      {/* Folder */}
      {(hasChildren || depth > 0) && (
        <button
          onClick={() => setExpanded(!expanded)}
          className={clsx(
            'w-full flex items-center gap-1.5 px-2 py-1.5 rounded text-xs hover:bg-blueprint-border transition-colors text-left',
            isActive ? 'text-blueprint-blue' : 'text-blueprint-muted'
          )}
          style={{ paddingLeft: depth * 12 + 8 }}
        >
          {expanded ? <FolderOpen size={13} /> : <Folder size={13} />}
          <span className="font-medium truncate flex-1">{name}</span>
          {expanded ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
        </button>
      )}

      {expanded && (
        <>
          {/* Files */}
          {node.files.map((file) => (
            <button
              key={file.path || file.id}
              onClick={() => onSelect(file)}
              className={clsx(
                'w-full flex items-center gap-1.5 px-2 py-1.5 rounded text-xs hover:bg-blueprint-border transition-colors text-left',
                activePath === (file.path || file.id)
                  ? 'bg-blueprint-blue/10 text-blueprint-blue'
                  : 'text-slate-300'
              )}
              style={{ paddingLeft: (depth + (depth > 0 ? 1 : 0)) * 12 + 8 }}
            >
              <FileText size={13} className="flex-shrink-0" />
              <span className="truncate flex-1">{file.title || file.path?.split('/').pop() || 'Untitled'}</span>
              {file.updated_at && (
                <span className="text-[10px] text-blueprint-muted flex-shrink-0 ml-1">
                  {new Date(file.updated_at).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })}
                </span>
              )}
            </button>
          ))}

          {/* Children */}
          {Object.entries(node.children || {}).map(([childName, childNode]) => (
            <TreeNode
              key={childName}
              name={childName}
              node={childNode}
              activePath={activePath}
              onSelect={onSelect}
              depth={depth + 1}
            />
          ))}
        </>
      )}
    </div>
  )
}

// ============================================
// Frontmatter Panel
// ============================================
function FrontmatterPanel({ frontmatter, onChange }) {
  const [open, setOpen] = useState(false)
  const [tags, setTags] = useState(frontmatter?.tags || [])

  function handleTagChange(newTags) {
    setTags(newTags)
    onChange({ ...frontmatter, tags: newTags })
  }

  return (
    <div className="border-t border-blueprint-border">
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center justify-between px-4 py-2.5 text-xs text-blueprint-muted hover:text-slate-200 transition-colors"
      >
        <div className="flex items-center gap-1.5">
          <Tag size={12} />
          <span>Frontmatter</span>
          {tags.length > 0 && (
            <span className="text-blueprint-blue">{tags.length} tag{tags.length !== 1 ? 's' : ''}</span>
          )}
        </div>
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
      </button>
      {open && (
        <div className="px-4 pb-4 space-y-3">
          <div>
            <label className="block text-[10px] text-blueprint-muted mb-1.5 uppercase tracking-wider">Tags</label>
            <TagInput tags={tags} onChange={handleTagChange} />
          </div>
          {Object.entries(frontmatter || {}).filter(([k]) => k !== 'tags').map(([k, v]) => (
            <div key={k}>
              <label className="block text-[10px] text-blueprint-muted mb-1 uppercase tracking-wider">{k}</label>
              <input
                value={String(v || '')}
                onChange={(e) => onChange({ ...frontmatter, [k]: e.target.value })}
                className="bp-input text-xs py-1"
              />
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ============================================
// KB Page
// ============================================
function KB() {
  const addNotification = useStore((s) => s.addNotification)
  const [docs, setDocs] = useState([])
  const [loading, setLoading] = useState(true)
  const [selectedDoc, setSelectedDoc] = useState(null)
  const [docContent, setDocContent] = useState('')
  const [docTitle, setDocTitle] = useState('')
  const [docFrontmatter, setDocFrontmatter] = useState({})
  const [saving, setSaving] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [showSearch, setShowSearch] = useState(false)
  const saveTimerRef = useRef(null)
  // Refs for autoSave closure — avoids stale state captures in setTimeout
  const selectedDocRef = useRef(null)
  const docContentRef = useRef('')
  const docTitleRef = useRef('')
  const docFrontmatterRef = useRef({})
  const dirtyRef = useRef(false)

  useEffect(() => {
    getKbDocs()
      .then((data) => setDocs(Array.isArray(data) ? data : data?.docs || []))
      .catch(() => setDocs([]))
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    // Keyboard shortcut Cmd+K / Ctrl+K for search
    function handleKey(e) {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault()
        setShowSearch((s) => !s)
      }
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [])

  async function handleSelectDoc(doc) {
    // Auto-save current doc before switching
    if (dirtyRef.current && selectedDocRef.current) {
      await performSave(selectedDocRef.current, docTitleRef.current, docContentRef.current, docFrontmatterRef.current)
    }
    selectedDocRef.current = doc
    setSelectedDoc(doc)
    setDocTitle(doc.title || '')
    docTitleRef.current = doc.title || ''
    setDocFrontmatter(doc.frontmatter || {})
    docFrontmatterRef.current = doc.frontmatter || {}
    setDirty(false)
    dirtyRef.current = false
    try {
      const full = await getKbDoc(doc.path || doc.id)
      const content = full.content || full.body || ''
      setDocContent(content)
      docContentRef.current = content
      if (full.frontmatter) {
        setDocFrontmatter(full.frontmatter)
        docFrontmatterRef.current = full.frontmatter
      }
    } catch {
      const content = doc.content || ''
      setDocContent(content)
      docContentRef.current = content
    }
  }

  function handleContentChange(content) {
    setDocContent(content)
    docContentRef.current = content
    setDirty(true)
    dirtyRef.current = true
    // Debounced auto-save using refs (no stale closure issue)
    clearTimeout(saveTimerRef.current)
    saveTimerRef.current = setTimeout(() => {
      if (!dirtyRef.current || !selectedDocRef.current) return
      performSave(selectedDocRef.current, docTitleRef.current, docContentRef.current, docFrontmatterRef.current)
    }, 2000)
  }

  async function performSave(doc, title, content, frontmatter) {
    try {
      setSaving(true)
      await saveKbDoc(doc.path || doc.id, { title, content, frontmatter })
      setDirty(false)
      dirtyRef.current = false
      setDocs((prev) => prev.map((d) =>
        (d.path || d.id) === (doc.path || doc.id)
          ? { ...d, title, updated_at: new Date().toISOString() }
          : d
      ))
    } catch (err) {
      addNotification({ type: 'error', message: 'Save failed: ' + err.message })
    } finally {
      setSaving(false)
    }
  }

  async function handleSave() {
    if (!selectedDoc) return
    await performSave(selectedDoc, docTitle, docContent, docFrontmatter)
  }

  function handleNewDoc() {
    const newDoc = {
      id: `doc_${Date.now()}`,
      path: `new-document-${Date.now()}.md`,
      title: 'New Document',
      content: '',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }
    setDocs((prev) => [newDoc, ...prev])
    handleSelectDoc(newDoc)
  }

  const tree = buildTree(docs)
  const filteredDocs = searchQuery
    ? docs.filter((d) =>
        (d.title || '').toLowerCase().includes(searchQuery.toLowerCase()) ||
        (d.path || '').toLowerCase().includes(searchQuery.toLowerCase())
      )
    : []

  return (
    <div className="flex h-full">
      {/* Left pane — file tree */}
      <div className="w-[280px] flex-shrink-0 border-r border-blueprint-border bg-blueprint-card flex flex-col">
        {/* Tree header */}
        <div className="flex items-center justify-between px-3 py-3 border-b border-blueprint-border">
          <span className="text-xs font-semibold text-slate-300 uppercase tracking-wider">Knowledge Base</span>
          <div className="flex items-center gap-1">
            <button
              onClick={() => setShowSearch(!showSearch)}
              className="p-1.5 rounded text-blueprint-muted hover:text-slate-200 hover:bg-blueprint-border transition-colors"
              title="Search (Ctrl+K)"
            >
              <Search size={13} />
            </button>
            <button
              onClick={handleNewDoc}
              className="p-1.5 rounded text-blueprint-muted hover:text-slate-200 hover:bg-blueprint-border transition-colors"
              title="New Document"
            >
              <Plus size={13} />
            </button>
          </div>
        </div>

        {/* Search overlay */}
        {showSearch && (
          <div className="px-3 py-2 border-b border-blueprint-border">
            <div className="relative">
              <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-blueprint-muted" />
              <input
                autoFocus
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onKeyDown={(e) => e.key === 'Escape' && setShowSearch(false)}
                className="bp-input pl-7 py-1.5 text-xs"
                placeholder="Search documents..."
              />
            </div>
            {searchQuery && (
              <div className="mt-2 space-y-0.5">
                {filteredDocs.length === 0 && (
                  <p className="text-xs text-blueprint-muted py-2 text-center">No results</p>
                )}
                {filteredDocs.map((doc) => (
                  <button
                    key={doc.path || doc.id}
                    onClick={() => { handleSelectDoc(doc); setShowSearch(false); setSearchQuery('') }}
                    className="w-full flex items-center gap-2 px-2 py-1.5 rounded hover:bg-blueprint-border text-xs text-slate-300 text-left"
                  >
                    <FileText size={12} />
                    <span className="truncate">{doc.title || doc.path}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Tree */}
        <div className="flex-1 overflow-y-auto px-1 py-2">
          {loading && (
            <div className="space-y-1.5 px-2">
              {Array.from({ length: 6 }).map((_, i) => (
                <div key={i} className="skeleton h-6 rounded" style={{ width: `${60 + Math.random() * 30}%` }} />
              ))}
            </div>
          )}
          {!loading && docs.length === 0 && (
            <div className="text-center py-8">
              <p className="text-xs text-blueprint-muted mb-2">No documents yet</p>
              <button onClick={handleNewDoc} className="text-xs text-blueprint-blue hover:underline">
                Create first document →
              </button>
            </div>
          )}
          {!loading && !searchQuery && (
            <>
              {tree.files.map((file) => (
                <button
                  key={file.path || file.id}
                  onClick={() => handleSelectDoc(file)}
                  className={clsx(
                    'w-full flex items-center gap-1.5 px-2 py-1.5 rounded text-xs hover:bg-blueprint-border transition-colors text-left',
                    (selectedDoc?.path || selectedDoc?.id) === (file.path || file.id)
                      ? 'bg-blueprint-blue/10 text-blueprint-blue'
                      : 'text-slate-300'
                  )}
                >
                  <FileText size={13} />
                  <span className="truncate">{file.title || file.path}</span>
                </button>
              ))}
              {Object.entries(tree.children).map(([name, node]) => (
                <TreeNode
                  key={name}
                  name={name}
                  node={node}
                  activePath={selectedDoc?.path || selectedDoc?.id}
                  onSelect={handleSelectDoc}
                />
              ))}
            </>
          )}
        </div>
      </div>

      {/* Right pane — editor */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {!selectedDoc && (
          <div className="flex-1 flex flex-col items-center justify-center text-center p-8">
            <div className="text-5xl mb-4">📝</div>
            <h2 className="text-base font-semibold text-slate-300 mb-2">Select a document</h2>
            <p className="text-sm text-blueprint-muted mb-4">
              Choose a file from the left panel or create a new document
            </p>
            <button onClick={handleNewDoc} className="bp-btn bp-btn-primary text-xs">
              <Plus size={13} />
              New Document
            </button>
          </div>
        )}

        {selectedDoc && (
          <>
            {/* Editor toolbar / title bar */}
            <div className="flex items-center justify-between px-4 py-2.5 border-b border-blueprint-border bg-blueprint-card flex-shrink-0">
              <div className="flex items-center gap-2 flex-1 min-w-0">
                <input
                  value={docTitle}
                  onChange={(e) => {
                    setDocTitle(e.target.value)
                    docTitleRef.current = e.target.value
                    setDirty(true)
                    dirtyRef.current = true
                  }}
                  className="bg-transparent text-sm font-semibold text-slate-100 outline-none flex-1 min-w-0"
                  placeholder="Document title..."
                />
                {dirty && <span className="text-xs text-blueprint-amber">●</span>}
              </div>
              <div className="flex items-center gap-2 flex-shrink-0">
                {selectedDoc.updated_at && (
                  <span className="text-xs text-blueprint-muted mono flex items-center gap-1">
                    <Clock size={10} />
                    {new Date(selectedDoc.updated_at).toLocaleDateString()}
                  </span>
                )}
                <button
                  onClick={handleSave}
                  disabled={saving || !dirty}
                  className={clsx(
                    'bp-btn bp-btn-primary text-xs py-1.5',
                    (!dirty || saving) && 'opacity-50 cursor-not-allowed'
                  )}
                >
                  <Save size={12} />
                  {saving ? 'Saving...' : 'Save'}
                </button>
              </div>
            </div>

            {/* Tiptap editor */}
            <div className="flex-1 overflow-hidden flex flex-col">
              <div className="flex-1 overflow-hidden">
                <Editor
                  key={selectedDoc.path || selectedDoc.id}
                  content={docContent}
                  onChange={handleContentChange}
                  placeholder="Start writing..."
                />
              </div>

              {/* Frontmatter panel */}
              <FrontmatterPanel
                frontmatter={docFrontmatter}
                onChange={(fm) => {
                  setDocFrontmatter(fm)
                  docFrontmatterRef.current = fm
                  setDirty(true)
                  dirtyRef.current = true
                }}
              />

              {/* Git history panel */}
              {selectedDoc.git_history && selectedDoc.git_history.length > 0 && (
                <div className="border-t border-blueprint-border">
                  <div className="flex items-center gap-1.5 px-4 py-2.5 text-xs text-blueprint-muted">
                    <GitBranch size={11} />
                    <span>Recent commits</span>
                  </div>
                  <div className="px-4 pb-3 space-y-1">
                    {selectedDoc.git_history.slice(0, 5).map((commit, i) => (
                      <div key={i} className="flex items-center gap-2 text-xs">
                        <span className="mono text-blueprint-muted w-16 truncate">{commit.hash?.slice(0, 7)}</span>
                        <span className="text-slate-300 flex-1 truncate">{commit.message}</span>
                        <span className="text-blueprint-muted whitespace-nowrap">
                          {commit.date ? new Date(commit.date).toLocaleDateString() : ''}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  )
}

export default KB
