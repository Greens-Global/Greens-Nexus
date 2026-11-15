// The phone New Task composer's pickers (Neil, 11/15/2026, plan
// https://claude.ai/artifact/EzwJbKJsvrGRWwtH1Ui4Ji, Option B). A chip on the
// composer opens one of these IN the sheet (BottomSheet's back arrow returns
// to the composer), never a dropdown over the form: the old desktop popovers
// covered the very fields above them on a phone.
//   DuePicker      - Today / Tomorrow / Friday / Next Monday, then a month
//   PeoplePicker   - the curated Nexus People list (usePeople), searchable, several
//   ProjectPicker  - No Project, then the live projects A to Z, searchable
//   PriorityPicker - Urgent / High / Medium / Low
// Dates are the person's own local day (lib.todayISO) and read MM/DD/YYYY.
import { useMemo, useState } from 'react';
import { Check, ChevronLeft, ChevronRight, Flag, FolderKanban, Search } from 'lucide-react';
import { NX, FONT, btn, PRIORITY_META, PRIORITY_ORDER } from './theme';
import { Avatar } from './components';
import { todayISO } from './lib';
import { duePresets } from './composerLib';
import { formatDate, formatWeekday } from '../lib/datetime';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const pad = (n) => String(n).padStart(2, '0');
const isoOf = (y, m, d) => `${y}-${pad(m + 1)}-${pad(d)}`;

const rowStyle = {
  display: 'flex', alignItems: 'center', gap: 12, width: '100%', minHeight: 52, padding: '0 4px',
  border: 'none', borderBottom: `1px solid ${NX.border2 || NX.border}`, background: 'transparent',
  fontFamily: FONT, fontSize: 15, color: NX.ink, textAlign: 'left', cursor: 'pointer',
};
const sideText = { marginLeft: 'auto', fontSize: 14, color: NX.dim, display: 'inline-flex', alignItems: 'center', gap: 6 };

export function DuePicker({ value, onPick, today = todayISO() }) {
  const presets = duePresets(today);
  const start = value || today;
  const [cursor, setCursor] = useState(() => ({ y: Number(start.slice(0, 4)), m: Number(start.slice(5, 7)) - 1 }));
  const first = new Date(cursor.y, cursor.m, 1).getDay();
  const days = new Date(cursor.y, cursor.m + 1, 0).getDate();
  const atTodayMonth = cursor.y === Number(today.slice(0, 4)) && cursor.m === Number(today.slice(5, 7)) - 1;
  const step = (n) => setCursor(({ y, m }) => { const d = new Date(y, m + n, 1); return { y: d.getFullYear(), m: d.getMonth() }; });
  const cells = [...Array(first).fill(null), ...Array.from({ length: days }, (_, i) => i + 1)];
  return (
    <div style={{ fontFamily: FONT }}>
      <div role="group" aria-label="Quick Dates">
        {presets.map((p) => (
          <button key={p.iso} type="button" onClick={() => onPick(p.iso)} aria-pressed={value === p.iso}
            style={{ ...rowStyle, color: value === p.iso ? NX.primary : NX.ink, fontWeight: value === p.iso ? 600 : 400 }}>
            {p.label}
            <span style={sideText}>{formatWeekday(p.iso, 'short')} {formatDate(p.iso)}{value === p.iso && <Check size={16} style={{ color: NX.primary }} />}</span>
          </button>
        ))}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', margin: '16px 0 6px' }}>
        <div style={{ fontSize: 15, fontWeight: 700 }} aria-live="polite">{MONTHS[cursor.m]} {cursor.y}</div>
        <div style={{ display: 'flex', gap: 4 }}>
          <button type="button" aria-label="Previous Month" disabled={atTodayMonth} onClick={() => step(-1)}
            style={{ ...btn('ghost'), width: 40, height: 40, padding: 0, justifyContent: 'center', opacity: atTodayMonth ? 0.35 : 1 }}><ChevronLeft size={18} /></button>
          <button type="button" aria-label="Next Month" onClick={() => step(1)}
            style={{ ...btn('ghost'), width: 40, height: 40, padding: 0, justifyContent: 'center' }}><ChevronRight size={18} /></button>
        </div>
      </div>
      <div role="grid" aria-label={`${MONTHS[cursor.m]} ${cursor.y}`} style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 2, textAlign: 'center' }}>
        {['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((d, i) => <div key={i} aria-hidden="true" style={{ fontSize: 12, color: NX.faint, padding: '4px 0' }}>{d}</div>)}
        {cells.map((d, i) => {
          if (!d) return <div key={`b${i}`} />;
          const iso = isoOf(cursor.y, cursor.m, d);
          const past = iso < today;
          const on = iso === value;
          return (
            <button key={iso} type="button" disabled={past} onClick={() => onPick(iso)} aria-pressed={on}
              aria-label={`${formatWeekday(iso)} ${formatDate(iso)}${iso === today ? ', today' : ''}`}
              style={{
                height: 42, border: iso === today && !on ? `1.5px solid ${NX.primary}` : '1.5px solid transparent', borderRadius: '50%',
                background: on ? NX.primary : 'transparent', color: on ? '#fff' : past ? NX.faint : NX.ink,
                fontFamily: FONT, fontSize: 15, fontWeight: on ? 700 : 400, cursor: past ? 'default' : 'pointer', opacity: past ? 0.45 : 1,
                fontVariantNumeric: 'tabular-nums',
              }}>{d}</button>
          );
        })}
      </div>
    </div>
  );
}

function SearchBox({ value, onChange, placeholder, label }) {
  return (
    <label style={{ display: 'flex', alignItems: 'center', gap: 8, height: 44, padding: '0 12px', border: `1px solid ${NX.border}`, borderRadius: 12, marginBottom: 6, background: NX.surface }}>
      <Search size={16} style={{ color: NX.faint, flexShrink: 0 }} aria-hidden="true" />
      <input className="nx-inline-edit" value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} aria-label={label} enterKeyHint="search"
        style={{ flex: 1, minWidth: 0, border: 'none', fontFamily: FONT, fontSize: 16, color: NX.ink }} /> {/* type-ok: below 16px iOS zooms into the box */}
    </label>
  );
}

const match = (q, ...texts) => { const s = q.trim().toLowerCase(); return !s || texts.some((t) => String(t || '').toLowerCase().includes(s)); };

export function PeoplePicker({ people, value, onChange, myEmail }) {
  const [q, setQ] = useState('');
  const list = useMemo(() => {
    const rank = (p) => (value.includes(p.email) ? 0 : p.email === myEmail ? 1 : 2);
    return people.filter((p) => match(q, p.name, p.email))
      .slice().sort((a, b) => rank(a) - rank(b) || String(a.name).localeCompare(String(b.name), 'en', { sensitivity: 'base' }));
    // Re-sorted when the search changes, not on every tick - a row must not jump away from the thumb that just ticked it.
  }, [people, q, myEmail]); // eslint-disable-line react-hooks/exhaustive-deps
  const toggle = (email) => onChange(value.includes(email) ? value.filter((e) => e !== email) : [...value, email]);
  return (
    <div style={{ fontFamily: FONT }}>
      <SearchBox value={q} onChange={setQ} placeholder="Search people" label="Search People" />
      <div role="group" aria-label="People">
        {list.map((p) => {
          const on = value.includes(p.email);
          return (
            <button key={p.email} type="button" aria-pressed={on} onClick={() => toggle(p.email)} style={rowStyle}>
              <Avatar email={p.email} name={p.name} size={30} card={false} />
              <span style={{ minWidth: 0, display: 'flex', flexDirection: 'column' }}>
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: on ? 600 : 400 }}>{p.email === myEmail ? `${p.name} (You)` : p.name}</span>
                <span style={{ fontSize: 12, color: NX.faint, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.email}</span>
              </span>
              <span style={sideText}>{on && <Check size={18} style={{ color: NX.primary }} />}</span>
            </button>
          );
        })}
        {!list.length && <div style={{ padding: '18px 4px', fontSize: 14, color: NX.faint }}>{people.length ? 'No one matches that search.' : 'Loading people...'}</div>}
      </div>
    </div>
  );
}

export function ProjectPicker({ projects, value, onPick }) {
  const [q, setQ] = useState('');
  const live = projects.filter((p) => !p.archived)
    .slice().sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'en', { sensitivity: 'base' }));
  const rows = [{ id: '', name: 'No Project' }, ...live].filter((p) => !p.id || match(q, p.name));
  return (
    <div style={{ fontFamily: FONT }}>
      {live.length > 6 && <SearchBox value={q} onChange={setQ} placeholder="Search projects" label="Search Projects" />}
      <div role="group" aria-label="Projects">
        {rows.map((p) => (
          <button key={p.id || 'none'} type="button" aria-pressed={value === p.id} onClick={() => onPick(p.id)}
            style={{ ...rowStyle, color: !p.id ? NX.dim : NX.ink, fontWeight: value === p.id ? 600 : 400 }}>
            <FolderKanban size={18} style={{ color: p.id ? (p.color || NX.dim) : NX.faint, flexShrink: 0 }} aria-hidden="true" />
            <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name}</span>
            <span style={sideText}>{value === p.id && <Check size={18} style={{ color: NX.primary }} />}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

export function PriorityPicker({ value, onPick }) {
  return (
    <div role="group" aria-label="Priority" style={{ fontFamily: FONT }}>
      {PRIORITY_ORDER.map((k) => (
        <button key={k} type="button" aria-pressed={value === k} onClick={() => onPick(k)}
          style={{ ...rowStyle, fontWeight: value === k ? 600 : 400 }}>
          <Flag size={18} style={{ color: PRIORITY_META[k].color, flexShrink: 0 }} aria-hidden="true" />
          {PRIORITY_META[k].label}
          <span style={sideText}>{value === k && <Check size={18} style={{ color: NX.primary }} />}</span>
        </button>
      ))}
    </div>
  );
}
