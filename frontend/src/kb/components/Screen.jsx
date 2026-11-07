// A REALISTIC Nexus screen drawn from data (Neil, 11/07/2026: "use realistic
// screenshots, not real"). A lesson describes a screen - the module, its tabs
// and buttons, the parts of the page in order, a dialog over it - and this
// draws it in the app's own vocabulary (the rail, the header, the tiles, the
// Time Clock dial, the yellow priority bar, a sheet from the right) at
// figure size, with numbered callouts. Nothing here is a picture of a real
// screen, so it carries no real name, number or tenant.
//
//   { device: 'computer' | 'phone', module, sub, tabs: [], tab, actions: [], badge,
//     parts: [ { kind, ... } ], callouts: [ { n, text } ] }
//
// Part kinds: tiles | card | clock | table | form | list | banner | dialog |
// sheet | bell | toast | text (backend/kb_seed/academy/README.md has the keys).
import { Bell, Search, Home, Briefcase, Ticket, Users, BookOpen, LifeBuoy, Package, ChevronLeft, Check, Camera, Play, Pause, Square } from 'lucide-react';

const RAIL = [['Dashboard', Home], ['Workday', Briefcase], ['Tickets', Ticket], ['People', Users], ['Items', Package], ['Training', BookOpen], ['Help Center', LifeBuoy]];

const N = ({ n }) => (n ? <i className="kb-scr-n" aria-label={`callout ${n}`}>{n}</i> : null);

function Btn({ b, small }) {
  const o = typeof b === 'string' ? { label: b } : b || {};
  return (
    <span className={`kb-scr-btn${o.primary ? ' pri' : ''}${o.tone ? ` ${o.tone}` : ''}${small ? ' sm' : ''}`}>
      {o.label}<N n={o.n} />
    </span>
  );
}
const Buttons = ({ list, small }) => (list && list.length ? <div className="kb-scr-btns">{list.map((b, i) => <Btn key={i} b={b} small={small} />)}</div> : null);

function Tiles({ p }) {
  return (
    <div className="kb-scr-tiles">
      {(p.items || []).map((t, i) => <div key={i} className="kb-scr-tile"><b>{t.value}</b><span>{t.label}</span><N n={t.n} /></div>)}
    </div>
  );
}

function Card({ p }) {
  return (
    <div className="kb-scr-card">
      <N n={p.n} />
      {p.title && <div className="kb-scr-card-t">{p.title}</div>}
      {p.note && <div className="kb-scr-muted">{p.note}</div>}
      {(p.rows || []).map((r, i) => (
        <div key={i} className={`kb-scr-row${r.tone ? ` ${r.tone}` : ''}`}><span>{r.label}</span><b>{r.value}</b><N n={r.n} /></div>
      ))}
      {p.text && <div className="kb-scr-p">{p.text}</div>}
      {(p.fields || []).map((f, i) => <Field key={i} f={f} />)}
      <Buttons list={p.buttons} small />
    </div>
  );
}

function Clock({ p }) {
  const state = p.state || 'out';
  const dash = state === 'out' ? 0 : state === 'break' ? 40 : 68;
  return (
    <div className={`kb-scr-card kb-scr-clock ${state}`}>
      <N n={p.n} />
      <div className="kb-scr-card-t">{p.title || 'Time Clock'}</div>
      <div className="kb-scr-clock-main">
        <svg viewBox="0 0 48 48" className="kb-scr-dial" aria-hidden="true">
          <circle cx="24" cy="24" r="20" fill="none" stroke="var(--kb-line)" strokeWidth="5" />
          {dash > 0 && <circle cx="24" cy="24" r="20" fill="none" stroke="currentColor" strokeWidth="5" strokeLinecap="round" strokeDasharray={`${(dash / 100) * 125.6} 125.6`} transform="rotate(-90 24 24)" />}
          <g transform="translate(24 24)" fill="currentColor">
            {state === 'out' ? <Play size={14} x={-6} y={-7} /> : state === 'break' ? <Pause size={14} x={-7} y={-7} /> : <Square size={12} x={-6} y={-6} />}
          </g>
        </svg>
        <div className="kb-scr-clock-txt">
          <b>{p.value}</b>
          <span>{p.label}</span>
        </div>
      </div>
      {p.tabs && <div className="kb-scr-seg">{p.tabs.map((t, i) => <span key={i} className={t === p.tab ? 'on' : ''}>{t}</span>)}</div>}
      <Buttons list={p.buttons} />
    </div>
  );
}

function Table({ p }) {
  return (
    <div className="kb-scr-card kb-scr-tablewrap">
      <N n={p.n} />
      {p.title && <div className="kb-scr-card-t">{p.title}</div>}
      <table className="kb-scr-table">
        {p.columns && <thead><tr>{p.columns.map((c, i) => <th key={i}>{c}</th>)}</tr></thead>}
        <tbody>
          {(p.rows || []).map((r, i) => <tr key={i}>{(Array.isArray(r) ? r : [r]).map((c, j) => <td key={j}>{c}</td>)}</tr>)}
        </tbody>
      </table>
    </div>
  );
}

function Field({ f }) {
  const kind = f.kind || 'text';
  return (
    <div className={`kb-scr-field ${kind}`}>
      {kind === 'check' ? (
        <label><span className={`kb-scr-check${f.value ? ' on' : ''}`}>{f.value && <Check size={10} />}</span>{f.label}<N n={f.n} /></label>
      ) : (
        <>
          <label>{f.label}<N n={f.n} /></label>
          <div className={`kb-scr-input ${kind}${f.value ? '' : ' empty'}`}>{f.value || f.hint || ''}{kind === 'select' && <span className="kb-scr-caret">▾</span>}</div>
          {f.value && f.hint && <small>{f.hint}</small>}
        </>
      )}
    </div>
  );
}

function Form({ p }) {
  return (
    <div className="kb-scr-card">
      <N n={p.n} />
      {p.title && <div className="kb-scr-card-t">{p.title}</div>}
      {p.text && <div className="kb-scr-p">{p.text}</div>}
      {(p.fields || []).map((f, i) => <Field key={i} f={f} />)}
      <Buttons list={p.buttons} />
    </div>
  );
}

function List({ p }) {
  return (
    <div className="kb-scr-card">
      <N n={p.n} />
      {p.title && <div className="kb-scr-card-t">{p.title}</div>}
      {(p.items || []).map((it, i) => (
        <div key={i} className="kb-scr-item">
          <span className="kb-scr-item-t"><b>{it.label}</b>{it.note && <span>{it.note}</span>}</span>
          {it.badge && <em className={`kb-scr-badge${it.tone ? ` ${it.tone}` : ''}`}>{it.badge}</em>}
          <N n={it.n} />
        </div>
      ))}
      <Buttons list={p.buttons} small />
    </div>
  );
}

function Banner({ p }) {
  return (
    <div className={`kb-scr-banner ${p.tone || ''}`}>
      <span>{p.text}</span>
      <Buttons list={p.buttons} small />
      <N n={p.n} />
    </div>
  );
}

function Dialog({ p, sheet }) {
  return (
    <div className={`kb-scr-scrim${sheet ? ' sheet' : ''}`}>
      <div className={`kb-scr-dialog${sheet ? ' sheet' : ''}`}>
        <N n={p.n} />
        {p.title && <div className="kb-scr-card-t">{p.title}</div>}
        {p.text && <div className="kb-scr-p">{p.text}</div>}
        {(p.fields || []).map((f, i) => <Field key={i} f={f} />)}
        {(p.items || []).map((it, i) => (
          <div key={i} className="kb-scr-item"><span className="kb-scr-item-t"><b>{it.label}</b>{it.note && <span>{it.note}</span>}</span>{it.badge && <em className={`kb-scr-badge${it.tone ? ` ${it.tone}` : ''}`}>{it.badge}</em>}<N n={it.n} /></div>
        ))}
        <Buttons list={p.buttons} />
      </div>
    </div>
  );
}

function BellPanel({ p }) {
  return (
    <div className="kb-scr-bellpanel">
      <N n={p.n} />
      <div className="kb-scr-bell-top"><b>{p.title || 'Notifications'}</b><span>{p.text}</span></div>
      {(p.items || []).map((it, i) => (
        <div key={i} className="kb-scr-item"><span className="kb-scr-dot" /><span className="kb-scr-item-t"><b>{it.label}</b>{it.note && <span>{it.note}</span>}</span><N n={it.n} /></div>
      ))}
      <Buttons list={p.buttons} small />
    </div>
  );
}

const Toast = ({ p }) => <div className="kb-scr-toast"><span>{p.text}</span><Buttons list={p.buttons} small /><N n={p.n} /></div>;
const Text = ({ p }) => <div className="kb-scr-p page">{p.title && <b>{p.title}</b>}{p.text}<N n={p.n} /></div>;

const PARTS = { tiles: Tiles, card: Card, clock: Clock, table: Table, form: Form, list: List, banner: Banner, bell: BellPanel, toast: Toast, text: Text };

export default function Screen({ d }) {
  const phone = d.device === 'phone';
  const bare = d.device === 'card';   // no rail, no header: a sign-in page, a dialog on its own
  const parts = d.parts || [];
  const overlays = parts.filter((p) => p.kind === 'dialog' || p.kind === 'sheet');
  const body = parts.filter((p) => p.kind !== 'dialog' && p.kind !== 'sheet');
  const tabs = d.tabs || [];
  return (
    <div className="kb-scr-wrap">
      <div className={`kb-scr ${phone ? 'kb-scr--phone' : bare ? 'kb-scr--card' : 'kb-scr--computer'}`} role="img" aria-label={`${d.module || 'Nexus'} screen`}>
        {bare ? null : phone ? (
          <div className="kb-scr-status"><span>9:41</span><span>●●●● ▲ ▮</span></div>
        ) : (
          <div className="kb-scr-rail">
            <span className="kb-scr-ntile">N</span>
            {RAIL.map(([label, Icon]) => <span key={label} className={`kb-scr-nav${label === d.module ? ' on' : ''}`}><Icon size={13} /><span>{label}</span></span>)}
          </div>
        )}
        <div className="kb-scr-main">
          {!bare && <div className="kb-scr-top">
            <div className="kb-scr-title">
              {d.sub && <span className="kb-scr-sub">{phone ? <ChevronLeft size={11} /> : '← '}{d.sub}</span>}
              <b>{d.module || 'Nexus'}</b>
            </div>
            {tabs.length > 0 && <div className="kb-scr-tabs">{tabs.map((t, i) => <span key={i} className={t === d.tab ? 'on' : ''}>{t}</span>)}</div>}
            <div className="kb-scr-right">
              {(d.actions || []).map((a, i) => <Btn key={i} b={a} small />)}
              {!phone && <span className="kb-scr-ico"><Search size={12} /></span>}
              <span className="kb-scr-ico bell"><Bell size={12} />{d.badge ? <em>{d.badge}</em> : null}</span>
            </div>
          </div>}
          <div className="kb-scr-stage">
            <div className={`kb-scr-body${overlays.length ? ' under' : ''}`}>
              {body.map((p, i) => { const P = PARTS[p.kind]; return P ? <P key={i} p={p} /> : null; })}
            </div>
            {overlays.map((p, i) => <Dialog key={i} p={p} sheet={p.kind === 'sheet'} />)}
          </div>
        </div>
      </div>
      {d.callouts && d.callouts.length > 0 && (
        <ol className="kb-scr-callouts">
          {d.callouts.map((c, i) => <li key={i}><i className="kb-scr-n">{c.n ?? i + 1}</i><span>{c.text}</span></li>)}
        </ol>
      )}
      <span className="kb-scr-note"><Camera size={11} /> A drawing of the screen, not a photo of one.</span>
    </div>
  );
}
