// Suggested Articles inside the ticket form - ticket deflection, the way
// Jira Service Management and Zendesk do it. As someone types a title and
// description, the guide is searched (docsSearch.js, local, no network) and up
// to three confident answers appear under the fields. Each opens inline, so
// reading one never costs the draft; "Open Full Article" goes to a new tab.
//
// Advisory only: nothing here blocks or slows Create Ticket, and when nothing
// clears the relevance floor the block is simply absent.
import { useEffect, useMemo, useState } from 'react';
import { BookOpen, ListChecks, Layers, Lightbulb, ShieldCheck, ChevronDown, ExternalLink, Check } from 'lucide-react';
import { suggestForTicket } from './docsSearch';
import { useDocAccess } from './docsAccess';
import { docUrl } from './openDoc';
import { showHelpToast } from './helpToast';

const KIND_ICON = { module: BookOpen, walkthrough: ListChecks, feature: Layers, tip: Lightbulb, manager: ShieldCheck };
const BRAND = 'var(--wk-brand, #2b45e1)';
export const DEFLECT_DEBOUNCE_MS = 250;

function useDebounced(value, ms) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

function ArticleBody({ r }) {
  if (r.kind === 'walkthrough') {
    return (
      <ol style={{ margin: 0, paddingLeft: 20, display: 'flex', flexDirection: 'column', gap: 5 }}>
        {r.body.map((s, i) => <li key={i} style={{ fontSize: 12.5, lineHeight: 1.5, color: 'var(--ink)' }}>{s}</li>)}
      </ol>
    );
  }
  if (r.kind === 'module') {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {r.body[0] && <div style={{ fontSize: 12.5, lineHeight: 1.5, color: 'var(--ink)' }}>{r.body[0]}</div>}
        {r.covers?.length > 0 && (
          <div style={{ fontSize: 12, lineHeight: 1.5, color: 'var(--muted)' }}>
            Step-by-step guides: {r.covers.join(', ')}.
          </div>
        )}
      </div>
    );
  }
  return (
    <ul style={{ margin: 0, paddingLeft: r.body.length > 1 ? 18 : 0, listStyle: r.body.length > 1 ? 'disc' : 'none', display: 'flex', flexDirection: 'column', gap: 5 }}>
      {r.body.map((s, i) => <li key={i} style={{ fontSize: 12.5, lineHeight: 1.5, color: 'var(--ink)' }}>{s}</li>)}
    </ul>
  );
}

/**
 * @param {string} subject      ticket title as typed
 * @param {string} description  ticket description as typed
 * @param {() => void} onSolved close the form without creating a ticket
 */
export default function TicketDeflection({ subject, description, onSolved }) {
  const { allow } = useDocAccess();
  const draft = useDebounced(JSON.stringify([subject || '', description || '']), DEFLECT_DEBOUNCE_MS);
  const results = useMemo(() => {
    const [s, d] = JSON.parse(draft);
    // Never let a search problem get in the way of raising the ticket.
    try { return suggestForTicket(s, d, { allow }); } catch { return []; }
  }, [draft, allow]);
  const [pickedId, setOpenId] = useState(null);
  // An article that dropped out of the suggestions as the text changed is no
  // longer open.
  const openId = results.some((r) => r.id === pickedId) ? pickedId : null;
  const [dismissed, setDismissed] = useState(false);

  if (dismissed || results.length === 0) return null;

  const solved = () => {
    showHelpToast('Ticket not submitted. You can open one any time from Support.');
    onSolved?.();
  };

  return (
    <section aria-label="Suggested Articles" data-testid="ticket-deflection"
      style={{ border: '1px solid var(--line)', borderRadius: 10, background: 'var(--mist)', padding: 12, margin: '2px 0 14px' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5, fontWeight: 700, color: 'var(--ink)' }}>
          <BookOpen size={14} style={{ color: BRAND }} /> Suggested Articles
        </span>
        <span style={{ fontSize: 12, color: 'var(--muted)' }}>These might solve it before you submit.</span>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {results.map((r) => {
          const Icon = KIND_ICON[r.kind] || BookOpen;
          const isOpen = openId === r.id;
          const panelId = `deflect-${r.id.replace(/[^a-z0-9-]/gi, '-')}`;
          return (
            <div key={r.id} className="deflect-row">
              <button type="button" className="deflect-head" aria-expanded={isOpen} aria-controls={panelId}
                onClick={() => setOpenId(isOpen ? null : r.id)}>
                <Icon size={14} style={{ color: 'var(--muted)', flexShrink: 0, marginTop: 2 }} />
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ display: 'block', fontSize: 13, fontWeight: 600, lineHeight: 1.35 }}>
                    {r.kind === 'tip' ? r.body[0] : r.title}
                  </span>
                  <span style={{ display: 'block', fontSize: 11.5, color: 'var(--muted)', marginTop: 1 }}>
                    {r.kind === 'module' ? `${r.group} guide` : r.docName}
                  </span>
                </span>
                <ChevronDown size={15} style={{ color: 'var(--muted)', flexShrink: 0, marginTop: 2, transform: isOpen ? 'rotate(180deg)' : 'none', transition: 'transform .15s' }} />
              </button>
              {isOpen && (
                <div id={panelId} style={{ padding: '2px 12px 11px 34px', display: 'flex', flexDirection: 'column', gap: 9 }}>
                  {r.kind !== 'tip' && <ArticleBody r={r} />}
                  <a href={docUrl(r.docId, r.anchor)} target="_blank" rel="noopener noreferrer"
                    style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12, fontWeight: 600, color: BRAND, textDecoration: 'none', alignSelf: 'flex-start' }}>
                    Open Full Article <ExternalLink size={12} />
                  </a>
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginTop: 10 }}>
        <button type="button" onClick={solved}
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 6, padding: '6px 12px', borderRadius: 8,
            border: '1px solid hsla(var(--color-green), 0.45)', background: 'hsla(var(--color-green), 0.1)',
            color: 'hsl(var(--color-green))', fontFamily: 'inherit', fontSize: 12.5, fontWeight: 700, cursor: 'pointer',
          }}>
          <Check size={14} /> This Solved My Problem
        </button>
        <button type="button" onClick={() => setDismissed(true)}
          style={{
            padding: '6px 10px', borderRadius: 8, border: 'none', background: 'transparent',
            color: 'var(--muted)', fontFamily: 'inherit', fontSize: 12.5, fontWeight: 600, cursor: 'pointer',
          }}>
          Still Need Help
        </button>
      </div>
    </section>
  );
}
