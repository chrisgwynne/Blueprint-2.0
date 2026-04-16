// Feature 3 — Agent Chat. Full implementation follows.
import React, { useEffect, useState, useRef, useCallback } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { formatDistanceToNow } from 'date-fns'
import { parseTimestamp } from '../lib/time'
import {
  MessageSquare, Send, Plus, Archive, AtSign,
} from 'lucide-react'
import useStore from '../lib/store'
import {
  getConversations, getConversation, createConversation,
  sendChatMessage, archiveConversation, getAgents,
} from '../lib/api'
import type { ChatMessage, ChatConversation } from '../types'

const AGENT_ICONS: Record<string, string> = {
  conductor:      '🎼',
  'seo-sentinel': '🔍',
  quill:          '✍️',
  velocity:       '⚡',
  'trend-spotter':'📈',
  merchant:       '🛒',
  ledger:         '📊',
  reporter:       '📰',
  sentinel:       '🛡️',
  dev:            '💻',
  researcher:     '🔬',
  outreach:       '📬',
}

interface AgentData {
  id: string
  name: string
  installed: boolean
  profile_summary?: { title?: string }
}

function fmtTime(iso: string | null | undefined) {
  if (!iso) return ''
  try { return formatDistanceToNow(parseTimestamp(iso) || new Date(), { addSuffix: true }) }
  catch { return '' }
}

function getAgentAvatar(id: string) {
  return AGENT_ICONS[id] ?? '🤖'
}

// ─── Markdown-lite renderer ───────────────────────────────────────────────────
function renderMessage(content: string | null | undefined) {
  if (!content) return null
  // Split paragraphs
  const paragraphs = content.split(/\n\n+/)
  return paragraphs.map((p, i) => {
    // Bold **text**
    const html = p
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/`([^`]+)`/g, '<code style="background:var(--bp-surface-3);padding:1px 5px;border-radius:3px;font-size:0.9em">$1</code>')
      .replace(/\[\[([^\]]+)\]\]/g, '<a href="/kb/$1" style="color:var(--bp-blue);text-decoration:underline">$1</a>')
      .replace(/(tsk_[a-zA-Z0-9-]+)/g, '<span style="background:rgba(77,166,255,0.15);border:1px solid rgba(77,166,255,0.3);border-radius:3px;padding:1px 5px;font-size:0.85em;color:var(--bp-blue)">$1</span>')
      .replace(/(@[\w-]+)/g, '<span style="color:var(--bp-blue);font-weight:500">$1</span>')
      .replace(/\n/g, '<br/>')
    return <p key={i} style={{ marginBottom: 8, lineHeight: 1.6 }} dangerouslySetInnerHTML={{ __html: html }} />
  })
}

// ─── Conversations sidebar ────────────────────────────────────────────────────
interface ConversationsListProps {
  businessId: string
  active: string | null
  onSelect: (id: string) => void
  onNew: () => void
  onPickAgent: (agentId: string) => void
}

function ConversationsList({ businessId, active, onSelect, onNew, onPickAgent }: ConversationsListProps) {
  const [conversations, setConversations] = useState<ChatConversation[]>([])
  const [agents, setAgents] = useState<AgentData[]>([])

  useEffect(() => {
    getConversations(businessId).then((c) => setConversations(c as ChatConversation[])).catch(() => setConversations([]))
    getAgents().then((a) => setAgents(a as AgentData[])).catch(() => setAgents([]))
  }, [businessId, active])

  return (
    <div style={{
      width: 240, borderRight: '1px solid var(--bp-border)',
      display: 'flex', flexDirection: 'column',
      background: 'var(--bp-surface)',
      overflow: 'hidden',
    }}>
      <div style={{ padding: 14, borderBottom: '1px solid var(--bp-border)' }}>
        <div style={{
          fontFamily: 'var(--bp-font-display)', fontWeight: 700, fontSize: 14,
          color: 'var(--bp-text)', marginBottom: 8,
        }}>Chat</div>
        <button
          onClick={onNew}
          className="bp-btn bp-btn-primary"
          style={{ width: '100%', justifyContent: 'center', fontSize: 11, padding: '6px' }}
        >
          <Plus size={11} /> New conversation
        </button>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: '6px' }}>
        {conversations.map((c) => (
          <button
            key={c.id}
            onClick={() => onSelect(c.id)}
            style={{
              width: '100%',
              textAlign: 'left',
              padding: '8px 10px',
              marginBottom: 2,
              borderRadius: 4,
              borderLeft: active === c.id ? '2px solid var(--bp-blue)' : '2px solid transparent',
              paddingLeft: active === c.id ? 8 : 10,
              background: active === c.id ? 'rgba(59,130,246,0.08)' : 'transparent',
              border: 'none',
              borderLeftWidth: 2,
              cursor: 'pointer',
              fontFamily: 'var(--bp-font-mono)',
            }}
          >
            <div style={{ fontSize: 11, color: 'var(--bp-text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {c.title ?? 'Untitled'}
            </div>
            <div style={{ fontSize: 9, color: 'var(--bp-text-3)', marginTop: 2 }}>
              {fmtTime(c.updated_at)}
            </div>
          </button>
        ))}
        {conversations.length === 0 && (
          <div style={{ padding: 14, fontSize: 11, color: 'var(--bp-text-3)', fontFamily: 'var(--bp-font-mono)', textAlign: 'center' }}>
            No conversations yet
          </div>
        )}
      </div>

      {/* Agent quick-mentions */}
      {agents.length > 0 && (
        <div style={{ padding: 10, borderTop: '1px solid var(--bp-border)' }}>
          <div style={{
            fontFamily: 'var(--bp-font-mono)', fontSize: 9, letterSpacing: '0.1em',
            color: 'var(--bp-text-3)', textTransform: 'uppercase', marginBottom: 6,
          }}>Agents</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
            {agents.filter(a => a.installed).slice(0, 10).map((a) => (
              <button
                key={a.id}
                onClick={() => onPickAgent(a.id)}
                title={`Chat with @${a.id}`}
                style={{
                  display: 'flex', alignItems: 'center', gap: 4,
                  padding: '3px 6px',
                  background: 'var(--bp-surface-2)',
                  border: '1px solid var(--bp-border)',
                  borderRadius: 3, cursor: 'pointer',
                  fontFamily: 'var(--bp-font-mono)', fontSize: 10,
                  color: 'var(--bp-text-2)',
                }}
              >
                <span style={{ fontSize: 11 }}>{getAgentAvatar(a.id)}</span>
                <span>{a.id}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Message bubble ───────────────────────────────────────────────────────────
interface MessageBubbleProps {
  msg: ChatMessage
}

function MessageBubble({ msg }: MessageBubbleProps) {
  const isHuman = msg.sender_type === 'human'
  const isBrain = msg.sender_type === 'system' && msg.sender_id === 'brain'

  // Brain/system messages: subtle, centered, italic
  if (isBrain) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', margin: '10px 0' }}>
        <div style={{
          maxWidth: '80%',
          padding: '8px 14px',
          background: 'rgba(157,122,255,0.06)',
          border: '1px solid rgba(157,122,255,0.15)',
          borderRadius: 4,
          fontFamily: 'var(--bp-font-mono)',
          fontSize: 11,
          color: 'var(--bp-text-2)',
          fontStyle: 'italic',
          textAlign: 'center',
          lineHeight: 1.5,
        }}>
          <div style={{ fontSize: 9, letterSpacing: '0.15em', color: 'var(--bp-purple)', marginBottom: 4, fontStyle: 'normal', textTransform: 'uppercase' }}>
            🧠 Blueprint Brain
          </div>
          {msg.content}
        </div>
      </div>
    )
  }

  const avatar = isHuman ? 'You' : getAgentAvatar(msg.sender_id)

  return (
    <div style={{
      display: 'flex', justifyContent: isHuman ? 'flex-end' : 'flex-start',
      marginBottom: 12,
    }}>
      <div style={{
        maxWidth: '78%',
        background: isHuman ? 'rgba(77,166,255,0.10)' : 'var(--bp-surface-2)',
        border: `1px solid ${isHuman ? 'rgba(77,166,255,0.30)' : 'var(--bp-border)'}`,
        borderRadius: 6,
        padding: '10px 14px',
        fontFamily: 'var(--bp-font-mono)',
        fontSize: 12,
        color: 'var(--bp-text)',
        position: 'relative',
      }}>
        <div style={{
          display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6,
          fontSize: 11, fontWeight: 600,
          color: isHuman ? 'var(--bp-blue)' : 'var(--bp-text)',
        }}>
          {isHuman ? null : <span style={{ fontSize: 14 }}>{avatar}</span>}
          <span>{msg.sender_name}</span>
        </div>
        <div>{renderMessage(msg.content)}</div>
        <div style={{
          fontSize: 9, color: 'var(--bp-text-3)', marginTop: 6,
          textAlign: isHuman ? 'right' : 'left',
        }}>
          {fmtTime(msg.created_at)}
        </div>
      </div>
    </div>
  )
}

// ─── @mention autocomplete ────────────────────────────────────────────────────
interface MentionDropdownProps {
  query: string
  agents: AgentData[]
  onPick: (agentId: string) => void
  position: number
}

function MentionDropdown({ query, agents, onPick, position }: MentionDropdownProps) {
  const filtered = agents.filter(a =>
    a.id.toLowerCase().includes(query.toLowerCase()) ||
    a.name.toLowerCase().includes(query.toLowerCase())
  ).slice(0, 6)

  if (filtered.length === 0) return null

  return (
    <div style={{
      position: 'absolute',
      bottom: '100%',
      left: position,
      marginBottom: 4,
      background: 'var(--bp-surface-2)',
      border: '1px solid var(--bp-border-2)',
      borderRadius: 5,
      padding: 4,
      minWidth: 220,
      zIndex: 50,
      boxShadow: '0 8px 24px rgba(0,0,0,0.5)',
    }}>
      {filtered.map((a) => (
        <button
          key={a.id}
          onClick={() => onPick(a.id)}
          style={{
            display: 'flex', alignItems: 'center', gap: 8,
            width: '100%', padding: '6px 10px',
            background: 'transparent',
            border: 'none', borderRadius: 3,
            cursor: 'pointer',
            fontFamily: 'var(--bp-font-mono)', fontSize: 11,
            color: 'var(--bp-text)',
            textAlign: 'left',
          }}
          onMouseEnter={e => (e.currentTarget.style.background = 'var(--bp-surface-3)')}
          onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
        >
          <span style={{ fontSize: 14 }}>{getAgentAvatar(a.id)}</span>
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 500 }}>@{a.id}</div>
            <div style={{ fontSize: 9, color: 'var(--bp-text-3)' }}>
              {a.profile_summary?.title ?? a.name}
            </div>
          </div>
        </button>
      ))}
    </div>
  )
}

// ─── Main Chat page ───────────────────────────────────────────────────────────
export default function Chat() {
  const { conversationId: paramId } = useParams()
  const navigate = useNavigate()
  const currentBusiness = useStore((s) => s.currentBusiness)
  const [activeId, setActiveId] = useState<string | null>(paramId || null)
  const [conversation, setConversation] = useState<ChatConversation | null>(null)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const [agents, setAgents] = useState<AgentData[]>([])
  const [mentionQuery, setMentionQuery] = useState<string | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    getAgents().then((list) => setAgents(((list ?? []) as AgentData[]).filter(a => a.installed))).catch(() => {})
  }, [])

  // Load active conversation
  useEffect(() => {
    if (!activeId || !currentBusiness) { setMessages([]); setConversation(null); return }
    getConversation(currentBusiness.id, activeId).then((data) => {
      const d = data as { conversation: ChatConversation; messages?: ChatMessage[] }
      setConversation(d.conversation)
      setMessages(d.messages ?? [])
    }).catch(() => {})
  }, [activeId, currentBusiness])

  // SSE: poll for new messages every 3s while conversation is open
  useEffect(() => {
    if (!activeId || !currentBusiness) return
    const interval = setInterval(async () => {
      try {
        const data = await getConversation(currentBusiness.id, activeId) as { messages?: ChatMessage[] }
        setMessages(data.messages ?? [])
      } catch {}
    }, 3000)
    return () => clearInterval(interval)
  }, [activeId, currentBusiness])

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight
  }, [messages])

  function handleInputChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
    const value = e.target.value
    setInput(value)
    // Detect @ at cursor position
    const cursorPos = e.target.selectionStart
    const before = value.slice(0, cursorPos)
    const match = before.match(/@([\w-]*)$/)
    if (match) setMentionQuery(match[1])
    else setMentionQuery(null)
  }

  function insertMention(agentId: string) {
    const cursorPos = textareaRef.current?.selectionStart ?? input.length
    const before = input.slice(0, cursorPos)
    const after = input.slice(cursorPos)
    const updatedBefore = before.replace(/@[\w-]*$/, `@${agentId} `)
    const newValue = updatedBefore + after
    setInput(newValue)
    setMentionQuery(null)
    setTimeout(() => textareaRef.current?.focus(), 0)
  }

  async function handleSend() {
    if (!input.trim() || sending || !currentBusiness) return
    const text = input.trim()
    setSending(true)
    setInput('')

    try {
      let convId = activeId
      if (!convId) {
        const created = await createConversation(currentBusiness.id, { title: text.slice(0, 60) }) as { id: string }
        convId = created.id
        setActiveId(convId)
        navigate(`/chat/${convId}`, { replace: true })
      }

      await sendChatMessage(currentBusiness.id, convId, text)
      // Reload messages immediately after send
      const data = await getConversation(currentBusiness.id, convId) as { conversation: ChatConversation; messages?: ChatMessage[] }
      setConversation(data.conversation)
      setMessages(data.messages ?? [])
    } catch (err) {
      console.error('Send failed:', err)
    } finally {
      setSending(false)
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  async function handleNewConversation() {
    setActiveId(null)
    setConversation(null)
    setMessages([])
    navigate('/chat')
  }

  async function handleArchive() {
    if (!activeId || !currentBusiness) return
    await archiveConversation(currentBusiness.id, activeId)
    handleNewConversation()
  }

  function handlePickAgent(agentId: string) {
    setInput(`@${agentId} `)
    textareaRef.current?.focus()
  }

  if (!currentBusiness) {
    return (
      <div style={{ padding: 40, textAlign: 'center', color: 'var(--bp-text-3)', fontFamily: 'var(--bp-font-mono)' }}>
        Select a business to start chatting.
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', height: 'calc(100vh - 52px)', overflow: 'hidden' }}>
      <ConversationsList
        businessId={currentBusiness.id}
        active={activeId}
        onSelect={(id) => { setActiveId(id); navigate(`/chat/${id}`) }}
        onNew={handleNewConversation}
        onPickAgent={handlePickAgent}
      />

      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        {/* Header */}
        <div style={{
          padding: '12px 20px', borderBottom: '1px solid var(--bp-border)',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          fontFamily: 'var(--bp-font-mono)',
        }}>
          <div style={{ fontSize: 13, color: 'var(--bp-text)', fontWeight: 500 }}>
            {conversation?.title ?? 'New conversation'}
          </div>
          {activeId && (
            <button onClick={handleArchive} className="bp-btn bp-btn-ghost" style={{ fontSize: 11 }}>
              <Archive size={11} /> Archive
            </button>
          )}
        </div>

        {/* Messages */}
        <div ref={scrollRef} style={{ flex: 1, overflowY: 'auto', padding: 20 }}>
          {messages.length === 0 && !activeId && (
            <div style={{ textAlign: 'center', padding: 40, color: 'var(--bp-text-3)', fontFamily: 'var(--bp-font-mono)', fontSize: 12 }}>
              <MessageSquare size={28} style={{ marginBottom: 12, opacity: 0.5 }} />
              <p style={{ marginBottom: 6 }}>Start a conversation with Blueprint agents.</p>
              <p style={{ fontSize: 10 }}>Use @mention to address a specific agent.</p>
            </div>
          )}
          {messages.map((m) => <MessageBubble key={m.id} msg={m} />)}
          {sending && (
            <div style={{ display: 'flex', gap: 6, padding: '10px 14px', fontFamily: 'var(--bp-font-mono)', fontSize: 11, color: 'var(--bp-text-3)' }}>
              <span className="pulse-dot pulse-dot-blue" style={{ animationDelay: '0s' }} />
              <span className="pulse-dot pulse-dot-blue" style={{ animationDelay: '0.3s' }} />
              <span className="pulse-dot pulse-dot-blue" style={{ animationDelay: '0.6s' }} />
              <span style={{ marginLeft: 8 }}>Agents thinking...</span>
            </div>
          )}
        </div>

        {/* Input */}
        <div style={{
          padding: 16, borderTop: '1px solid var(--bp-border)',
          background: 'var(--bp-surface)',
          position: 'relative',
        }}>
          {mentionQuery !== null && (
            <MentionDropdown
              query={mentionQuery}
              agents={agents}
              onPick={insertMention}
              position={20}
            />
          )}
          <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
            <textarea
              ref={textareaRef}
              value={input}
              onChange={handleInputChange}
              onKeyDown={handleKeyDown}
              placeholder="Message agents... (@mention to target one)"
              rows={2}
              style={{
                flex: 1,
                padding: '10px 12px',
                background: 'var(--bp-surface-2)',
                border: '1px solid var(--bp-border)',
                borderRadius: 5,
                color: 'var(--bp-text)',
                fontFamily: 'var(--bp-font-mono)',
                fontSize: 12,
                resize: 'vertical',
                outline: 'none',
              }}
            />
            <button
              onClick={handleSend}
              disabled={!input.trim() || sending}
              className="bp-btn bp-btn-primary"
              style={{ padding: '10px 14px' }}
            >
              <Send size={12} />
            </button>
          </div>
          <div style={{ fontFamily: 'var(--bp-font-mono)', fontSize: 9, color: 'var(--bp-text-3)', marginTop: 6 }}>
            Enter to send · Shift+Enter for newline
          </div>
        </div>
      </div>
    </div>
  )
}
