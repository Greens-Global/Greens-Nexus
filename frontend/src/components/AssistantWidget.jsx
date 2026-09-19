import { useState, useRef, useEffect, Component, lazy, Suspense } from 'react';
import { X, Send, Loader2, Sparkles } from 'lucide-react';
import { api } from '../api';

// react-markdown + remark-gfm only load once someone actually opens the
// widget and gets a reply - this widget is mounted globally on every screen,
// so most page loads never need the parser at all.
const MarkdownReply = lazy(async () => {
  const [{ default: ReactMarkdown }, { default: remarkGfm }] = await Promise.all([
    import('react-markdown'), import('remark-gfm'),
  ]);
  return { default: ({ children }) => <ReactMarkdown remarkPlugins={[remarkGfm]}>{children}</ReactMarkdown> };
});

// A crash inside the widget must not blank the whole app (CLAUDE.md's
// "never let a screen render blank" rule) - RootErrorBoundary would catch it,
// but that reloads the entire app for a widget-local problem. This keeps the
// failure contained to the bubble itself.
class AssistantErrorBoundary extends Component {
  state = { error: null };
  static getDerivedStateFromError(error) { return { error }; }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div style={{
        position: 'fixed', bottom: 18, right: 18, zIndex: 1190,
        width: 260, background: 'var(--card)', border: '1px solid var(--line)',
        borderRadius: 14, padding: '14px 16px', fontFamily: 'Inter, sans-serif',
        boxShadow: '0 12px 40px rgba(0,0,0,0.18)',
      }}>
        <div style={{ fontWeight: 700, fontSize: 13, color: 'var(--ink)', marginBottom: 4 }}>
          Assistant hit a snag
        </div>
        <div style={{ fontSize: 12, color: 'var(--muted)' }}>
          Reload the page to bring it back.
        </div>
      </div>
    );
  }
}

function AssistantWidgetInner() {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState([]); // {role, content}
  const [conversationId, setConversationId] = useState(null);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const listRef = useRef(null);

  useEffect(() => {
    if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight;
  }, [messages, sending]);

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    if (open) window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  const send = async () => {
    const text = input.trim();
    if (!text || sending) return;
    setInput('');
    setError('');
    setMessages(m => [...m, { role: 'user', content: text }]);
    setSending(true);
    try {
      const res = await api.askAssistant({ conversation_id: conversationId, message: text });
      setConversationId(res.conversation_id);
      setMessages(m => [...m, { role: 'assistant', content: res.reply }]);
    } catch (e) {
      setError(e?.message || 'The assistant could not be reached - try again in a moment.');
    } finally {
      setSending(false);
    }
  };

  return (
    <>
      {/* Bubble - bottom-right, a pill badge (not a plain icon circle) so it
          reads as "AI" at a glance. Fixed position, same on every module -
          Neil/Pranshu, Sep 19: no per-module repositioning, even on Tasks
          where it sits close to the module's own floating "+". */}
      <button
        onClick={() => setOpen(o => !o)}
        aria-label="Nexus Assistant"
        style={{
          position: 'fixed', bottom: 18, right: 18, zIndex: 1190,
          border: 'none', borderRadius: 999, padding: 2, cursor: 'pointer',
          background: 'linear-gradient(135deg, #06b6d4, #22c55e)',
          boxShadow: '0 8px 28px rgba(0,0,0,0.22)',
        }}
      >
        <span style={{
          display: 'flex', alignItems: 'center', gap: 6,
          background: 'var(--card)', color: 'var(--ink)', borderRadius: 999,
          padding: open ? '10px' : '10px 16px',
        }}>
          {open ? <X size={16} /> : <><Sparkles size={14} /><span style={{ fontWeight: 700, fontSize: 13 }}>AI</span></>}
        </span>
      </button>

      {/* Panel */}
      <div style={{
        position: 'fixed', bottom: 78, right: 18, zIndex: 1190,
        width: 'min(380px, 92vw)', height: 'min(560px, 70vh)',
        background: 'var(--card)', border: '1px solid var(--line)',
        borderRadius: 16, boxShadow: '0 24px 70px rgba(17,24,39,0.30)',
        display: 'flex', flexDirection: 'column', overflow: 'hidden',
        fontFamily: 'Inter, sans-serif',
        transform: open ? 'translateY(0)' : 'translateY(12px)',
        opacity: open ? 1 : 0,
        pointerEvents: open ? 'auto' : 'none',
        transition: 'transform 0.22s cubic-bezier(0.4,0,0.2,1), opacity 0.18s ease',
      }}>
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '14px 16px', borderBottom: '1px solid var(--line)', flexShrink: 0 }}>
          <div style={{ width: 30, height: 30, borderRadius: 9, background: 'hsla(var(--color-blue),0.12)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
            <Sparkles size={15} style={{ color: 'hsl(var(--color-blue))' }} />
          </div>
          <div style={{ fontWeight: 700, fontSize: 14, color: 'var(--ink)' }}>Nexus Assistant</div>
        </div>

        {/* Messages */}
        <div ref={listRef} style={{ flex: 1, overflowY: 'auto', padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 10 }}>
          {messages.length === 0 && (
            <div style={{ fontSize: 12.5, color: 'var(--muted)', lineHeight: 1.5 }}>
              Ask about your own Nexus data - your profile or your notifications, for now. More is coming.
            </div>
          )}
          {messages.map((m, i) => (
            <div key={i} style={{
              alignSelf: m.role === 'user' ? 'flex-end' : 'flex-start',
              maxWidth: '85%', padding: '8px 12px', borderRadius: 12,
              background: m.role === 'user' ? 'hsl(var(--color-blue))' : 'var(--mist)',
              color: m.role === 'user' ? '#fff' : 'var(--ink)',
              fontSize: 13, lineHeight: 1.5,
            }}>
              {m.role === 'assistant'
                ? <Suspense fallback={m.content}><MarkdownReply>{m.content}</MarkdownReply></Suspense>
                : m.content}
            </div>
          ))}
          {sending && (
            <div style={{ alignSelf: 'flex-start', color: 'var(--muted)', display: 'flex', alignItems: 'center', gap: 6, fontSize: 12.5 }}>
              <Loader2 size={13} style={{ animation: 'spin 0.7s linear infinite' }} /> Thinking...
            </div>
          )}
          {error && (
            <div style={{ fontSize: 12, color: 'hsl(var(--color-red))' }}>{error}</div>
          )}
        </div>

        {/* Composer */}
        <div style={{ display: 'flex', gap: 8, padding: 12, borderTop: '1px solid var(--line)', flexShrink: 0 }}>
          <input
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
            placeholder="Ask a question..."
            disabled={sending}
            style={{
              flex: 1, border: '1px solid var(--line)', borderRadius: 9,
              padding: '8px 11px', fontSize: 13, fontFamily: 'Inter, sans-serif',
              background: 'var(--card)', color: 'var(--ink)',
            }}
          />
          <button
            onClick={send}
            disabled={sending || !input.trim()}
            aria-label="Send"
            style={{
              width: 36, height: 36, borderRadius: 9, border: 'none',
              background: 'var(--ink)', color: 'var(--card)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              cursor: sending || !input.trim() ? 'default' : 'pointer',
              opacity: sending || !input.trim() ? 0.5 : 1,
            }}
          >
            <Send size={15} />
          </button>
        </div>
      </div>
    </>
  );
}

export default function AssistantWidget() {
  return (
    <AssistantErrorBoundary>
      <AssistantWidgetInner />
    </AssistantErrorBoundary>
  );
}
