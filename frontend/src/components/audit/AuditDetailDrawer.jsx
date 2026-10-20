// The Audit Log's detail drawer (Oct 20 2026): one event in full - every field
// before -> after, who / when / where, the Act As explanation, the request it
// came from and the other events of that request - and the Record History
// view, the record's whole timeline oldest first, so the state at any point
// ("what was it before") reads straight down the page.
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X, History, Link2, ChevronLeft, ExternalLink, Check } from 'lucide-react';
import { api } from '../../api';
import { SkeletonBlocks, ErrorBanner } from '../AsyncState';
import { useIsMobile } from '../../lib/useIsMobile';
import { useScrollLock } from '../../lib/useScrollLock';
import { useDialogFocus } from '../../lib/useDialogFocus';
import { useBackToClose } from '../../lib/useBackToClose';
import { PersonAvatar, ModuleBadge, ActAsBadge, ActionIcon, ChangesTable, AMBER, AMBER_BG } from './AuditParts';
import { exactDateTime, relativeTime } from './auditModel';

const label = { fontSize: 11, fontWeight: 600, color: 'var(--muted)', letterSpacing: '.02em' };
const sectionTitle = { fontSize: 12.5, fontWeight: 700, color: 'var(--ink)', margin: '22px 0 8px' };

function Fact({ name, children, mono }) {
  if (children === undefined || children === null || children === '') return null;
  return (
    <div style={{ minWidth: 0 }}>
      <div style={label}>{name}</div>
      <div style={{ fontSize: 13, color: 'var(--ink)', marginTop: 2, overflowWrap: 'anywhere', fontFamily: mono ? 'ui-monospace, monospace' : 'inherit' }}>{children}</div>
    </div>
  );
}

export function TargetLink({ target, onOpenTarget, size = 13 }) {
  if (!target) return null;
  const text = target.label || target.id;
  if (!target.link?.view) return <span style={{ fontSize: size, color: 'var(--ink)' }}>{text}</span>;
  return (
    <button type="button" onClick={(e) => { e.stopPropagation(); onOpenTarget(target.link); }}
      style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: 'var(--wk-brand, var(--pine))', fontSize: size, fontWeight: 600, fontFamily: 'inherit', display: 'inline-flex', alignItems: 'center', gap: 4, textAlign: 'left' }}>
      {text} <ExternalLink size={size - 1} aria-hidden="true" />
    </button>
  );
}

function ActAsNote({ ev, nameOf }) {
  if (!ev.actingAs) return null;
  const who = nameOf(ev.actor?.email, ev.actor?.name) || 'Someone';
  const as = nameOf(ev.actingAs.email, ev.actingAs.name);
  return (
    <div role="note" style={{ display: 'flex', gap: 10, padding: '10px 12px', borderRadius: 10, background: AMBER_BG, border: '1px solid rgba(180,83,9,0.25)', color: AMBER, fontSize: 13, lineHeight: 1.5, marginTop: 14 }}>
      <div>
        <strong>{who}</strong> made this change while acting as <strong>{as}</strong>.
        <div style={{ color: 'var(--muted)', fontSize: 12 }}>It ran with {as}'s access. The audit always records the real person at the keyboard.</div>
      </div>
    </div>
  );
}

function RelatedList({ related, onOpen, nameOf }) {
  if (!related?.length) return null;
  return (
    <>
      <div style={sectionTitle}>Same Request</div>
      <div style={{ border: '1px solid var(--line)', borderRadius: 10, overflow: 'hidden' }}>
        {related.map((r, i) => (
          <button key={r.id} type="button" onClick={() => onOpen(r)}
            style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', textAlign: 'left', padding: '9px 12px', border: 'none', borderTop: i ? '1px solid var(--line)' : 'none', background: 'none', cursor: 'pointer', fontFamily: 'inherit', fontSize: 12.5, color: 'var(--ink)' }}>
            <ActionIcon action={r.action} />
            <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.title}</span>
            <span style={{ color: 'var(--muted)', fontSize: 11.5, flexShrink: 0 }}>{nameOf(r.actor?.email, r.actor?.name)}</span>
          </button>
        ))}
      </div>
    </>
  );
}

function EventBody({ ev, detail, loading, error, nameOf, onOpenTarget, onOpenRelated, onRetry }) {
  const full = detail || ev;
  const actor = nameOf(full.actor?.email, full.actor?.name) || 'System';
  const req = full.request;
  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <PersonAvatar email={full.actor?.email} name={actor} size={36} />
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 14, fontWeight: 700 }}>{actor}</div>
          {full.actor?.email && <div style={{ fontSize: 12, color: 'var(--muted)' }}>{full.actor.email}</div>}
        </div>
        {full.actingAs && <ActAsBadge name={nameOf(full.actingAs.email, full.actingAs.name)} />}
      </div>
      <ActAsNote ev={full} nameOf={nameOf} />
      {full.summary && <p style={{ fontSize: 13, color: 'var(--muted)', lineHeight: 1.5, margin: '14px 0 0' }}>{full.summary}</p>}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: '12px 18px', marginTop: 16, padding: 14, border: '1px solid var(--line)', borderRadius: 10 }}>
        <Fact name="When">{exactDateTime(full.at)}<span style={{ color: 'var(--muted)' }}> ({relativeTime(full.at)})</span></Fact>
        <Fact name="Module"><ModuleBadge module={full.module} label={full.moduleLabel} /></Fact>
        <Fact name="Record">{full.target ? <TargetLink target={full.target} onOpenTarget={onOpenTarget} /> : null}</Fact>
        <Fact name="IP Address" mono>{full.ip}</Fact>
        <Fact name="Source">{full.source}</Fact>
        <Fact name="Request" mono>{req?.path ? `${req.method || ''} ${req.path}${req.status ? ` (${req.status})` : ''}`.trim() : null}</Fact>
      </div>

      {full.undone && (
        <div style={{ marginTop: 12, fontSize: 12.5, color: 'var(--muted)' }}>This change was undone later.</div>
      )}

      {error ? (
        <div style={{ marginTop: 18 }}><ErrorBanner message={error} onRetry={onRetry} /></div>
      ) : loading ? (
        <div style={{ marginTop: 18 }}><SkeletonBlocks count={3} height={44} borderRadius={8} /></div>
      ) : (
        <>
          {full.changes?.length > 0 && (
            <>
              <div style={sectionTitle}>What Changed ({full.changes.length})</div>
              <ChangesTable changes={full.changes} />
            </>
          )}
          {full.legacy && full.facts?.length > 0 && (
            <>
              <div style={sectionTitle}>Details</div>
              <div style={{ border: '1px solid var(--line)', borderRadius: 10, padding: '4px 14px' }}>
                {full.facts.map(f => (
                  <div key={f.field} style={{ display: 'grid', gridTemplateColumns: 'minmax(110px, 180px) 1fr', gap: 12, padding: '7px 0', fontSize: 13 }}>
                    <span style={{ color: 'var(--muted)', fontSize: 12, fontWeight: 600 }}>{f.label}</span>
                    <span style={{ overflowWrap: 'anywhere' }}>{f.value}</span>
                  </div>
                ))}
              </div>
              <p style={{ fontSize: 12, color: 'var(--muted)', marginTop: 8 }}>This entry comes from the older log, which did not keep the prior values.</p>
            </>
          )}
          {!full.legacy && !full.changes?.length && (
            <p style={{ fontSize: 12.5, color: 'var(--muted)', marginTop: 18 }}>No field changes were recorded for this event.</p>
          )}
          <RelatedList related={full.related} onOpen={onOpenRelated} nameOf={nameOf} />
        </>
      )}
    </>
  );
}

function HistoryBody({ target, nameOf, onOpenEvent }) {
  const [state, setState] = useState({ loading: true, error: '', events: [] });
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let alive = true;
    setState({ loading: true, error: '', events: [] });
    api.auditRecordHistory(target.type, target.id)
      .then(r => { if (alive) setState({ loading: false, error: '', events: r?.events || [] }); })
      .catch(e => { if (alive) setState({ loading: false, error: e?.status === 404 ? 'Record History is not available yet.' : (e?.message || 'Could not load the history.'), events: [] }); });
    return () => { alive = false; };
  }, [target.type, target.id, tick]);

  if (state.error) return <ErrorBanner message={state.error} onRetry={() => setTick(t => t + 1)} />;
  if (state.loading) return <SkeletonBlocks count={4} height={70} borderRadius={10} />;
  if (!state.events.length) return <p style={{ fontSize: 13, color: 'var(--muted)' }}>No history has been recorded for this record yet.</p>;
  return (
    <ol aria-label="Record History" style={{ listStyle: 'none', margin: 0, padding: 0, position: 'relative' }}>
      {state.events.map((ev, i) => {
        const actor = nameOf(ev.actor?.email, ev.actor?.name) || 'System';
        return (
          <li key={ev.id} style={{ display: 'grid', gridTemplateColumns: '24px 1fr', gap: 12, paddingBottom: 18 }}>
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
              <span style={{ width: 24, height: 24, borderRadius: '50%', border: '1px solid var(--line)', background: 'var(--card)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 10.5, fontWeight: 700, color: 'var(--muted)' }}>{i + 1}</span>
              {i < state.events.length - 1 && <span style={{ flex: 1, width: 1, background: 'var(--line)', marginTop: 4 }} />}
            </div>
            <div style={{ minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <ActionIcon action={ev.action} />
                <button type="button" onClick={() => onOpenEvent(ev)}
                  style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontFamily: 'inherit', fontSize: 13, fontWeight: 600, color: 'var(--ink)', textAlign: 'left' }}>
                  {ev.title}
                </button>
                {ev.actingAs && <ActAsBadge compact name={nameOf(ev.actingAs.email, ev.actingAs.name)} />}
              </div>
              <div style={{ fontSize: 12, color: 'var(--muted)', margin: '2px 0 8px' }}>
                {actor} · {exactDateTime(ev.at)}
              </div>
              {ev.changes?.length > 0 && <ChangesTable changes={ev.changes} />}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

export default function AuditDetailDrawer({ event, onClose, onOpenEvent, onOpenTarget, onCopyLink, nameOf }) {
  const isMobile = useIsMobile();
  const panelRef = useRef(null);
  const [detail, setDetail] = useState(null);
  const [loading, setLoading] = useState(!event.legacy);
  const [error, setError] = useState('');
  const [tick, setTick] = useState(0);
  const [view, setView] = useState('event');   // 'event' | 'history'
  const [copied, setCopied] = useState(false);
  useScrollLock(true);
  useDialogFocus(panelRef);
  useBackToClose(isMobile, () => (view === 'history' ? setView('event') : onClose()));

  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      e.preventDefault();
      if (view === 'history') setView('event'); else onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [view, onClose]);

  useEffect(() => {
    setView('event');
    if (event.legacy) { setDetail(null); setLoading(false); setError(''); return undefined; }
    let alive = true;
    setLoading(true); setError(''); setDetail(null);
    api.auditEvent(event.id)
      .then(d => { if (alive) { setDetail(d); setLoading(false); } })
      .catch(e => { if (alive) { setError(e?.message || 'Could not load this event.'); setLoading(false); } });
    return () => { alive = false; };
  }, [event.id, event.legacy, tick]);

  const full = detail || event;
  const target = full.target;
  const canHistory = !!(target?.type && target?.id) && !full.legacy;

  const copy = () => {
    onCopyLink(event.id);
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  };

  const iconBtn = { background: 'none', border: '1px solid var(--line)', borderRadius: 8, cursor: 'pointer', color: 'var(--ink)', display: 'inline-flex', alignItems: 'center', gap: 5, padding: '5px 10px', fontSize: 12, fontWeight: 600, fontFamily: 'inherit' };

  return createPortal(
    <div onMouseDown={(e) => e.target === e.currentTarget && onClose()}
      style={{ position: 'fixed', inset: 0, background: 'rgba(17,24,39,0.38)', zIndex: 3500, display: 'flex', justifyContent: 'flex-end' }}>
      <aside ref={panelRef} tabIndex={-1} role="dialog" aria-modal="true" aria-label={view === 'history' ? 'Record History' : 'Audit Event'}
        style={{
          width: isMobile ? '100vw' : 'min(100vw, max(420px, 60vw))', height: '100%', background: 'var(--card)',
          borderLeft: '1px solid var(--line)', boxShadow: '-8px 0 40px rgba(0,0,0,0.16)', display: 'flex', flexDirection: 'column',
          fontFamily: 'Inter, sans-serif',
        }}>
        <header style={{ padding: '14px 20px', borderBottom: '1px solid var(--line)', display: 'flex', alignItems: 'center', gap: 10 }}>
          {view === 'history' ? (
            <button type="button" onClick={() => setView('event')} aria-label="Back to Event" style={{ ...iconBtn, border: 'none', padding: 4 }}>
              <ChevronLeft size={18} />
            </button>
          ) : <ActionIcon action={full.action} size={16} />}
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 15, fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: isMobile ? 'normal' : 'nowrap' }}>
              {view === 'history' ? 'Record History' : (full.title || 'Loading...')}
            </div>
            <div style={{ fontSize: 12, color: 'var(--muted)' }}>
              {view === 'history' ? (target?.label || target?.id) : `${exactDateTime(full.at)}`}
            </div>
          </div>
          {view === 'event' && !full.legacy && (
            <button type="button" onClick={copy} style={iconBtn} title="Copy a link to this event">
              {copied ? <Check size={13} /> : <Link2 size={13} />} {isMobile ? '' : copied ? 'Copied' : 'Copy Link'}
            </button>
          )}
          {view === 'event' && canHistory && (
            <button type="button" onClick={() => setView('history')} style={iconBtn}>
              <History size={13} /> {isMobile ? '' : 'Record History'}
            </button>
          )}
          <button type="button" onClick={onClose} aria-label="Close" style={{ ...iconBtn, border: 'none', padding: 4, color: 'var(--muted)' }}><X size={18} /></button>
        </header>
        <div style={{ flex: 1, overflowY: 'auto', padding: '18px 20px 28px' }}>
          {view === 'history' && canHistory ? (
            <HistoryBody target={target} nameOf={nameOf} onOpenEvent={(ev) => { setView('event'); onOpenEvent(ev); }} />
          ) : (
            <EventBody ev={event} detail={detail} loading={loading} error={error} nameOf={nameOf}
              onOpenTarget={onOpenTarget} onOpenRelated={onOpenEvent} onRetry={() => setTick(t => t + 1)} />
          )}
        </div>
      </aside>
    </div>,
    document.body,
  );
}
