import { useMemo, useState } from 'react';
import { AlertTriangle, Download, Link2 } from 'lucide-react';
import { api } from '../api';
import LinesPanel from '../components/accounting/LinesPanel';
import { Spinner } from '../components/AsyncState';
import { formatDate } from '../lib/datetime';
import { formatCurrency } from './lib/format';
import { ErrorState, LoadingState, Modal, useIrLoad } from './lib/ui';

// Investor Relations, live from Intacct (Neil, 11/11/2026). A deal IS an
// Intacct entity (Greens Austin, LLC = 67000) and an investor IS their own
// partner equity accounts (300xx E&C, 310xx Contribution, 320xx
// Distribution). Every figure here is read live through the accounting proxy
// (routers/investor_books.py); the server answers {allowed: false, reason}
// to anyone without Accounting access to the entity, and this screen then
// shows the reason and no figure. Posted figures open their ledger lines in
// the side panel (LinesPanel).

const KIND_PREFIX = { ec: '300', contributed: '310', distributed: '320' };
const num = { textAlign: 'right', fontVariantNumeric: 'tabular-nums' };

function Head({ title, sub, right }) {
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 10, marginBottom: 10 }}>
      <div>
        <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.06em', color: 'var(--ink)' }}>{title}</div>
        {sub && <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 3 }}>{sub}</div>}
      </div>
      {right}
    </div>
  );
}

const Muted = ({ children }) => <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>{children}</div>;

// An amount that opens the ledger lines behind it (when it has accounts).
function Amt({ value, onDrill, color }) {
  const text = formatCurrency(value);
  if (!onDrill) return <span style={{ color }}>{text}</span>;
  return (
    <button type="button" onClick={(e) => { e.stopPropagation(); onDrill(); }} title="Show the ledger lines"
      style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', font: 'inherit', color: color || 'inherit', textDecoration: 'underline dotted', textUnderlineOffset: 3 }}>
      {text}
    </button>
  );
}

function useDrill() {
  const [drill, setDrill] = useState(null);
  // One ledger search per account, up to `to`, on one entity.
  const open = (title, accounts, location, to, from) => setDrill({
    title, queries: accounts.map(account => ({ account, location, to, ...(from ? { from } : {}) })),
  });
  const panel = drill && (
    <LinesPanel title={drill.title} queries={drill.queries} widthsKey="ir-books" label="Ledger Lines" onClose={() => setDrill(null)} />
  );
  return { open, panel };
}

// A member's percentage in the operating agreement, typed in place; it is
// kept on their commitment in the deal (the books do not hold it).
function MembershipCell({ fundId, member, onSaved }) {
  const shown = member.membershipPct == null ? '' : String(member.membershipPct);
  const [value, setValue] = useState(shown);
  const [state, setState] = useState('');
  if (!member.investorId) return <span style={{ color: 'var(--muted)' }}>-</span>;
  const save = async () => {
    if (value.trim() === shown || state === 'saving') return;
    const pct = value.trim() === '' ? null : Number(value);
    if (pct != null && (!Number.isFinite(pct) || pct < 0 || pct > 100)) { setState('Use 0 to 100'); return; }
    setState('saving');
    try { await api.setIrMembership(fundId, member.investorId, pct); setState(''); onSaved?.(); }
    catch (e) { setState(e?.message || 'Not saved'); }
  };
  return (
    <span style={{ display: 'inline-flex', flexDirection: 'column', alignItems: 'flex-end' }}>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
        <input className="form-input" type="number" min="0" max="100" step="any" value={value} placeholder="-"
          aria-label={`${member.name} membership percentage`}
          onChange={e => { setValue(e.target.value); setState(''); }} onBlur={save}
          onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); save(); } }}
          style={{ width: 76, textAlign: 'right', padding: '3px 6px', fontSize: 12.5 }} />%
      </span>
      {state && state !== 'saving' && <span style={{ fontSize: 11, color: 'hsl(var(--color-red))' }}>{state}</span>}
    </span>
  );
}

const ofKind = (accounts, kind) => (accounts || []).filter(a => a.startsWith(KIND_PREFIX[kind]));

function Tiles({ items }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: '12px 16px', marginBottom: 14 }}>
      {items.map(([label, value, onDrill]) => (
        <div key={label}>
          <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.05em', color: 'var(--muted)' }}>{label}</div>
          <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--ink)', marginTop: 2, fontVariantNumeric: 'tabular-nums' }}>
            <Amt value={value} onDrill={onDrill} />
          </div>
        </div>
      ))}
    </div>
  );
}

// ── A deal's entity, figures and members ────────────────────────────────────
function EntityLink({ fundId, current, onSaved }) {
  const [open, setOpen] = useState(false);
  const [pick, setPick] = useState(current || '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const { data, loading, error } = useIrLoad(() => (open ? api.getIrBookEntities() : Promise.resolve(null)), [open]);
  const save = async (entity) => {
    setBusy(true); setErr('');
    try { await api.linkIrFundBooks(fundId, entity); setOpen(false); await onSaved(); } catch (e) { setErr(e?.message || 'Could not link the deal.'); } finally { setBusy(false); }
  };
  if (!open) {
    return (
      <button type="button" className="secondary-btn" onClick={() => setOpen(true)} style={{ fontSize: 12, padding: '5px 12px', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
        <Link2 size={13} /> {current ? 'Change Entity' : 'Link to Intacct'}
      </button>
    );
  }
  const list = data?.entities || [];
  return (
    <div style={{ display: 'grid', gap: 8, width: '100%' }}>
      {loading ? <LoadingState label="Reading the entities…" /> : error ? <ErrorState message={error} /> : data && !data.allowed ? <Muted>{data.reason}</Muted> : (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <select className="form-select" value={pick} onChange={e => setPick(e.target.value)} style={{ flex: 1, minWidth: 220 }}>
            <option value="">Pick the entity this deal is…</option>
            {list.map(e => (
              <option key={e.code} value={e.code} disabled={!!e.fundId && e.fundId !== fundId}>
                {e.code} {e.name} - {formatCurrency(e.partnerCapital)}, {e.members} member{e.members === 1 ? '' : 's'}{e.fundId && e.fundId !== fundId ? ` (linked to ${e.fundName})` : ''}
              </option>
            ))}
          </select>
          <button type="button" className="primary-btn" disabled={busy || !pick || pick === current} onClick={() => save(pick)} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            {busy && <Spinner size={12} />} Link
          </button>
          {current && <button type="button" className="secondary-btn" disabled={busy} onClick={() => save('')}>Unlink</button>}
          <button type="button" className="secondary-btn" disabled={busy} onClick={() => setOpen(false)}>Cancel</button>
        </div>
      )}
      {err && <div style={{ color: 'hsl(var(--color-red))', fontSize: 12.5 }}>{err}</div>}
    </div>
  );
}

export function DealBooks({ fundId, onChanged }) {
  const { data, loading, error, reload } = useIrLoad(() => api.getIrFundBooks(fundId), [fundId]);
  const [importing, setImporting] = useState(false);
  const [note, setNote] = useState('');
  const drill = useDrill();
  const changed = async () => { await reload(); onChanged?.(); };
  const importMembers = async () => {
    setImporting(true); setNote('');
    try {
      const r = await api.importIrFromBooks(data.entity);
      setNote(`${r.created} new profile${r.created === 1 ? '' : 's'}, ${r.linked} existing profile${r.linked === 1 ? '' : 's'} linked.`);
      await changed();
    } catch (e) { setNote(e?.message || 'Import failed.'); } finally { setImporting(false); }
  };

  const d = data || {};
  const p = d.property || {};
  const members = d.members || [];
  const unlinked = members.filter(m => !m.investorId).length;
  const pcts = members.filter(m => m.membershipPct != null);
  const pctTotal = pcts.reduce((t, m) => t + m.membershipPct, 0);
  const at = (title, accounts, from) => accounts?.length ? () => drill.open(title, accounts, d.entity, d.asOf, from) : null;
  const yearStart = d.asOf ? `${d.asOf.slice(0, 4)}-01-01` : undefined;

  return (
    <div className="form-group-full" style={{ borderTop: '1px solid var(--line)', paddingTop: 16, marginTop: 4 }}>
      <Head title="Live From Intacct"
        sub={d.linked ? `Entity ${d.entity} ${d.entityName || ''} - accrual book, as of ${formatDate(d.asOf)}` : 'Link this deal to its Intacct entity to read its figures and every member\'s capital live.'}
        right={d.allowed !== false && !loading && <EntityLink fundId={fundId} current={d.entity} onSaved={changed} />} />
      {loading ? <LoadingState label="Reading the books…" /> : error ? <ErrorState message={error} onRetry={reload} />
        : d.allowed === false ? <Muted>{d.reason}</Muted>
        : !d.linked ? null
        : d.booksError ? <ErrorState message={d.booksError} onRetry={reload} /> : (
          <>
            <Tiles items={[
              ['Partner Capital', d.partnerCapital],
              ['Book Equity', p.bookEquity],
              ['Cash', p.cash, at('Cash', p.cashAccounts)],
              ['Total Assets', p.assets],
              ['Total Liabilities', p.liabilities],
              ['Revenue YTD', p.revenueYtd, at('Revenue YTD', p.revenueAccounts, yearStart)],
              ['Net Income YTD', p.netIncomeYtd],
            ]} />
            <Head title="Members" sub="Each member's capital account is their own partner accounts on this entity. Membership is the percentage in the operating agreement - type it in."
              right={unlinked > 0 && (
                <button type="button" className="secondary-btn" disabled={importing} onClick={importMembers} style={{ fontSize: 12, padding: '5px 12px', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                  {importing ? <Spinner size={12} /> : <Download size={13} />} Add {unlinked} Profile{unlinked === 1 ? '' : 's'}
                </button>
              )} />
            {note && <div style={{ fontSize: 12.5, color: 'var(--ink)', marginBottom: 8 }}>{note}</div>}
            {pcts.length > 0 && Math.abs(pctTotal - 100) > 0.005 && (
              <div style={{ fontSize: 12, color: 'var(--warn-fg)', display: 'flex', alignItems: 'center', gap: 5, marginBottom: 8 }}>
                <AlertTriangle size={12} /> Membership adds up to {+pctTotal.toFixed(4)}%, not 100%{pcts.length < members.length ? ` - ${members.length - pcts.length} member${members.length - pcts.length === 1 ? '' : 's'} not set` : ''}.
              </div>
            )}
            {members.length === 0 ? <Muted>No partner capital on this entity.</Muted> : (
              <div style={{ overflowX: 'auto' }}>
                <table className="req-table stack-table">
                  <thead><tr><th>Member</th><th style={num}>Membership</th><th style={num}>E&C</th><th style={num}>Contributed</th><th style={num}>Distributed</th><th style={num}>Capital Account</th></tr></thead>
                  <tbody>
                    {members.map(m => {
                      const gap = m.nexus && Math.abs((m.nexus.called || 0) - m.contributed) >= 1;
                      return (
                        <tr key={m.investorId || m.name}>
                          <td>
                            <div style={{ fontWeight: 600 }}>{m.name}</div>
                            <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>{m.investorId ? `Accounts ${m.accounts.join(', ')}` : 'No profile yet'}</div>
                            {gap && (
                              <div style={{ fontSize: 11.5, color: 'var(--warn-fg)', display: 'flex', alignItems: 'center', gap: 4, marginTop: 2 }}>
                                <AlertTriangle size={11} /> Nexus capital calls show {formatCurrency(m.nexus.called)} paid in
                              </div>
                            )}
                          </td>
                          <td data-th="Membership" style={num}><MembershipCell key={m.membershipPct ?? ''} fundId={fundId} member={m} onSaved={reload} /></td>
                          <td data-th="E&C" style={num}><Amt value={m.ec} onDrill={at(`${m.name} - E&C`, ofKind(m.accounts, 'ec'))} /></td>
                          <td data-th="Contributed" style={num}><Amt value={m.contributed} onDrill={at(`${m.name} - Contributed`, ofKind(m.accounts, 'contributed'))} /></td>
                          <td data-th="Distributed" style={num}><Amt value={m.distributed} onDrill={at(`${m.name} - Distributed`, ofKind(m.accounts, 'distributed'))} /></td>
                          <td data-th="Capital Account" style={{ ...num, fontWeight: 600 }}><Amt value={m.balance} onDrill={at(`${m.name} - Capital Account`, m.accounts)} /></td>
                        </tr>
                      );
                    })}
                  </tbody>
                  <tfoot><tr style={{ fontWeight: 600 }}>
                    <td>Total</td>
                    <td data-th="Membership" style={num}>{pcts.length ? `${+pctTotal.toFixed(4)}%` : '-'}</td>
                    <td colSpan={3} />
                    <td data-th="Capital Account" style={num}>{formatCurrency(d.partnerCapital)}</td>
                  </tr></tfoot>
                </table>
              </div>
            )}
          </>
        )}
      {drill.panel}
    </div>
  );
}

// ── An investor's accounts and positions ────────────────────────────────────
function AccountPicker({ investorId, current, onSaved, onCancel }) {
  const { data, loading, error } = useIrLoad(() => api.getIrBookPartners(), []);
  const [q, setQ] = useState('');
  const [picked, setPicked] = useState(new Set(current));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const partners = useMemo(() => {
    const words = q.trim().toLowerCase();
    return (data?.partners || []).filter(p => !words || p.name.toLowerCase().includes(words) || p.accounts.some(a => a.accountNo.startsWith(words)));
  }, [data, q]);
  // Linked accounts the chart no longer lists - shown so they can be unlinked.
  const stale = useMemo(() => {
    const known = new Set((data?.partners || []).flatMap(p => p.accounts.map(a => a.accountNo)));
    return data ? current.filter(a => !known.has(a)) : [];
  }, [data, current]);
  const flip = (a) => setPicked(prev => { const next = new Set(prev); if (next.has(a)) next.delete(a); else next.add(a); return next; });
  const free = (a) => !a.investorId || a.investorId === investorId;
  const toggle = (p) => setPicked(prev => {
    const next = new Set(prev);
    const mine = p.accounts.filter(free).map(a => a.accountNo);
    const on = mine.every(a => next.has(a));
    mine.forEach(a => (on ? next.delete(a) : next.add(a)));
    return next;
  });
  const save = async () => {
    setBusy(true); setErr('');
    try { await api.linkIrInvestorBooks(investorId, [...picked]); await onSaved(); } catch (e) { setErr(e?.message || 'Could not link the accounts.'); } finally { setBusy(false); }
  };
  if (loading) return <LoadingState label="Reading the chart of accounts…" />;
  if (error) return <ErrorState message={error} />;
  if (data && !data.allowed) return <Muted>{data.reason}</Muted>;
  return (
    <div style={{ display: 'grid', gap: 8 }}>
      <input className="form-input" placeholder="Search by name or account number…" value={q} onChange={e => setQ(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter') e.preventDefault(); /* it sits inside the investor form */ }} />
      <div style={{ maxHeight: 260, overflowY: 'auto', border: '1px solid var(--line)', borderRadius: 10 }}>
        {partners.slice(0, 200).map(p => {
          const mine = p.accounts.filter(free);
          const on = mine.length > 0 && mine.every(a => picked.has(a.accountNo));
          const taken = p.accounts.find(a => !free(a));
          return (
            <label key={p.key} style={{ display: 'flex', gap: 10, alignItems: 'flex-start', padding: '8px 12px', borderBottom: '1px solid var(--line)', cursor: mine.length ? 'pointer' : 'default', opacity: mine.length ? 1 : 0.5 }}>
              <input type="checkbox" checked={on} disabled={!mine.length} onChange={() => toggle(p)} style={{ marginTop: 3 }} />
              <span style={{ minWidth: 0 }}>
                <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--ink)' }}>{p.name}</span>
                <span style={{ display: 'block', fontSize: 11.5, color: 'var(--muted)' }}>
                  {p.accounts.map(a => a.accountNo).join(', ')}{taken ? ` - linked to ${taken.investorName}` : ''}
                </span>
              </span>
            </label>
          );
        })}
        {partners.length === 0 && <div style={{ padding: 12 }}><Muted>No investor accounts match.</Muted></div>}
        {stale.map(a => (
          <label key={a} style={{ display: 'flex', gap: 10, alignItems: 'center', padding: '8px 12px', borderBottom: '1px solid var(--line)', cursor: 'pointer' }}>
            <input type="checkbox" checked={picked.has(a)} onChange={() => flip(a)} />
            <span style={{ fontSize: 12.5, color: 'var(--muted)' }}>{a} - no longer in the chart of accounts</span>
          </label>
        ))}
      </div>
      {err && <div style={{ color: 'hsl(var(--color-red))', fontSize: 12.5 }}>{err}</div>}
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        <button type="button" className="secondary-btn" disabled={busy} onClick={onCancel}>Cancel</button>
        <button type="button" className="primary-btn" disabled={busy} onClick={save} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          {busy && <Spinner size={12} />} Save Accounts
        </button>
      </div>
    </div>
  );
}

export function InvestorBooks({ investorId, onChanged }) {
  const { data, loading, error, reload } = useIrLoad(() => api.getIrInvestorBooks(investorId), [investorId]);
  const [picking, setPicking] = useState(false);
  const drill = useDrill();
  const d = data || {};
  const accounts = d.accounts || [];
  const at = (title, accts, entity) => accts?.length ? () => drill.open(title, accts, entity, d.asOf) : null;
  return (
    <div className="form-group-full" style={{ borderTop: '1px solid var(--line)', paddingTop: 16, marginTop: 4 }}>
      <Head title="Intacct Accounts"
        sub={accounts.length ? `Linked to ${accounts.join(', ')} - capital as of ${formatDate(d.asOf)}` : 'Link this investor to their partner equity accounts in Intacct to see their capital in every entity.'}
        right={d.allowed !== false && !loading && !picking && (
          <button type="button" className="secondary-btn" onClick={() => setPicking(true)} style={{ fontSize: 12, padding: '5px 12px', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <Link2 size={13} /> {accounts.length ? 'Change Accounts' : 'Link Accounts'}
          </button>
        )} />
      {picking && <AccountPicker investorId={investorId} current={accounts} onCancel={() => setPicking(false)}
        onSaved={async () => { setPicking(false); await reload(); onChanged?.(); }} />}
      {!picking && (loading ? <LoadingState label="Reading the books…" /> : error ? <ErrorState message={error} onRetry={reload} />
        : d.allowed === false ? <Muted>{d.reason}</Muted>
        : d.booksError ? <ErrorState message={d.booksError} onRetry={reload} />
        : accounts.length === 0 ? null
        : d.positions.length === 0 ? <Muted>No balance on these accounts in any entity you can read.</Muted> : (
          <div style={{ overflowX: 'auto' }}>
            <table className="req-table stack-table">
              <thead><tr><th>Entity</th><th style={num}>Membership</th><th style={num}>Contributed</th><th style={num}>Distributed</th><th style={num}>E&C</th><th style={num}>Capital Account</th></tr></thead>
              <tbody>
                {d.positions.map(x => (
                  <tr key={x.entity}>
                    <td>
                      <div style={{ fontWeight: 600 }}>{x.name}</div>
                      <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>{x.entity}{x.fundName ? ` - Deal: ${x.fundName}` : ''}</div>
                    </td>
                    <td data-th="Membership" style={num}>{x.membershipPct == null ? '-' : `${x.membershipPct}%`}</td>
                    <td data-th="Contributed" style={num}><Amt value={x.contributed} onDrill={at(`${x.name} - Contributed`, ofKind(x.accounts, 'contributed'), x.entity)} /></td>
                    <td data-th="Distributed" style={num}><Amt value={x.distributed} onDrill={at(`${x.name} - Distributed`, ofKind(x.accounts, 'distributed'), x.entity)} /></td>
                    <td data-th="E&C" style={num}><Amt value={x.ec} onDrill={at(`${x.name} - E&C`, ofKind(x.accounts, 'ec'), x.entity)} /></td>
                    <td data-th="Capital Account" style={{ ...num, fontWeight: 600 }}><Amt value={x.balance} onDrill={at(`${x.name} - Capital Account`, x.accounts, x.entity)} /></td>
                  </tr>
                ))}
                <tr>
                  <td style={{ fontWeight: 700 }}>Total</td><td /><td /><td /><td />
                  <td data-th="Total" style={{ ...num, fontWeight: 700 }}>{formatCurrency(d.total)}</td>
                </tr>
              </tbody>
            </table>
          </div>
        ))}
      {drill.panel}
    </div>
  );
}

// ── Import deals and members from the books ─────────────────────────────────
export function ImportFromBooks({ onClose, onDone }) {
  const { data, loading, error, reload } = useIrLoad(() => api.getIrBookEntities(), []);
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState({});
  const run = async (e) => {
    setBusy(e.code);
    try {
      const r = await api.importIrFromBooks(e.code);
      setMsg(m => ({ ...m, [e.code]: `${r.fundCreated ? 'Deal created' : 'Deal kept'} - ${r.created} new profile${r.created === 1 ? '' : 's'}, ${r.linked} linked, ${r.kept} already linked.` }));
      await reload(); onDone?.();
    } catch (err) {
      setMsg(m => ({ ...m, [e.code]: err?.message || 'Import failed.' }));
    } finally { setBusy(''); }
  };
  const list = data?.entities || [];
  return (
    <Modal title="Import From Intacct" onClose={onClose}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }} className="nx-fill">
        <Muted>Every entity with partner capital on the books. Import makes the deal (or keeps the one already linked) and a profile for each member, linked to their own partner accounts. Nothing is deleted and no commitment is invented.</Muted>
        {loading ? <LoadingState label="Reading the books…" /> : error ? <ErrorState message={error} onRetry={reload} />
          : data && !data.allowed ? <Muted>{data.reason}</Muted> : (
            <div style={{ overflowX: 'auto' }}>
              <table className="req-table stack-table">
                <thead><tr><th>Entity</th><th style={num}>Members</th><th style={num}>Partner Capital</th><th>Deal</th><th /></tr></thead>
                <tbody>
                  {list.map(e => (
                    <tr key={e.code}>
                      <td>
                        <div style={{ fontWeight: 600 }}>{e.name}</div>
                        <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>{e.code}</div>
                        {msg[e.code] && <div style={{ fontSize: 11.5, color: 'var(--ink)', marginTop: 2 }}>{msg[e.code]}</div>}
                      </td>
                      <td data-th="Members" style={num}>{e.members}</td>
                      <td data-th="Partner Capital" style={num}>{formatCurrency(e.partnerCapital)}</td>
                      <td data-th="Deal" style={{ color: e.fundId ? 'var(--ink)' : 'var(--muted)' }}>{e.fundName || 'Not Linked'}</td>
                      <td style={{ textAlign: 'right' }}>
                        <button type="button" className="secondary-btn" disabled={!!busy} onClick={() => run(e)} style={{ fontSize: 12, padding: '5px 12px', display: 'inline-flex', alignItems: 'center', gap: 6, whiteSpace: 'nowrap' }}>
                          {busy === e.code && <Spinner size={12} />} {e.fundId ? 'Update Members' : 'Import'}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
      </div>
      <div className="modal-footer">
        <button type="button" className="secondary-btn" onClick={onClose}>Close</button>
      </div>
    </Modal>
  );
}
