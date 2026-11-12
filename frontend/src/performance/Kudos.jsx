// Kudos (Neil, Oct 29 2026: "add all the bigger features"): a short
// thank-you from one colleague to another, seen across the recipient's
// company. Never deleted - the sender or HR takes one down.
// Thanks, the value tag and the Teams post (Neil, 11/08/2026): anyone but
// the sender adds their thanks once (an optional one-line note) and the
// recipient's one bell grows in place; a kudos may carry one of the
// company's values; the send form may post it to the Teams chat Settings
// names. backend/perf_feedback.py holds the rules.
// Kudos on Teams, both ways (Neil, 11/12/2026): the post goes to the
// company's channel; a reaction or reply there comes back as that person's
// thanks (their emoji beside the names), reactions from people outside Nexus
// are a count, and Open in Teams goes to the post (backend/perf_kudos_teams.py).
import { useCallback, useEffect, useState } from 'react';
import { Award, Plus, EyeOff } from 'lucide-react';
import { api } from '../api';
import { Modal, Avatar, PersonSelect, usePeople } from '../tasks/components';
import { SkeletonBlocks, ErrorBanner } from '../components/AsyncState';
import { StatusLabel } from '../components/StatusLabel';
import { Switch } from '../components/settings/SettingsUI';
import { formatDate } from '../lib/datetime';
import { Segmented } from './MyNumbers';
import { card, cardHead, HD, LBL, muted } from './lib';

const MAX = 500;
const NOTE_MAX = 200;
const VALUE_COLOR = '#0f766e';
const TEXT_BTN = { border: 'none', background: 'none', padding: 0, font: 'inherit', fontSize: 13, fontWeight: 600, color: 'var(--brand, #1a7f4b)', cursor: 'pointer' };

export function ValueLabel({ value, size = 'sm' }) {
  return value ? <StatusLabel label={value} color={VALUE_COLOR} size={size} title="The value they lived" /> : null;
}

// The chip picker: "Which value did they live?" - one of the company's list, or none.
export function ValuePicker({ values = [], value, onChange }) {
  if (!values.length) return null;
  return (
    <div style={{ display: 'grid', gap: 6 }}>
      <span style={LBL}>Which Value Did They Live? <span style={{ fontWeight: 400 }}>(optional)</span></span>
      <div role="group" aria-label="Which value did they live?" style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {values.map(v => {
          const on = v === value;
          return (
            <button key={v} type="button" aria-pressed={on} onClick={() => onChange(on ? '' : v)}
              style={{ padding: '4px 11px', borderRadius: 999, fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit',
                border: `1px solid ${on ? VALUE_COLOR : 'var(--line)'}`, background: on ? `${VALUE_COLOR}14` : 'transparent', color: on ? VALUE_COLOR : 'var(--ink)' }}>
              {v}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function GiveKudosModal({ me, to = '', onClose, onGiven, toastErr }) {
  const people = usePeople();
  const [who, setWho] = useState(to);
  const [msg, setMsg] = useState('');
  const [value, setValue] = useState('');
  const [teams, setTeams] = useState(true);
  const [busy, setBusy] = useState(false);
  // The recipient's company decides the values and the Teams chat (read once a recipient is picked).
  const [opts, setOpts] = useState({ values: [], teamsChat: false, teamsPlace: '' });
  useEffect(() => {
    if (!who) { setOpts({ values: [], teamsChat: false, teamsPlace: '' }); return undefined; }
    let on = true;
    api.perfKudosOptions(who).then(o => { if (on) { setOpts({ values: o?.values || [], teamsChat: !!o?.teamsChat, teamsPlace: o?.teamsPlace || '' }); setValue(v => ((o?.values || []).includes(v) ? v : '')); } })
      .catch(() => { if (on) setOpts({ values: [], teamsChat: false, teamsPlace: '' }); });
    return () => { on = false; };
  }, [who]);
  const { values, teamsChat, teamsPlace } = opts;
  const choices = people.filter(p => !p.external && p.email !== me);
  async function send() {
    if (!who) { toastErr?.('Pick who the kudos are for.'); return; }
    setBusy(true);
    try { onGiven?.(await api.perfKudosGive({ to: who, message: msg, value, post_teams: teamsChat && teams })); }
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
        <ValuePicker values={values} value={value} onChange={setValue} />
        <label className="nx-fill" style={{ display: 'flex', flexDirection: 'column', gap: 5, flex: 1 }}>
          <span style={LBL}>What They Did <span style={{ fontWeight: 400 }}>({msg.length} of {MAX})</span></span>
          <textarea className="form-input" value={msg} onChange={e => setMsg(e.target.value.slice(0, MAX))} rows={5}
            placeholder="Stayed late to get the Escondido walkthrough ready - the client noticed." style={{ fontSize: /* type-ok: iOS zooms a field under 16px */ 16, resize: 'vertical', flex: 1, minHeight: 110 }} />
        </label>
        {teamsChat && (
          <label style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 13, color: 'var(--ink)' }}>
            <Switch checked={teams} onChange={setTeams} label="Also post to Teams" />
            <span>Also post to Teams{teamsPlace && <span style={{ color: 'var(--muted)' }}> - {teamsPlace}</span>}</span>
          </label>
        )}
      </div>
    </Modal>
  );
}

// Names in a sentence: "Marco, Ana and 3 others".
export function thanksSentence(names) {
  if (names.length <= 2) return names.join(' and ');
  if (names.length === 3) return `${names[0]}, ${names[1]} and ${names[2]}`;
  return `${names[0]}, ${names[1]} and ${names.length - 2} others`;
}

// The thanks row under a kudos: who added theirs (click to read the notes),
// your own entry with Take Back, and the quiet Add Your Thanks button that
// opens a one-line note inline.
export function ThanksRow({ k, me, onThank, onUnthank }) {
  const recipient = me === k.toEmail;   // the recipient's thanks is the reply (Say Thanks)
  const [adding, setAdding] = useState(false);
  const [note, setNote] = useState('');
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const others = (k.thanks || []).filter(t => t.email !== me);
  const mine = k.myThanks;
  const first = (n) => (n || '').split(' ')[0];
  async function add() {
    setBusy(true);
    try { await onThank(k, note.trim()); setAdding(false); setNote(''); }
    finally { setBusy(false); }
  }
  const withNotes = (k.thanks || []).filter(t => t.note);
  // The emoji people used on the Teams post, once each.
  const reactions = [...new Set(others.map(t => t.reaction).filter(Boolean))].join(' ');
  const outside = k.teams?.others || 0;
  return (
    <div style={{ marginTop: 6, display: 'grid', gap: 4, fontSize: 13, color: 'var(--muted)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        {others.length > 0 && (
          <button type="button" onClick={() => setOpen(o => !o)} aria-expanded={open} disabled={!withNotes.length}
            style={{ ...TEXT_BTN, color: 'var(--muted)', fontWeight: 500, cursor: withNotes.length ? 'pointer' : 'default', textAlign: 'left' }}>
            {reactions && <span aria-hidden="true">{reactions} </span>}{thanksSentence(others.map(t => first(t.name)))} added their thanks
          </button>
        )}
        {outside > 0 && <span>{outside} {outside === 1 ? 'person' : 'people'} on Teams reacted</span>}
        {k.teams?.url && (
          <a href={k.teams.url} target="_blank" rel="noopener noreferrer" style={{ ...TEXT_BTN, fontWeight: 500 }}>Open in Teams</a>
        )}
        {mine ? (
          <span>{recipient ? 'You said thanks' : 'You added your thanks'}{k.can?.takeBack && <> · <button type="button" style={TEXT_BTN} disabled={busy} onClick={() => onUnthank(k)}>Take Back</button></>}</span>
        ) : k.can?.thank && !adding ? (
          <button type="button" style={TEXT_BTN} onClick={() => setAdding(true)}>{recipient ? 'Say Thanks' : 'Add Your Thanks'}</button>
        ) : null}
      </div>
      {open && withNotes.length > 0 && (
        <div style={{ display: 'grid', gap: 2, paddingLeft: 8, borderLeft: '2px solid var(--line)' }}>
          {withNotes.map(t => <div key={t.email}><strong style={{ color: 'var(--ink)', fontWeight: 600 }}>{first(t.name)}</strong> {t.note}{t.via === 'teams' && <span> · on Teams</span>}</div>)}
        </div>
      )}
      {adding && (
        <form onSubmit={e => { e.preventDefault(); add(); }} style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
          <input className="form-input" value={note} onChange={e => setNote(e.target.value.slice(0, NOTE_MAX))} autoFocus
            placeholder="A word of your own (optional)" aria-label="Your note" style={{ fontSize: /* type-ok: iOS zooms a field under 16px */ 16, flex: '1 1 200px', minWidth: 0, padding: '6px 10px' }} />
          <button type="submit" className="primary-btn" disabled={busy} style={{ minHeight: 32, padding: '4px 12px' }}>Add</button>
          <button type="button" className="secondary-btn" disabled={busy} onClick={() => { setAdding(false); setNote(''); }} style={{ minHeight: 32, padding: '4px 12px' }}>Cancel</button>
        </form>
      )}
    </div>
  );
}

export function KudosList({ items, me = '', onHide, onThank, onUnthank, empty, compact = false }) {
  if (!items.length) return <div style={muted}>{empty}</div>;
  return (
    <div className="nx-perf-list" role="list">
      {items.map(k => (
        <div key={k.id} className="nx-perf-row nx-perf-kudo" role="listitem">
          <Avatar email={k.fromEmail} name={k.fromName} size={28} card={false} />
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 13, color: 'var(--muted)', display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
              <span><strong style={{ color: 'var(--ink)', fontWeight: 600 }}>{k.fromName}</strong> to <strong style={{ color: 'var(--ink)', fontWeight: 600 }}>{k.toName}</strong> · {formatDate(k.createdAt)}</span>
              <ValueLabel value={k.value} />
            </div>
            <div style={{ fontSize: 13, whiteSpace: compact ? 'nowrap' : 'pre-wrap', overflow: compact ? 'hidden' : undefined, textOverflow: compact ? 'ellipsis' : undefined, overflowWrap: 'anywhere', marginTop: 2 }}>
              {compact ? (k.message || '').split('\n')[0] : k.message}
            </div>
            {onThank && <ThanksRow k={k} me={me} onThank={onThank} onUnthank={onUnthank} />}
          </div>
          {k.can?.hide && onHide && (
            <button type="button" className="nx-perf-icon-btn" onClick={() => onHide(k)} aria-label="Take Down" title="Take Down"><EyeOff size={15} /></button>
          )}
        </div>
      ))}
    </div>
  );
}

// Add or take back a thanks and put the server's row in place of the old one.
export function useThanks(setData, toastErr) {
  const swap = useCallback((row) => setData(d => (d ? { ...d, items: (d.items || []).map(k => (k.id === row.id ? row : k)) } : d)), [setData]);
  const thank = useCallback(async (k, note) => {
    try { swap(await api.perfKudosThank(k.id, note)); }
    catch (e) { toastErr?.(e?.message || 'Could not add your thanks.'); }
  }, [swap, toastErr]);
  const unthank = useCallback(async (k) => {
    try { swap(await api.perfKudosUnthank(k.id)); }
    catch (e) { toastErr?.(e?.message || 'Could not take it back.'); }
  }, [swap, toastErr]);
  return { thank, unthank };
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
  const { thank, unthank } = useThanks(setData, toastErr);
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
          <KudosList items={data.items || []} me={ctx?.email} onHide={hide} onThank={thank} onUnthank={unthank}
            empty={person ? `No kudos for ${first || 'them'} yet.` : tab === 'mine' ? 'No kudos to or from you yet.' : 'No kudos yet - be the first to thank someone.'} />
        </div>
      )}
      {give && <GiveKudosModal me={ctx?.email} to={person} onClose={() => setGive(false)} toastErr={toastErr}
        onGiven={(k) => { setGive(false); toastOk?.(`Kudos sent to ${k.toName}.`); load(); }} />}
    </section>
  );
}

// The Dashboard widget (Neil, 11/08/2026): the company feed's latest six,
// Add Your Thanks inline, See All to Workday > Performance.
export function KudosWidget({ me = '' }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  const [note, setNote] = useState('');   // a failed thank says so under the list, never silently
  const load = useCallback(() => api.perfKudos({ scope: 'company', limit: 6 }).then(r => { setErr(''); setData(r); }).catch(e => setErr(e?.message || 'Could not load the kudos.')), []);
  useEffect(() => { load(); }, [load]);
  const say = useCallback((m) => { setNote(m); setTimeout(() => setNote(''), 5000); }, []);
  const { thank, unthank } = useThanks(setData, say);
  const go = () => window.dispatchEvent(new CustomEvent('nexus:navigate', { detail: { view: 'myhr', sub: 'performance' } }));
  return (
    <div className="dash-card" style={{ height: '100%', boxSizing: 'border-box', display: 'flex', flexDirection: 'column' }}>
      <div className="dash-card-head" style={{ marginBottom: 10, gap: 8 }}>
        <div className="dash-card-title">Kudos</div>
        <button type="button" className="secondary-btn" onClick={go} style={{ fontSize: 12, padding: '4px 10px', minHeight: 30 }}>See All</button>
      </div>
      <div className="dash-scroll" style={{ flex: 1, minHeight: 0 }}>
        {err ? <ErrorBanner message={err} onRetry={load} /> : data === null ? <SkeletonBlocks count={2} height={48} /> : (
          <KudosList items={(data.items || []).slice(0, 6)} me={me} onThank={thank} onUnthank={unthank} compact
            empty="No kudos yet - be the first to thank someone." />
        )}
        {note && <div role="alert" style={{ marginTop: 8, fontSize: 13, color: 'var(--red, #b91c1c)' }}>{note}</div>}
      </div>
    </div>
  );
}
