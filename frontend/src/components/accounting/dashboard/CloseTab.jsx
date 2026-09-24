import { useState } from 'react';
import { TARGET_CLOSE_DAY } from '../../../accounting/dashboard/model/close';
import { fmtMD, monthLabel, monthLong, mShort, shiftKey, whenTxt } from '../../../accounting/dashboard/model/months';
import { pctTxt } from '../../../accounting/dashboard/model/money';
import { BAD, Chip, EmptyBox, Footnote, GroupRow, LoadingBox, Panel, SectionTabs, Tile, input, mono, num, toneColor } from './Bits';
import { ColoredBars, Lines } from './Charts';
import { useDash } from './DashContext';
import { Toolbar } from './Filters';
import { useCloseState, useFlux, useNotes } from './hooks';
import { WidgetPanel, useDashNav } from './registry';

// Close tab: pace against the target day, the shared checklist, account
// reconciliations, balance-sheet flux with explanations, intercompany, bank
// lines to code, activity, and days-to-close history. One section at a time.

const SECTIONS = ['checklist', 'recon', 'flux', 'controls'];

// Checklist views (Priyanka, Sep 24): My Tasks / All Tasks / Overdue, with
// My Tasks the default once a bookkeeper has said who they are. A task's
// owner is a role name ("Bookkeeper", "Controller") or a person's name, so
// "mine" means tasks whose owner is the role picked here or my own name.
const TASK_VIEWS = [{ id: 'mine', label: 'My Tasks' }, { id: 'all', label: 'All Tasks' }, { id: 'overdue', label: 'Overdue' }];
const ROLE_LS = 'nexus-accounting-close-role';
const readRole = () => { try { return JSON.parse(localStorage.getItem(ROLE_LS) || '{}') || {}; } catch { return {}; } };
const isMine = (r, role, me) => {
  const o = (r.owner || '').trim().toLowerCase();
  return !!o && (o === (role || '').trim().toLowerCase() || (!!me && o === me.trim().toLowerCase()));
};

export default function CloseTab({ canEdit, meName = '' }) {
  const { period, act, m } = useDash();
  const [closePref, setClosePref] = useState(() => { const s = readRole(); return { role: s.role || '', view: s.view || 'all' }; });
  const role = closePref.role;
  const view = closePref.view;
  const savePref = (next) => { setClosePref(next); try { localStorage.setItem(ROLE_LS, JSON.stringify(next)); } catch { /* private mode */ } };
  const setView = (v) => savePref({ ...closePref, view: v });
  const setRole = (r) => savePref({ role: r, view: r ? 'mine' : closePref.view === 'mine' ? 'all' : closePref.view });
  const showRow = (r) => (view === 'all' ? true : view === 'overdue' ? r.state === 'past_due' : isMine(r, role, meName));
  const nav = useDashNav();
  const { state, history, isLoading } = useCloseState();
  const { rows: flux, hasPrior } = useFlux();
  const { flux: fluxNotes } = useNotes();
  const [busy, setBusy] = useState(null);
  const [drafts, setDrafts] = useState({});
  const [section, setSection] = useState('checklist');

  const toggle = async (r) => {
    setBusy(r.id);
    try { await act('close-task', { period, task_id: r.id, done: !r.done, detail: `${r.title} · ${monthLong(period)}` }); } finally { setBusy(null); }
  };
  const explain = async (r) => {
    const text = (drafts[r.gl] ?? '').trim() || r.suggestion;
    if (!text) return;
    setBusy(`flux:${r.gl}`);
    try { await act('note', { period, kind: 'flux', key: r.gl, body: text, detail: `${r.gl} ${r.name} · ${monthLong(period)}` }); } finally { setBusy(null); }
  };
  const recordDay = () => state && act('close-day', { period, day: state.dayN });

  const prevKey = shiftKey(period, 1);
  const prevClosed = history.find((h) => h.period === prevKey)?.closed_day;
  const last6 = history.filter((h) => h.period <= period).slice(-6);
  const avg = last6.length ? last6.reduce((t, h) => t + h.closed_day, 0) / last6.length : null;
  const explained = flux.filter((r) => fluxNotes.has(r.gl)).length;
  const paceData = state ? Array.from({ length: 13 }, (_, d) => ({ label: String(d), planned: state.planned[d], actual: d === 0 ? 0 : (state.actual[d - 1] ?? null) })) : [];
  const grid = { display: 'grid', gridTemplateColumns: 'repeat(12, minmax(0, 1fr))', gap: 14 };
  const wide = typeof window !== 'undefined' && window.innerWidth >= 900;
  const col = (n) => ({ gridColumn: `span ${wide ? n : 12}` });
  const tabs = [
    { id: 'checklist', label: 'Checklist', badge: state ? `${state.nDone}/${state.n}` : undefined },
    { id: 'recon', label: 'Reconciliations' },
    { id: 'flux', label: 'Balance Sheet Flux', badge: hasPrior ? `${explained}/${flux.length}` : undefined },
    { id: 'controls', label: 'Controls & Activity' },
  ];

  return (
    <div style={{ display: 'grid', gap: 14 }}>
      <Toolbar right={state ? <Chip tone={state.status === 'Behind' ? 'bad' : state.status === 'Closed' ? 'ok' : 'neutral'}>{state.status}{state.late.length ? ` · ${state.late.length} past due` : ''}</Chip> : null} />
      <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>Close · {monthLong(period)}{state ? ` · Business day ${state.dayN} · target close day ${TARGET_CLOSE_DAY} (${fmtMD(state.targetDate)})` : ''}</div>
      {isLoading || !state ? <LoadingBox height={84} /> : state.n ? (
        <div className="cards-grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 12 }}>
          <Tile label="Tasks complete" value={`${state.nDone}/${state.n}`} sub={pctTxt(state.nDone / state.n, 0)} />
          <Tile label="Past due" value={<span style={{ color: state.late.length ? BAD : undefined }}>{state.late.length}</span>} sub={state.late.length ? state.late.slice(0, 2).map((t) => t.title).join('; ') : 'nothing overdue'} />
          <Tile label="Last month closed" value={prevClosed != null ? `day ${prevClosed}` : '-'} sub={avg != null ? `6-month avg day ${avg.toFixed(1)}` : 'no history yet'} />
          <Tile label="Target" value={`day ${TARGET_CLOSE_DAY}`} sub={fmtMD(state.targetDate)} />
        </div>
      ) : null}
      <SectionTabs tabs={tabs} value={SECTIONS.includes(section) ? section : 'checklist'} onChange={setSection} />

      {section === 'checklist' ? (
        <div style={grid}>
          <Panel title="Close pace" sub={state ? `${state.nDone} of ${state.n} tasks complete · ${state.expected} expected by today` : undefined} style={col(5)}
            right={canEdit && state?.status === 'Closed' && !history.some((h) => h.period === period) ? <button type="button" className="secondary-btn" style={{ fontSize: '0.7rem', padding: '2px 8px' }} onClick={recordDay}>Record close day {state.dayN}</button> : null}>
            {isLoading || !state ? <LoadingBox /> : !state.n ? <EmptyBox title="No close plan yet" body="Add the checklist under the Data tab. A default plan is seeded for new companies." /> : (
              <>
                <Lines data={paceData} xKey="label" height={170} series={[{ key: 'planned', label: 'Planned pace', color: '#0998c3', dashed: true }, { key: 'actual', label: 'Completed', color: 'var(--wk-brand, #2b45e1)' }]} />
                <Footnote>Business day since period end (0 to 12). Target day {TARGET_CLOSE_DAY}.</Footnote>
              </>
            )}
          </Panel>
          <Panel title="Close checklist" sub="Tick a task and everyone sees who completed it" style={col(7)} bodyStyle={{ padding: 0 }}
            right={state?.n ? (
              <span style={{ display: 'inline-flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
                <select value={role} onChange={(e) => setRole(e.target.value)} style={{ ...input, padding: '3px 6px', fontSize: '0.74rem' }} aria-label="My close role">
                  <option value="">I am... (not set)</option>
                  {[...new Set(state.rows.map((r) => (r.owner || '').trim()).filter(Boolean))].sort().map((o) => <option key={o} value={o}>I am {o}</option>)}
                </select>
                <span style={{ display: 'inline-flex', border: '1px solid var(--border-color)', borderRadius: 8, padding: 2 }}>
                  {TASK_VIEWS.map((t) => (
                    <button key={t.id} type="button" onClick={() => setView(t.id)} aria-pressed={view === t.id}
                      style={{ border: 'none', borderRadius: 6, padding: '2px 8px', font: 'inherit', fontSize: '0.72rem', fontWeight: 600, cursor: 'pointer', background: view === t.id ? 'var(--wk-brand, #2b45e1)' : 'transparent', color: view === t.id ? '#fff' : 'var(--text-secondary)' }}>
                      {t.label}{t.id === 'overdue' && state.late.length ? ` (${state.late.length})` : ''}
                    </button>
                  ))}
                </span>
              </span>
            ) : null}>
            {isLoading || !state ? <LoadingBox /> : !state.n ? <EmptyBox title="No tasks" style={{ margin: 16 }} /> : !state.rows.some(showRow) ? (
              <EmptyBox style={{ margin: 16 }} title={view === 'overdue' ? 'Nothing overdue' : view === 'mine' && !role ? 'Pick who you are' : 'No tasks for you this month'} body={view === 'mine' && !role ? 'Choose your role (Bookkeeper, Controller...) in the box above and My Tasks lists what is yours.' : undefined} />
            ) : (
              <table className="req-table">
                <thead><tr><th style={{ width: 32 }} /><th>Task</th><th>Owner</th><th>Due</th><th>Status</th></tr></thead>
                <tbody>
                  {state.phases.filter((p) => p.rows.some(showRow)).map((p) => (
                    <PhaseRows key={p.phase} title={`${p.phase} · ${p.done}/${p.rows.length}`}>
                      {p.rows.filter(showRow).map((r) => (
                        <tr key={r.id} style={r.done ? { color: 'var(--text-muted)' } : undefined}>
                          <td><input type="checkbox" checked={!!r.done} disabled={!canEdit || busy === r.id} onChange={() => toggle(r)} aria-label={`${r.done ? 'Reopen' : 'Complete'} ${r.title}`} /></td>
                          <td style={r.done ? { textDecoration: 'line-through' } : undefined}>{r.title}</td>
                          <td style={{ fontSize: '0.78rem' }}>{r.owner}</td>
                          <td style={{ fontSize: '0.78rem', fontVariantNumeric: 'tabular-nums' }}>Day {r.day_offset} · {fmtMD(r.due)}</td>
                          <td>{r.done ? <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}><Chip tone="ok">Done</Chip><span style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>{r.done.completed_by} · {whenTxt(r.done.completed_at)}</span></span> : r.state === 'past_due' ? <Chip tone="bad">Past due</Chip> : r.state === 'due_today' ? <Chip tone="wait">Due today</Chip> : <Chip>Open</Chip>}</td>
                        </tr>
                      ))}
                    </PhaseRows>
                  ))}
                </tbody>
              </table>
            )}
          </Panel>
        </div>
      ) : null}

      {section === 'recon' ? <WidgetPanel id="recon" compact={false} /> : null}

      {section === 'flux' ? (
        <Panel title="Balance sheet flux - explain changes over $25K or 10%" sub={hasPrior ? `${explained} of ${flux.length} explained` : 'No prior month to compare'} bodyStyle={{ padding: 0 }} onOpenReport={() => nav('reports')}>
          {!hasPrior ? <EmptyBox title="No prior month to compare." style={{ margin: 16 }} /> : !flux.length ? <EmptyBox title="No material balance changes" style={{ margin: 16 }} /> : (
            <table className="req-table" style={{ fontVariantNumeric: 'tabular-nums' }}>
              <thead><tr><th>Account</th><th style={num}>{mShort(prevKey)}</th><th style={num}>{mShort(period)}</th><th style={num}>Change</th><th style={{ width: '38%' }}>Explanation</th></tr></thead>
              <tbody>
                {flux.map((r) => {
                  const note = fluxNotes.get(r.gl);
                  return (
                    <tr key={r.id}>
                      <td><span style={mono}>{r.gl}</span>{r.name}</td>
                      <td style={{ ...num, color: 'var(--text-muted)' }}>{m(r.prior, { paren: true })}</td>
                      <td style={num}>{m(r.balance, { paren: true })}</td>
                      <td style={{ ...num, color: toneColor(r.change >= 0) }}>{m(r.change, { paren: true })}<div style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>{r.prior ? pctTxt(r.changePct, 0) : 'new'}</div></td>
                      <td>
                        {note ? <div style={{ fontSize: '0.84rem' }}>{note.body}<div style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>{note.written_by} · {whenTxt(note.written_at)}</div></div> : canEdit ? (
                          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                            <input value={drafts[r.gl] ?? ''} onChange={(e) => setDrafts((d) => ({ ...d, [r.gl]: e.target.value }))} placeholder={r.suggestion ? `Suggested: ${r.suggestion}` : 'Why did this move?'} style={{ ...input, flex: 1 }} />
                            <button type="button" className="secondary-btn" style={{ fontSize: '0.72rem', padding: '3px 10px' }} disabled={busy === `flux:${r.gl}` || (!(drafts[r.gl] ?? '').trim() && !r.suggestion)} onClick={() => explain(r)}>Save</button>
                          </div>
                        ) : <span style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>Not explained yet</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </Panel>
      ) : null}

      {section === 'controls' ? (
        <div style={grid}>
          <div style={col(4)}><WidgetPanel id="ic" style={{ height: '100%' }} /></div>
          <div style={col(8)}><WidgetPanel id="uncat" style={{ height: '100%' }} /></div>
          <div style={col(6)}><WidgetPanel id="activity" style={{ height: '100%' }} /></div>
          <Panel title="Days to close · last six months" style={col(6)}>
            {!last6.length ? <EmptyBox title="No close history yet" body="When a month reaches Closed, record its close day and it charts here." /> : (
              <>
                <ColoredBars data={last6.map((h) => ({ label: monthLabel(h.period), value: h.closed_day, color: h.closed_day <= 7 ? 'var(--wk-brand, #2b45e1)' : '#d97706' }))} height={150} valueLabel={(v) => `day ${v}`} />
                <Footnote>Target is business day {TARGET_CLOSE_DAY}. Months in the brand color closed in seven days or fewer.</Footnote>
              </>
            )}
          </Panel>
        </div>
      ) : null}
    </div>
  );
}

function PhaseRows({ title, children }) {
  return (<><GroupRow title={title} cols={5} />{children}</>);
}
