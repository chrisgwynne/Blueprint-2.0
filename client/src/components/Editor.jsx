import React, { useState, useCallback, useEffect } from 'react'
import { useEditor, EditorContent } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import {
  Bold,
  Italic,
  Heading1,
  Heading2,
  Heading3,
  List,
  ListOrdered,
  Code,
  Code2,
  FileText,
} from 'lucide-react'
import clsx from 'clsx'

// ============================================
// Toolbar Button
// ============================================
function ToolbarBtn({ onClick, active, disabled, title, children }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={clsx(
        'p-1.5 rounded transition-colors text-xs',
        active
          ? 'bg-blueprint-blue/20 text-blueprint-blue'
          : 'text-blueprint-muted hover:text-slate-200 hover:bg-blueprint-border',
        disabled && 'opacity-40 cursor-not-allowed'
      )}
    >
      {children}
    </button>
  )
}

function Divider() {
  return <div className="w-px h-5 bg-blueprint-border mx-0.5" />
}

// ============================================
// Editor Component
// ============================================
function Editor({ content = '', onChange, readOnly = false, placeholder = 'Start writing...' }) {
  const [markdownMode, setMarkdownMode] = useState(false)
  const [rawMarkdown, setRawMarkdown] = useState('')

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        codeBlock: {
          HTMLAttributes: {
            class: 'code-block',
          },
        },
      }),
    ],
    content,
    editable: !readOnly,
    onUpdate: ({ editor }) => {
      if (!markdownMode && onChange) {
        onChange(editor.getHTML())
      }
    },
    editorProps: {
      attributes: {
        class: 'tiptap-editor focus:outline-none',
        'data-placeholder': placeholder,
      },
    },
  })

  // TipTap's useEditor only consumes `content` on initial mount. When the
  // parent swaps which document is selected, we need to explicitly reset the
  // editor's content — otherwise the second doc the user clicks never appears.
  useEffect(() => {
    if (!editor) return
    // Avoid a feedback loop: only sync when the incoming prop differs from
    // what the editor currently has.
    const current = editor.getHTML()
    if (content !== current) {
      editor.commands.setContent(content || '', false)
    }
  }, [content, editor])

  function toggleMarkdown() {
    if (!editor) return
    if (!markdownMode) {
      // Entering markdown mode — get raw HTML as text representation
      setRawMarkdown(editor.getText())
      setMarkdownMode(true)
    } else {
      // Leaving markdown mode — restore
      setMarkdownMode(false)
    }
  }

  function handleMarkdownChange(e) {
    setRawMarkdown(e.target.value)
    if (onChange) onChange(e.target.value)
  }

  if (!editor) return null

  return (
    <div className="flex flex-col h-full">
      {/* Toolbar */}
      {!readOnly && (
        <div className="flex items-center gap-0.5 px-3 py-2 border-b border-blueprint-border bg-blueprint-card flex-shrink-0 flex-wrap">
          <ToolbarBtn
            onClick={() => editor.chain().focus().toggleBold().run()}
            active={editor.isActive('bold')}
            title="Bold"
          >
            <Bold size={14} />
          </ToolbarBtn>
          <ToolbarBtn
            onClick={() => editor.chain().focus().toggleItalic().run()}
            active={editor.isActive('italic')}
            title="Italic"
          >
            <Italic size={14} />
          </ToolbarBtn>

          <Divider />

          <ToolbarBtn
            onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()}
            active={editor.isActive('heading', { level: 1 })}
            title="Heading 1"
          >
            <Heading1 size={14} />
          </ToolbarBtn>
          <ToolbarBtn
            onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}
            active={editor.isActive('heading', { level: 2 })}
            title="Heading 2"
          >
            <Heading2 size={14} />
          </ToolbarBtn>
          <ToolbarBtn
            onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()}
            active={editor.isActive('heading', { level: 3 })}
            title="Heading 3"
          >
            <Heading3 size={14} />
          </ToolbarBtn>

          <Divider />

          <ToolbarBtn
            onClick={() => editor.chain().focus().toggleBulletList().run()}
            active={editor.isActive('bulletList')}
            title="Bullet List"
          >
            <List size={14} />
          </ToolbarBtn>
          <ToolbarBtn
            onClick={() => editor.chain().focus().toggleOrderedList().run()}
            active={editor.isActive('orderedList')}
            title="Ordered List"
          >
            <ListOrdered size={14} />
          </ToolbarBtn>

          <Divider />

          <ToolbarBtn
            onClick={() => editor.chain().focus().toggleCode().run()}
            active={editor.isActive('code')}
            title="Inline Code"
          >
            <Code size={14} />
          </ToolbarBtn>
          <ToolbarBtn
            onClick={() => editor.chain().focus().toggleCodeBlock().run()}
            active={editor.isActive('codeBlock')}
            title="Code Block"
          >
            <Code2 size={14} />
          </ToolbarBtn>

          <Divider />

          <button
            onClick={toggleMarkdown}
            className={clsx(
              'px-2 py-1 rounded text-xs font-semibold mono transition-colors',
              markdownMode
                ? 'bg-blueprint-amber/20 text-blueprint-amber'
                : 'text-blueprint-muted hover:text-slate-200 hover:bg-blueprint-border'
            )}
            title="Toggle Markdown mode"
          >
            MD
          </button>
        </div>
      )}

      {/* Editor area */}
      <div className="flex-1 overflow-auto">
        {markdownMode ? (
          <textarea
            value={rawMarkdown}
            onChange={handleMarkdownChange}
            className="w-full h-full bg-transparent text-slate-300 text-sm mono p-4 resize-none outline-none leading-relaxed"
            placeholder="Write markdown..."
            readOnly={readOnly}
          />
        ) : (
          <div className="tiptap-editor p-4 min-h-full">
            <EditorContent editor={editor} />
          </div>
        )}
      </div>
    </div>
  )
}

export default Editor
