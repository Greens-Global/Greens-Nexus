import { useEffect, useState } from 'react';
import { FilePlus2, LayoutTemplate, Send, FileText, Clock, Loader2, ChevronRight } from 'lucide-react';
import { api } from '../api';

// ── Documents Dashboard ───────────────────────────────────────────────────────
// Landing screen for the Documents module: quick actions, recent documents, and
// a pending-signatures summary pulled from the existing E-Sign inbox (api.mySignatures()
// - no new backend surface needed for that half). "New Document"/"New Template"
// hand off to My Documents / Templates and ask them to pop their create dialog.
const DOC_STATUS = {
  draft:    { label: 'Draft',    fg: 'hsl(var(--color-blue))',   bg: 'hsla(var(--color-blue),0.12)' },
  final:    { label: 'Final',    fg: 'hsl(var(--color-green))',  bg: 'hsla(var(--color-green),0.12)' },
  archived: { label: 'Archived', fg: 'var(--muted)',             bg: 'var(--mist)' },
};

const actionCard = { flex: '1 1 180px', display: 'flex', alignItems: 'center', gap: 12, padding: '16px 18px', border: '1px solid var(--line)', borderRadius: 14, background: 'var(--card)', cursor: 'pointer', transition: 'border-color 0.15s' };
const iconBubble = (bg, fg) => ({ width: 38, height: 38, borderRadius: 10, background: bg, color: fg, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 });

export default function DocumentsDashboard({ onGoToBrowse, onGoToTemplates, onGoToEsign }) {
  const [recent, setRecent] = useState(null);
  const [inbox, setInbox] = useState(null);

  useEffect(() => {
    api.getDocuments({ limit: 5 }).then(setRecent).catch(() => setRecent([]));
    api.mySignatures().then(setInbox).catch(() => setInbox([]));
  }, []);

  const myTurn = (inbox || []).filter(x => x.myTurn);

  return (
    <div>
      {/* Quick Actions */}
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 24 }}>
        <div style={actionCard} onClick={() => onGoToBrowse?.(true)}>
          <div style={iconBubble('hsla(var(--color-blue),0.14)', 'hsl(var(--color-blue))')}><FilePlus2 size={18} /></div>
          <div>
            <div style={{ fontSize: 13.5, fontWeight: 700 }}>New Document</div>
            <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>Start a draft</div>
          </div>
        </div>
        <div style={actionCard} onClick={() => onGoToTemplates?.(true)}>
          <div style={iconBubble('hsla(var(--color-orange),0.14)', 'hsl(var(--color-orange))')}><LayoutTemplate size={18} /></div>
          <div>
            <div style={{ fontSize: 13.5, fontWeight: 700 }}>New Template</div>
            <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>Build a reusable template</div>
          </div>
        </div>
        <div style={actionCard} onClick={() => onGoToEsign?.()}>
          <div style={iconBubble('hsla(var(--color-green),0.14)', 'hsl(var(--color-green))')}><Send size={18} /></div>
          <div>
            <div style={{ fontSize: 13.5, fontWeight: 700 }}>Send for Signature</div>
            <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>Open E-Sign</div>
          </div>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap' }}>
        {/* Recent Documents */}
        <div style={{ flex: '2 1 380px', border: '1px solid var(--line)', borderRadius: 14, padding: '16px 18px', background: 'var(--card)' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
            <div style={{ fontSize: 13.5, fontWeight: 700, display: 'flex', alignItems: 'center', gap: 7 }}><FileText size={15} /> Recent Documents</div>
            <button onClick={() => onGoToBrowse?.(false)} style={{ background: 'none', border: 'none', color: 'var(--muted)', fontSize: 11.5, fontWeight: 600, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 3 }}>
              View all <ChevronRight size={12} />
            </button>
          </div>
          {!recent ? (
            <div style={{ padding: 20, textAlign: 'center', color: 'var(--muted)' }}><Loader2 size={16} style={{ animation: 'spin 1s linear infinite' }} /></div>
          ) : recent.length === 0 ? (
            <div style={{ padding: '20px 4px', color: 'var(--muted)', fontSize: 12.5 }}>No documents yet - create your first draft.</div>
          ) : recent.map(d => {
            const st = DOC_STATUS[d.status] || DOC_STATUS.draft;
            return (
              <div key={d.id} onClick={() => onGoToBrowse?.(false)}
                style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 4px', borderTop: '1px solid var(--line)', cursor: 'pointer' }}>
                <div style={{ flex: 1, minWidth: 0, fontSize: 12.5, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.title}</div>
                <span style={{ padding: '2px 9px', borderRadius: 12, fontSize: 10.5, fontWeight: 800, color: st.fg, background: st.bg, whiteSpace: 'nowrap' }}>{st.label}</span>
              </div>
            );
          })}
        </div>

        {/* Pending Signatures */}
        <div style={{ flex: '1 1 280px', border: '1px solid var(--line)', borderRadius: 14, padding: '16px 18px', background: 'var(--card)' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
            <div style={{ fontSize: 13.5, fontWeight: 700, display: 'flex', alignItems: 'center', gap: 7 }}><Clock size={15} /> Pending Signatures</div>
            {myTurn.length > 0 && (
              <span style={{ padding: '2px 9px', borderRadius: 12, fontSize: 10.5, fontWeight: 800, color: '#f59e0b', background: 'rgba(245,158,11,0.16)' }}>{myTurn.length}</span>
            )}
          </div>
          {!inbox ? (
            <div style={{ padding: 20, textAlign: 'center', color: 'var(--muted)' }}><Loader2 size={16} style={{ animation: 'spin 1s linear infinite' }} /></div>
          ) : myTurn.length === 0 ? (
            <div style={{ padding: '20px 4px', color: 'var(--muted)', fontSize: 12.5 }}>Nothing awaiting your signature.</div>
          ) : myTurn.slice(0, 5).map(item => (
            <div key={item.partyId} onClick={() => onGoToEsign?.()}
              style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 4px', borderTop: '1px solid var(--line)', cursor: 'pointer' }}>
              <div style={{ flex: 1, minWidth: 0, fontSize: 12.5, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.title}</div>
              <span style={{ fontSize: 11, color: 'var(--muted)' }}>from {item.from}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
