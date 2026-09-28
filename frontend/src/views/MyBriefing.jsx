// My Briefing (Sep 26) - the Daily Briefing email as a Nexus page, at /briefing.
//
// Outlook decides how an email looks (its card format fixes colors and
// buttons, and classic Outlook ignores click-to-collapse), so the email stays a
// read-only summary and links here. This page is the interactive version: the
// same three sections and module tables, sections that open and close, and
// Approve / Reject / Comment / React / Change Status / Mark Complete that run
// in place. Content and actions come from backend/routers/daily_briefing.py
// (/daily-briefing/me and /me/act), which reuse the email's own content
// builder and the same action code the email links use.
import { useEffect, useState, useCallback } from 'react';
import { ChevronRight, RefreshCw, Check, AlertCircle } from 'lucide-react';
import { api } from '../api';
import AsyncSection, { SkeletonBlocks } from '../components/AsyncState';
import { formatDate, formatDateTime } from '../lib/datetime';

const FONT = 'Inter, sans-serif';

// Section colors match the email: red / amber / green.
const SECTION_COLOR = {
  action_required: '--color-red',
  needs_to_know: '--color-orange',
  completed: '--color-green',
};
const SUMMARY_LABEL = {
  action_required: 'Need your action',
  needs_to_know: 'Updates for you',
  completed: 'Completed',
};
const MODULE_LABEL = {
  tasks: 'Tasks', tickets: 'Tickets', documents: 'Documents', time_off: 'Time Off',
  timecard: 'Time Card', items: 'Items', team: 'Team',
};
const MODULE_ORDER = ['tasks', 'tickets', 'documents', 'time_off', 'timecard', 'items', 'team'];
const ROWS_SHOWN = 5;
const COLLAPSE_KEY = 'nexus:my-briefing:collapsed';

const hsl = (v, a) => (a == null ? `hsl(var(${v}))` : `hsla(var(${v}), ${a})`);

function readCollapsed() {
  try { return JSON.parse(localStorage.getItem(COLLAPSE_KEY) || '{}') || {}; } catch { return {}; }
}
function writeCollapsed(v) {
  try { localStorage.setItem(COLLAPSE_KEY, JSON.stringify(v)); } catch { /* per-viewer convenience only */ }
}

function groupByModule(rows) {
  const buckets = {};
  rows.forEach((r) => { (buckets[r.module] = buckets[r.module] || []).push(r); });
  const order = [...MODULE_ORDER.filter((m) => buckets[m]), ...Object.keys(buckets).filter((m) => !MODULE_ORDER.includes(m))];
  return order.map((m) => [m, MODULE_LABEL[m] || m.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()), buckets[m]]);
}

const btnBase = {
  fontFamily: FONT, fontSize: 12.5, fontWeight: 600, padding: '6px 13px', borderRadius: 6,
  cursor: 'pointer', lineHeight: 1.2, border: '1px solid transparent',
};
const solid = (v) => ({ ...btnBase, background: hsl(v), borderColor: hsl(v), color: '#fff' });
const outline = { ...btnBase, background: 'var(--card)', borderColor: 'var(--line)', color: 'var(--ink)' };
const textInput = {
  fontFamily: FONT, fontSize: 13, width: '100%', boxSizing: 'border-box', padding: '8px 10px',
  borderRadius: 6, border: '1px solid var(--line)', background: 'var(--card)', color: 'var(--ink)',
};

export default function MyBriefing() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [collapsed, setCollapsed] = useState(readCollapsed);

  const load = useCallback(() => {
    setError(false);
    return api.getMyBriefing()
      .then((d) => setData(d))
      .catch((e) => { console.error('[my-briefing] load failed', e); setError(true); })
      .finally(() => setLoading(false));
  }, []);
  useEffect(() => { load(); }, [load]);

  const toggle = (key) => setCollapsed((c) => { const next = { ...c, [key]: !c[key] }; writeCollapsed(next); return next; });
  const open = (key) => setCollapsed((c) => { const next = { ...c, [key]: false }; writeCollapsed(next); return next; });

  const sections = data?.sections || [];
  return (
    <div style={{ fontFamily: FONT, color: 'var(--ink)', maxWidth: 1040, margin: '0 auto', padding: '8px 0 48px' }}>
      <style>{`
        .mb-row { display: grid; grid-template-columns: minmax(0, 1fr) 34%; gap: 16px; }
        .mb-head { display: grid; grid-template-columns: minmax(0, 1fr) 34%; gap: 16px; }
        .mb-tiles { display: grid; gap: 10px; }
        @media (max-width: 640px) {
          .mb-row { grid-template-columns: 1fr; gap: 4px; }
          .mb-head { display: none; }
          .mb-tiles { gap: 6px; }
          .mb-tile { padding: 10px 10px !important; }
          .mb-tile-n { font-size: 22px !important; }
          .mb-tile-l { font-size: 11.5px !important; }
        }
      `}</style>

      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', marginBottom: 18 }}>
        <div>
          <div style={{ fontSize: 22, fontWeight: 700 }}>
            {data ? `${data.greeting}${data.firstName ? `, ${data.firstName}` : ''}.` : 'My Briefing'}
          </div>
          <div style={{ fontSize: 13.5, color: 'var(--muted)', marginTop: 4 }}>
            {data
              ? `Everything since your last briefing (${formatDateTime(`${data.since}Z`)}), kept up to date.`
              : 'Your daily briefing, with everything you can act on.'}
          </div>
        </div>
        <button style={{ ...outline, display: 'inline-flex', alignItems: 'center', gap: 6 }} onClick={() => { setLoading(true); load(); }}>
          <RefreshCw size={13} /> Refresh
        </button>
      </div>

      <AsyncSection
        loading={loading && !data}
        error={error && !data}
        onRetry={() => { setLoading(true); load(); }}
        errorMessage="Your briefing couldn't be loaded right now - please try again."
        isEmpty={!sections.length}
        skeleton={<SkeletonBlocks count={3} height={110} borderRadius={10} />}
        emptyContent={
          <div style={{ padding: '40px 20px', textAlign: 'center', color: 'var(--muted)', fontSize: 14, border: '1px dashed var(--line)', borderRadius: 10 }}>
            Nothing new since your last briefing.
          </div>
        }
      >
        <div className="mb-tiles" style={{ marginBottom: 22, gridTemplateColumns: `repeat(${sections.length}, minmax(0, 1fr))` }}>
          {sections.map((s) => (
            <button key={s.key} className="mb-tile" onClick={() => { open(s.key); document.getElementById(`mb-${s.key}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' }); }}
              style={{ textAlign: 'left', padding: '14px 16px', borderRadius: 8, border: 'none', cursor: 'pointer',
                background: hsl(SECTION_COLOR[s.key]), color: '#fff', fontFamily: FONT }}>
              <div className="mb-tile-n" style={{ fontSize: 26, fontWeight: 700, lineHeight: 1 }}>{s.rows.length}</div>
              <div className="mb-tile-l" style={{ fontSize: 12.5, marginTop: 6, fontWeight: 500 }}>{SUMMARY_LABEL[s.key] || s.label}</div>
            </button>
          ))}
        </div>

        {sections.map((s) => (
          <Section key={s.key} section={s} collapsed={!!collapsed[s.key]} onToggle={() => toggle(s.key)}
            reactions={data.reactions || []} onChanged={load} />
        ))}
        {data && <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 18 }}>Briefing date {formatDate(data.date)}.</div>}
      </AsyncSection>
    </div>
  );
}

function Section({ section, collapsed, onToggle, reactions, onChanged }) {
  const color = SECTION_COLOR[section.key] || '--color-blue';
  return (
    <section id={`mb-${section.key}`} style={{ marginBottom: 26, scrollMarginTop: 80 }}>
      <button onClick={onToggle} aria-expanded={!collapsed}
        style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 8, padding: '0 0 9px', background: 'none', border: 'none',
          borderBottom: `2px solid ${hsl(color)}`, cursor: 'pointer', fontFamily: FONT, color: 'var(--ink)', textAlign: 'left' }}>
        <ChevronRight size={16} style={{ transform: collapsed ? 'none' : 'rotate(90deg)', transition: 'transform .15s', color: hsl(color) }} />
        <span style={{ fontSize: 16, fontWeight: 700 }}>{section.label}</span>
        <span style={{ fontSize: 14, color: 'var(--muted)' }}>({section.rows.length})</span>
        <span style={{ marginLeft: 'auto', fontSize: 12.5, fontWeight: 600, color: hsl(color) }}>{collapsed ? 'Show' : 'Hide'}</span>
      </button>
      {!collapsed && groupByModule(section.rows).map(([m, label, rows]) => (
        <ModuleTable key={m} label={label} rows={rows} color={color} reactions={reactions} onChanged={onChanged} />
      ))}
    </section>
  );
}

function ModuleTable({ label, rows, color, reactions, onChanged }) {
  const [all, setAll] = useState(false);
  const shown = all ? rows : rows.slice(0, ROWS_SHOWN);
  return (
    <div style={{ marginTop: 16 }}>
      <div style={{ fontSize: 13.5, fontWeight: 600, marginBottom: 7 }}>
        {label} <span style={{ fontWeight: 400, color: 'var(--muted)' }}>({rows.length})</span>
      </div>
      <div style={{ border: `1px solid ${hsl(color, 0.35)}`, borderRadius: 8, overflow: 'hidden', background: hsl(color, 0.05) }}>
        <div className="mb-head" style={{ padding: '8px 14px', background: hsl(color, 0.13), fontSize: 11, fontWeight: 700,
          letterSpacing: '.05em', textTransform: 'uppercase', color: 'var(--muted)' }}>
          <span>Item</span><span>Update</span>
        </div>
        {shown.map((r, i) => (
          <Row key={`${r.title}-${i}`} row={r} color={color} first={i === 0} reactions={reactions} onChanged={onChanged} />
        ))}
        {rows.length > ROWS_SHOWN && (
          <div style={{ padding: '10px 14px', borderTop: `1px solid ${hsl(color, 0.25)}`, background: hsl(color, 0.09) }}>
            <button onClick={() => setAll((v) => !v)} style={{ ...btnBase, padding: 0, background: 'none', color: hsl('--color-green') }}>
              {all ? 'Show Fewer' : `Show All ${rows.length}`}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function Row({ row, color, first, reactions, onChanged }) {
  const [panel, setPanel] = useState('');       // '', comment, react, status, reject:<id>
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);   // { ok, message }

  const act = async (payload) => {
    setBusy(true); setResult(null);
    try {
      const r = await api.actOnMyBriefing(payload);
      setResult({ ok: true, message: r.message || 'Done.' });
      setPanel(''); setText('');
      setTimeout(onChanged, 900);
    } catch (e) {
      setResult({ ok: false, message: e?.message || 'That did not go through. Please try again.' });
    } finally { setBusy(false); }
  };
  const decide = (d, action, note = '') => act({ kind: 'decision', id: d.id, decision_kind: d.kind, action, text: note });
  const task = (action, value = '') => act({ kind: 'task', id: row.taskId, action, text: value });
  // Nexus requires a reason to reject a ticket request; the other decisions need none.
  const reject = (d) => (d.kind === 'ticket_approval' ? setPanel(`reject:${d.id}`) : decide(d, 'reject'));
  const openPanel = (p) => { setPanel((cur) => (cur === p ? '' : p)); setText(p === 'status' ? (row.taskStatus || row.statusOptions?.[0]?.value || '') : ''); };

  const decisionButtons = (d) => (
    <>
      <button disabled={busy} style={solid('--color-green')} onClick={() => decide(d, 'approve')}>Approve</button>
      <button disabled={busy} style={solid('--color-red')} onClick={() => reject(d)}>Reject</button>
    </>
  );
  const rejectPanel = (d) => panel === `reject:${d.id}` && (
    <div style={{ marginTop: 8, display: 'grid', gap: 6 }}>
      <textarea autoFocus rows={2} value={text} onChange={(e) => setText(e.target.value)} placeholder="Reason for rejecting (required)" style={textInput} />
      <div style={{ display: 'flex', gap: 6 }}>
        <button disabled={busy || !text.trim()} style={{ ...solid('--color-red'), opacity: text.trim() ? 1 : 0.5 }} onClick={() => decide(d, 'reject', text.trim())}>Confirm Reject</button>
        <button style={outline} onClick={() => setPanel('')}>Cancel</button>
      </div>
    </div>
  );

  return (
    <div style={{ padding: '13px 14px', borderTop: first ? 'none' : `1px solid ${hsl(color, 0.25)}` }}>
      <div className="mb-row">
        <div style={{ fontSize: 14, fontWeight: 600, lineHeight: 1.4, minWidth: 0, overflowWrap: 'anywhere' }}>
          {row.ref && <span style={{ color: 'var(--muted)', fontWeight: 600, marginRight: 8 }}>{row.ref}</span>}
          {row.title}
        </div>
        <div style={{ fontSize: 13, color: 'var(--muted)', lineHeight: 1.45 }}>{row.detail}</div>
      </div>

      {row.comments?.length > 0 && (
        <div style={{ marginTop: 9, padding: '8px 12px', background: 'var(--card)', borderLeft: `3px solid ${hsl(color, 0.5)}`, borderRadius: 4 }}>
          <div style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: '.05em', textTransform: 'uppercase', color: 'var(--muted)', marginBottom: 3 }}>Recent Comments</div>
          {row.comments.map((c, i) => (
            <div key={i} style={{ fontSize: 12.5, lineHeight: 1.5, padding: '2px 0' }}><b>{c.author}:</b> {c.body}</div>
          ))}
        </div>
      )}

      {row.subDecisions?.map((d) => (
        <div key={d.id} style={{ marginTop: 8, paddingTop: 8, borderTop: `1px dashed ${hsl(color, 0.3)}` }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 13 }}>{d.detail}</span>
            <span style={{ display: 'flex', gap: 6 }}>{decisionButtons(d)}</span>
          </div>
          {rejectPanel(d)}
        </div>
      ))}

      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 10 }}>
        {row.decision && decisionButtons(row.decision)}
        {row.taskId && (
          <>
            <button style={outline} onClick={() => openPanel('comment')}>Comment</button>
            <button style={outline} onClick={() => openPanel('react')}>React</button>
            {row.taskOpen && row.statusOptions?.length > 0 && <button style={outline} onClick={() => openPanel('status')}>Change Status</button>}
            {row.taskOpen && <button disabled={busy} style={outline} onClick={() => task('complete')}>Mark Complete</button>}
          </>
        )}
        {row.path && <a href={row.path} style={{ ...solid('--color-green'), textDecoration: 'none', display: 'inline-block' }}>Open in Nexus</a>}
      </div>
      {row.decision && rejectPanel(row.decision)}

      {panel === 'comment' && (
        <div style={{ marginTop: 8, display: 'grid', gap: 6 }}>
          <textarea autoFocus rows={3} value={text} onChange={(e) => setText(e.target.value)} placeholder="Write a comment" style={textInput} />
          <div style={{ display: 'flex', gap: 6 }}>
            <button disabled={busy || !text.trim()} style={{ ...solid('--color-green'), opacity: text.trim() ? 1 : 0.5 }} onClick={() => task('comment', text.trim())}>Post Comment</button>
            <button style={outline} onClick={() => setPanel('')}>Cancel</button>
          </div>
        </div>
      )}
      {panel === 'react' && (
        <div style={{ marginTop: 8, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {reactions.map((e) => (
            <button key={e} disabled={busy} aria-label={`React ${e}`} style={{ ...outline, fontSize: 16, padding: '4px 10px' }} onClick={() => task('react', e)}>{e}</button>
          ))}
        </div>
      )}
      {panel === 'status' && (
        <div style={{ marginTop: 8, display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
          <select value={text} onChange={(e) => setText(e.target.value)} style={{ ...textInput, width: 'auto', minWidth: 180 }}>
            {row.statusOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
          <button disabled={busy} style={solid('--color-green')} onClick={() => task('status', text)}>Update Status</button>
          <button style={outline} onClick={() => setPanel('')}>Cancel</button>
        </div>
      )}

      {result && (
        <div role="status" style={{ marginTop: 8, display: 'flex', alignItems: 'center', gap: 6, fontSize: 12.5, fontWeight: 600,
          color: result.ok ? hsl('--color-green') : hsl('--color-red') }}>
          {result.ok ? <Check size={14} /> : <AlertCircle size={14} />} {result.message}
        </div>
      )}
    </div>
  );
}
