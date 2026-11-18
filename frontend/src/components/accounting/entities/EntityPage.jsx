import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../../../api';
import { ModuleActions } from '../../ModuleTabs';
import { useTrailCrumbs } from '../../PageTrail';
import { SkeletonBlocks } from '../../AsyncState';
import { formatDate, formatDateTime } from '../../../lib/datetime';
import { FS } from '../../../lib/typeScale';
import LinesPanel from '../LinesPanel';
import { lineQuery } from '../reportModel';
import { requestStatement } from '../drill';
import StructureChart from './StructureChart';
import EntityEditSheet from './EntityEditSheet';
import { MANAGEMENT } from './entityWords';
import OwnersPanel from './OwnersPanel';
import OwnershipBar from './OwnershipBar';
import { focusGraph, groupInvestors, pctText, withLenders } from './structureModel';

// One entity (Neil, 11/17/2026, plan https://claude.ai/artifact/JZmUfATX7NvH2Qq4kAkJb1):
// Overview is the one-page picture - the legal record on the left, the books,
// the owners and the look-through on the right, its structure chart under
// them. Structure is the chart at full size with the owners (kept here for an
// entity that is not a deal), what it owns and who manages it. Money is the
// books and the loans; Agreements the fees, leases, recurring expenses and
// construction jobs. Every posted figure opens its ledger lines or its
// statement (house rule, Charmi 10/27); Book Equity and Partner Capital are
// worked out from other figures, so they stay plain.

const TABS = [['overview', 'Overview'], ['structure', 'Structure'], ['money', 'Money'], ['agreements', 'Agreements']];
const STATUS_WORDS = { active: 'Active', inactive: 'Inactive', dissolved: 'Dissolved', sold: 'Sold' };
const money = (v) => {
  const n = Math.round(Number(v) || 0);
  const t = `$${Math.abs(n).toLocaleString('en-US')}`;
  return n < 0 ? `(${t})` : t;
};

function Kv({ rows }) {
  return (
    <dl className="ent-kv">
      {rows.filter((r) => r && r[1] !== undefined && r[1] !== null && r[1] !== false && r[1] !== '').map(([k, v]) => (
        <div key={k} className="ent-kv-row"><dt>{k}</dt><dd>{v}</dd></div>
      ))}
    </dl>
  );
}

function Drill({ value, onClick, title }) {
  return <button type="button" className="ent-amt" onClick={onClick} title={title || 'Open the ledger lines'}>{money(value)}</button>;
}

export default function EntityPage({ code, onSubChange, onOpenEntity }) {
  const [tab, setTab] = useState('overview');
  const [entity, setEntity] = useState(null);
  const [error, setError] = useState('');
  const [graph, setGraph] = useState(null);
  const [list, setList] = useState([]);
  const [books, setBooks] = useState(null);
  const [loans, setLoans] = useState(null);
  const [agreements, setAgreements] = useState(null);
  const [editing, setEditing] = useState(false);
  const [ein, setEin] = useState('');
  const [lines, setLines] = useState(null);
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => { setError(''); setTick((t) => t + 1); }, []);

  useTrailCrumbs([{ label: 'Entities', onClick: () => onSubChange?.('entities') }]);

  useEffect(() => {
    let alive = true;
    api.getLegalEntity(code).then((d) => { if (alive) setEntity(d); }).catch((e) => { if (alive) setError(e?.message || 'Could not read this entity.'); });
    api.getLegalEntityStructure().then((g) => { if (alive) setGraph(g); }).catch(() => { if (alive) setGraph({ nodes: [], edges: [] }); });
    api.getLegalEntities().then((d) => { if (alive) setList(d?.entities || []); }).catch(() => {});
    return () => { alive = false; };
  }, [code, tick]);
  useEffect(() => {
    let alive = true;
    api.getLegalEntityBooks(code).then((d) => { if (alive) setBooks(d); }).catch((e) => { if (alive) setBooks({ error: e?.message || 'Could not read the books.' }); });
    api.getLoansByEntity(code).then((d) => { if (alive) setLoans(d); }).catch(() => { if (alive) setLoans({ loans: [], notRead: true }); });
    return () => { alive = false; };
  }, [code]);
  useEffect(() => {
    if (tab !== 'agreements' || agreements) return undefined;
    let alive = true;
    api.getLegalEntityAgreements(code).then((d) => { if (alive) setAgreements(d); }).catch((e) => { if (alive) setAgreements({ error: e?.message || 'Could not read the agreements.' }); });
    return () => { alive = false; };
  }, [tab, code, agreements]);

  const openEntity = (c) => (onOpenEntity ? onOpenEntity(c) : onSubChange?.(`entity-${c}`));
  const openNode = (n) => {
    if (n.kind === 'entity' && n.code && n.code !== code) openEntity(n.code);
    else if (n.kind === 'property') window.dispatchEvent(new CustomEvent('nexus:navigate', { detail: { view: 'property-asset', sub: `a:${encodeURIComponent(n.assetId)}:property` } }));
    else if (n.kind === 'investor') window.dispatchEvent(new CustomEvent('nexus:navigate', { detail: { view: 'investor-relations', sub: 'investor-investors' } }));
  };
  const openDeal = () => window.dispatchEvent(new CustomEvent('nexus:navigate', { detail: { view: 'investor-relations', sub: 'investor-funds' } }));

  const chartFor = useCallback((big) => {
    if (!graph?.nodes || !entity) return null;
    const g = groupInvestors(focusGraph(graph, code, { up: big ? 6 : 3, down: big ? 4 : 1 }), big ? 8 : 4);
    return withLenders(g, code, (loans?.loans || []));
  }, [graph, entity, code, loans]);
  const small = useMemo(() => chartFor(false), [chartFor]);
  const big = useMemo(() => chartFor(true), [chartFor]);

  if (error) return <p role="alert" style={{ color: 'var(--danger, #dc2626)', fontSize: FS.body }}>{error}</p>;
  if (!entity) return <SkeletonBlocks count={4} />;

  const e = entity;
  const asOf = books?.asOf || '';
  const showEin = async () => {
    try { setEin((await api.revealLegalEntityEin(code))?.ein || ''); } catch (err) { setEin(''); setError(err?.message || 'Could not show the EIN.'); }
  };
  const cashLines = () => setLines({
    title: `Cash - ${e.name}`, caption: `Bank accounts as of ${formatDate(asOf)}`,
    queries: (books?.cashAccounts || []).map((a) => lineQuery({ account: a, drill: { to: asOf }, entities: [code] })),
    report: { account: (books?.cashAccounts || [])[0] || '', to: asOf, entity: code },
  });
  const statement = (report, from) => requestStatement({ entities: [code], from: from || books?.yearFrom || `${asOf.slice(0, 4)}-01-01`, to: asOf, report });
  const openLoans = () => onSubChange?.('loans');
  const loanRows = loans?.loans || [];
  const debt = loanRows.reduce((s, l) => s + (Number(l.balance) || 0), 0);
  const below = loanRows.filter((l) => l.belowCovenant);
  const managed = (e.managedBy || []);
  const managementWords = MANAGEMENT.find((m) => m[0] === e.management)?.[1] || '';

  const legalRows = [
    ['Legal Name', e.legalName || <span className="ent-muted">Not recorded - the books call it {e.booksName || code}</span>],
    ['Doing Business As', e.dba],
    ['Type', e.typeLine || <span className="ent-muted">Not set yet</span>],
    ['Formed', [e.formedState, e.formedOn ? formatDate(e.formedOn) : ''].filter(Boolean).join(', ') || <span className="ent-muted">Not recorded</span>],
    ['EIN', e.hasEin ? (
      <span>{ein || e.einMasked} {e.canFull && !ein && <button type="button" className="ent-link" onClick={showEin}>Show</button>}</span>
    ) : <span className="ent-muted">Not recorded</span>],
    ['Status', `${STATUS_WORDS[e.status] || 'Active'}${e.endedOn ? ` on ${formatDate(e.endedOn)}` : ''}`],
    ['Fiscal Year Ends', e.fiscalYearEnd ? e.fiscalYearEnd.replace('-', '/') : ''],
    ['Address', e.address],
    ['Managed By', (managementWords || managed.length || e.managerName) ? (
      <span>
        {managementWords}{managementWords && (managed.length || e.managerName) ? ' - ' : ''}
        {managed.map((m, i) => <span key={m.id}>{i > 0 && ', '}<button type="button" className="ent-link" onClick={() => openEntity(m.code)}>{m.label}</button>{m.terms && m.terms !== 'Manager' ? ` (${m.terms.replace('Manager - ', '')})` : ''}</span>)}
        {!managed.length && e.managerName}
      </span>
    ) : ''],
    ['Registered Agent', e.registeredAgent ? `${e.registeredAgent}${e.agentRenewsOn ? `, renews ${formatDate(e.agentRenewsOn)}` : ''}` : ''],
    ['Also Registered In', (e.foreignStates || []).map((s) => s.state).join(', ')],
    ['Signers', (e.signers || []).map((s) => [s.name, s.title].filter(Boolean).join(', ')).join('; ')],
    ['Steward', e.steward],
    ['Owns', (e.holds || []).length ? (e.holds.map((p, i) => <span key={p.id}>{i > 0 && ', '}<button type="button" className="ent-link" onClick={() => openNode(p)}>{p.label}</button></span>)) : ''],
    ['Locations', (e.locations || []).map((l) => `${l.code}${l.name ? ` ${l.name}` : ''}`).join(', ')],
    ['Reports Under', e.parentCode ? `${e.parentCode} ${e.parentName}`.trim() : ''],
    ['Egnyte Folder', e.egnyteFolder],
    ['Notes', e.notes],
  ];

  const booksLines = !books ? <SkeletonBlocks count={3} /> : books.error ? <p className="ent-muted">{books.error}</p> : (
    <div className="ent-lines">
      <div className="ent-line">Cash {books.cashAccounts?.length ? <Drill value={books.cash} onClick={cashLines} /> : money(books.cash)} in {books.cashAccounts?.length || 0} bank {books.cashAccounts?.length === 1 ? 'account' : 'accounts'}</div>
      <div className="ent-line">
        Assets <Drill value={books.assets} onClick={() => statement('balance-sheet')} title="Open the Balance Sheet" /> - liabilities{' '}
        <Drill value={books.liabilities} onClick={() => statement('balance-sheet')} title="Open the Balance Sheet" /> - book equity {money(books.bookEquity)}
      </div>
      <div className="ent-line">
        Revenue this year <Drill value={books.revenueYtd} onClick={() => statement('pnl')} title="Open the Income Statement" /> - net income{' '}
        <Drill value={books.netIncomeYtd} onClick={() => statement('pnl')} title="Open the Income Statement" />
      </div>
      <div className="ent-line">
        Last 12 months: revenue <Drill value={books.revenueT12} onClick={() => statement('pnl', books.t12From)} title="Open the Income Statement" /> - net income{' '}
        <Drill value={books.netIncomeT12} onClick={() => statement('pnl', books.t12From)} title="Open the Income Statement" />
      </div>
      {loans && !loans.notRead && (loanRows.length ? (
        <div className="ent-line">
          Debt <button type="button" className="ent-amt" onClick={openLoans} title="Open Loans">{money(debt)}</button> with {loanRows.length} {loanRows.length === 1 ? 'loan' : 'loans'}
          {loanRows.length === 1 && loanRows[0].ratePct ? ` at ${Number(loanRows[0].ratePct).toFixed(2)}%` : ''}
          {loanRows.length === 1 && loanRows[0].maturity ? `, matures ${formatDate(loanRows[0].maturity)}` : ''}
          {below.length > 0 && <span style={{ color: 'var(--danger, #dc2626)' }}> - {below.length} below {below.length === 1 ? 'its' : 'their'} DSCR covenant</span>}
        </div>
      ) : <div className="ent-line ent-muted">No open loans on Loans for this entity</div>)}
      {Math.abs(books.partnerCapital || 0) >= 0.5 && <div className="ent-line">Partner capital on the books {money(books.partnerCapital)}</div>}
      <div className="ent-line ent-muted" style={{ fontSize: FS.meta }}>Accrual book, as of {formatDate(asOf)}</div>
    </div>
  );

  const ownerLines = (
    <div className="ent-lines">
      {(e.owners || []).length ? (
        <>
          <OwnershipBar owners={e.owners} onOpenEntity={openEntity} />
          <div className="ent-line ent-muted">
            {e.ownersHome === 'ir' ? `Members of the deal ${e.deal?.name} in Investor Relations` : 'Recorded on this entity'} - {pctText(e.ownersTotal) || '0%'} recorded
          </div>
        </>
      ) : <div className="ent-line ent-muted">No owners recorded yet{e.ownersHome === 'ir' ? ' - add members\' percentages on the deal' : ''}</div>}
      {(e.lookThrough || []).some((r) => (r.via || []).length) && (
        <>
          <div className="ent-sub-head">Ultimate Owners</div>
          <p className="ent-muted" style={{ fontSize: FS.label, margin: '0 0 4px' }}>Each chain multiplied through - who really owns {e.name}.</p>
          <OwnershipBar onOpenEntity={openEntity}
            owners={e.lookThrough.map((r) => ({ ...r, sub: (r.via || []).length ? `through ${r.via.join(', then ')}${r.partlyUnknown ? ' (part not known)' : ''}` : 'directly' }))} />
        </>
      )}
      {(e.owned || []).length > 0 && (
        <>
          <div className="ent-sub-head">Owns</div>
          {e.owned.map((o) => (
            <div key={o.id} className="ent-line ent-line--split">
              <button type="button" className="ent-link" onClick={() => openEntity(o.code)}>{o.label}</button>
              <b>{pctText(o.pct)}</b>
            </div>
          ))}
        </>
      )}
    </div>
  );

  const chartNote = (
    <p className="ent-muted" style={{ fontSize: FS.label, margin: '0 0 6px' }}>
      Owners above, what it owns below, percentages on each line; dashed lines are who manages it and who lends to it. Select a shape to open it.
    </p>
  );

  return (
    <div className="ent-page">
      <ModuleActions>
        {e.deal && <button type="button" className="secondary-btn" onClick={openDeal}>Open the Deal</button>}
        {e.canEdit && <button type="button" className="primary-btn" onClick={() => setEditing(true)}>Edit</button>}
      </ModuleActions>
      <header className="ent-head">
        <h2 style={{ fontSize: FS.page, margin: 0 }}>{e.name}</h2>
        <p className="ent-muted" style={{ margin: '2px 0 0', fontSize: FS.body }}>
          {[code, e.typeLine, STATUS_WORDS[e.status] && e.status !== 'active' ? STATUS_WORDS[e.status] : '', e.deal ? `Deal: ${e.deal.name}` : '', e.kind === 'location' ? 'Location' : ''].filter(Boolean).join(' - ')}
        </p>
        {e.company && <p className="ent-muted" style={{ margin: '2px 0 0', fontSize: FS.label }}>Also the Nexus company {e.company.name}: its legal name, EIN, address and signatory come from Settings &gt; Companies.</p>}
        {!e.recorded && e.canEdit && <p style={{ margin: '6px 0 0', fontSize: FS.body }}>No legal record yet. <button type="button" className="ent-link" onClick={() => setEditing(true)}>Add the legal facts</button></p>}
      </header>

      <div className="scroll-tabs ent-tabs" role="tablist" aria-label="Entity sections">
        {TABS.map(([k, l]) => <button key={k} type="button" role="tab" aria-selected={tab === k} className={tab === k ? 'is-on' : undefined} onClick={() => setTab(k)}>{l}</button>)}
      </div>

      {tab === 'overview' && (
        <>
          <div className="ent-two">
            <section><h3 className="ent-head3">Legal</h3><Kv rows={legalRows} /></section>
            <section>
              <h3 className="ent-head3">The Books</h3>{booksLines}
              <h3 className="ent-head3" style={{ marginTop: 22 }}>Ownership</h3>{ownerLines}
            </section>
          </div>
          <section style={{ marginTop: 26 }}>
            <h3 className="ent-head3">Structure</h3>
            {chartNote}
            <StructureChart graph={small?.graph} beside={small?.beside} focus={`e:${code}`} onOpen={openNode} title={`Structure of ${e.name}`} fileName={`structure-${code}`}
              empty={<p className="ent-muted">Nothing to draw yet - record its owners, or link its deal.</p>} />
          </section>
        </>
      )}

      {tab === 'structure' && (
        <>
          {chartNote}
          <StructureChart graph={big?.graph} beside={big?.beside} focus={`e:${code}`} onOpen={openNode} title={`Structure of ${e.name}`} fileName={`structure-${code}`}
            empty={<p className="ent-muted">Nothing to draw yet - record its owners, or link its deal.</p>} />
          <div className="ent-two" style={{ marginTop: 22 }}>
            <section>
              <h3 className="ent-head3">Owners</h3>
              <OwnersPanel entity={e} entities={list} onChanged={reload} onOpenDeal={openDeal} />
            </section>
            <section><h3 className="ent-head3">Through the Chain</h3>{ownerLines}</section>
          </div>
        </>
      )}

      {tab === 'money' && (
        <div className="ent-two">
          <section>
            <h3 className="ent-head3">The Books</h3>{booksLines}
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 12 }}>
              <button type="button" className="secondary-btn" onClick={() => statement('balance-sheet')}>Balance Sheet</button>
              <button type="button" className="secondary-btn" onClick={() => statement('pnl')}>Income Statement</button>
              <button type="button" className="secondary-btn" onClick={() => statement('cash-flow')}>Statement of Cash Flows</button>
            </div>
          </section>
          <section>
            <h3 className="ent-head3">Loans</h3>
            {!loans ? <SkeletonBlocks count={2} /> : loans.notRead ? <p className="ent-muted">Loans could not be read.</p> : !loanRows.length ? <p className="ent-muted">No open loans on Loans for this entity.</p> : (
              <div className="ent-lines">
                {loanRows.map((l) => (
                  <div key={l.id} className="ent-line">
                    <button type="button" className="ent-link" onClick={openLoans}>{l.lender || 'Lender'}{l.loanNo ? ` #${l.loanNo}` : ''}</button>{' '}
                    {money(l.balance)}{l.ratePct ? ` at ${Number(l.ratePct).toFixed(2)}%` : ''}{l.maturity ? `, matures ${formatDate(l.maturity)}` : ''}
                    {l.dscr !== null && l.dscr !== undefined && <span className={l.belowCovenant ? undefined : 'ent-muted'} style={l.belowCovenant ? { color: 'var(--danger, #dc2626)' } : undefined}> - DSCR {Number(l.dscr).toFixed(2)} against {Number(l.covenantMin || 0).toFixed(2)}</span>}
                    {l.internal && <span className="ent-muted"> - intercompany</span>}
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>
      )}

      {tab === 'agreements' && (
        !agreements ? <SkeletonBlocks count={3} /> : agreements.error ? <p className="ent-muted">{agreements.error}</p> : (
          <div className="ent-two">
            <section>
              <h3 className="ent-head3">Management Fees</h3>
              {agreements.fees.length ? (
                <div className="ent-lines">{agreements.fees.map((a) => (
                  <div key={a.id} className="ent-line">
                    {a.role === 'managed' ? <>Managed by <button type="button" className="ent-link" onClick={() => a.other && openEntity(a.other)}>{a.otherName || 'not named'}</button></> : <>Manages <button type="button" className="ent-link" onClick={() => openEntity(a.other)}>{a.otherName}</button></>}
                    {' '}- {a.terms}{a.billing ? `, billed ${a.billing.toLowerCase()}` : ''}{a.status && a.status !== 'Active' ? ` - ${a.status}` : ''}
                  </div>
                ))}<div className="ent-line"><button type="button" className="ent-link" onClick={() => onSubChange?.('mgmt-fees')}>Open Management Fees</button></div></div>
              ) : <p className="ent-muted">None.</p>}
              <h3 className="ent-head3" style={{ marginTop: 22 }}>Leases</h3>
              {agreements.leases.length ? (
                <div className="ent-lines">{agreements.leases.map((l) => (
                  <div key={l.id} className="ent-line">{l.tenant || 'Tenant'} - {l.property}{l.tenancy === 'internal' ? ' - related company' : ''}{l.end ? `, ends ${formatDate(l.end)}` : ', month to month'}</div>
                ))}<div className="ent-line"><button type="button" className="ent-link" onClick={() => onSubChange?.('mri')}>Open Monthly Recurring Income</button></div></div>
              ) : <p className="ent-muted">None.</p>}
            </section>
            <section>
              <h3 className="ent-head3">Recurring Expenses</h3>
              {agreements.recurring.length ? (
                <div className="ent-lines">{agreements.recurring.map((r) => (
                  <div key={r.id} className="ent-line">{r.vendor || 'Vendor'} <span className="ent-muted">- {r.category.replace('_', ' ')}, {r.frequency}</span></div>
                ))}<div className="ent-line"><button type="button" className="ent-link" onClick={() => onSubChange?.('mre')}>Open Monthly Recurring Expenses</button></div></div>
              ) : <p className="ent-muted">None.</p>}
              <h3 className="ent-head3" style={{ marginTop: 22 }}>Construction Jobs</h3>
              {agreements.jobs.length ? (
                <div className="ent-lines">{agreements.jobs.map((j) => (
                  <div key={j.id} className="ent-line">
                    <button type="button" className="ent-link" onClick={() => window.dispatchEvent(new CustomEvent('nexus:navigate', { detail: { view: 'ops', sub: `project:${j.id}` } }))}>{j.name}</button>
                    <span className="ent-muted"> - {[j.code, j.status].filter(Boolean).join(', ')}</span>
                  </div>
                ))}</div>
              ) : <p className="ent-muted">None you can open.</p>}
            </section>
          </div>
        )
      )}

      {e.updatedAt && <p className="ent-muted" style={{ fontSize: FS.meta, marginTop: 28 }}>Legal record last saved {formatDateTime(e.updatedAt)}{e.updatedBy ? ` by ${e.updatedBy}` : ''}</p>}

      {editing && (
        <EntityEditSheet entity={e} entities={list} canFull={e.canFull} onClose={() => setEditing(false)}
          onSaved={() => { setEditing(false); reload(); }} />
      )}
      {lines && <LinesPanel title={lines.title} caption={lines.caption} queries={lines.queries} report={lines.report} widthsKey="entity" onClose={() => setLines(null)} />}
    </div>
  );
}
