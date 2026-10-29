// Kudos (Neil, Oct 29 2026: "add all the bigger features"): a short
// thank-you from one colleague to another, seen across the recipient's
// company. Never deleted - the sender or HR takes one down.
// backend/perf_feedback.py holds the rules.
import { useCallback, useEffect, useState } from 'react';
import { Award, Plus, EyeOff } from 'lucide-react';
import { api } from '../api';
import { Modal, Avatar, PersonSelect, usePeople } from '../tasks/components';
import { SkeletonBlocks, ErrorBanner } from '../components/AsyncState';
import { formatDate } from '../lib/datetime';
import { Segmented } from './MyNumbers';
import { card, cardHead, HD, LBL, muted } from './lib';

const MAX = 500;

export function GiveKudosModal({ me, to = '', onClose, onGiven, toastErr }) {
  const people = usePeople();
  const [who, setWho] = useState(to);
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const choices = people.filter(p => !p.external && p.email !== me);
  async function send() {
    if (!who) { toastErr?.('Pick who the kudos are for.'); return; }
    setBusy(true);
    try { onGiven?.(await api.perfKudosGive({ to: who, message: msg })); }
    catch (e) { toastErr?.(e?.message || 'Could not send the kudos.'); }
    finally { setBusy(false); }
  }
  return (
    <Modal title="Give Kudos" onClose={onClose} isDirty={!!msg.trim()}
      footer={<>
        <button type="button" className="secondary-btn" onClick={onClose}>Cancel</button>
        <button type="button" className="primary-btn" disabled={busy || !who || msg.trim().length < 3} onClick={send}>{busy ? 'Sending' : 'Send Kudos'}</button>
      </>}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, flex: 1, minHeight: 0 }}>
        <div style={muted}>Everyone in their company sees it, and so do they and their manager.</div>
        <label style={{ display: 'grid', gap: 5 }}>
          <span style={LBL}>For</span>
          <PersonSelect value={who} onChange={setWho} people={choices} allowNone={false} placeholder="Pick a colleague" ariaLabel="For" />
        </label>
        <label className="nx-fill" style={{ display: 'flex', flexDirection: 'column', gap: 5, flex: 1 }}>
          <span style={LBL}>What They Did <span style={{ fontWeight: 400 }}>({msg.length} of {MAX})</span></span>
          <textarea className="form-input" value={msg} onChange={e => setMsg(e.target.value.slice(0, MAX))} rows={5}
            placeholder="Stayed late to get the Escondido walkthrough ready - the client noticed." style={{ fontSize: 16, resize: 'vertical', flex: 1, minHeight: 110 }} />
        </label>
      </div>
    </Modal>
  );
}

export function KudosList({ items, onHide, empty }) {
  if (!items.length) return <div style={muted}>{empty}</div>;
  return (
    <div className="nx-perf-list" role="list">
      {items.map(k => (
        <div key={k.id} className="nx-perf-row nx-perf-kudo" role="listitem">
          <Avatar email={k.fromEmail} name={k.fromName} size={28} card={false} />
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 13, color: 'var(--muted)' }}>
              <strong style={{ color: 'var(--ink)', fontWeight: 600 }}>{k.fromName}</strong> to <strong style={{ color: 'var(--ink)', fontWeight: 600 }}>{k.toName}</strong> · {formatDate(k.createdAt)}
            </div>
            <div style={{ fontSize: 13.5, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', marginTop: 2 }}>{k.message}</div>
          </div>
          {k.can?.hide && onHide && (
            <button type="button" className="nx-perf-icon-btn" onClick={() => onHide(k)} aria-label="Take Down" title="Take Down"><EyeOff size={15} /></button>
          )}
        </div>
      ))}
    </div>
  );
}

// The Kudos card: For You (to me and from me) and Everyone (my company).
// `person` - someone else's page: the kudos they received.
export function KudosCard({ ctx, person = '', name = '', focusId = '', toastOk, toastErr }) {
  const [tab, setTab] = useState(focusId ? 'mine' : 'company');
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  const [give, setGive] = useState(false);
  const load = useCallback(() => {
    const p = person ? api.perfKudos({ scope: 'person', person }) : api.perfKudos({ scope: tab });
    return p.then(r => { setErr(''); setData(r); }).catch(e => setErr(e?.message || 'Could not load the kudos.'));
  }, [person, tab]);
  useEffect(() => { load(); }, [load]);
  const hide = async (k) => {
    try { await api.perfKudosHide(k.id); toastOk?.('Taken down.'); load(); }
    catch (e) { toastErr?.(e?.message || 'Could not take it down.'); }
  };
  const first = (name || '').split(' ')[0];
  return (
    <section style={card} aria-label="Kudos">
      <div style={cardHead}>
        <span className="wkc-chip"><Award size={14} /></span>
        <span style={HD}>Kudos</span>
        {!person && data?.receivedLast90 > 0 && <span style={muted}>{data.receivedLast90} for you in 90 days</span>}
        <button type="button" className="secondary-btn" onClick={() => setGive(true)}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 6, marginLeft: 'auto', minHeight: 36 }}>
          <Plus size={14} /> {person ? `Give ${first || 'Them'} Kudos` : 'Give Kudos'}
        </button>
      </div>
      {!person && (
        <div style={{ marginBottom: 10 }}>
          <Segmented label="Whose kudos" value={tab} onChange={(v) => { setData(null); setTab(v); }}
            options={[{ key: 'company', label: 'Everyone' }, { key: 'mine', label: 'Yours' }]} />
        </div>
      )}
      {err ? <ErrorBanner message={err} onRetry={load} /> : data === null ? <SkeletonBlocks count={2} height={48} /> : (
        <div style={{ maxHeight: 420, overflowY: 'auto' }}>
          <KudosList items={data.items || []} onHide={hide}
            empty={person ? `No kudos for ${first || 'them'} yet.` : tab === 'mine' ? 'No kudos to or from you yet.' : 'No kudos yet - be the first to thank someone.'} />
        </div>
      )}
      {give && <GiveKudosModal me={ctx?.email} to={person} onClose={() => setGive(false)} toastErr={toastErr}
        onGiven={(k) => { setGive(false); toastOk?.(`Kudos sent to ${k.toName}.`); load(); }} />}
    </section>
  );
}
